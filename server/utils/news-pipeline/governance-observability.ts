import { normalizeDomainKey, type DomainCircuitState, type DomainGovernorMode } from "./domain-request-governor";
import { boundText, clampCount } from "./stage-telemetry";

export const GOVERNANCE_DIAGNOSTICS_DEFAULT_LIMIT = 25;
export const GOVERNANCE_DIAGNOSTICS_MAX_LIMIT = 100;
export const GOVERNANCE_DIAGNOSTICS_MAX_ARTIFACT_SCAN = 500;
export const GOVERNANCE_DIAGNOSTICS_MAX_TEXT = 160;

export type NetworkTransport = "static" | "browser";
export type NetworkDecision = "allowed" | "deferred" | "shadow-would-defer";
export type PersistedNetworkOutcome = "success" | "deferred" | "failure" | "unknown";
export type EvidenceCoverage = "complete" | "bounded" | "unavailable";

export type NetworkAttemptOutcome = {
  domainKey: string | null;
  agent: string | null;
  stage: string | null;
  purpose: string | null;
  transport: NetworkTransport | null;
  governorMode: DomainGovernorMode | null;
  decision: NetworkDecision | null;
  decisionReason: string | null;
  circuitStateBefore: DomainCircuitState | null;
  circuitStateAfter: DomainCircuitState | null;
  httpStatus: number | null;
  retryAfterSource: string | null;
  retryAfterAt: string | null;
  leaseAcquired: boolean | null;
  leaseReleased: boolean | null;
  leaseExpired: boolean | null;
  mainDocumentRequests: number | null;
  firstPartySubrequests: number | null;
  thirdPartySubrequests: number | null;
  durationMs: number | null;
  durationBucket: string | null;
  persistedOutcome: PersistedNetworkOutcome;
  evidenceCoverage: EvidenceCoverage;
};

type JsonRecord = Record<string, unknown>;

type DomainGovernorRow = {
  domainKey: string;
  circuitState?: unknown;
  cooldownUntil?: Date | string | null;
  nextRequestAt?: Date | string | null;
  activeLeaseToken?: unknown;
  activeLeaseExpiresAt?: Date | string | null;
  lastHttpStatus?: unknown;
  lastSuccessAt?: Date | string | null;
  lastBlockedAt?: Date | string | null;
  lastDecision?: unknown;
  lastDecisionAt?: Date | string | null;
  consecutive429Count?: unknown;
  consecutive403Count?: unknown;
  updatedAt?: Date | string | null;
};

type RobotsRow = {
  domainKey: string;
  policyStatus?: unknown;
  fetchedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  httpStatus?: unknown;
  lastDecision?: unknown;
};

type ArtifactRow = {
  id: string;
  createdAt: Date | string;
  artifactType: string;
  status: string;
  payload: unknown;
};

export type GovernanceDiagnosticsDb = {
  domainRequestGovernor?: { findMany(args: Record<string, unknown>): Promise<DomainGovernorRow[]> };
  publisherRobotsPolicy?: { findMany(args: Record<string, unknown>): Promise<RobotsRow[]> };
  pipelineArtifact?: { findMany(args: Record<string, unknown>): Promise<ArtifactRow[]> };
};

export type GovernanceDiagnosticsQuery = {
  cursor?: string | null;
  limit?: number;
  now?: Date;
  scanCap?: number;
};

const FINAL_NETWORK_ARTIFACTS = [
  "article_enrichment_result",
  "article_enrichment_rejection",
  "agent1_target_outcome",
  "article_discovery_candidates",
  "article_discovery_deferred",
  "article_discovery_headless_required",
] as const;

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

const asDate = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const text = (value: unknown, max = GOVERNANCE_DIAGNOSTICS_MAX_TEXT): string | null =>
  boundText(typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : null, max);

const numberOrNull = (value: unknown, maximum = 1_000_000): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
};

const statusOrNull = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) return null;
  return value;
};

const normalizeStoredDomain = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return normalizeDomainKey(value.includes("://") ? value : `https://${value}`);
  } catch {
    return null;
  }
};

const domainFromValue = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 4_000) return null;
  return normalizeStoredDomain(value);
};

const circuitState = (value: unknown): DomainCircuitState | null =>
  value === "OPEN" || value === "HALF_OPEN" || value === "CLOSED" ? value : null;

const transportForStage = (stage: string): NetworkTransport =>
  stage === "agent2-headless" || stage === "agent3-browser" ? "browser" : "static";

const durationBucket = (value: number | null): string | null => {
  if (value === null) return null;
  if (value < 100) return "under_100ms";
  if (value < 1_000) return "100ms_1s";
  if (value < 5_000) return "1s_5s";
  if (value < 30_000) return "5s_30s";
  return "30s_plus";
};

