import { Prisma } from "@prisma/client";
import { isEffectivelyPublishableArticle, getTerminalPublicationStage } from "./news-pipeline/publication-gate";
import { classifyAgent2TargetLifecycle, isAgent2TargetActionable, type Agent2LifecycleState } from "./news-pipeline/agent2-target-lifecycle";

export const ADMIN_INSPECTION_DEFAULT_LIMIT = 50;
export const ADMIN_INSPECTION_MAX_LIMIT = 100;
export const ADMIN_INSPECTION_MAX_TARGETS = 25;
export const ADMIN_INSPECTION_MAX_DATE_RANGE_DAYS = 90;
export const ADMIN_INSPECTION_ARTIFACT_SCAN_CAP = 5_000;
export const ADMIN_INSPECTION_ARTICLE_SCAN_CAP = 2_000;
export const ADMIN_INSPECTION_REASON_LIMIT = 240;
export const ADMIN_INSPECTION_PREVIEW_LIMIT = 320;
export const ADMIN_INSPECTION_BODY_PREFIX_LIMIT = 520;

export const ADMIN_INSPECTION_FLAGS = [
  "NO_ARTICLES_GENERATED", "DISCOVERED_NOT_ENRICHED", "ENRICHED_NOT_PUBLISHED",
  "HIGH_REJECTION_RATE", "RETRY_BACKLOG", "RSS_UNPRODUCTIVE",
  "BROWSER_FALLBACK_REQUIRED", "RECENTLY_PRODUCTIVE",
] as const;
export type AdminInspectionFlag = (typeof ADMIN_INSPECTION_FLAGS)[number];
export type AdminArticleState = "PUBLISHED" | "PENDING" | "DEFERRED" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" | "REJECTED";
export type AdminInspectionTargetType = "SOURCE" | "CATEGORY";
export type AdminPipelineStage = "AGENT1" | "AGENT2" | "AGENT3" | "TERMINAL" | "UNKNOWN";
export type InspectionActivityState = "ACTIVE_AND_PRODUCTIVE" | "ACTIVE_UNPRODUCTIVE" | "ACTIVE_DEFERRED" | "ACTIVE_BROWSER_REQUIRED" | "INACTIVE" | "FAILED" | "DOMAIN_DEAD";

export type AdminInspectionStats = {
  totalArticlesInWindow: number; publishedArticlesInWindow: number; pendingArticlesInWindow: number;
  deferredArticlesInWindow: number; rejectedArticlesInWindow: number; permanentFailuresInWindow: number;
  retryableFailuresInWindow: number; agent1ProductivityCount: number; agent2DiscoveredCount: number;
  agent3ProcessedCount: number; agent3EnrichedCount: number; agent3PublishedCount: number;
  agent3RejectedCount: number; deferredCount: number; retryableFailureCount: number;
  permanentFailureCount: number; browserFallbackUsageCount: number;
  latestArticleCreatedAt: Date | null; latestPublishedArticleAt: Date | null;
  latestFailureReason: string | null; diagnosticFlags: AdminInspectionFlag[]; diagnosticsTruncated: boolean;
  metricsApproximate: boolean; metricAccuracy: "EXACT" | "APPROXIMATE";
  approximateMetrics: string[]; artifactOnlyEvents: number; scannedArticles: number; scannedArtifacts: number;
};

export const emptyInspectionStats = (): AdminInspectionStats => ({
  totalArticlesInWindow: 0, publishedArticlesInWindow: 0, pendingArticlesInWindow: 0,
  deferredArticlesInWindow: 0, rejectedArticlesInWindow: 0, permanentFailuresInWindow: 0,
  retryableFailuresInWindow: 0, agent1ProductivityCount: 0, agent2DiscoveredCount: 0,
  agent3ProcessedCount: 0, agent3EnrichedCount: 0, agent3PublishedCount: 0,
  agent3RejectedCount: 0, deferredCount: 0, retryableFailureCount: 0, permanentFailureCount: 0,
  browserFallbackUsageCount: 0, latestArticleCreatedAt: null, latestPublishedArticleAt: null,
  latestFailureReason: null, diagnosticFlags: [], diagnosticsTruncated: false, metricsApproximate: false,
  metricAccuracy: "EXACT", approximateMetrics: [], artifactOnlyEvents: 0, scannedArticles: 0, scannedArtifacts: 0,
});

const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const boundedString = (value: unknown, max = ADMIN_INSPECTION_REASON_LIMIT): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : null;
};
export const boundInspectionText = boundedString;

