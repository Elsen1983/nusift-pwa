import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { validateHostname } from "../ssrf-guard";
import {
  parseBoundedStaticRetryAfter,
  STATIC_RETRY_AFTER_MAX_MS,
} from "./retry-after-policy";

export type DomainGovernorMode = "off" | "shadow" | "enforce";
export type DomainCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export const DOMAIN_REQUEST_GOVERNOR_MODE_ENV = "NUXT_DOMAIN_REQUEST_GOVERNOR_MODE";
export const DOMAIN_REQUEST_MIN_LEASE_TTL_MS = 1_000;
export const DOMAIN_REQUEST_DEFAULT_LEASE_TTL_MS = 30_000;
export const DOMAIN_REQUEST_DEFAULT_MIN_INTERVAL_MS = 1_000;
export const DOMAIN_REQUEST_MAX_LEASE_TTL_MS = 5 * 60_000;
export const DOMAIN_REQUEST_MAX_MIN_INTERVAL_MS = 60 * 60_000;
export const DOMAIN_REQUEST_DEFAULT_RECOVERY_LIMIT = 100;
export const DOMAIN_REQUEST_MAX_RECOVERY_LIMIT = 1_000;
export const DOMAIN_REQUEST_RETRY_AFTER_MAX_MS = STATIC_RETRY_AFTER_MAX_MS;

export type DomainGovernorState = {
  domainKey: string;
  circuitState: DomainCircuitState;
  cooldownUntil: Date | null;
  nextRequestAt: Date | null;
  activeLeaseToken: string | null;
  activeLeaseExpiresAt: Date | null;
  version: number;
  consecutive429Count: number;
  consecutive403Count: number;
  lastHttpStatus: number | null;
  lastSuccessAt: Date | null;
  lastBlockedAt: Date | null;
  lastDecision?: string | null;
  lastDecisionAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DomainOutcome = {
  kind: "success" | "rate_limited" | "forbidden" | "failure";
  status?: number | null;
  /** Retry-After delta-seconds, HTTP-date, or a previously bounded ISO timestamp. */
  retryAfter?: string | null;
};

export type DomainGovernorPolicyOptions = {
  now?: Date;
  minIntervalMs?: number;
};

export type DomainGovernorDb = {
  domainRequestGovernor: {
    findUnique(args: { where: { domainKey: string } }): Promise<DomainGovernorState | null>;
    findMany(args: Record<string, unknown>): Promise<DomainGovernorState[]>;
    create(args: { data: Record<string, unknown> }): Promise<DomainGovernorState>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
};

const dbClient = (db?: DomainGovernorDb): DomainGovernorDb =>
  db ?? (prisma as unknown as DomainGovernorDb);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUniqueConflict = (error: unknown): boolean =>
  isRecord(error) && error.code === "P2002";

const boundedInteger = (value: number | undefined, fallback: number, maximum: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value as number), maximum)) : fallback;

/** Lease validity is always strictly positive and bounded independently of request interval. */
const boundedLeaseTtl = (value?: number): number => {
  // Non-positive and non-finite caller values are invalid configuration and
  // use the maintained default; valid positive values are clamped to bounds.
  if (!Number.isFinite(value) || (value as number) <= 0) return DOMAIN_REQUEST_DEFAULT_LEASE_TTL_MS;
  return Math.max(
    DOMAIN_REQUEST_MIN_LEASE_TTL_MS,
    Math.min(Math.floor(value as number), DOMAIN_REQUEST_MAX_LEASE_TTL_MS),
  );
};

const boundedMinInterval = (value?: number): number =>
  boundedInteger(value, DOMAIN_REQUEST_DEFAULT_MIN_INTERVAL_MS, DOMAIN_REQUEST_MAX_MIN_INTERVAL_MS);

/** Recovery queries are always finite, integral, and bounded before reaching Prisma. */
export const parseDomainGovernorRecoveryLimit = (value?: number): number => {
  if (!Number.isFinite(value)) return DOMAIN_REQUEST_DEFAULT_RECOVERY_LIMIT;
  return Math.max(1, Math.min(Math.floor(value as number), DOMAIN_REQUEST_MAX_RECOVERY_LIMIT));
};

const asDateOrNull = (value: unknown): Date | null => value instanceof Date ? value : null;

const asCircuitState = (value: unknown): DomainCircuitState =>
  value === "OPEN" || value === "HALF_OPEN" ? value : "CLOSED";

