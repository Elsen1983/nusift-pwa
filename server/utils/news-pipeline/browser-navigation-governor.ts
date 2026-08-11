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
import { parseBoundedStaticRetryAfter } from "./retry-after-policy";
import { GovernedFetchDeferredError } from "./governed-fetch";
import { checkPublisherRobotsAccess } from "./robots-policy";

const MAX_NAVIGATION_REQUEST_COUNT = 1_000;

export type BrowserNavigationGovernorContext = {
  agent: "agent2" | "agent3";
  stage: string;
  mode?: DomainGovernorMode;
  robotsPolicy?: "required" | "skip";
  db?: DomainGovernorDb;
  now?: () => Date;
  robotsDb?: unknown;
};

export type BrowserNavigationEvidence = {
  governorDecision: string;
  domainKey: string | null;
  mainDocumentRequests: number;
  firstPartySubrequests: number;
  thirdPartySubrequests: number;
  blockedHeavyResources: number;
  mainDocumentStatus: number | null;
  publisherDomain429Observed: boolean;
  authoritativePublisher429: boolean;
  retryAfterAt: string | null;
  retryAfterSource: string | null;
  robotsDecision: string | null;
  robotsStatus: string | null;
};

export type BrowserNavigationLease = {
  url: string;
  mode: DomainGovernorMode;
  permit: AcquireDomainPermitResult | null;
  context: BrowserNavigationGovernorContext;
  finished: boolean;
  terminalOperations: number;
};

export type BrowserNavigationAcquireResult =
  | { allowed: true; lease: BrowserNavigationLease; evidence: BrowserNavigationEvidence }
  | { allowed: false; reason: string; evidence: BrowserNavigationEvidence };

export type GovernedBrowserNavigationResult =
  | {
      allowed: true;
      response: any | null;
      error: unknown | null;
      evidence: BrowserNavigationEvidence;
      complete: (outcome?: DomainOutcome) => Promise<void>;
    }
  | { allowed: false; reason: string; evidence: BrowserNavigationEvidence };

const boundedIncrement = (value: number) => Math.min(MAX_NAVIGATION_REQUEST_COUNT, value + 1);

const domainKeyForUrl = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  } catch {
    return null;
  }
};

const makeEvidence = (decision: string, domainKey: string | null): BrowserNavigationEvidence => ({
  governorDecision: decision.slice(0, 80),
  domainKey,
  mainDocumentRequests: 0,
  firstPartySubrequests: 0,
  thirdPartySubrequests: 0,
  blockedHeavyResources: 0,
  mainDocumentStatus: null,
  publisherDomain429Observed: false,
  authoritativePublisher429: false,
  retryAfterAt: null,
  retryAfterSource: null,
  robotsDecision: null,
  robotsStatus: null,
});

const readHeader = async (response: any, name: string): Promise<string | null> => {
  try {
    const headers = typeof response?.headers === "function"
      ? await Promise.resolve(response.headers())
      : response?.headers;
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(name);
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key && typeof headers[key] === "string" ? headers[key] : null;
  } catch {
    return null;
  }
};

const outcomeForStatus = async (response: any | null, fallback: DomainOutcome): Promise<DomainOutcome> => {
  const status = typeof response?.status === "function" ? response.status() : null;
  if (status === 429) {
    return { kind: "rate_limited", status, retryAfter: await readHeader(response, "retry-after") };
  }
  if (status === 403) return { kind: "forbidden", status };
  if (Number.isInteger(status) && status >= 200 && status < 400) return { kind: "success", status };
  if (Number.isInteger(status)) return { kind: "failure", status };
  return fallback;
};

const isPersistenceFailure = (reason: string) =>
  reason === "governor-persistence-unavailable" || reason === "cas-conflict" || reason === "token-mismatch";

export async function acquireBrowserNavigationPermit(input: {
  url: string;
  context: BrowserNavigationGovernorContext;
}): Promise<BrowserNavigationAcquireResult> {
  const mode = parseDomainGovernorMode(input.context.mode);
  const permit = mode === "off"
    ? null
    : await acquireDomainPermit({ url: input.url, mode, now: input.context.now?.() ?? new Date(), db: input.context.db });
  const domainKey = permit?.domainKey ?? domainKeyForUrl(input.url);
  const evidence = makeEvidence(permit?.reason ?? "off", domainKey);
  if (permit && !permit.allowed) return { allowed: false, reason: permit.reason, evidence };
  return {
    allowed: true,
    evidence,
    lease: {
      url: input.url,
      mode,
      permit,
      context: input.context,
      finished: false,
      terminalOperations: 0,
    },
  };
}

export async function releaseUnusedBrowserNavigationPermit(lease: BrowserNavigationLease): Promise<void> {
  if (lease.finished) return;
  lease.finished = true;
  lease.terminalOperations += 1;
  if (!lease.permit?.leaseToken) return;
  await releaseDomainPermit({
    url: lease.url,
    mode: lease.mode,
    leaseToken: lease.permit.leaseToken,
    now: lease.context.now?.() ?? new Date(),
    db: lease.context.db,
  });
}