/** Strip credentials, query values, fragments, and non-web protocols. */
export const safeInspectionUrl = (value: unknown, base?: string): string | null => {
  if (typeof value !== "string" || value.length > 4_000) return null;
  try {
    const parsed = new URL(value, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = "";
    return parsed.toString();
  } catch { return null; }
};
export const hostnameFromUrl = (value: unknown): string | null => {
  const safe = safeInspectionUrl(value);
  if (!safe) return null;
  try { return new URL(safe).hostname.replace(/^www\./i, "").toLowerCase().slice(0, 255) || null; } catch { return null; }
};

export type BodyReadinessEvidence = { id: number; bodyPresent: boolean; bodyLength: number; bodyPrefix: string | null };

export type AdminInspectionEvidenceRow = {
  id: string;
  createdAt: Date;
  artifactType: string;
  status: string;
  articleId: string | null;
  kind: string | null;
  rejectionCode: string | null;
  rejectionDetail: string | null;
  retryAfterAt: string | null;
  browserAttempted: string | null;
  browserSucceeded: string | null;
  retryDisposition: string | null;
  failureReason: string | null;
  errorLog: string | null;
};

/**
 * Fetch only bounded body evidence. The SQL is fully parameterized; the prefix
 * is sufficient to prove the minimum length without loading Article.bodyText.
 */
export async function loadBodyReadinessEvidence(
  client: { $queryRaw: (...args: any[]) => Promise<unknown[]> },
  ids: number[],
): Promise<Map<number, BodyReadinessEvidence>> {
  const result = new Map<number, BodyReadinessEvidence>();
  const uniqueIds = [...new Set(ids.filter((id) => Number.isSafeInteger(id)))];
  if (uniqueIds.length === 0) return result;
  if (typeof client.$queryRaw !== "function") return result;
  const rows = await client.$queryRaw(Prisma.sql`
    SELECT "id",
           ("bodyText" IS NOT NULL) AS "bodyPresent",
           COALESCE(length(regexp_replace(COALESCE("bodyText", ''), '^[[:space:]]+|[[:space:]]+$', '', 'g')), 0)::int AS "bodyLength",
           CASE WHEN "bodyText" IS NULL THEN NULL ELSE left("bodyText", ${ADMIN_INSPECTION_BODY_PREFIX_LIMIT}) END AS "bodyPrefix"
    FROM "Article"
    WHERE "id" IN (${Prisma.join(uniqueIds)})
  `);
  for (const rawRow of rows) {
    const row = asRecord(rawRow);
    if (!row) continue;
    const id = typeof row.id === "number" ? row.id : typeof row.id === "bigint" ? Number(row.id) : typeof row.id === "string" ? Number(row.id) : NaN;
    const bodyLength = typeof row.bodyLength === "number" ? row.bodyLength : typeof row.bodyLength === "bigint" ? Number(row.bodyLength) : typeof row.bodyLength === "string" ? Number(row.bodyLength) : 0;
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(bodyLength)) continue;
    result.set(id, {
      id,
      bodyPresent: row.bodyPresent === true || row.bodyPresent === "true" || row.bodyPresent === 1,
      bodyLength: Math.max(0, bodyLength),
      bodyPrefix: typeof row.bodyPrefix === "string" ? row.bodyPrefix : null,
    });
  }
  return result;
}

/**
 * Load bounded, article-specific artifact evidence in one parameterized query.
 * The per-article window prevents noisy source history from evicting evidence
 * for another article in the same scan batch.
 */