const asState = (value: DomainGovernorState): DomainGovernorState => ({
  domainKey: value.domainKey,
  circuitState: asCircuitState(value.circuitState),
  cooldownUntil: asDateOrNull(value.cooldownUntil),
  nextRequestAt: asDateOrNull(value.nextRequestAt),
  activeLeaseToken: typeof value.activeLeaseToken === "string" ? value.activeLeaseToken : null,
  activeLeaseExpiresAt: asDateOrNull(value.activeLeaseExpiresAt),
  version: Number.isInteger(value.version) && value.version >= 0 ? value.version : 0,
  consecutive429Count: Number.isInteger(value.consecutive429Count) && value.consecutive429Count >= 0 ? value.consecutive429Count : 0,
  consecutive403Count: Number.isInteger(value.consecutive403Count) && value.consecutive403Count >= 0 ? value.consecutive403Count : 0,
  lastHttpStatus: Number.isInteger(value.lastHttpStatus) ? value.lastHttpStatus : null,
  lastSuccessAt: asDateOrNull(value.lastSuccessAt),
  lastBlockedAt: asDateOrNull(value.lastBlockedAt),
  lastDecision: typeof value.lastDecision === "string" ? value.lastDecision : null,
  lastDecisionAt: asDateOrNull(value.lastDecisionAt),
  createdAt: value.createdAt instanceof Date ? value.createdAt : new Date(0),
  updatedAt: value.updatedAt instanceof Date ? value.updatedAt : new Date(0),
});

export function parseDomainGovernorMode(
  value: unknown = process.env[DOMAIN_REQUEST_GOVERNOR_MODE_ENV],
): DomainGovernorMode {
  return value === "shadow" || value === "enforce" ? value : "off";
}

/**
 * Canonical domain identity for all governor state.
 *
 * The URL parser supplies WHATWG/ASCII hostname semantics. `www.example.com`
 * and `example.com` intentionally share policy; subdomains do not. A terminal
 * dot is removed before validation. No eTLD+1/public-suffix guessing is used.
 * The existing SSRF hostname policy rejects private, reserved, malformed, and
 * literal-IP hosts at this boundary.
 */
export function normalizeDomainKey(rawUrl: string): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("Domain URL is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Malformed domain URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP(S) domain URLs are supported.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const domainKey = hostname.replace(/^www\./, "");
  if (!domainKey) throw new Error("Domain hostname is empty.");
  validateHostname(domainKey);
  return domainKey;
}

