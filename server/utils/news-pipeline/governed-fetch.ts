import * as ssrfGuard from "../ssrf-guard";
import type { SafeFetchOptions, SafeFetchTransportHooks } from "../ssrf-guard";
import {
  acquireDomainPermit,
  parseDomainGovernorMode,
  recordDomainOutcome,
  releaseDomainPermit,
  type AcquireDomainPermitResult,
  type DomainGovernorDb,
  type DomainGovernorMode,
  type DomainOutcome,
} from "./domain-request-governor";

/**
 * Bounded context for diagnostics and future observability. The adapter never
 * persists the URL, query, headers, cookies, response body, or credentials.
 */
export type GovernedFetchContext = {
  agent: "agent1" | "agent2" | "agent3";
  stage: string;
  purpose: "feed" | "listing" | "robots" | "sitemap" | "article_detail" | "article_extraction" | string;
  pipelineRunId?: string | null;
  sourceId?: string | null;
  categoryId?: string | null;
  articleId?: number | null;
  mode?: DomainGovernorMode;
  db?: DomainGovernorDb;
  /** Invocation-local host stop activated by an observed static HTTP 429. */
  static429Hostnames?: Set<string>;
  /** Shared robots policy is checked before every non-robots publisher request. */
  robotsPolicy?: "required" | "skip";
  /** Optional injected durable robots-cache client for tests/isolated runtimes. */
  robotsDb?: unknown;
  /** Existing Agent-local budget, consumed once only after a permit is allowed. */
  requestBudget?: {
    snapshot?: () => { remaining: number };
    remaining?: () => number;
    consume: (...args: any[]) => boolean;
    phase?: string;
    recordRateLimit?: (...args: any[]) => unknown;
  };
};

export class GovernedFetchDeferredError extends Error {
  readonly reason: string;
  readonly domainKey: string | null;
  readonly governor = true;

  constructor(reason: string, domainKey: string | null = null) {
    super("Pipeline request deferred by domain governance");
    this.name = "GovernedFetchDeferredError";
    this.reason = reason;
    this.domainKey = domainKey;
  }
}

export class GovernedFetchRequestBudgetError extends Error {
  readonly governor = false;
  readonly requestBudget = true;

  constructor() {
    super("Pipeline request budget exhausted");
    this.name = "GovernedFetchRequestBudgetError";
  }
}

const readResponseHeader = (response: Pick<Response, "headers">, name: string): string | null => {
  const headers = response.headers as Headers & Record<string, unknown>;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return typeof value === "string" ? value : null;
};

const outcomeFromResponse = (response: Response): DomainOutcome => {
  const status = response.status;
  if (status === 429) {
    return {
      kind: "rate_limited",
      status,
      retryAfter: readResponseHeader(response, "retry-after"),
    };
  }
  if (status === 403) return { kind: "forbidden", status };
  if (status >= 200 && status < 300) return { kind: "success", status };
  return { kind: "failure", status };
};

const failureOutcome = (): DomainOutcome => ({ kind: "failure", status: null });

const isGovernorPersistenceFailure = (reason: string): boolean =>
  reason === "governor-persistence-unavailable" || reason === "cas-conflict" || reason === "token-mismatch";

const ensureRecorded = (result: Awaited<ReturnType<typeof recordDomainOutcome>>, domainKey: string | null) => {
  if (result.reason !== "recorded" && isGovernorPersistenceFailure(result.reason)) {
    throw new GovernedFetchDeferredError(result.reason, domainKey);
  }
};

const budgetRemaining = (budget: NonNullable<GovernedFetchContext["requestBudget"]>): number | null => {
  if (budget.snapshot) return budget.snapshot().remaining;
  if (budget.remaining) return budget.remaining();
  return null;
};

const consumeBudget = (
  budget: NonNullable<GovernedFetchContext["requestBudget"]>,
  context: GovernedFetchContext,
  url: string,
): boolean => {
  const phase = context.requestBudget?.phase ?? context.purpose;
  return budget.consume.length >= 2 ? budget.consume(phase, url) : budget.consume();
};