export async function loadArticleInspectionEvidenceForArticles(
  client: { $queryRaw: <T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => Promise<T> },
  articleIds: number[],
  perArticleLimit = 20,
): Promise<AdminInspectionEvidenceRow[]> {
  const uniqueIds = [...new Set(articleIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (uniqueIds.length === 0) return [];
  const boundedPerArticleLimit = Math.min(50, Math.max(1, Math.floor(perArticleLimit)));
  return client.$queryRaw<AdminInspectionEvidenceRow[]>(Prisma.sql`
    WITH ranked AS (
      SELECT "id", "createdAt", "artifactType", "status",
             "payload"->>'articleId' AS "articleId",
             "payload"->>'kind' AS "kind",
             COALESCE("payload"->'rejection'->>'code', "payload"->>'rejectionCode') AS "rejectionCode",
             "payload"->>'rejectionDetail' AS "rejectionDetail",
             COALESCE("payload"->>'retryAfterAt', "payload"->'rejection'->>'retryAfterAt') AS "retryAfterAt",
             "payload"->'browserFallback'->>'attempted' AS "browserAttempted",
             "payload"->'browserFallback'->>'succeeded' AS "browserSucceeded",
             "payload"->'retryDiagnostics'->>'disposition' AS "retryDisposition",
             left(COALESCE("payload"->>'failureReason', "payload"->>'error', "payload"->>'lastError', ''), 240) AS "failureReason",
             left(COALESCE("errorLog", ''), 240) AS "errorLog",
             row_number() OVER (
               PARTITION BY CASE
                 WHEN ("payload"->>'articleId') ~ '^[0-9]{1,10}$'
                   AND ("payload"->>'articleId')::numeric BETWEEN 1 AND 2147483647
                 THEN ("payload"->>'articleId')::bigint
               END
               ORDER BY "createdAt" DESC, "id" DESC
             ) AS "rowNumber"
      FROM "PipelineArtifact"
      WHERE jsonb_typeof("payload"->'articleId') = 'number'
        AND ("payload"->>'articleId') ~ '^[0-9]{1,10}$'
        AND ("payload"->>'articleId')::numeric BETWEEN 1 AND 2147483647
        AND ("payload"->>'articleId')::bigint IN (${Prisma.join(uniqueIds)})
    )
    SELECT "id", "createdAt", "artifactType", "status", "articleId", "kind",
           "rejectionCode", "rejectionDetail", "retryAfterAt", "browserAttempted",
           "browserSucceeded", "retryDisposition", "failureReason", "errorLog"
    FROM ranked
    WHERE "rowNumber" <= ${boundedPerArticleLimit}
    ORDER BY "createdAt" DESC, "id" DESC
  `);
}

export async function loadArticleInspectionEvidence(
  client: { $queryRaw: <T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => Promise<T> },
  articleId: number,
  limit = 500,
): Promise<AdminInspectionEvidenceRow[]> {
  return loadArticleInspectionEvidenceForArticles(client, [articleId], Math.min(50, limit));
}

export const normalizeBodyPreview = (value: unknown, max = ADMIN_INSPECTION_PREVIEW_LIMIT): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : null;
};
export const clampInspectionLimit = (value: unknown): number => {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(parsed) ? Math.min(ADMIN_INSPECTION_MAX_LIMIT, Math.max(1, parsed)) : ADMIN_INSPECTION_DEFAULT_LIMIT;
};
export const parseInspectionDate = (value: unknown): Date | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date : null;
};
export const validateInspectionDateRange = (input: { dateFrom?: unknown; dateTo?: unknown; now?: Date }): string | null => {
  const now = input.now ?? new Date();
  const from = input.dateFrom === undefined ? null : parseInspectionDate(input.dateFrom);
  const to = input.dateTo === undefined ? null : parseInspectionDate(input.dateTo);
  if (input.dateFrom !== undefined && !from) return "Invalid dateFrom.";
  if (input.dateTo !== undefined && !to) return "Invalid dateTo.";
  if (to && to > now) return "dateTo cannot be in the future.";
  if (from && to && from > to) return "dateFrom must not be after dateTo.";
  if (from && to && to.getTime() - from.getTime() > ADMIN_INSPECTION_MAX_DATE_RANGE_DAYS * 86400000) return "The date range cannot exceed 90 days.";
  return null;
};

export const normalizeInspectionDateRange = (input: { dateFrom?: unknown; dateTo?: unknown; now?: Date }): { dateFrom: Date; dateTo: Date; days: number } => {
  const now = input.now ?? new Date();
  const requestedTo = parseInspectionDate(input.dateTo) ?? now;
  const requestedFrom = parseInspectionDate(input.dateFrom) ?? new Date(requestedTo.getTime() - 7 * 86400000);
  const dateTo = requestedTo < now ? requestedTo : now;
  const maximumFrom = new Date(dateTo.getTime() - ADMIN_INSPECTION_MAX_DATE_RANGE_DAYS * 86400000);
  const dateFrom = requestedFrom < maximumFrom ? maximumFrom : requestedFrom;
  const safeFrom = dateFrom <= dateTo ? dateFrom : new Date(dateTo.getTime() - 86400000);
  return { dateFrom: safeFrom, dateTo, days: Math.max(1, Math.ceil((dateTo.getTime() - safeFrom.getTime()) / 86400000)) };
};

/** Stable, non-secret description of the exact metric contract exposed by inspection. */
export const INSPECTION_METRIC_RULE = "Article lifecycle metrics count unique Article IDs; source targets include categorized articles, category targets include only that category; artifact-only events are separate and never added to exact article totals.";

/**
 * Database-representable portion of the shared all-active predicate. The source
 * endpoint applies the complete lifecycle adapter; article all-active mode uses
 * this same durable ownership/system/deferred/productive subset rather than the
 * unsafe `rssStatus != FAILED` shortcut. Artifact-derived recovery is added by
 * the source summary and remains bounded there.
 */