const persistedOutcomeForStatus = (status: string): PersistedNetworkOutcome => {
  if (["CAPTURED", "PASS", "RSS_ACTIVE", "SKIPPED"].includes(status)) return "success";
  if (status.includes("DEFERRED") || status.includes("PENDING")) return "deferred";
  if (["FAILED", "INVALID"].includes(status)) return "failure";
  return "unknown";
};

const browserNavigationFrom = (payload: JsonRecord): JsonRecord | null => {
  const direct = asRecord(payload.browserNavigation);
  if (direct) return direct;
  const governor = asRecord(payload.browserGovernorEvidence);
  if (governor) return governor;
  const fallback = asRecord(payload.browserFallback);
  const diagnostics = asRecord(fallback?.browserDiagnostics);
  return asRecord(diagnostics?.navigation);
};

const domainFromPayload = (payload: JsonRecord, evidence: JsonRecord | null): string | null => {
  const evidenceDomain = normalizeStoredDomain(evidence?.domainKey);
  if (evidenceDomain) return evidenceDomain;
  for (const candidate of [payload.targetUrl, payload.sourceUrl, payload.feedUrl, payload.rssUrl]) {
    const domain = domainFromValue(candidate);
    if (domain) return domain;
  }
  return null;
};

/** Normalize only the bounded fields that are safe for diagnostics output. */
export function normalizeNetworkAttemptOutcome(
  raw: unknown,
  fallback: Partial<NetworkAttemptOutcome> = {},
): NetworkAttemptOutcome {
  const value = asRecord(raw) ?? {};
  const navigation = browserNavigationFrom(value);
  const status = statusOrNull(navigation?.mainDocumentStatus ?? value.httpStatus ?? value.statusCode);
  const decisionValue = navigation?.governorDecision ?? value.governorDecision ?? value.decision;
  const decision = decisionValue === "shadow-would-defer"
    ? "shadow-would-defer"
    : typeof decisionValue === "string" && (decisionValue.includes("defer") || decisionValue.includes("denied"))
      ? "deferred"
      : decisionValue
        ? "allowed"
        : (fallback.decision ?? null);
  const browser = Boolean(navigation);
  const duration = numberOrNull(value.durationMs ?? asRecord(value.timing)?.durationMs, 86_400_000);
  const persistedOutcome = fallback.persistedOutcome ?? persistedOutcomeForStatus(typeof value.status === "string" ? value.status : "UNKNOWN");
  const coverage: EvidenceCoverage = navigation || status !== null ? "bounded" : "unavailable";

  return {
    domainKey: normalizeStoredDomain(navigation?.domainKey ?? value.domainKey) ?? fallback.domainKey ?? null,
    agent: text(value.agent) ?? fallback.agent ?? null,
    stage: text(value.stage) ?? fallback.stage ?? null,
    purpose: text(value.purpose) ?? fallback.purpose ?? (browser ? "article_detail" : null),
    transport: browser ? "browser" : fallback.transport ?? (status !== null ? "static" : null),
    governorMode: value.governorMode === "shadow" || value.governorMode === "enforce" || value.governorMode === "off"
      ? value.governorMode
      : fallback.governorMode ?? null,
    decision: decision as NetworkDecision | null,
    decisionReason: text(navigation?.governorDecision ?? value.reason ?? value.deferredReason) ?? fallback.decisionReason ?? null,
    circuitStateBefore: circuitState(value.circuitStateBefore) ?? fallback.circuitStateBefore ?? null,
    circuitStateAfter: circuitState(value.circuitStateAfter) ?? fallback.circuitStateAfter ?? null,
    httpStatus: status ?? fallback.httpStatus ?? null,
    retryAfterSource: text(navigation?.retryAfterSource ?? value.retryAfterSource, 40) ?? fallback.retryAfterSource ?? null,
    retryAfterAt: text(navigation?.retryAfterAt ?? value.retryAfterAt, 40) ?? fallback.retryAfterAt ?? null,
    leaseAcquired: navigation ? (numberOrNull(navigation.mainDocumentRequests) ?? 0) > 0 : fallback.leaseAcquired ?? null,
    leaseReleased: fallback.leaseReleased ?? null,
    leaseExpired: fallback.leaseExpired ?? null,
    mainDocumentRequests: navigation ? numberOrNull(navigation.mainDocumentRequests) : fallback.mainDocumentRequests ?? null,
    firstPartySubrequests: navigation ? numberOrNull(navigation.firstPartySubrequests) : fallback.firstPartySubrequests ?? null,
    thirdPartySubrequests: navigation ? numberOrNull(navigation.thirdPartySubrequests) : fallback.thirdPartySubrequests ?? null,
    durationMs: duration ?? fallback.durationMs ?? null,
    durationBucket: durationBucket(duration ?? fallback.durationMs ?? null),
    persistedOutcome,
    evidenceCoverage: fallback.evidenceCoverage ?? coverage,
  };
}