const ensureRobotsAllowed = async (url: string, context: GovernedFetchContext): Promise<void> => {
  if (context.purpose === "robots" || context.robotsPolicy === "skip") return;
  const { checkPublisherRobotsAccess } = await import("./robots-policy");
  const robotsDecision = await checkPublisherRobotsAccess(url, { context });
  if (!robotsDecision.allowed || robotsDecision.decision === "deferred") {
    throw new GovernedFetchDeferredError(robotsDecision.reason, robotsDecision.domainKey);
  }
};

type HopLease = {
  permit: AcquireDomainPermitResult | null;
  url: string;
  /** True once recordDomainOutcome has authoritatively completed this lease. */
  completed: boolean;
};

const releaseLease = async (
  lease: HopLease,
  mode: DomainGovernorMode,
  context: GovernedFetchContext,
) => {
  if (lease.completed || !lease.permit?.leaseToken) return;
  const released = await releaseDomainPermit({
    url: lease.url,
    mode,
    leaseToken: lease.permit.leaseToken,
    now: new Date(),
    db: context.db,
  });
  if (isGovernorPersistenceFailure(released.reason)) {
    throw new GovernedFetchDeferredError(released.reason, released.domainKey);
  }
};

const recordLeaseOutcome = async (
  lease: HopLease,
  mode: DomainGovernorMode,
  context: GovernedFetchContext,
  outcome: DomainOutcome,
) => {
  // Shadow permits are deliberately tokenless. They still record bounded,
  // status-normalized diagnostics, but never acquire or complete a lease.
  if (!lease.permit?.leaseToken && mode !== "shadow") return;
  let recorded: Awaited<ReturnType<typeof recordDomainOutcome>>;
  try {
    recorded = await recordDomainOutcome({
      url: lease.url,
      mode,
      now: new Date(),
      ...(lease.permit?.leaseToken ? { leaseToken: lease.permit.leaseToken } : {}),
      outcome,
      db: context.db,
    });
  } catch (error) {
    // Shadow mode is observation-only: diagnostic persistence failures never
    // suppress transport or turn into a publisher/network failure.
    if (mode === "shadow") return;
    throw error;
  }

  // Shadow diagnostics are observation-only: a persistence/CAS failure must
  // not suppress the transport that shadow mode is explicitly allowing.
  if (mode === "shadow") return;

  ensureRecorded(recorded, lease.permit?.domainKey ?? null);
  if (recorded.recorded) lease.completed = true;
};