export const buildInspectionAllActiveArticleWhere = (targetType: "ALL" | "SOURCE" | "CATEGORY") => {
  const sourceActive = {
    OR: [
      { isSystemImported: true },
      { currentFeedProductive: true },
      { nextRetryAt: { gt: new Date() } },
      { subscribers: { some: { isActive: true } } },
      { categories: { some: { subscribers: { some: { isActive: true } } } } },
    ],
    rssStatus: { notIn: ["FAILED", "DOMAIN_DEAD"] },
  };
  const categoryActive = {
    OR: [
      { currentFeedProductive: true },
      { nextRetryAt: { gt: new Date() } },
      { subscribers: { some: { isActive: true } } },
    ],
    rssStatus: { notIn: ["FAILED", "DOMAIN_DEAD"] },
    newsSource: sourceActive,
  };
  if (targetType === "SOURCE") return { source: sourceActive };
  if (targetType === "CATEGORY") return { category: categoryActive };
  // SOURCE ownership includes categorized articles by contract. The combined
  // all-active view therefore uses the same source-owned article universe and
  // additionally admits explicitly active category targets.
  return { OR: [{ source: sourceActive }, { category: categoryActive }] };
};

export const normalizeInspectionSearch = (value: unknown): string | null => typeof value === "string" ? boundedString(value, 120) : null;
export type InspectionAccessDiagnostics = {
  classification: string | null;
  detectorVersion: string | null;
  confidence: string | null;
  sourceStage: string | null;
  evidenceCodes: string[];
  contradictingEvidenceCodes: string[];
  fullBodyExtracted: boolean | null;
  articleScopedGate: boolean | null;
  previousIsPaywall: boolean | null;
  finalIsPaywall: boolean | null;
  earlyStageClassification: string | null;
  earlyStageSource: string | null;
  earlyStageEvidenceCodes: string[];
  earlyStageContradictingEvidenceCodes: string[];
  overrideReason: string | null;
};

const readAccessDiagnostics = (value: unknown): InspectionAccessDiagnostics => {
  const raw = asRecord(value);
  const access = asRecord(raw?.access);
  const evidenceCodes = Array.isArray(access?.evidenceCodes)
    ? access.evidenceCodes.filter((code): code is string => typeof code === "string").slice(0, 12)
    : [];
  const contradictingEvidenceCodes = Array.isArray(access?.contradictingEvidenceCodes)
    ? access.contradictingEvidenceCodes.filter((code): code is string => typeof code === "string").slice(0, 12)
    : [];
  return {
    classification: typeof access?.classification === "string" ? access.classification : null,
    detectorVersion: typeof access?.detectorVersion === "string" ? access.detectorVersion : null,
    confidence: typeof access?.confidence === "string" ? access.confidence : null,
    sourceStage: typeof access?.sourceStage === "string" ? access.sourceStage : null,
    evidenceCodes,
    contradictingEvidenceCodes,
    fullBodyExtracted: typeof access?.usableBodyExtracted === "boolean" ? access.usableBodyExtracted : null,
    articleScopedGate: typeof access?.articleScopedGateOrOverlayDetected === "boolean" ? access.articleScopedGateOrOverlayDetected : null,
    previousIsPaywall: typeof access?.previousIsPaywall === "boolean" ? access.previousIsPaywall : null,
    finalIsPaywall: typeof access?.finalIsPaywall === "boolean" ? access.finalIsPaywall : null,
    earlyStageClassification: typeof access?.earlyStageClassification === "string" ? access.earlyStageClassification : null,
    earlyStageSource: typeof access?.earlyStageSource === "string" ? access.earlyStageSource : null,
    earlyStageEvidenceCodes: Array.isArray(access?.earlyStageEvidenceCodes)
      ? access.earlyStageEvidenceCodes.filter((code): code is string => typeof code === "string").slice(0, 12)
      : [],
    earlyStageContradictingEvidenceCodes: Array.isArray(access?.earlyStageContradictingEvidenceCodes)
      ? access.earlyStageContradictingEvidenceCodes.filter((code): code is string => typeof code === "string").slice(0, 12)
      : [],
    overrideReason: boundedString(access?.overrideReason, 240),
  };
};

export type InspectionOutcomeSummary = {
  kind: string | null;
  rejectionCode: string | null;
  retryAfterAt: string | null;
  browserFallback: Record<string, unknown> | null;
  retryDiagnostics: Record<string, unknown> | null;
  access: InspectionAccessDiagnostics;
};