async function completeLease(lease: BrowserNavigationLease, outcome: DomainOutcome): Promise<void> {
  if (lease.finished) return;
  if (lease.mode === "off") {
    lease.finished = true;
    lease.terminalOperations += 1;
    return;
  }

  const result = await recordDomainOutcome({
    url: lease.url,
    mode: lease.mode,
    ...(lease.permit?.leaseToken ? { leaseToken: lease.permit.leaseToken } : {}),
    outcome,
    now: lease.context.now?.() ?? new Date(),
    db: lease.context.db,
  });
  if (lease.mode === "enforce" && !result.recorded && isPersistenceFailure(result.reason)) {
    throw new GovernedFetchDeferredError(result.reason, result.domainKey);
  }
  lease.finished = true;
  lease.terminalOperations += 1;
}

const completeOrReleaseLease = async (lease: BrowserNavigationLease, outcome: DomainOutcome) => {
  try {
    await completeLease(lease, outcome);
  } catch (error) {
    await releaseUnusedBrowserNavigationPermit(lease);
    throw error;
  }
};

export async function startGovernedBrowserNavigation(input: {
  page: any;
  url: string;
  gotoOptions: Record<string, unknown>;
  context: BrowserNavigationGovernorContext;
  lease?: BrowserNavigationLease;
  getBlockedHeavyResources?: () => number;
}): Promise<GovernedBrowserNavigationResult> {
  const robots = input.context.robotsPolicy === "skip"
    ? { allowed: true, decision: "allowed" as const, status: "no_policy" as const, reason: "robots_test_bypass", domainKey: domainKeyForUrl(input.url), cacheHit: false, sitemapUrls: [] }
    : await checkPublisherRobotsAccess(input.url, {
    context: {
      agent: input.context.agent,
      stage: input.context.stage,
      purpose: "article_detail",
      mode: input.context.mode,
      db: input.context.db,
      robotsDb: input.context.robotsDb,
    },
      });
  const robotsEvidence = makeEvidence("robots", domainKeyForUrl(input.url));
  robotsEvidence.robotsDecision = robots.decision;
  robotsEvidence.robotsStatus = robots.status;
  if (!robots.allowed || robots.decision === "deferred") {
    return { allowed: false, reason: robots.reason, evidence: robotsEvidence };
  }
  const acquired = input.lease
    ? { allowed: true as const, lease: input.lease, evidence: makeEvidence(input.lease.permit?.reason ?? "off", input.lease.permit?.domainKey ?? domainKeyForUrl(input.url)) }
    : await acquireBrowserNavigationPermit({ url: input.url, context: input.context });
  if (!acquired.allowed) return acquired;

  const { lease, evidence } = acquired;
  const publisherDomain = domainKeyForUrl(input.url);
  const onRequest = (request: any) => {
    try {
      const isMain = request?.isNavigationRequest?.() === true && request?.frame?.() === input.page?.mainFrame?.();
      if (isMain) return;
      const requestDomain = domainKeyForUrl(request?.url?.() ?? "");
      if (requestDomain && requestDomain === publisherDomain) {
        evidence.firstPartySubrequests = boundedIncrement(evidence.firstPartySubrequests);
      } else {
        evidence.thirdPartySubrequests = boundedIncrement(evidence.thirdPartySubrequests);
      }
    } catch { /* diagnostic-only */ }
  };
  const onResponse = (response: any) => {
    try {
      if (response?.status?.() !== 429) return;
      const responseDomain = domainKeyForUrl(response?.url?.() ?? "");
      if (responseDomain && responseDomain === publisherDomain) evidence.publisherDomain429Observed = true;
    } catch { /* diagnostic-only */ }
  };
  input.page?.on?.("request", onRequest);
  input.page?.on?.("response", onResponse);
  const detachListeners = () => {
    if (typeof input.page?.off === "function") {
      input.page.off("request", onRequest);
      input.page.off("response", onResponse);
    } else {
      input.page?.removeListener?.("request", onRequest);
      input.page?.removeListener?.("response", onResponse);
    }
  };

  let response: any | null = null;
  let navigationError: unknown | null = null;
  evidence.mainDocumentRequests = 1;
  try {
    response = await input.page.goto(input.url, input.gotoOptions);
  } catch (error) {
    navigationError = error;
  }

  evidence.mainDocumentStatus = typeof response?.status === "function" ? response.status() : null;
  evidence.authoritativePublisher429 = evidence.mainDocumentStatus === 429;
  if (evidence.authoritativePublisher429) {
    evidence.publisherDomain429Observed = true;
    const parsedRetryAfter = parseBoundedStaticRetryAfter(
      await readHeader(response, "retry-after"),
      (input.context.now?.() ?? new Date()).getTime(),
    );
    evidence.retryAfterAt = parsedRetryAfter.retryAfterAt;
    evidence.retryAfterSource = parsedRetryAfter.source;
    try {
      await completeOrReleaseLease(lease, await outcomeForStatus(response, { kind: "failure", status: null }));
    } catch (completionError) {
      detachListeners();
      throw completionError;
    }
  }

  const complete = async (override?: DomainOutcome) => {
    evidence.blockedHeavyResources = Math.min(
      MAX_NAVIGATION_REQUEST_COUNT,
      Math.max(0, Math.floor(input.getBlockedHeavyResources?.() ?? evidence.blockedHeavyResources)),
    );
    try {
      await completeOrReleaseLease(
        lease,
        override ?? await outcomeForStatus(response, navigationError
          ? { kind: "failure", status: null }
          : { kind: "success", status: null }),
      );
    } finally {
      detachListeners();
    }
  };

  return { allowed: true, response, error: navigationError, evidence, complete };
}