export function createInitialDomainGovernorState(
  domainKey: string,
  now = new Date(),
): DomainGovernorState {
  return {
    domainKey,
    circuitState: "CLOSED",
    cooldownUntil: null,
    nextRequestAt: null,
    activeLeaseToken: null,
    activeLeaseExpiresAt: null,
    version: 0,
    consecutive429Count: 0,
    consecutive403Count: 0,
    lastHttpStatus: null,
    lastSuccessAt: null,
    lastBlockedAt: null,
    lastDecision: null,
    lastDecisionAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Status is authoritative when present. A 429/403 can never be downgraded by
 * a contradictory caller kind; non-2xx success/forbidden/rate-limit kinds are
 * treated as technical failure instead of mutating publisher streaks.
 */
export function normalizeDomainOutcome(outcome: DomainOutcome): DomainOutcome {
  const status = Number.isInteger(outcome.status) ? outcome.status as number : null;
  if (status === 429) return { ...outcome, kind: "rate_limited", status };
  if (status === 403) return { ...outcome, kind: "forbidden", status };
  if (outcome.kind === "success" && status !== null && (status < 200 || status >= 400)) {
    return { ...outcome, kind: "failure", status };
  }
  if (outcome.kind === "forbidden" || outcome.kind === "rate_limited") {
    return { ...outcome, kind: "failure", status };
  }
  return { ...outcome, status };
}

/** Pure, deterministic circuit/observability transition. */
export function applyDomainOutcome(
  input: DomainGovernorState,
  outcome: DomainOutcome,
  options: DomainGovernorPolicyOptions = {},
): DomainGovernorState {
  const now = options.now ?? new Date();
  const minIntervalMs = boundedMinInterval(options.minIntervalMs);
  const state = asState(input);
  const authoritativeOutcome = normalizeDomainOutcome(outcome);
  const status = Number.isInteger(authoritativeOutcome.status) ? authoritativeOutcome.status as number : null;
  const next = {
    ...state,
    lastHttpStatus: status,
    nextRequestAt: new Date(now.getTime() + minIntervalMs),
    updatedAt: now,
  };

  if (authoritativeOutcome.kind === "success") {
    return {
      ...next,
      circuitState: "CLOSED",
      cooldownUntil: null,
      consecutive429Count: 0,
      consecutive403Count: 0,
      lastSuccessAt: now,
    };
  }

  if (authoritativeOutcome.kind === "rate_limited" && status === 429) {
    const parsed = parseBoundedStaticRetryAfter(authoritativeOutcome.retryAfter, now.getTime());
    const baseDelayMs = Math.max(0, Date.parse(parsed.retryAfterAt) - now.getTime());
    const multiplier = 2 ** Math.min(state.consecutive429Count, 3);
    const delayMs = Math.min(DOMAIN_REQUEST_RETRY_AFTER_MAX_MS, baseDelayMs * multiplier);
    const cooldownUntil = new Date(now.getTime() + delayMs);
    const priorCooldown = state.cooldownUntil && state.cooldownUntil > cooldownUntil
      ? state.cooldownUntil
      : cooldownUntil;
    return {
      ...next,
      circuitState: "OPEN",
      cooldownUntil: priorCooldown,
      nextRequestAt: priorCooldown,
      consecutive429Count: state.consecutive429Count + 1,
      consecutive403Count: 0,
      lastBlockedAt: now,
    };
  }

  if (authoritativeOutcome.kind === "forbidden" && status === 403) {
    return {
      ...next,
      // A 403 is recorded evidence, not a rate-limit circuit transition.
      // It cannot preserve an OPEN 429 circuit after becoming authoritative.
      circuitState: "CLOSED",
      consecutive429Count: 0,
      consecutive403Count: state.consecutive403Count + 1,
      lastBlockedAt: now,
    };
  }

  return {
    ...next,
    // Technical failures do not create a rate-limit circuit and break both
    // publisher streaks. They always leave the pure policy state CLOSED.
    circuitState: "CLOSED",
    consecutive429Count: 0,
    consecutive403Count: 0,
  };
}

type PermitCandidate = {
  reason: "allowed" | "half-open-probe-granted";
  circuitState: DomainCircuitState;
};

const evaluatePermit = (
  state: DomainGovernorState,
  now: Date,
): { deferReason: "circuit-open" | "minimum-interval-not-reached" | "active-lease-held" | null; candidate: PermitCandidate | null } => {
  const activeLease = state.activeLeaseToken && state.activeLeaseExpiresAt && state.activeLeaseExpiresAt > now;
  if (activeLease) return { deferReason: "active-lease-held", candidate: null };

  if (state.circuitState === "OPEN" && state.cooldownUntil && state.cooldownUntil > now) {
    return { deferReason: "circuit-open", candidate: null };
  }

  const halfOpen = state.circuitState === "HALF_OPEN" || state.circuitState === "OPEN";
  if (!halfOpen && state.nextRequestAt && state.nextRequestAt > now) {
    return { deferReason: "minimum-interval-not-reached", candidate: null };
  }

  return {
    deferReason: null,
    candidate: halfOpen
      ? { reason: "half-open-probe-granted", circuitState: "HALF_OPEN" }
      : { reason: "allowed", circuitState: "CLOSED" },
  };
};

export type AcquireDomainPermitInput = {
  url: string;
  mode?: DomainGovernorMode;
  now?: Date;
  leaseTtlMs?: number;
  minIntervalMs?: number;
  db?: DomainGovernorDb;
};

export type AcquireDomainPermitResult = {
  allowed: boolean;
  shadow: boolean;
  domainKey: string | null;
  reason:
    | "off"
    | "allowed"
    | "half-open-probe-granted"
    | "shadow-would-allow"
    | "shadow-would-defer"
    | "circuit-open"
    | "minimum-interval-not-reached"
    | "active-lease-held"
    | "half-open-probe-unavailable"
    | "governor-persistence-unavailable"
    | "invalid-domain";
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  circuitState: DomainCircuitState | null;
};

const invalidPermit = (reason: "invalid-domain" | "governor-persistence-unavailable"): AcquireDomainPermitResult => ({
  allowed: false,
  shadow: false,
  domainKey: null,
  reason,
  leaseToken: null,
  leaseExpiresAt: null,
  circuitState: null,
});

async function loadOrCreateState(db: DomainGovernorDb, domainKey: string, now: Date): Promise<DomainGovernorState> {
  const existing = await db.domainRequestGovernor.findUnique({ where: { domainKey } });
  if (existing) return asState(existing);
  try {
    return asState(await db.domainRequestGovernor.create({
      data: {
        domainKey,
        circuitState: "CLOSED",
        version: 0,
        consecutive429Count: 0,
        consecutive403Count: 0,
        lastDecision: null,
        lastDecisionAt: null,
      },
    }));
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = await db.domainRequestGovernor.findUnique({ where: { domainKey } });
    if (!raced) throw error;
    return asState(raced);
  }
}

export async function acquireDomainPermit(
  input: AcquireDomainPermitInput,
): Promise<AcquireDomainPermitResult> {
  let domainKey: string;
  try {
    domainKey = normalizeDomainKey(input.url);
  } catch {
    return invalidPermit("invalid-domain");
  }
  const mode = parseDomainGovernorMode(input.mode);
  if (mode === "off") {
    return { allowed: true, shadow: false, domainKey, reason: "off", leaseToken: null, leaseExpiresAt: null, circuitState: null };
  }

  const now = input.now ?? new Date();
  const db = dbClient(input.db);
  let state: DomainGovernorState;
  try {
    state = await loadOrCreateState(db, domainKey, now);
  } catch {
    return mode === "enforce"
      ? invalidPermit("governor-persistence-unavailable")
      : { allowed: true, shadow: true, domainKey, reason: "shadow-would-allow", leaseToken: null, leaseExpiresAt: null, circuitState: null };
  }

  const evaluation = evaluatePermit(state, now);
  if (mode === "shadow") {
    const shadowReason = evaluation.deferReason ? "shadow-would-defer" : "shadow-would-allow";
    try {
      await db.domainRequestGovernor.updateMany({
        where: { domainKey, version: state.version },
        // Shadow diagnostics are durable, but must not participate in lease CAS
        // versioning: shadow traffic cannot invalidate an enforce lease.
        data: { lastDecision: shadowReason, lastDecisionAt: now },
      });
    } catch {
      // Shadow mode never suppresses network work when diagnostics cannot persist.
    }
    return {
      allowed: true,
      shadow: true,
      domainKey,
      reason: shadowReason,
      leaseToken: null,
      leaseExpiresAt: null,
      circuitState: evaluation.candidate?.circuitState ?? state.circuitState,
    };
  }

  if (evaluation.deferReason) {
    return {
      allowed: false,
      shadow: false,
      domainKey,
      reason: evaluation.deferReason,
      leaseToken: null,
      leaseExpiresAt: null,
      circuitState: state.circuitState,
    };
  }

  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + boundedLeaseTtl(input.leaseTtlMs));
  let updated: { count: number };
  try {
    updated = await db.domainRequestGovernor.updateMany({
      where: {
        domainKey,
        version: state.version,
        circuitState: state.circuitState,
        activeLeaseToken: state.activeLeaseToken,
      },
      data: {
        circuitState: evaluation.candidate!.circuitState,
        activeLeaseToken: leaseToken,
        activeLeaseExpiresAt: leaseExpiresAt,
        nextRequestAt: new Date(now.getTime() + boundedMinInterval(input.minIntervalMs)),
        lastDecision: "allowed",
        lastDecisionAt: now,
        version: { increment: 1 },
      },
    });
  } catch {
    return {
      allowed: false,
      shadow: false,
      domainKey,
      reason: "governor-persistence-unavailable",
      leaseToken: null,
      leaseExpiresAt: null,
      circuitState: state.circuitState,
    };
  }

  if (updated.count !== 1) {
    return {
      allowed: false,
      shadow: false,
      domainKey,
      reason: evaluation.candidate!.circuitState === "HALF_OPEN" ? "half-open-probe-unavailable" : "active-lease-held",
      leaseToken: null,
      leaseExpiresAt: null,
      circuitState: state.circuitState,
    };
  }

  return {
    allowed: true,
    shadow: false,
    domainKey,
    reason: evaluation.candidate!.reason,
    leaseToken,
    leaseExpiresAt,
    circuitState: evaluation.candidate!.circuitState,
  };
}

export type RecordDomainOutcomeInput = {
  url: string;
  outcome: DomainOutcome;
  leaseToken?: string | null;
  mode?: DomainGovernorMode;
  now?: Date;
  minIntervalMs?: number;
  db?: DomainGovernorDb;
};

export type RecordDomainOutcomeResult = {
  recorded: boolean;
  domainKey: string | null;
  reason: "off" | "shadow-noop" | "recorded" | "token-mismatch" | "cas-conflict" | "governor-persistence-unavailable" | "invalid-domain";
};

export async function recordDomainOutcome(
  input: RecordDomainOutcomeInput,
): Promise<RecordDomainOutcomeResult> {
  let domainKey: string;
  try { domainKey = normalizeDomainKey(input.url); } catch { return { recorded: false, domainKey: null, reason: "invalid-domain" }; }
  const mode = parseDomainGovernorMode(input.mode);
  if (mode === "off") return { recorded: false, domainKey, reason: "off" };
  // Token-bearing shadow completion is a database-free no-op. Check before
  // resolving the client or loading/creating state.
  if (mode === "shadow" && input.leaseToken) {
    return { recorded: false, domainKey, reason: "shadow-noop" };
  }
  const db = dbClient(input.db);
  const now = input.now ?? new Date();
  try {
    const state = await loadOrCreateState(db, domainKey, now);
    if (mode === "shadow") {
      // Shadow outcome persistence is diagnostic-only. It must never mutate
      // circuit, cooldown, counters, lease ownership, or CAS version state
      // that an enforce-mode worker may currently own.
      const normalizedOutcome = normalizeDomainOutcome(input.outcome);
      const diagnostic = await db.domainRequestGovernor.updateMany({
        where: { domainKey, version: state.version },
        data: {
          // Shadow diagnostics use the same status-authoritative normalization
          // as enforce mode, while remaining coordination-state neutral.
          lastDecision: `shadow-outcome:${normalizedOutcome.kind}`,
          lastDecisionAt: now,
        },
      });
      return diagnostic.count === 1
        ? { recorded: true, domainKey, reason: "recorded" }
        : { recorded: false, domainKey, reason: "cas-conflict" };
    }
    if (input.leaseToken && (!state.activeLeaseExpiresAt || state.activeLeaseExpiresAt <= now)) {
      return { recorded: false, domainKey, reason: "token-mismatch" };
    }
    if (mode === "enforce" && (!input.leaseToken || state.activeLeaseToken !== input.leaseToken)) {
      return { recorded: false, domainKey, reason: "token-mismatch" };
    }
    const next = applyDomainOutcome(state, input.outcome, { now, minIntervalMs: input.minIntervalMs });
    const updated = await db.domainRequestGovernor.updateMany({
      where: {
        domainKey,
        version: state.version,
        ...(input.leaseToken ? {
          activeLeaseToken: input.leaseToken,
          activeLeaseExpiresAt: { gt: now },
        } : {}),
      },
      data: {
        circuitState: next.circuitState,
        cooldownUntil: next.cooldownUntil,
        nextRequestAt: next.nextRequestAt,
        activeLeaseToken: input.leaseToken ? null : state.activeLeaseToken,
        activeLeaseExpiresAt: input.leaseToken ? null : state.activeLeaseExpiresAt,
        consecutive429Count: next.consecutive429Count,
        consecutive403Count: next.consecutive403Count,
        lastHttpStatus: next.lastHttpStatus,
        lastSuccessAt: next.lastSuccessAt,
        lastBlockedAt: next.lastBlockedAt,
        version: { increment: 1 },
      },
    });
    return updated.count === 1
      ? { recorded: true, domainKey, reason: "recorded" }
      : { recorded: false, domainKey, reason: "cas-conflict" };
  } catch {
    return { recorded: false, domainKey, reason: "governor-persistence-unavailable" };
  }
}

export type ReleaseDomainPermitInput = {
  url: string;
  leaseToken: string;
  mode?: DomainGovernorMode;
  now?: Date;
  db?: DomainGovernorDb;
};

export type ReleaseDomainPermitResult = {
  released: boolean;
  domainKey: string | null;
  reason: "off" | "shadow-noop" | "released" | "token-mismatch" | "governor-persistence-unavailable" | "invalid-domain";
};

export async function releaseDomainPermit(
  input: ReleaseDomainPermitInput,
): Promise<ReleaseDomainPermitResult> {
  let domainKey: string;
  try { domainKey = normalizeDomainKey(input.url); } catch { return { released: false, domainKey: null, reason: "invalid-domain" }; }
  const mode = parseDomainGovernorMode(input.mode);
  if (mode === "off") return { released: false, domainKey, reason: "off" };
  if (mode === "shadow") return { released: false, domainKey, reason: "shadow-noop" };
  if (!input.leaseToken) return { released: false, domainKey, reason: "token-mismatch" };
  const now = input.now ?? new Date();
  try {
    const state = await dbClient(input.db).domainRequestGovernor.findUnique({ where: { domainKey } });
    if (!state || !state.activeLeaseExpiresAt || state.activeLeaseExpiresAt <= now || state.activeLeaseToken !== input.leaseToken) {
      return { released: false, domainKey, reason: "token-mismatch" };
    }
    const updated = await dbClient(input.db).domainRequestGovernor.updateMany({
      where: {
        domainKey,
        version: state.version,
        activeLeaseToken: input.leaseToken,
        activeLeaseExpiresAt: { gt: now },
      },
      data: { activeLeaseToken: null, activeLeaseExpiresAt: null, version: { increment: 1 } },
    });
    return updated.count === 1
      ? { released: true, domainKey, reason: "released" }
      : { released: false, domainKey, reason: "token-mismatch" };
  } catch {
    return { released: false, domainKey, reason: "governor-persistence-unavailable" };
  }
}

export type RecoverExpiredDomainLeasesInput = {
  now?: Date;
  limit?: number;
  mode?: DomainGovernorMode;
  db?: DomainGovernorDb;
  timeBudgetMs?: number;
  clock?: () => number;
};

export type RecoverExpiredDomainLeasesResult = {
  scanned: number;
  recovered: number;
  conflicted: number;
  malformed: number;
  failed: number;
  timeBudgetExhausted: boolean;
  reason: "off" | "shadow-noop" | "recovered" | "governor-persistence-unavailable";
};

const emptyLeaseRecoveryResult = (
  reason: RecoverExpiredDomainLeasesResult["reason"],
): RecoverExpiredDomainLeasesResult => ({
  scanned: 0,
  recovered: 0,
  conflicted: 0,
  malformed: 0,
  failed: 0,
  timeBudgetExhausted: false,
  reason,
});

export async function recoverExpiredDomainLeases(
  input: RecoverExpiredDomainLeasesInput = {},
): Promise<RecoverExpiredDomainLeasesResult> {
  const mode = parseDomainGovernorMode(input.mode);
  if (mode === "off") return emptyLeaseRecoveryResult("off");
  if (mode === "shadow") return emptyLeaseRecoveryResult("shadow-noop");
  const now = input.now ?? new Date();
  const limit = parseDomainGovernorRecoveryLimit(input.limit);
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const requestedTimeBudget = input.timeBudgetMs ?? 5_000;
  const timeBudgetMs = Number.isFinite(requestedTimeBudget)
    ? Math.max(1, Math.min(Math.floor(requestedTimeBudget), 30_000))
    : 5_000;
  try {
    const db = dbClient(input.db);
    const rows = await db.domainRequestGovernor.findMany({
      where: { activeLeaseExpiresAt: { lte: now }, activeLeaseToken: { not: null } },
      orderBy: [{ activeLeaseExpiresAt: "asc" }, { domainKey: "asc" }],
      take: limit,
    });
    let recovered = 0;
    let conflicted = 0;
    let malformed = 0;
    let failed = 0;
    let timeBudgetExhausted = false;
    for (const row of rows) {
      if (clock() - startedAt >= timeBudgetMs) {
        timeBudgetExhausted = true;
        break;
      }
      const state = asState(row);
      if (
        !state.activeLeaseToken ||
        !state.activeLeaseExpiresAt ||
        !Number.isInteger(row.version) ||
        row.version < 0
      ) {
        malformed += 1;
        continue;
      }
      try {
        const result = await db.domainRequestGovernor.updateMany({
          where: {
            domainKey: state.domainKey,
            version: state.version,
            activeLeaseToken: state.activeLeaseToken,
            activeLeaseExpiresAt: state.activeLeaseExpiresAt,
          },
          data: { activeLeaseToken: null, activeLeaseExpiresAt: null, version: { increment: 1 } },
        });
        if (result.count === 1) recovered += 1;
        else conflicted += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      scanned: rows.length,
      recovered,
      conflicted,
      malformed,
      failed,
      timeBudgetExhausted,
      reason: failed > 0 ? "governor-persistence-unavailable" : "recovered",
    };
  } catch {
    return {
      ...emptyLeaseRecoveryResult("governor-persistence-unavailable"),
      failed: 1,
    };
  }
}