export const emptyInspectionAccessDiagnostics = (): InspectionAccessDiagnostics => ({
  classification: null,
  detectorVersion: null,
  confidence: null,
  sourceStage: null,
  evidenceCodes: [],
  contradictingEvidenceCodes: [],
  fullBodyExtracted: null,
  articleScopedGate: null,
  previousIsPaywall: null,
  finalIsPaywall: null,
  earlyStageClassification: null,
  earlyStageSource: null,
  earlyStageEvidenceCodes: [],
  earlyStageContradictingEvidenceCodes: [],
  overrideReason: null,
});
export const readInspectionOutcomeSummary = (value: unknown): InspectionOutcomeSummary => {
  const raw = asRecord(value);
  return {
    kind: typeof raw?.kind === "string" ? raw.kind : null,
    rejectionCode: typeof raw?.rejectionCode === "string" ? raw.rejectionCode : null,
    retryAfterAt: typeof raw?.retryAfterAt === "string" ? raw.retryAfterAt : null,
    browserFallback: asRecord(raw?.browserFallback),
    retryDiagnostics: asRecord(raw?.retryDiagnostics),
    access: readAccessDiagnostics(value),
  };
};
const isRetryableSummary = (summary: InspectionOutcomeSummary) => summary.kind === "RETRYABLE_FAILURE" || summary.retryDiagnostics?.disposition === "READY_RETRY" || (summary.retryAfterAt ? Date.parse(summary.retryAfterAt) > Date.now() : false);
const isDeferredSummary = (summary: InspectionOutcomeSummary) => summary.kind === "HEADLESS_REQUIRED" || summary.retryDiagnostics?.disposition === "DEFERRED";
// INTERSTITIAL_OR_CHALLENGE is intentionally NOT a rejected summary: only the
// durable publicationStatus (REJECTED for quarantined interstitials, PROCESSING
// while browser recovery is still possible) decides its state. Deferred/ready-
// retry interstitials are classified below via retryDiagnostics.
const isRejectedSummary = (summary: InspectionOutcomeSummary) => ["PAYWALL_BLOCKED", "CANONICAL_MISMATCH", "LOW_CONTENT_QUALITY", "UNSUPPORTED_STRUCTURE", "HTTP_ACCESS_BLOCKED"].includes(summary.kind || "") || ["PAYWALL_BLOCKED", "CANONICAL_MISMATCH", "LOW_CONTENT_QUALITY", "UNSUPPORTED_STRUCTURE", "HTTP_ACCESS_BLOCKED"].includes(summary.rejectionCode || "");

/** PUBLISHED always validates the actual durable body; omitted body is never publishable. */
export const classifyInspectionArticleState = (article: {
  title?: string | null; canonicalUrl?: string | null; bodyText?: string | null; bodyLength?: number | null;
  publicationStatus: string; publicationStage?: string | null; publicationReadyAt?: Date | null;
  enrichmentStatus?: string | null; enrichmentOutcome?: unknown;
}, summaryOverride?: InspectionOutcomeSummary | null): AdminArticleState => {
  const summary = summaryOverride ?? readInspectionOutcomeSummary(article.enrichmentOutcome);
  const bodyIsUsable = typeof article.bodyLength === "number"
    ? article.bodyLength >= 500
    : isEffectivelyPublishableArticle({ title: article.title ?? null, canonicalUrl: article.canonicalUrl ?? null, bodyText: article.bodyText ?? null });
  if (article.publicationStatus === "PUBLISHED" && article.publicationStage === getTerminalPublicationStage() && article.publicationReadyAt && article.enrichmentStatus === "ENRICHED" && Boolean(article.title?.trim()) && Boolean(article.canonicalUrl?.trim()) && bodyIsUsable) return "PUBLISHED";
  if (article.publicationStatus === "REJECTED" || isRejectedSummary(summary)) return "REJECTED";
  if (isDeferredSummary(summary) || article.enrichmentStatus === "ENRICHMENT_QUEUED_HEADLESS") return "DEFERRED";
  if (isRetryableSummary(summary)) return "RETRYABLE_FAILURE";
  if (article.enrichmentStatus === "ENRICHMENT_FAILED") return "PERMANENT_FAILURE";
  return "PENDING";
};

export const getInspectionPipelineStage = (article: { publicationStatus?: string; publicationStage?: string | null; enrichmentStatus?: string | null; processingStage?: string | null; processingStatus?: string | null }, evidenceTypes: string[] = []): AdminPipelineStage => {
  if (article.publicationStatus === "PUBLISHED" && article.publicationStage === getTerminalPublicationStage()) return "TERMINAL";
  if (article.enrichmentStatus && ["ENRICHED", "ENRICHING", "ENRICHMENT_FAILED", "ENRICHMENT_QUEUED_HEADLESS", "ENRICHMENT_SKIPPED"].includes(article.enrichmentStatus)) return "AGENT3";
  if (evidenceTypes.some((type) => type.startsWith("article_enrichment_") || type === "article_headless_queue_candidate")) return "AGENT3";
  if (evidenceTypes.some((type) => type === "article_discovery_candidates" || type === "article_discovery_headless_required" || type === "article_discovery_attempt")) return "AGENT2";
  if (article.processingStage && /agent2|discov|headless/i.test(article.processingStage)) return "AGENT2";
  if (article.processingStage || article.processingStatus) return "AGENT1";
  return "UNKNOWN";
};