type StageAggregate = {
  stage: string;
  transport: NetworkTransport;
  networkRequests: number;
  browserAttempts: number;
  rateLimited403: number;
  rateLimited429: number;
  timedOut: number;
  persistedOutcomes: number;
};

const emptyStage = (stage: string): StageAggregate => ({
  stage,
  transport: transportForStage(stage),
  networkRequests: 0,
  browserAttempts: 0,
  rateLimited403: 0,
  rateLimited429: 0,
  timedOut: 0,
  persistedOutcomes: 0,
});

const extractStageAggregate = (artifact: ArtifactRow): StageAggregate | null => {
  const payload = asRecord(artifact.payload);
  if (!payload || payload.artifactKind !== "stage_batch_telemetry") return null;
  const stage = typeof payload.stage === "string" ? payload.stage : null;
  if (!stage) return null;
  const result = emptyStage(stage);
  result.networkRequests = clampCount(numberOrNull(payload.networkRequests) ?? 0);
  result.browserAttempts = clampCount(numberOrNull(payload.browserAttempts) ?? 0);
  result.rateLimited403 = clampCount(numberOrNull(payload.rateLimited403) ?? 0);
  result.rateLimited429 = clampCount(numberOrNull(payload.rateLimited429) ?? 0);
  result.timedOut = clampCount(numberOrNull(payload.timedOut) ?? 0);
  result.persistedOutcomes = clampCount(numberOrNull(payload.succeeded) ?? 0);
  return result;
};

const mergeStage = (map: Map<string, StageAggregate>, row: StageAggregate): void => {
  const key = `${row.stage}:${row.transport}`;
  const current = map.get(key) ?? emptyStage(row.stage);
  current.networkRequests = clampCount(current.networkRequests + row.networkRequests);
  current.browserAttempts = clampCount(current.browserAttempts + row.browserAttempts);
  current.rateLimited403 = clampCount(current.rateLimited403 + row.rateLimited403);
  current.rateLimited429 = clampCount(current.rateLimited429 + row.rateLimited429);
  current.timedOut = clampCount(current.timedOut + row.timedOut);
  current.persistedOutcomes = clampCount(current.persistedOutcomes + row.persistedOutcomes);
  map.set(key, current);
};

const parseLimit = (value: number | undefined, fallback: number, maximum: number): number =>
  Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value as number))) : fallback;

export const encodeGovernanceCursor = (domainKey: string): string =>
  Buffer.from(JSON.stringify({ domainKey }), "utf8").toString("base64url");

export const decodeGovernanceCursor = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as JsonRecord;
    return normalizeStoredDomain(parsed.domainKey);
  } catch {
    return null;
  }
};

const stateView = (row: DomainGovernorRow, now: Date) => {
  const expiry = asDate(row.activeLeaseExpiresAt);
  const hasToken = typeof row.activeLeaseToken === "string" && row.activeLeaseToken.length > 0;
  const leaseState = hasToken && expiry
    ? expiry > now ? "active" : "expired"
    : "none";
  const cooldown = asDate(row.cooldownUntil);
  const nextRequest = asDate(row.nextRequestAt);
  const nextProbeAt = [cooldown, nextRequest]
    .filter((date): date is Date => date !== null && date > now)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const circuit = circuitState(row.circuitState) ?? "CLOSED";
  const lastDecision = text(row.lastDecision, 80);
  return {
    domainKey: normalizeStoredDomain(row.domainKey) ?? "unknown",
    circuitState: circuit,
    // "forbidden" reads as "publisher likely blocks the configured crawler
    // identity" in any admin surface — never a paywall or malicious-behavior
    // claim; that classification is owned by article-access-classification.ts.
    circuitReason: lastDecision ?? (
      row.lastHttpStatus === 429 ? "rate_limited" : row.lastHttpStatus === 403 ? "forbidden" : null
    ),
    nextProbeAt,
    lease: { state: leaseState, expiresAt: expiry },
    consecutive429Count: clampCount(numberOrNull(row.consecutive429Count) ?? 0),
    consecutive403Count: clampCount(numberOrNull(row.consecutive403Count) ?? 0),
    lastHttpStatus: statusOrNull(row.lastHttpStatus),
    lastSuccessAt: asDate(row.lastSuccessAt),
    lastBlockedAt: asDate(row.lastBlockedAt),
    lastDecision,
    lastDecisionAt: asDate(row.lastDecisionAt),
    updatedAt: asDate(row.updatedAt),
    evidenceCoverage: "complete" as const,
  };
};