const makeTransportHooks = (
  context: GovernedFetchContext,
  mode: DomainGovernorMode,
): SafeFetchTransportHooks => {
  let logicalBudgetConsumed = false;

  const domainKeyForUrl = (url: string): string | null => {
    try {
      return new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    } catch {
      return null;
    }
  };

  const observeStatic429 = (url: string, response: Pick<Response, "status">) => {
    if (response.status !== 429) return;
    const domainKey = domainKeyForUrl(url);
    if (domainKey) context.static429Hostnames?.add(domainKey);
  };

  return {
    beforeTransport: async (url, isFirstTransport) => {
      const domainKey = domainKeyForUrl(url);
      if (domainKey && context.static429Hostnames?.has(domainKey)) {
        throw new GovernedFetchDeferredError("static_429_host", domainKey);
      }
      const budget = context.requestBudget;
      const remaining = budget ? budgetRemaining(budget) : null;
      if (isFirstTransport && remaining !== null && remaining <= 0) {
        throw new GovernedFetchRequestBudgetError();
      }

      // The initial URL is checked once before the parser starts. A false flag
      // identifies a redirect hop, so validate that target here before its
      // transport is issued without adding a second initial robots fetch.
      if (!isFirstTransport) await ensureRobotsAllowed(url, context);

      const permit = mode === "off"
        ? null
        : await acquireDomainPermit({ url, mode, now: new Date(), db: context.db });
      if (permit && !permit.allowed) {
        throw new GovernedFetchDeferredError(permit.reason, permit.domainKey);
      }

      if (isFirstTransport && !logicalBudgetConsumed && budget && !consumeBudget(budget, context, url)) {
        const lease: HopLease = { permit, url, completed: false };
        try {
          await releaseLease(lease, mode, context);
        } catch (error) {
          if (error instanceof GovernedFetchDeferredError) throw error;
        }
        throw new GovernedFetchRequestBudgetError();
      }
      if (isFirstTransport) logicalBudgetConsumed = true;
      return { permit, url, completed: false } satisfies HopLease;
    },

    onRedirectResponse: async (url, response, lease) => {
      observeStatic429(url, response);
      const hopLease = lease as HopLease;
      let completionError: unknown = null;
      try {
        await recordLeaseOutcome(hopLease, mode, context, outcomeFromResponse(response));
      } catch (error) {
        completionError = error;
        throw error;
      } finally {
        try {
          await releaseLease(hopLease, mode, context);
        } catch (releaseError) {
          // Preserve the authoritative completion/defer error if one already
          // exists; a release failure is only primary when cleanup is the
          // first failed lifecycle operation.
          if (!completionError) throw releaseError;
        }
      }
    },

    onFinalResponse: async (url, response, lease, parseError) => {
      observeStatic429(url, response);
      const hopLease = lease as HopLease;
      let completionError: unknown = null;
      try {
        await recordLeaseOutcome(hopLease, mode, context, outcomeFromResponse(response));
      } catch (error) {
        completionError = error;
        throw error;
      } finally {
        try {
          await releaseLease(hopLease, mode, context);
        } catch (releaseError) {
          // A parser error remains the caller-visible primary error. Likewise,
          // preserve an authoritative governor defer over cleanup failure.
          if (!parseError && !completionError) throw releaseError;
        }
      }
    },

    onTransportError: async (url, error, lease) => {
      const hopLease = lease as HopLease;
      let completionError: unknown = null;
      try {
        await recordLeaseOutcome(hopLease, mode, context, failureOutcome());
      } catch (error) {
        completionError = error;
        throw error;
      } finally {
        try {
          await releaseLease(hopLease, mode, context);
        } catch (releaseError) {
          if (!completionError) throw releaseError;
        }
      }
    },
  };
};

/**
 * Govern one logical SSRF-safe static pipeline request. URL parsing and SSRF
 * preflight happen inside safeFetch before each hook invocation, so no governor
 * row or local budget slot is touched for malformed or blocked targets.
 */
async function runGovernedRequest<T>(
  url: string,
  options: SafeFetchOptions,
  context: GovernedFetchContext,
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  const mode = parseDomainGovernorMode(context.mode);
  const budget = context.requestBudget;
  if (budget) {
    const remaining = budgetRemaining(budget);
    if (remaining !== null && remaining <= 0) throw new GovernedFetchRequestBudgetError();
  }
  await ensureRobotsAllowed(url, context);
  const hooks = makeTransportHooks(context, mode);
  const governedOptions = { ...options, transportHooks: hooks };

  // The parser-aware SSRF core is mandatory for governed transport. It owns
  // URL/DNS/IP preflight before beforeTransport, validates every redirect hop,
  // and holds the final lease through bounded body parsing. A legacy safeFetch-
  // only fallback cannot prove that ordering, so fail closed instead of
  // issuing an ungoverned or prematurely governed request.
  const parser = ssrfGuard.safeFetchWithParser;
  if (typeof parser !== "function") {
    throw new Error("Governed static transport requires safeFetchWithParser");
  }
  return parser(url, governedOptions, parse);
}

/** Govern one logical SSRF-safe static request. */
export function governedSafeFetch(
  url: string,
  options: SafeFetchOptions = {},
  context: GovernedFetchContext,
): Promise<Response> {
  return runGovernedRequest(url, options, context, async (response) => response);
}

/** True when a static request was denied/deferred by domain governance. */
export const isGovernedFetchDeferredError = (error: unknown): error is GovernedFetchDeferredError =>
  error instanceof GovernedFetchDeferredError;

export const isGovernedFetchRequestBudgetError = (error: unknown): error is GovernedFetchRequestBudgetError =>
  error instanceof GovernedFetchRequestBudgetError;

/**
 * Preferred form for body consumers. The final response parser executes before
 * the final hop lease is recorded/released.
 */
export function governedSafeFetchAndParse<T>(
  url: string,
  options: SafeFetchOptions,
  context: GovernedFetchContext,
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  return runGovernedRequest(url, options, context, parse);
}