export const inspectionStateMatches = (state: AdminArticleState, requested: string | null): boolean => !requested || requested === "ALL" || state === requested;
export const inspectionStageMatches = (stage: AdminPipelineStage, requested: string | null): boolean => !requested || requested === "ALL" || stage === requested;

export type InspectionActiveReason = "ACTIVE_SUBSCRIBER" | "SYSTEM_TARGET" | "DEFERRED_RETRY" | "ACTIVE_RECOVERY" | "NONE";
export type InspectionTargetLifecycleInput = {
  rssStatus: string;
  currentFeedProductive: boolean;
  /** Canonical activity evidence, computed from durable ownership/targeting state. */
  active: boolean;
  activeReason?: InspectionActiveReason;
  nextRetryAt?: Date | null;
  lifecycle?: Agent2LifecycleState | null;
};

/**
 * Map canonical activity evidence into the compact inspection state vocabulary.
 * The endpoint must calculate `active` from durable ownership/target evidence;
 * this function deliberately does not treat a merely non-terminal RSS status as
 * active.
 */
export const resolveInspectionActivity = (input: InspectionTargetLifecycleInput): InspectionActivityState => {
  if (input.rssStatus === "DOMAIN_DEAD") return "DOMAIN_DEAD";
  if (input.rssStatus === "FAILED") return "FAILED";
  if (!input.active) return "INACTIVE";
  if (input.nextRetryAt && input.nextRetryAt > new Date()) return "ACTIVE_DEFERRED";
  if (input.lifecycle && ["browser_pending", "browser_failed_retryable", "browser_failed_terminal"].includes(input.lifecycle)) return "ACTIVE_BROWSER_REQUIRED";
  if (input.currentFeedProductive || input.lifecycle === "rss_owned" || input.lifecycle === "resolved" || input.lifecycle === "static_productive" || input.lifecycle === "browser_productive" || input.lifecycle === "profile_active") return "ACTIVE_AND_PRODUCTIVE";
  return "ACTIVE_UNPRODUCTIVE";
};

export type InspectionLifecycleArtifact = {
  id?: string;
  createdAt?: Date | string | null;
  sourceId?: string | null;
  categoryId?: string | null;
  artifactType: string;
  status: string;
  payload: unknown;
};

export type InspectionLifecycleTarget = {
  rssStatus: string;
  currentFeedProductive: boolean;
};

/**
 * Convert bounded durable Agent 1/Agent 2 evidence into the same lifecycle
 * input consumed by the canonical Agent 2 classifier. Newer evidence wins;
 * the deterministic ID tie-breaker prevents older failures from overriding a
 * newer resolved/profile state when timestamps collide.
 */