const robotsView = (row: RobotsRow | undefined, now: Date) => row ? {
  status: text(row.policyStatus, 40) ?? "unknown",
  fetchedAt: asDate(row.fetchedAt),
  expiresAt: asDate(row.expiresAt),
  cacheFresh: Boolean(asDate(row.expiresAt) && (asDate(row.expiresAt) as Date).getTime() > now.getTime()),
  httpStatus: statusOrNull(row.httpStatus),
  lastDecision: text(row.lastDecision, 80),
  evidenceCoverage: "complete" as const,
} : null;

export async function loadGovernanceDiagnostics(
  db: GovernanceDiagnosticsDb,
  query: GovernanceDiagnosticsQuery = {},
) {
  const now = query.now ?? new Date();
  const limit = parseLimit(query.limit, GOVERNANCE_DIAGNOSTICS_DEFAULT_LIMIT, GOVERNANCE_DIAGNOSTICS_MAX_LIMIT);
  const scanCap = parseLimit(query.scanCap, GOVERNANCE_DIAGNOSTICS_MAX_ARTIFACT_SCAN, GOVERNANCE_DIAGNOSTICS_MAX_ARTIFACT_SCAN);
  const cursor = query.cursor ? decodeGovernanceCursor(query.cursor) : null;
  if (query.cursor && !cursor) throw new Error("Invalid governance diagnostics cursor.");

  const governorRows = db.domainRequestGovernor
    ? await db.domainRequestGovernor.findMany({
      ...(cursor ? { where: { domainKey: { gt: cursor } } } : {}),
      orderBy: { domainKey: "asc" },
      take: limit + 1,
      select: {
        domainKey: true, circuitState: true, cooldownUntil: true, nextRequestAt: true,
        activeLeaseToken: true, activeLeaseExpiresAt: true, lastHttpStatus: true,
        lastSuccessAt: true, lastBlockedAt: true, lastDecision: true, lastDecisionAt: true,
        consecutive429Count: true, consecutive403Count: true, updatedAt: true,
      },
    })
    : [];
  const pageTruncated = governorRows.length > limit;
  const pageRows = governorRows.slice(0, limit);
  const domainKeys = pageRows.map((row) => normalizeStoredDomain(row.domainKey)).filter((key): key is string => key !== null);

  const robotsRows = db.publisherRobotsPolicy && domainKeys.length > 0
    ? await db.publisherRobotsPolicy.findMany({
      where: { domainKey: { in: domainKeys } },
      select: { domainKey: true, policyStatus: true, fetchedAt: true, expiresAt: true, httpStatus: true, lastDecision: true },
    })
    : [];
  const robotsByDomain = new Map(robotsRows.map((row) => [normalizeStoredDomain(row.domainKey), row]));

  const artifactRows = db.pipelineArtifact
    ? await db.pipelineArtifact.findMany({
      where: { artifactType: { in: [...FINAL_NETWORK_ARTIFACTS, "stage_batch_telemetry"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: scanCap + 1,
      select: { id: true, createdAt: true, artifactType: true, status: true, payload: true },
    })
    : [];
  const artifactTruncated = artifactRows.length > scanCap;
  const scannedArtifacts = artifactRows.slice(0, scanCap);
  const stageMap = new Map<string, StageAggregate>();
  const networkOutcomes: NetworkAttemptOutcome[] = [];
  let feedFirstSkipped = 0;
  let robotsSkipped = 0;
  let shadowWouldDefer = 0;

  for (const artifact of scannedArtifacts) {
    const stage = extractStageAggregate(artifact);
    if (stage) {
      mergeStage(stageMap, stage);
      continue;
    }
    const payload = asRecord(artifact.payload);
    if (!payload) continue;
    const navigation = browserNavigationFrom(payload);
    const outcome = normalizeNetworkAttemptOutcome({
      ...payload,
      ...(navigation ?? {}),
      status: artifact.status,
      domainKey: domainFromPayload(payload, navigation),
      decision: artifact.status.includes("DEFERRED") || artifact.status.includes("PENDING") || payload.governorDeferred === true
        ? "deferred"
        : undefined,
      reason: payload.deferredReason ?? payload.detailEvaluationStoppedReason,
      persistedOutcome: persistedOutcomeForStatus(artifact.status),
      agent: artifact.artifactType.startsWith("agent1")
        ? "agent1"
        : artifact.artifactType.includes("discovery")
          ? "agent2"
          : "agent3",
      stage: artifact.artifactType.includes("headless") ? "agent2-headless" : artifact.artifactType.includes("discovery") ? "agent2-static" : artifact.artifactType.startsWith("agent1") ? "agent1" : "agent3",
      purpose: navigation ? "article_detail" : artifact.artifactType.includes("discovery") ? "listing" : "feed",
      transport: navigation ? "browser" : "static",
      evidenceCoverage: navigation || payload.rateLimitEvidence ? "bounded" : "unavailable",
    });
    networkOutcomes.push(outcome);
    if (artifact.status === "ARTICLE_DISCOVERY_HEADLESS_FEED_FIRST_SKIPPED" || /feed.?first/i.test(String(payload.reason ?? payload.status ?? ""))) feedFirstSkipped++;
    if (outcome.decision === "shadow-would-defer") shadowWouldDefer++;
    if (outcome.decisionReason?.startsWith("robots_") || navigation?.robotsDecision === "disallowed" || navigation?.robotsDecision === "deferred") robotsSkipped++;
  }

  const stageSummary = [...stageMap.values()].sort((a, b) => `${a.stage}:${a.transport}`.localeCompare(`${b.stage}:${b.transport}`));
  const browser = networkOutcomes.filter((item) => item.transport === "browser");
  const actualNetworkRequests = stageSummary.reduce((sum, item) => sum + item.networkRequests, 0);
  const actualBrowserAttempts = stageSummary.reduce((sum, item) => sum + item.browserAttempts, 0);
  const rateLimited403 = stageSummary.reduce((sum, item) => sum + item.rateLimited403, 0);
  const rateLimited429 = stageSummary.reduce((sum, item) => sum + item.rateLimited429, 0);
  const timedOut = stageSummary.reduce((sum, item) => sum + item.timedOut, 0);
  const mainDocumentRequests = browser.reduce((sum, item) => sum + (item.mainDocumentRequests ?? 0), 0);
  const firstPartySubrequests = browser.reduce((sum, item) => sum + (item.firstPartySubrequests ?? 0), 0);
  const thirdPartySubrequests = browser.reduce((sum, item) => sum + (item.thirdPartySubrequests ?? 0), 0);
  const currentShadowWouldDeferDomains = pageRows.filter((row) => row.lastDecision === "shadow-would-defer").length;

  return {
    ok: true,
    generatedAt: now,
    domains: pageRows.map((row) => {
      const view = stateView(row, now);
      return { ...view, robots: robotsView(robotsByDomain.get(view.domainKey), now) };
    }),
    network: {
      stageTransport: stageSummary,
      actualWork: { networkRequests: actualNetworkRequests, browserAttempts: actualBrowserAttempts },
      persistedOutcomes: networkOutcomes.length,
      rateLimited: { http403: rateLimited403, http429: rateLimited429 },
      timedOut,
      shadowWouldDefer,
      currentShadowWouldDeferDomains,
      browserAmplification: {
        mainDocumentRequests,
        firstPartySubrequests,
        thirdPartySubrequests,
        requestsPerMainDocument: mainDocumentRequests > 0
          ? Number(((firstPartySubrequests + thirdPartySubrequests) / mainDocumentRequests).toFixed(2))
          : null,
      },
      policySkips: { feedFirst: feedFirstSkipped, robots: robotsSkipped },
      outcomes: networkOutcomes.slice(0, GOVERNANCE_DIAGNOSTICS_MAX_LIMIT),
    },
    evidence: {
      domainState: db.domainRequestGovernor ? "complete" : "unavailable",
      robotsCache: db.publisherRobotsPolicy ? "complete" : "unavailable",
      networkOutcomes: db.pipelineArtifact ? (artifactTruncated ? "bounded" : "complete") : "unavailable",
      scannedArtifacts: scannedArtifacts.length,
      scanCap,
      truncated: artifactTruncated,
      unavailableReasons: [
        ...(db.pipelineArtifact ? [] : ["pipeline_artifacts_unavailable"]),
        ...(networkOutcomes.some((outcome) => outcome.evidenceCoverage === "unavailable") ? ["some_legacy_artifacts_lack_network_evidence"] : []),
      ],
    },
    pagination: {
      limit,
      totalReturned: pageRows.length,
      truncated: pageTruncated,
      nextCursor: pageTruncated && pageRows.length > 0
        ? encodeGovernanceCursor(normalizeStoredDomain(pageRows[pageRows.length - 1]!.domainKey) ?? "")
        : null,
    },
  };
}