export const adaptInspectionLifecycleEvidence = (
  artifacts: InspectionLifecycleArtifact[],
  target: InspectionLifecycleTarget,
): { lifecycle: Agent2LifecycleState; evidenceCoverage: "COMPLETE" | "BOUNDED" | "NONE"; evidenceTruncated: boolean } => {
  const ordered = [...artifacts].sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return timeB - timeA || String(b.id ?? "").localeCompare(String(a.id ?? ""));
  });
  let staticQuality: string | null = null;
  let staticEscalated = false;
  let browserStatus: string | null = null;
  let accepted: number | null = null;
  let inserted: number | null = null;
  let cooldown = false;
  let hardSourceLifecycleState: string | null = null;
  let recoverySuggestion: string | null = null;
  let discoveryProfileStatus: string | null = null;
  let consecutiveFailures = 0;
  let consecutiveFailuresSeen = false;
  for (const artifact of ordered) {
    const payload = asRecord(artifact.payload);
    const profile = asRecord(payload?.profile);
    if (hardSourceLifecycleState === null) hardSourceLifecycleState = typeof payload?.hardSourceLifecycleState === "string" ? payload.hardSourceLifecycleState : typeof payload?.profileLifecycleState === "string" ? payload.profileLifecycleState : typeof payload?.lifecycleState === "string" ? payload.lifecycleState : null;
    if (recoverySuggestion === null) recoverySuggestion = typeof payload?.recoverySuggestion === "string" ? payload.recoverySuggestion : typeof payload?.suggestedNextAction === "string" ? payload.suggestedNextAction : null;
    if (discoveryProfileStatus === null) discoveryProfileStatus = typeof profile?.status === "string" ? profile.status : typeof payload?.discoveryProfileStatus === "string" ? payload.discoveryProfileStatus : artifact.artifactType === "agent2_discovery_profile" && artifact.status === "ACTIVE" ? "active" : null;
    if (!consecutiveFailuresSeen && typeof payload?.failureCount === "number" && Number.isFinite(payload.failureCount)) {
      consecutiveFailures = Math.max(0, Math.floor(payload.failureCount));
      consecutiveFailuresSeen = true;
    }
    if (staticQuality === null && artifact.artifactType === "article_discovery_candidates") {
      const quality = asRecord(payload?.qualityAssessment);
      staticQuality = typeof quality?.quality === "string" ? quality.quality : typeof payload?.quality === "string" ? payload.quality : null;
      staticEscalated = quality?.shouldEscalateToHeadless === true;
    }
    if (browserStatus === null && (artifact.artifactType === "article_discovery_headless_required" || artifact.artifactType === "article_headless_queue_candidate")) {
      browserStatus = artifact.status;
      accepted = typeof payload?.browserAccepted === "number" ? payload.browserAccepted : null;
      inserted = typeof payload?.browserInserted === "number" ? payload.browserInserted : null;
      cooldown = payload?.browserRateLimited === true || payload?.skippedDueToBrowserCooldown === true || (typeof payload?.browserRetryAfterAt === "string" && Date.parse(payload.browserRetryAfterAt) > Date.now());
    }
  }
  const lifecycle = classifyAgent2TargetLifecycle({
    rssStatus: target.rssStatus,
    currentFeedProductive: target.currentFeedProductive,
    resolvedByAgent1ScopedRss: target.rssStatus === "ACTIVE" && target.currentFeedProductive || ["resolved", "RESOLVED", "RESOLVED_BY_AGENT1_RSS", "RESOLVED_BY_STATIC_DISCOVERY"].includes(hardSourceLifecycleState ?? ""),
    lastStaticQuality: staticQuality,
    lastStaticEscalated: staticEscalated,
    lastBrowserStatus: browserStatus,
    lastAcceptedCount: accepted,
    lastInsertedCount: inserted,
    inBrowserCooldown: cooldown,
    hardSourceLifecycleState,
    recoverySuggestion,
    discoveryProfileStatus,
    consecutiveFailedDiscoveryAttempts: consecutiveFailures,
  });
  return { lifecycle, evidenceCoverage: ordered.length === 0 ? "NONE" : ordered.length >= ADMIN_INSPECTION_ARTIFACT_SCAN_CAP ? "BOUNDED" : "COMPLETE", evidenceTruncated: ordered.length >= ADMIN_INSPECTION_ARTIFACT_SCAN_CAP };
};

export type InspectionActivityEvidence = {
  rssStatus: string;
  parentRssStatus?: string | null;
  currentFeedProductive: boolean;
  activeSubscriberCount: number;
  isSystemImported: boolean;
  nextRetryAt?: Date | null;
  lifecycle?: Agent2LifecycleState | null;
  /** Parent-source lifecycle state (CATEGORY targets); a resolved/productive parent keeps the category an active inspection target. */
  parentLifecycle?: Agent2LifecycleState | null;
};

/**
 * Canonical inspection-active predicate. Ownership and actionable durable
 * recovery evidence are the authority; RSS status alone is not sufficient.
 */
export const deriveInspectionActivityEvidence = (input: InspectionActivityEvidence): {
  active: boolean;
  activeReason: InspectionActiveReason;
} => {
  const terminal = new Set(["FAILED", "DOMAIN_DEAD"]);
  if (terminal.has(input.rssStatus) || (input.parentRssStatus != null && terminal.has(input.parentRssStatus))) {
    return { active: false, activeReason: "NONE" };
  }
  if (input.activeSubscriberCount > 0) return { active: true, activeReason: "ACTIVE_SUBSCRIBER" };
  if (input.nextRetryAt && input.nextRetryAt > new Date()) return { active: true, activeReason: "DEFERRED_RETRY" };
  if (input.isSystemImported) return { active: true, activeReason: "SYSTEM_TARGET" };
  const lifecycle = input.lifecycle;
  const actionableRecovery = lifecycle != null && lifecycle !== "static_pending" && lifecycle !== "ignored" && isAgent2TargetActionable(lifecycle);
  // A resolved/productive Agent 2 target remains an actionable inspection
  // target for the current feed, even though it does not need another Agent 2
  // recovery attempt. This keeps resolved evidence from being mislabeled
  // INACTIVE while still allowing terminal RSS/parent states above to win.
  const productiveOrResolved = lifecycle != null && [
    "rss_owned", "static_productive", "browser_productive", "resolved", "profile_active",
  ].includes(lifecycle);
  if (actionableRecovery || productiveOrResolved || input.currentFeedProductive) return { active: true, activeReason: "ACTIVE_RECOVERY" };
  // Parent lifecycle parity: a resolved/productive parent source keeps the
  // category an active inspection target even when the category row itself has
  // no direct actionable evidence (the parent owns the feed path).
  const parentProductive = input.parentLifecycle != null && [
    "rss_owned", "static_productive", "browser_productive", "resolved", "profile_active",
  ].includes(input.parentLifecycle);
  if (parentProductive) return { active: true, activeReason: "ACTIVE_RECOVERY" };
  return { active: false, activeReason: "NONE" };
};

/** Compatibility helper retained for callers that already computed activity. */
export const isCanonicalInspectionTargetActive = (rssStatus: string, active = false): boolean => active && rssStatus !== "FAILED" && rssStatus !== "DOMAIN_DEAD";

export const readArtifactFailureReason = (artifact: { errorLog?: string | null; payload?: unknown }): string | null => { const payload = asRecord(artifact.payload); return boundedString(artifact.errorLog) || boundedString(payload?.failureReason) || boundedString(payload?.error) || boundedString(payload?.lastError); };
export const readArtifactArticleId = (payload: unknown): number | null => { const id = asRecord(payload)?.articleId; return typeof id === "number" && Number.isSafeInteger(id) ? id : null; };
export const readBrowserFallbackUsed = (value: unknown): boolean => asRecord(asRecord(value)?.browserFallback)?.attempted === true;
export const readBrowserFallbackSucceeded = (value: unknown): boolean => asRecord(asRecord(value)?.browserFallback)?.succeeded === true;

export const mergeInspectionStats = (target: AdminInspectionStats, addition: Partial<AdminInspectionStats>): void => {
  const keys: Array<keyof AdminInspectionStats> = ["totalArticlesInWindow", "publishedArticlesInWindow", "pendingArticlesInWindow", "deferredArticlesInWindow", "rejectedArticlesInWindow", "permanentFailuresInWindow", "retryableFailuresInWindow", "agent1ProductivityCount", "agent2DiscoveredCount", "agent3ProcessedCount", "agent3EnrichedCount", "agent3PublishedCount", "agent3RejectedCount", "deferredCount", "retryableFailureCount", "permanentFailureCount", "browserFallbackUsageCount"];
  for (const key of keys) if (typeof addition[key] === "number") (target[key] as number) += addition[key] as number;
  if (addition.latestArticleCreatedAt && (!target.latestArticleCreatedAt || addition.latestArticleCreatedAt > target.latestArticleCreatedAt)) target.latestArticleCreatedAt = addition.latestArticleCreatedAt;
  if (addition.latestPublishedArticleAt && (!target.latestPublishedArticleAt || addition.latestPublishedArticleAt > target.latestPublishedArticleAt)) target.latestPublishedArticleAt = addition.latestPublishedArticleAt;
  if (!target.latestFailureReason && addition.latestFailureReason) target.latestFailureReason = addition.latestFailureReason;
  target.diagnosticsTruncated ||= addition.diagnosticsTruncated === true; target.metricsApproximate ||= addition.metricsApproximate === true;
  if (addition.metricAccuracy === "APPROXIMATE") target.metricAccuracy = "APPROXIMATE";
  target.approximateMetrics = [...new Set([...target.approximateMetrics, ...(addition.approximateMetrics ?? [])])];
  target.artifactOnlyEvents += addition.artifactOnlyEvents ?? 0; target.scannedArticles += addition.scannedArticles ?? 0; target.scannedArtifacts += addition.scannedArtifacts ?? 0;
};
export const deriveInspectionFlags = (stats: Omit<AdminInspectionStats, "diagnosticFlags"> & { rssStatus?: string; currentFeedProductive?: boolean; lastSuccessfulPipelineAt?: Date | null }): AdminInspectionFlag[] => {
  const flags: AdminInspectionFlag[] = [];
  if (stats.totalArticlesInWindow === 0) flags.push("NO_ARTICLES_GENERATED");
  if (stats.agent2DiscoveredCount > 0 && stats.agent3EnrichedCount === 0) flags.push("DISCOVERED_NOT_ENRICHED");
  if (stats.agent3EnrichedCount > 0 && stats.publishedArticlesInWindow === 0) flags.push("ENRICHED_NOT_PUBLISHED");
  if (stats.totalArticlesInWindow > 0 && stats.rejectedArticlesInWindow >= Math.ceil(stats.totalArticlesInWindow / 2)) flags.push("HIGH_REJECTION_RATE");
  if (stats.retryableFailuresInWindow + stats.deferredArticlesInWindow > 0) flags.push("RETRY_BACKLOG");
  if (stats.rssStatus && stats.currentFeedProductive === false) flags.push("RSS_UNPRODUCTIVE");
  if (stats.browserFallbackUsageCount > 0) flags.push("BROWSER_FALLBACK_REQUIRED");
  if (stats.lastSuccessfulPipelineAt && Date.now() - stats.lastSuccessfulPipelineAt.getTime() <= 7 * 86400000) flags.push("RECENTLY_PRODUCTIVE");
  return flags;
};
