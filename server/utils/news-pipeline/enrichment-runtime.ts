import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import {
  AGENT3_EXTRACTOR_VERSION,
  buildFailureOutcome,
  buildHeadlessRequiredOutcome,
  buildSkippedOutcome,
  buildSuccessOutcome,
  createEnrichmentOutcome,
  sanitizeEnrichmentEvidenceText,
  sanitizeEnrichmentEvidenceUrl,
  summarizeArticleAccess,
  type ArticleEnrichmentOutcome,
  type EarlyAccessRecoveryDiagnostics,
  type ArticleFieldProvenance,
  type ArticleUpstreamProvenance,
  type EnrichmentTiming,
  type FieldProvenanceSource,
  type EnrichmentRejectionReason,
  type RejectionDiagnostics,
} from "./enrichment";
import {
  buildEnrichmentRunSummary,
  claimEnrichmentArticle,
  createEmptyEnrichmentBatchPersistResult,
  mergeEnrichmentBatchPersistResult,
  persistAttemptMarker,
  persistEnrichmentBatch,
  releaseEnrichmentClaim,
  recoverExpiredEnrichmentClaims,
  type EnrichmentBatchPersistResult,
} from "./enrichment-persist";
import { persistRunTargetManifest } from "./run-funnel";
import { createPipelineRun } from "./artifacts";
import { normalizeTargetUrl } from "./text";
import { logAgentScan } from "./log";
import {
  extractArticleContentFromUrl,
  type ArticleContentExtractionResult,
  type ArticleContentExtractionFail,
  type ExtractionDiagnostics,
} from "./article-content-extractor";
import {
  extractArticleContentWithBrowser,
  isBrowserFallbackEligibleForFailure,
} from "./article-content-browser-extractor";
import { getHttpsArticleUrl } from "./article-transport-policy";
import type { Agent3RetryDiagnostics, BrowserFallbackMetadata, BrowserFallbackRunStats, BrowserDiagnostics, BrowserFallbackSkippedReason } from "./enrichment";
import { hasUsableAgent3BodyText } from "./publication-gate";
import {
  decideAgent3RetryDisposition,
  getAgent3AttemptNumber,
  getAgent3HttpStatus,
  getAgent3RetryAfter,
  getAgent3Tier,
  isAgent3RetryableNow,
  MAX_AUTOMATIC_AGENT3_ATTEMPTS,
} from "./agent3-retry-policy";
import type { Agent3RetryDisposition } from "./agent3-retry-policy";
import {
  createNoopStageBatchProbe,
  type StageBatchProbe,
} from "./stage-telemetry";
import { GovernedFetchDeferredError } from "./governed-fetch";
import type { GovernedFetchContext } from "./governed-fetch";
import {
  acquireBrowserNavigationPermit,
  type BrowserNavigationAcquireResult,
  type BrowserNavigationGovernorContext,
} from "./browser-navigation-governor";
import {
  Agent3BrowserSessionError,
  createAgent3BrowserSession,
  type Agent3BrowserSession,
} from "./agent3-browser-session";

// ─────────────────────────────────────────────────────────────────────────────
// Agent 3 — Article enrichment runtime batch path (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────
//
// Wires the canonical `ArticleEnrichmentOutcome` contract into a runnable
// batch: select eligible articles → recover precise upstream provenance from
// Agent 1 ingest artifacts → emit attempt markers → run the real HTTP
// article content extractor → persist outcomes (row summary + result artifact).
//
// Phase 2: uses `extractArticleContentFromUrl` for real HTTP-based extraction
// (canonical check, meta/DOM selectors, paywall detection, quality scoring,
// field comparison + override). `stubExtractArticle` is retained for tests.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum article age considered eligible for enrichment (Agent 3 dev plan
 * §6.2: at most 7 days old).
 *
 * Re-exported from the shared article-retention-policy module.
 */
import { ARTICLE_RETENTION_DAYS, getArticleRetentionCutoff } from "./article-retention-policy";
export const ENRICHMENT_FRESHNESS_DAYS = ARTICLE_RETENTION_DAYS;

/**
 * Determine whether an article needs Agent 3 reprocessing with the current extractor version.
 *
 * Pure helper — no DB access. Uses the same semantics as selectEnrichmentEligibleArticles
 * and getAgent3Progress so all three stay in sync.
 *
 * Returns true when:
 *  - status is INGESTED (never processed)
 *  - status is ENRICHMENT_FAILED (previous attempt failed)
 *  - status is ENRICHED but bodyText is missing/too short
 *  - status is ENRICHED but enrichmentOutcome is missing
 *  - status is ENRICHED but extractorVersion doesn't match current
 * Returns false when:
 *  - status is ENRICHED AND extractorVersion matches AND bodyText is usable
 *  - status is something else (conservative: don't select unknown statuses)
 */
/**
 * Cooldown windows for recently-blocked articles (cross-run retry loop prevention).
 * Articles that failed with these blocking reasons are temporarily excluded from
 * reselection unless forceReprocess or includeRecentlyBlocked is set.
 */
const HTTP_403_COOLDOWN_MS = 24 * 60 * 60 * 1000;    // 24 hours
const HTTP_429_COOLDOWN_MS = 60 * 60 * 1000;           // 1 hour
const BROWSER_RUNTIME_UNAVAILABLE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Determine whether an article is "recently blocked" — its latest enrichment attempt
 * failed with a blocking reason (HTTP 403/429, browser runtime unavailable) and the
 * cooldown window has not yet elapsed.
 *
 * Only applies to ENRICHMENT_FAILED articles with the current extractor version.
 * INGESTED articles are never "recently blocked" (they haven't been tried yet).
 *
 * Pure helper — no DB access.
 */
export function isRecentlyBlocked(
  article: { enrichmentStatus: string | null; enrichmentOutcome?: unknown; enrichmentFinishedAt?: Date | null },
  now: Date = new Date(),
): boolean {
  if (article.enrichmentStatus !== "ENRICHMENT_FAILED") return false;

  const outcome = article.enrichmentOutcome as Record<string, unknown> | null | undefined;
  if (!outcome || typeof outcome !== "object") return false;

  // Must have been processed by the current extractor version
  if (outcome.extractorVersion !== AGENT3_EXTRACTOR_VERSION) return false;

  // Must have a recent enough finish time
  const finishedAt = article.enrichmentFinishedAt;
  if (!finishedAt) return false;
  const elapsed = now.getTime() - finishedAt.getTime();
  // Guard against future timestamps (clock skew)
  if (elapsed < 0) return false;

  // Check rejection details for blocking indicators
  const rejection = outcome.rejection as Record<string, unknown> | undefined;
  const httpStatus = typeof rejection?.httpStatus === "number"
    ? rejection.httpStatus
    : typeof outcome.rejectionHttpStatus === "number"
      ? outcome.rejectionHttpStatus
      : null;
  const detail = typeof rejection?.detail === "string"
    ? rejection.detail
    : typeof outcome.rejectionDetail === "string"
      ? outcome.rejectionDetail
      : "";
  const rejectionCode = typeof outcome.rejectionCode === "string" ? outcome.rejectionCode : null;

  // Check browser fallback metadata
  const bf = outcome.browserFallback as Record<string, unknown> | undefined;
  const bfRuntimeUnavailable = bf?.runtimeUnavailable === true;
  const bfRateLimited = bf?.rateLimited === true;

  // HTTP 403 blocking: 24h cooldown
  if (httpStatus === 403 || rejectionCode === "HTTP_403" || (rejectionCode === "HTTP_FORBIDDEN" && httpStatus !== 429) || (detail.includes("[http_error]") && detail.includes("403"))) {
    return elapsed < HTTP_403_COOLDOWN_MS;
  }

  // HTTP 429 blocking: 1h cooldown
  if (httpStatus === 429 || rejectionCode === "HTTP_429" || rejectionCode === "HTTP_FORBIDDEN" || (detail.includes("[http_error]") && detail.includes("429")) || bfRateLimited) {
    return elapsed < HTTP_429_COOLDOWN_MS;
  }

  // Browser runtime unavailable: 30min cooldown
  if (bfRuntimeUnavailable) {
    return elapsed < BROWSER_RUNTIME_UNAVAILABLE_COOLDOWN_MS;
  }

  return false;
}

export function needsAgent3CurrentVersionReprocess(article: {
  enrichmentStatus: string | null;
  bodyText?: string | null;
  enrichmentOutcome?: unknown;
}): boolean {
  const status = article.enrichmentStatus;
  if (status === "INGESTED" || status === "ENRICHMENT_FAILED") return true;
  if (status !== "ENRICHED") return false;

  // ENRICHED articles: check if they need reprocess
  if (!hasUsableAgent3BodyText(article.bodyText)) return true;

  const outcome = article.enrichmentOutcome as Record<string, unknown> | null | undefined;
  if (!outcome || typeof outcome !== "object") return true;

  const version = outcome.extractorVersion;
  if (typeof version !== "string" || version !== AGENT3_EXTRACTOR_VERSION) return true;

  return false; // current version + usable bodyText → no reprocess needed
}/**
 * Determine whether an ENRICHMENT_FAILED article should be retried in the
 * current Agent 3 run.
 *
 * Returns true for:
 *  - INGESTED articles (not yet attempted)
 *  - ENRICHMENT_FAILED with no outcome metadata (legacy/unknown rows)
 *  - ENRICHMENT_FAILED with a different extractor version (version bump retry)
 *  - ENRICHMENT_FAILED with HTTP_ACCESS_BLOCKED after cooldown expires
 *  - ENRICHMENT_FAILED with FETCH_TIMEOUT (transient)
 *  - ENRICHMENT_FAILED with RETRYABLE_FAILURE kind (transient)
 *
 * Returns false for:
 *  - ENRICHMENT_FAILED with current extractor version + permanent failure kind
 *    (LOW_CONTENT_QUALITY, UNSUPPORTED_STRUCTURE, PAYWALL_BLOCKED, etc.)
 *  - ENRICHMENT_FAILED that is currently inside a cooldown window
 *  - Non-ENRICHMENT_FAILED statuses that are not INGESTED (conservative)
 *
 * Pure helper — no DB access.
 */
export function isAgent3FailureRetryableNow(
  article: {
    enrichmentStatus: string | null;
    enrichmentAttemptCount?: number | null;
    enrichmentOutcome?: unknown;
    enrichmentFinishedAt?: Date | null;
  },
  now: Date = new Date(),
): boolean {
  return isAgent3RetryableNow({ ...article, now, ignoreCooldown: true });
}

/**
 * Per-batch safety caps (Agent 3 dev plan §11: max concurrency / per-run limit).
 * Phase 1 runs sequentially, so MAX_ARTICLES_PER_RUN bounds the batch size.
 */
export const MAX_ARTICLES_PER_RUN = 50;

/**
 * Fields selected for enrichment eligibility + provenance construction.
 * Minimal select to keep DB reads cheap (Agent 3 dev plan §10).
 */
type EnrichmentEligibleArticle = {
  id: number;
  sourceId: string;
  categoryId: string | null;
  canonicalUrl: string | null;
  sourceUrl: string | null;
  title: string;
  bodyText: string | null;
  publishedAt: Date | null;
  isPaywall: boolean;
  createdAt: Date;
  enrichmentStatus: string;
  enrichmentAttemptCount: number;
  enrichmentFinishedAt?: Date | null;
  enrichmentOutcome?: unknown;
  /** Bounded Agent 1/2 access hint recovered from a candidate artifact. */
  accessEvidence?: {
    classification: "PAYWALL_BLOCKED" | "METERED_OR_DECLARED" | "ACCESSIBLE" | "UNKNOWN";
    sourceStage: "agent1" | "agent2";
    evidenceCodes: string[];
    contradictingEvidenceCodes: string[];
  } | null;
};

/**
 * Options for article selection during enrichment.
 */
export interface EnrichmentSelectionOptions {
  /** Include already-ENRICHED articles (for reprocessing after extractor fixes). */
  includeEnriched?: boolean;
  /** Include recently-blocked articles that are in cooldown (HTTP 403/429, browser unavailable). */
  includeRecentlyBlocked?: boolean;
  /** Allow bounded browser recovery of an article's own current-version HTTP 403 failure. */
  allowBrowserRecoveryDuringHttp403Cooldown?: boolean;
  /** Force reprocess: override non-retryable failure exclusion. */
  forceReprocess?: boolean;
  /** Filter to specific article IDs (debug/admin rerun). Bypasses freshness cutoff. */
  articleIds?: number[];
  /** Filter to specific source IDs. */
  sourceIds?: string[];
  /** Durable Agent 3 run whose attempt artifacts must be excluded. */
  pipelineRunId?: string;
}

const ENRICHMENT_ARTICLE_SELECT = {
  id: true,
  sourceId: true,
  categoryId: true,
  canonicalUrl: true,
  sourceUrl: true,
  title: true,
  bodyText: true,
  publishedAt: true,
  isPaywall: true,
  createdAt: true,
  enrichmentStatus: true,
  enrichmentAttemptCount: true,
  enrichmentFinishedAt: true,
  enrichmentOutcome: true,
  enrichmentClaim: true,
} satisfies Prisma.ArticleSelect;

type RecentBlockState = {
  articleIds: ReadonlySet<number>;
  hostnames: ReadonlySet<string>;
  http403Hostnames: ReadonlySet<string>;
  retryAfterByArticleId: ReadonlyMap<number, string>;
  retryAfterByHostname: ReadonlyMap<string, string>;
};

function articleHostname(article: Pick<EnrichmentEligibleArticle, "canonicalUrl" | "sourceUrl">): string {
  const canonicalHostname = extractHostname(article.canonicalUrl);
  if (canonicalHostname !== "unknown") return canonicalHostname;
  return extractHostname(article.sourceUrl);
}

function isBlockedByRecentBlockState(
  article: Pick<EnrichmentEligibleArticle, "id" | "canonicalUrl" | "sourceUrl">,
  state: RecentBlockState,
): boolean {
  if (state.articleIds.has(article.id)) return true;
  const hostname = articleHostname(article);
  return hostname !== "unknown" && state.hostnames.has(hostname);
}

async function scanEnrichedArticlesForSelection(
  baseWhere: Record<string, unknown>,
  limit: number,
): Promise<EnrichmentEligibleArticle[]> {
  const selected: EnrichmentEligibleArticle[] = [];
  let scanned = 0;
  let cursor: number | undefined;

  while (selected.length < limit && scanned < PROGRESS_SCAN_SAFETY_CAP) {
    const page = await prisma.article.findMany({
      where: { ...baseWhere, enrichmentStatus: "ENRICHED" },
      select: ENRICHMENT_ARTICLE_SELECT,
      orderBy: { id: "asc" },
      take: PROGRESS_SCAN_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (!Array.isArray(page) || page.length === 0) break;
    scanned += page.length;

    for (const article of page) {
      if (needsAgent3CurrentVersionReprocess({
        enrichmentStatus: article.enrichmentStatus,
        bodyText: article.bodyText,
        enrichmentOutcome: article.enrichmentOutcome,
      })) {
        selected.push(article);
        if (selected.length >= limit) break;
      }
    }

    cursor = page[page.length - 1]!.id;
    if (page.length < PROGRESS_SCAN_PAGE_SIZE) break;
  }

  return selected;
}

/**
 * Select articles eligible for Agent 3 enrichment (dev plan §6.2):
 *  - successfully stored by Agent 1
 *  - at most ENRICHMENT_FRESHNESS_DAYS old
 *  - not yet successfully enriched, OR failed earlier for a retryable reason
 *
 * When `options.includeEnriched` is true, also includes ENRICHED articles
 * for reprocessing after extractor improvements.
 *
 * When `options.articleIds` is provided, bypasses the freshness cutoff
 * (admin/debug mode: re-run specific articles regardless of age).
 *
 * Uses the `Article_enrichmentStatus_date_idx` index added in Phase 1.
 * Capped at MAX_ARTICLES_PER_RUN per batch.
 */
async function scanRecentBlockState(
  baseWhere: Record<string, unknown>,
  now: Date,
): Promise<RecentBlockState> {
  const articleIds = new Set<number>();
  const hostnames = new Set<string>();
  const http403Hostnames = new Set<string>();
  const retryAfterByArticleId = new Map<number, string>();
  const retryAfterByHostname = new Map<string, string>();
  let cursor: number | undefined;
  let scanned = 0;

  while (scanned < PROGRESS_SCAN_SAFETY_CAP) {
    const page = await prisma.article.findMany({
      where: { ...baseWhere, enrichmentStatus: "ENRICHMENT_FAILED" },
      select: {
        id: true,
        canonicalUrl: true,
        sourceUrl: true,
        enrichmentStatus: true,
        enrichmentOutcome: true,
        enrichmentFinishedAt: true,
      },
      take: PROGRESS_SCAN_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });

    if (!Array.isArray(page) || page.length === 0) break;
    scanned += page.length;

    for (const article of page) {
      if (!isRecentlyBlocked(article, now)) continue;
      articleIds.add(article.id);
      const retryAfter = getAgent3RetryAfter({ ...article, now });
      if (retryAfter) retryAfterByArticleId.set(article.id, retryAfter);
      const hostname = extractHostname(article.canonicalUrl) !== "unknown"
        ? extractHostname(article.canonicalUrl)
        : extractHostname(article.sourceUrl);
      if (hostname !== "unknown") {
        hostnames.add(hostname);
        if (getAgent3HttpStatus(article) === 403) {
          http403Hostnames.add(hostname);
        }
        if (retryAfter) {
          const current = retryAfterByHostname.get(hostname);
          if (!current || Date.parse(retryAfter) > Date.parse(current)) {
            retryAfterByHostname.set(hostname, retryAfter);
          }
        }
      }
    }

    cursor = page[page.length - 1]!.id;
    if (page.length < PROGRESS_SCAN_PAGE_SIZE) break;
  }

  return { articleIds, hostnames, http403Hostnames, retryAfterByArticleId, retryAfterByHostname };
}

async function countBlockedEligibleArticles(
  baseWhere: Record<string, unknown>,
  includeEnriched: boolean,
  blockState: RecentBlockState,
): Promise<number> {
  if (blockState.articleIds.size === 0 && blockState.hostnames.size === 0) return 0;

  let count = 0;
  let cursor: number | undefined;
  let scanned = 0;
  const statuses = includeEnriched
    ? ["INGESTED", "ENRICHMENT_FAILED", "ENRICHED"]
    : ["INGESTED", "ENRICHMENT_FAILED"];

  while (scanned < PROGRESS_SCAN_SAFETY_CAP) {
    const page = await prisma.article.findMany({
      where: { ...baseWhere, enrichmentStatus: { in: statuses } },
      select: ENRICHMENT_ARTICLE_SELECT,
      take: PROGRESS_SCAN_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });

    if (!Array.isArray(page) || page.length === 0) break;
    scanned += page.length;

    for (const article of page) {
      const eligible = article.enrichmentStatus === "INGESTED"
        || article.enrichmentStatus === "ENRICHMENT_FAILED"
        || (includeEnriched && needsAgent3CurrentVersionReprocess(article));
      if (eligible && isBlockedByRecentBlockState(article, blockState)) count++;
    }

    cursor = page[page.length - 1]!.id;
    if (page.length < PROGRESS_SCAN_PAGE_SIZE) break;
  }

  return count;
}

async function readAttemptedArticleIds(pipelineRunId: string): Promise<ReadonlySet<number>> {
  const attempted = new Set<number>();
  const artifacts = await prisma.pipelineArtifact.findMany({
    where: { pipelineRunId, artifactType: "article_enrichment_attempt", status: "ATTEMPTED" },
    select: { payload: true },
    take: 10_000,
  });
  for (const artifact of artifacts) {
    const payload = artifact.payload as Record<string, unknown>;
    if (typeof payload?.articleId === "number") attempted.add(payload.articleId);
  }
  return attempted;
}

function compareAgent3QueueArticles(
  a: EnrichmentEligibleArticle,
  b: EnrichmentEligibleArticle,
): number {
  const tierRank: Record<string, number> = {
    NEW: 0,
    RETRY_1: 1,
    RETRY_2: 2,
    LEGACY: 3,
    DEFERRED: 4,
    QUARANTINED: 5,
    NON_RETRYABLE: 6,
  };
  const aRank = tierRank[getAgent3Tier(a)] ?? 99;
  const bRank = tierRank[getAgent3Tier(b)] ?? 99;
  if (aRank !== bRank) return aRank - bRank;
  const attempt = getAgent3AttemptNumber(a) - getAgent3AttemptNumber(b);
  if (attempt !== 0) return attempt;
  const aFinished = a.enrichmentFinishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bFinished = b.enrichmentFinishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aFinished !== bFinished) return aFinished - bFinished;
  return a.id - b.id;
}

export const selectEnrichmentEligibleArticles = async (
  now: Date = new Date(),
  limit: number = MAX_ARTICLES_PER_RUN,
  options?: EnrichmentSelectionOptions,
): Promise<EnrichmentEligibleArticle[]> => {
  const includeEnriched = options?.includeEnriched ?? false;
  const includeRecentlyBlocked = options?.includeRecentlyBlocked ?? false;
  const articleIds = options?.articleIds;
  const sourceIds = options?.sourceIds;
  const pipelineRunId = options?.pipelineRunId;
  const allowBrowserRecoveryDuringHttp403Cooldown =
    options?.allowBrowserRecoveryDuringHttp403Cooldown ?? false;

  // When explicit articleIds are provided, bypass freshness cutoff
  // (admin re-run mode: process specific articles regardless of age).
  const cutoff = articleIds && articleIds.length > 0 ? undefined : getArticleRetentionCutoff(now);

  // Build the where clause.
  // When includeEnriched=true, only select ENRICHED articles that need
  // current-version reprocess (old/missing extractor version or missing bodyText).
  // This prevents endless reprocessing of already-current articles.
  const where: Record<string, unknown> = {};

  if (cutoff) {
    where.date = { gte: cutoff };
  }

  if (articleIds && articleIds.length > 0) {
    where.id = { in: articleIds };
  }

  if (sourceIds && sourceIds.length > 0) {
    where.sourceId = { in: sourceIds };
  }

  const targetLimit = Math.min(Math.max(1, limit), MAX_ARTICLES_PER_RUN);
  const forceReprocess = options?.forceReprocess ?? false;
  const hasExplicitArticleIds = articleIds && articleIds.length > 0;
  const shouldApplyRecentBlockFilter = !includeRecentlyBlocked && !forceReprocess && !hasExplicitArticleIds;
  // Non-retryable failures are excluded unless forceReprocess or explicit articleIds
  const shouldApplyRetryableFilter = !forceReprocess && !hasExplicitArticleIds;

  const recentBlockState = shouldApplyRecentBlockFilter
    ? await scanRecentBlockState(where, now)
    : {
        articleIds: new Set<number>(),
        hostnames: new Set<string>(),
        http403Hostnames: new Set<string>(),
        retryAfterByArticleId: new Map<number, string>(),
        retryAfterByHostname: new Map<string, string>(),
      };
  const sameRunArticleIds = pipelineRunId
    ? await readAttemptedArticleIds(pipelineRunId)
    : new Set<number>();
  const enrichedFallbackRows: EnrichmentEligibleArticle[] = [];

  const explicitlyTargeted = Boolean(hasExplicitArticleIds);
  const acceptsArticle = (article: EnrichmentEligibleArticle): boolean => {
    if (sameRunArticleIds.has(article.id)) return false;
    const browserRecoverable403 = allowBrowserRecoveryDuringHttp403Cooldown && (
      (article.enrichmentStatus === "ENRICHMENT_FAILED" && getAgent3HttpStatus(article) === 403)
      || (article.enrichmentStatus === "INGESTED"
        && recentBlockState.http403Hostnames.has(articleHostname(article)))
    );
    if (
      shouldApplyRecentBlockFilter &&
      isBlockedByRecentBlockState(article, recentBlockState) &&
      !browserRecoverable403
    ) return false;
    const disposition = decideAgent3RetryDisposition({
      ...article,
      now,
      forceReprocess,
      explicitlyTargeted,
      ignoreCooldown: forceReprocess || explicitlyTargeted || includeRecentlyBlocked,
    });
    if (browserRecoverable403 && disposition.state === "DEFERRED") return true;
    return shouldApplyRetryableFilter
      ? disposition.state === "READY_NEW" || disposition.state === "READY_RETRY"
      : explicitlyTargeted || forceReprocess
        ? disposition.state !== "DEFERRED"
        : disposition.state === "READY_NEW" || disposition.state === "READY_RETRY";
  };

  // Automatic selection is intentionally tiered. Each query is completed
  // before the next tier is consulted, so a retry cannot displace NEW work.
  const fetchTier = async (
    status: "INGESTED" | "ENRICHMENT_FAILED",
    attemptCount?: number | number[],
  ): Promise<EnrichmentEligibleArticle[]> => {
    const attemptFilter = attemptCount === undefined
      ? {}
      : { enrichmentAttemptCount: Array.isArray(attemptCount) ? { in: attemptCount } : attemptCount };
    const selected: EnrichmentEligibleArticle[] = [];
    const pageSize = Math.max(targetLimit * 3, 50);
    let cursor: number | undefined;
    let scanned = 0;

    while (selected.length < targetLimit && scanned < PROGRESS_SCAN_SAFETY_CAP) {
      const rows = await prisma.article.findMany({
        where: {
          ...where,
          enrichmentStatus: status,
          ...attemptFilter,
          enrichmentClaim: null,
        },
        select: ENRICHMENT_ARTICLE_SELECT,
        orderBy: [{ enrichmentAttemptCount: "asc" }, { enrichmentFinishedAt: "asc" }, { id: "asc" }],
        take: pageSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!Array.isArray(rows) || rows.length === 0) break;
      scanned += rows.length;
      if (includeEnriched) {
        enrichedFallbackRows.push(...rows.filter((article) => article.enrichmentStatus === "ENRICHED"));
      }
      selected.push(...rows
        .filter((article) => article.enrichmentStatus === status)
        .filter((article) => attemptCount === undefined || (Array.isArray(attemptCount)
          ? attemptCount.includes(article.enrichmentAttemptCount)
          : article.enrichmentAttemptCount === attemptCount))
        .filter(acceptsArticle));
      const nextCursor = rows[rows.length - 1]!.id;
      if (cursor === nextCursor || rows.length < pageSize) break;
      cursor = nextCursor;
    }

    return selected.sort(compareAgent3QueueArticles).slice(0, targetLimit);
  };

  let filtered: EnrichmentEligibleArticle[] = [];
  if (shouldApplyRetryableFilter) {
    filtered = await fetchTier("INGESTED");
    if (filtered.length < targetLimit) {
      // One bounded query for all retry candidates, followed by policy sorting.
      // The comparator preserves RETRY_1 before RETRY_2 and keeps legacy rows
      // after both explicit retry tiers.
      filtered.push(...(await fetchTier("ENRICHMENT_FAILED", [0, 1, 2]))
        .slice(0, targetLimit - filtered.length));
    }
  } else {
    filtered = (await prisma.article.findMany({
      where: {
        ...where,
        enrichmentStatus: { in: ["INGESTED", "ENRICHMENT_FAILED"] },
        enrichmentClaim: null,
      },
      select: ENRICHMENT_ARTICLE_SELECT,
      orderBy: [{ enrichmentAttemptCount: "asc" }, { enrichmentFinishedAt: "asc" }, { id: "asc" }],
      take: targetLimit,
    })).filter(acceptsArticle).sort(compareAgent3QueueArticles);
  }

  filtered = filtered.slice(0, targetLimit);

  if (!includeEnriched || filtered.length >= targetLimit) {
    return filtered;
  }

  const enrichedArticles = enrichedFallbackRows.length > 0
    ? enrichedFallbackRows
    : await scanEnrichedArticlesForSelection(where, targetLimit - filtered.length);
  const filteredEnriched = enrichedArticles
    .filter((a) => needsAgent3CurrentVersionReprocess(a))
    .filter((a) => !sameRunArticleIds.has(a.id))
    .filter((a) => !shouldApplyRecentBlockFilter || !isBlockedByRecentBlockState(a, recentBlockState));
  return [...filtered, ...filteredEnriched].sort(compareAgent3QueueArticles).slice(0, targetLimit);
};

/**
 * Build the upstream Agent 1 provenance object from an Article row.
 *
 * Agent 3 must NOT re-derive or overwrite upstream provenance — it preserves
 * traceability of where the article came from. The Article row does not store
 * the exact feed origin/feedUrl that Agent 1 recorded (that lives in the
 * ingest artifact payload), so an Article-row-only fallback uses explicit
 * unknown values rather than asserting an origin.
 *  - feedOrigin is null until Agent 1 evidence proves it.
 *  - discoveredFromCategoryFeed and arrivedViaHardCaseRerun are null when
 *    the row does not prove them.
 *  - ingestedAt = article.createdAt (the row timestamp, not a claimed feed time).
 */
export const buildArticleProvenance = (
  article: EnrichmentEligibleArticle,
): ArticleUpstreamProvenance => {
  const articleUrl = article.canonicalUrl || article.sourceUrl;
  return {
    sourceId: article.sourceId,
    categoryId: article.categoryId,
    // Article row does not prove the feed origin or discovery route.
    feedOrigin: null,
    feedUrl: null,
    ...(articleUrl?.toLowerCase().startsWith("http://")
      ? { originalArticleUrl: articleUrl }
      : {}),
    discoveredFromCategoryFeed: null,
    arrivedViaHardCaseRerun: null,
    ingestedAt: article.createdAt.toISOString(),
  };
};

const preserveOriginalArticleUrl = (
  article: EnrichmentEligibleArticle,
  provenance: ArticleUpstreamProvenance,
): ArticleUpstreamProvenance => {
  const articleUrl = article.canonicalUrl || article.sourceUrl;
  if (
    provenance.originalArticleUrl === undefined &&
    articleUrl?.toLowerCase().startsWith("http://")
  ) {
    return { ...provenance, originalArticleUrl: articleUrl };
  }
  return provenance;
};

const MAX_UPSTREAM_RECOVERY_ARTIFACTS = 200;
const MAX_UPSTREAM_RECOVERY_CANDIDATES_PER_ARTIFACT = 100;
const MAX_UPSTREAM_RECOVERY_QUERY_CONCURRENCY = 4;
const RECOVERY_ARTIFACT_TYPES = ["rss_candidates", "article_discovery_candidates"] as const;

type RecoveryArtifact = {
  id?: string;
  pipelineRunId?: string;
  sourceId?: string | null;
  artifactType?: string;
  createdAt?: Date | string | null;
  payload: unknown;
};

type RecoveryCandidateMatch = {
  candidate: Record<string, unknown>;
  matchType: "canonical" | "source";
  artifact: RecoveryArtifact;
  candidateIndex: number;
  earlyAccessEvidence: ReturnType<typeof readEarlyAccessEvidence>;
};

type RecoverySourceWindow = {
  artifacts: RecoveryArtifact[];
  windowTruncated: boolean;
  queryFailed: boolean;
};

const normalizeRecoveryUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  return normalizeTargetUrl(value.trim());
};

const recoveryArtifactTime = (artifact: RecoveryArtifact): number => {
  const value = artifact.createdAt instanceof Date
    ? artifact.createdAt.getTime()
    : typeof artifact.createdAt === "string"
      ? Date.parse(artifact.createdAt)
      : Number.NEGATIVE_INFINITY;
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
};

const compareRecoveryArtifactRecency = (a: RecoveryArtifact, b: RecoveryArtifact): number =>
  recoveryArtifactTime(b) - recoveryArtifactTime(a);

const compareRecoveryArtifacts = (a: RecoveryArtifact, b: RecoveryArtifact): number => {
  const byTime = compareRecoveryArtifactRecency(a, b);
  if (byTime !== 0) return byTime;
  return String(b.id ?? "").localeCompare(String(a.id ?? ""));
};

const readRecoveryCandidates = (payload: unknown): {
  candidates: Array<Record<string, unknown>>;
  truncated: boolean;
} => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { candidates: [], truncated: false };
  const raw = (payload as Record<string, unknown>).candidates;
  if (!Array.isArray(raw)) return { candidates: [], truncated: false };
  return {
    candidates: raw.slice(0, MAX_UPSTREAM_RECOVERY_CANDIDATES_PER_ARTIFACT)
      .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)),
    truncated: raw.length > MAX_UPSTREAM_RECOVERY_CANDIDATES_PER_ARTIFACT,
  };
};

const readEarlyAccessEvidence = (candidate: Record<string, unknown>) => {
  const raw = candidate.accessEvidence;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const classifications = new Set(["PAYWALL_BLOCKED", "METERED_OR_DECLARED", "ACCESSIBLE", "UNKNOWN"]);
  if (!classifications.has(String(value.classification)) || (value.sourceStage !== "agent1" && value.sourceStage !== "agent2")) return null;
  const boundedCodes = (input: unknown) => Array.isArray(input)
    ? input.map((code) => sanitizeEnrichmentEvidenceText(code, 80)).filter((code): code is string => Boolean(code)).slice(0, 12)
    : [];
  return {
    classification: value.classification as "PAYWALL_BLOCKED" | "METERED_OR_DECLARED" | "ACCESSIBLE" | "UNKNOWN",
    sourceStage: value.sourceStage as "agent1" | "agent2",
    evidenceCodes: boundedCodes(value.evidenceCodes),
    contradictingEvidenceCodes: boundedCodes(value.contradictingEvidenceCodes),
  };
};

const makeRecoveryDiagnostics = (input: Partial<EarlyAccessRecoveryDiagnostics> & { status: EarlyAccessRecoveryDiagnostics["status"] }): EarlyAccessRecoveryDiagnostics => ({
  status: input.status,
  artifactTypesQueried: [...RECOVERY_ARTIFACT_TYPES],
  artifactsScanned: input.artifactsScanned ?? 0,
  artifactWindowLimit: MAX_UPSTREAM_RECOVERY_ARTIFACTS,
  candidateLimitPerArtifact: MAX_UPSTREAM_RECOVERY_CANDIDATES_PER_ARTIFACT,
  matchingArtifactType: input.matchingArtifactType ?? null,
  matchingArtifactId: input.matchingArtifactId ?? null,
  candidateMatchType: input.candidateMatchType ?? null,
  windowTruncated: input.windowTruncated ?? false,
});

/**
 * Recover bounded upstream provenance from both Agent 1 and Agent 2 candidate
 * artifacts. Agent 3 remains authoritative: this function only carries early
 * evidence forward and never selects the final access boolean.
 */
export const recoverUpstreamProvenanceBatch = async (
  articles: EnrichmentEligibleArticle[],
): Promise<Map<number, ArticleUpstreamProvenance>> => {
  const result = new Map<number, ArticleUpstreamProvenance>();
  if (articles.length === 0) return result;
  const sourceIds = [...new Set(articles.map((article) => article.sourceId))];

  const sourceWindows = new Map<string, RecoverySourceWindow>();
  let nextSourceIndex = 0;
  const recoverOneSource = async (sourceId: string): Promise<void> => {
    try {
      const rows = await prisma.pipelineArtifact.findMany({
        where: {
          sourceId,
          artifactType: { in: [...RECOVERY_ARTIFACT_TYPES] },
          status: "CAPTURED",
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        // One sentinel row is fetched independently for every source.
        take: MAX_UPSTREAM_RECOVERY_ARTIFACTS + 1,
        select: { id: true, pipelineRunId: true, sourceId: true, artifactType: true, createdAt: true, payload: true },
      });

      const artifacts = rows
        .slice(0, MAX_UPSTREAM_RECOVERY_ARTIFACTS)
        .map((row) => ({
          id: typeof row.id === "string" ? row.id : undefined,
          pipelineRunId: typeof row.pipelineRunId === "string" ? row.pipelineRunId : undefined,
          // Legacy mocked rows may omit sourceId; the query itself scopes them
          // to this source, so use the requested source as the safe fallback.
          sourceId: typeof row.sourceId === "string" ? row.sourceId : sourceId,
          artifactType: typeof row.artifactType === "string" ? row.artifactType : "rss_candidates",
          createdAt: row.createdAt,
          payload: row.payload,
        } satisfies RecoveryArtifact))
        .filter((artifact) => artifact.sourceId === sourceId && RECOVERY_ARTIFACT_TYPES.includes(artifact.artifactType as typeof RECOVERY_ARTIFACT_TYPES[number]))
        .sort(compareRecoveryArtifacts);

      sourceWindows.set(sourceId, {
        artifacts,
        windowTruncated: rows.length > MAX_UPSTREAM_RECOVERY_ARTIFACTS,
        queryFailed: false,
      });
    } catch {
      // Isolate a failed source query. Other sources in the same bounded batch
      // remain recoverable and retain their own truthful diagnostics.
      sourceWindows.set(sourceId, {
        artifacts: [],
        windowTruncated: false,
        queryFailed: true,
      });
    }
  };

  const workerCount = Math.min(MAX_UPSTREAM_RECOVERY_QUERY_CONCURRENCY, sourceIds.length);
  const worker = async (): Promise<void> => {
    while (true) {
      const sourceIndex = nextSourceIndex++;
      if (sourceIndex >= sourceIds.length) return;
      await recoverOneSource(sourceIds[sourceIndex]!);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const validOrigins = new Set(["rss", "atom", "json", "html_fallback", "web_discovery"]);
  for (const article of articles) {
    const conservative = buildArticleProvenance(article);
    const articleCanonical = normalizeRecoveryUrl(article.canonicalUrl);
    const articleSource = normalizeRecoveryUrl(article.sourceUrl);
    const sourceWindow = sourceWindows.get(article.sourceId);
    const candidates = sourceWindow?.artifacts ?? [];
    if (sourceWindow?.queryFailed) {
      result.set(article.id, {
        ...conservative,
        earlyAccessRecovery: makeRecoveryDiagnostics({ status: "QUERY_FAILED" }),
      });
      continue;
    }
    const matches: RecoveryCandidateMatch[] = [];
    let candidateWindowTruncated = false;

    for (const artifact of candidates) {
      const read = readRecoveryCandidates(artifact.payload);
      candidateWindowTruncated ||= read.truncated;
      read.candidates.forEach((candidate, candidateIndex) => {
        const candidateSourceId = candidate.sourceId;
        if (typeof candidateSourceId === "string" && candidateSourceId !== article.sourceId) return;
        const candidateCategoryId = candidate.categoryId;
        if (typeof candidateCategoryId === "string" && article.categoryId && candidateCategoryId !== article.categoryId) return;
        const candidateCanonical = normalizeRecoveryUrl(candidate.canonicalUrl);
        const candidateSource = normalizeRecoveryUrl(candidate.sourceUrl);
        const earlyAccessEvidence = readEarlyAccessEvidence(candidate);
        let matchType: RecoveryCandidateMatch["matchType"] | null = null;

        if (articleCanonical && candidateCanonical === articleCanonical) {
          matchType = "canonical";
        } else if (articleCanonical && !candidateCanonical && candidateSource === articleCanonical) {
          matchType = "source";
        } else if (!articleCanonical && articleSource && candidateCanonical === articleSource) {
          matchType = "canonical";
        } else if (!articleCanonical && articleSource && !candidateCanonical && candidateSource === articleSource) {
          matchType = "source";
        }

        if (matchType) matches.push({ candidate, matchType, artifact, candidateIndex, earlyAccessEvidence });
      });
    }

    matches.sort((a, b) => {
      // Valid bounded evidence is preferred over malformed/missing evidence.
      const byEvidence = Number(Boolean(b.earlyAccessEvidence)) - Number(Boolean(a.earlyAccessEvidence));
      if (byEvidence !== 0) return byEvidence;
      // Among valid exact matches, recency is the primary ordering criterion,
      // independent of canonicalUrl versus legacy sourceUrl identity.
      const byRecency = compareRecoveryArtifactRecency(a.artifact, b.artifact);
      if (byRecency !== 0) return byRecency;
      // Identity strength may only break an artifact-timestamp tie.
      const typeRank = (value: RecoveryCandidateMatch["matchType"]) => value === "canonical" ? 0 : 1;
      const byType = typeRank(a.matchType) - typeRank(b.matchType);
      if (byType !== 0) return byType;
      const byArtifactId = String(b.artifact.id ?? "").localeCompare(String(a.artifact.id ?? ""));
      if (byArtifactId !== 0) return byArtifactId;
      return a.candidateIndex - b.candidateIndex;
    });

    const match = matches[0];
    const windowTruncated = Boolean(sourceWindow?.windowTruncated) || candidateWindowTruncated;
    if (!match) {
      result.set(article.id, {
        ...conservative,
        earlyAccessRecovery: makeRecoveryDiagnostics({
          status: windowTruncated ? "WINDOW_TRUNCATED" : "NO_MATCH",
          artifactsScanned: candidates.length,
          windowTruncated,
        }),
        earlyAccessRecoveryWindowTruncated: windowTruncated,
      });
      continue;
    }

    const provenance = match.candidate.provenance && typeof match.candidate.provenance === "object" && !Array.isArray(match.candidate.provenance)
      ? match.candidate.provenance as Record<string, unknown>
      : {};
    const origin = typeof provenance.origin === "string" && validOrigins.has(provenance.origin) ? provenance.origin as ArticleUpstreamProvenance["feedOrigin"] : null;
    result.set(article.id, {
      sourceId: article.sourceId,
      categoryId: article.categoryId,
      feedOrigin: origin,
      feedUrl: sanitizeEnrichmentEvidenceUrl(provenance.feedUrl),
      originalArticleUrl: sanitizeEnrichmentEvidenceUrl(provenance.originalArticleUrl),
      discoveredFromCategoryFeed: typeof provenance.discoveredFromCategoryFeed === "boolean" ? provenance.discoveredFromCategoryFeed : null,
      ingestArtifactId: match.artifact.id ?? null,
      ingestPipelineRunId: match.artifact.pipelineRunId ?? null,
      arrivedViaHardCaseRerun: null,
      ingestedAt: article.createdAt.toISOString(),
      earlyAccessEvidence: match.earlyAccessEvidence,
      earlyAccessRecovery: makeRecoveryDiagnostics({
        status: "MATCHED",
        artifactsScanned: candidates.length,
        matchingArtifactType: match.artifact.artifactType as "rss_candidates" | "article_discovery_candidates",
        matchingArtifactId: match.artifact.id ?? null,
        candidateMatchType: match.matchType,
        windowTruncated,
      }),
      earlyAccessRecoveryWindowTruncated: windowTruncated,
    });
  }

  return result;
};

// ─── Phase 2: Real HTTP extractor integration ───────────────────────────────

/**
 * Map an extractor rejection reason to the enrichment rejection code.
 * Single source of truth so the runtime never produces invalid codes.
 */
const extractorReasonToRejectionCode = (
  reason: ArticleContentExtractionFail["rejectedReason"],
): EnrichmentRejectionReason["code"] => {
  switch (reason) {
    case "missing_article_url":
      return "NO_ARTICLE_URL";
    case "fetch_failed":
      return "FETCH_TIMEOUT";
    case "http_error":
      return "UNKNOWN";
    case "non_html_response":
      return "UNSUPPORTED_STRUCTURE";
    case "empty_html":
      return "LOW_CONTENT_QUALITY";
    case "no_article_text":
    case "too_short":
      return "LOW_CONTENT_QUALITY";
    case "interstitial_or_challenge":
      return "INTERSTITIAL_OR_CHALLENGE";
    case "paywall_or_blocked":
      return "PAYWALL_BLOCKED";
    case "stale_or_invalid":
      return "OUTSIDE_FRESHNESS_WINDOW";
    case "parse_error":
      return "UNSUPPORTED_STRUCTURE";
    default:
      return "UNKNOWN";
  }
};

/**
 * Determine whether an extractor failure is retryable.
 * Network/timeout errors are retryable; structural/content issues are not.
 */
const isRetryableExtractionFailure = (
  reason: ArticleContentExtractionFail["rejectedReason"],
): boolean => {
  return reason === "fetch_failed";
};

/**
 * Build a full ArticleEnrichmentOutcome from a successful extraction result.
 * Compares extracted fields against existing article values and preserves
 * field provenance for each touched field.
 *
 * When `forceReprocess` is true, uses a lower threshold for body replacement.
 */
const buildOutcomeFromSuccess = (
  article: EnrichmentEligibleArticle,
  result: Extract<ArticleContentExtractionResult, { ok: true }>,
  provenance: ArticleUpstreamProvenance,
  timing: EnrichmentTiming,
  forceReprocess: boolean = false,
): ArticleEnrichmentOutcome => {
  const originalArticleUrl = article.canonicalUrl || article.sourceUrl || null;
  const articleUrl = result.transportUrl || originalArticleUrl;

  // Build field provenance for each extracted field
  const titleProvenance = buildTitleProvenance(article.title, result.title);
  // Only consider extracted bodyText sources, not existing-fallback.
  const bodySource = result.diagnostics.bodySource;
  const extractedBody = (bodySource === "dom" || bodySource === "expanded-dom" || bodySource === "readability" || bodySource === "jsonld")
    ? result.bodyText
    : null;
  const bodyTextProvenance = buildBodyTextProvenance(article.bodyText, extractedBody, forceReprocess);
  const isPaywallProvenance = buildIsPaywallProvenance(
    article.isPaywall,
    result.isPaywall,
    extractedBody,
  );

  const fields: ArticleFieldProvenance = {};

  if (titleProvenance) fields.title = titleProvenance;

  if (bodyTextProvenance) fields.bodyText = bodyTextProvenance;
  // Store excerpt as separate field provenance (never as bodyText)
  if (result.excerpt) {
    fields.excerpt = {
      raw: null,
      chosenValue: result.excerpt,
      chosenFrom: "meta" as FieldProvenanceSource,
      overrideReason: "Extracted from meta description (excerpt only, not bodyText).",
    };
  }
  if (result.imageUrl) {
    fields.imageUrl = {
      raw: null,
      chosenValue: result.imageUrl,
      chosenFrom: "meta" as FieldProvenanceSource,
      overrideReason: "Extracted from og:image/twitter:image.",
    };
  }
  if (result.author) {
    fields.author = {
      raw: null,
      chosenValue: result.author,
      chosenFrom: "meta" as FieldProvenanceSource,
      overrideReason: "Extracted from meta/JSON-LD author.",
    };
  }
  if (result.publishedAt) {
    fields.publishedAt = {
      raw: null,
      chosenValue: result.publishedAt,
      chosenFrom: "meta" as FieldProvenanceSource,
      overrideReason: "Extracted from JSON-LD/meta datePublished.",
    };
  }
  if (isPaywallProvenance) fields.isPaywall = isPaywallProvenance;

  const earlyAccess = provenance.earlyAccessEvidence;
  const finalIsPaywall = isPaywallProvenance?.chosenValue ?? result.isPaywall ?? article.isPaywall;
  const accessSummary = result.access
    ? summarizeArticleAccess(result.access, {
        previousIsPaywall: article.isPaywall,
        earlyStageClassification: earlyAccess?.classification ?? (article.isPaywall ? "PAYWALL_BLOCKED" : null),
        earlyStageSource: earlyAccess?.sourceStage ?? (article.isPaywall ? "agent1" : null),
        earlyStageEvidenceCodes: earlyAccess?.evidenceCodes,
        earlyStageContradictingEvidenceCodes: earlyAccess?.contradictingEvidenceCodes,
        sourceStage: "agent3",
        finalIsPaywall,
        overrideReason: isPaywallProvenance?.overrideReason ?? null,
      })
    : undefined;

  return buildSuccessOutcome({
    articleId: article.id,
    articleUrl,
    provenance,
    method: {
      method: result.method,
      detail: `Real HTTP extractor: ${result.qualitySignals.join(", ")}`,
      resolvedCanonicalUrl: result.resolvedUrl,
      transportUrl: result.transportUrl ?? null,
      originalArticleUrl: result.originalArticleUrl ?? originalArticleUrl,
      redirected: result.resolvedUrl !== articleUrl || articleUrl !== originalArticleUrl,
    },
    timing,
    quality: {
      confidence: result.confidence,
      qualityScore: Math.round(result.confidence * 100),
      signals: result.qualitySignals,
      bodyLength: result.bodyText?.length ?? null,
    },
    fields,
    ...(accessSummary ? { access: accessSummary } : {}),
  });
};

/**
 * Build title field provenance: prefer extracted title if article has no title
 * or if the extracted title is meaningfully different and longer.
 */
function buildTitleProvenance(
  existingTitle: string,
  extractedTitle: string | null,
): { raw: string; chosenValue: string; chosenFrom: FieldProvenanceSource; overrideReason: string } | null {
  if (!extractedTitle) return null;

  const chosenFrom: FieldProvenanceSource =
    !existingTitle || existingTitle.trim().length === 0 ? "meta" : "unchanged";
  const chosenValue = chosenFrom === "meta" ? extractedTitle : existingTitle;

  return {
    raw: existingTitle,
    chosenValue,
    chosenFrom,
    overrideReason:
      chosenFrom === "meta"
        ? "Article had no title; used extracted title."
        : "Kept existing title from Agent 1/2 ingest.",
  };
}

/**
 * Build bodyText field provenance.
 * Uses extracted body if it is better (longer, or article had no body).
 * Does not overwrite good existing body with worse extracted content.
 *
 * When `forceReprocess` is true, uses a lower threshold for replacement:
 *  - new length >= old length * 1.5
 *  - OR new paragraph count >= old paragraph count + 3
 *  - OR old body was lead-like/excerpt-like and new body passes full quality gate
 */
function buildBodyTextProvenance(
  existingBodyText: string | null,
  extractedBodyText: string | null,
  forceReprocess: boolean = false,
): { raw: string | null; chosenValue: string | null; chosenFrom: FieldProvenanceSource; overrideReason: string } | null {
  if (!extractedBodyText) {
    if (!existingBodyText || existingBodyText.trim().length === 0) return null;
    return {
      raw: existingBodyText,
      chosenValue: existingBodyText,
      chosenFrom: "unchanged",
      overrideReason: "Kept existing body because extraction produced no replacement.",
    };
  }

  const existingLength = existingBodyText?.length ?? 0;
  const extractedLength = extractedBodyText.length;
  const existingParagraphs = existingBodyText ? existingBodyText.split(/\n{2,}/).filter((p) => p.trim().length > 0).length : 0;
  const extractedParagraphs = extractedBodyText.split(/\n{2,}/).filter((p) => p.trim().length > 0).length;

  let shouldUseExtracted: boolean;
  let reason: string;

  if (!existingBodyText || existingBodyText.trim().length === 0) {
    // No existing body — always use extracted
    shouldUseExtracted = true;
    reason = `Extracted body (${extractedLength} chars) replaces missing existing body.`;
  } else if (forceReprocess) {
    // Force reprocess: materially better means
    //  - new length >= old length * 1.5
    //  - OR new paragraph count >= old paragraph count + 3
    //  - OR old body is very short (< 500 chars) and new body is substantial
    const materiallyBetter =
      extractedLength >= existingLength * 1.5 ||
      (extractedParagraphs >= existingParagraphs + 3) ||
      (existingLength < 500 && extractedLength >= 1000);
    shouldUseExtracted = materiallyBetter;
    reason = materiallyBetter
      ? `Force reprocess: extracted body (${extractedLength} chars, ${extractedParagraphs} paras) materially better than existing (${existingLength} chars, ${existingParagraphs} paras).`
      : `Force reprocess: extracted body (${extractedLength} chars) not materially better than existing (${existingLength} chars).`;  } else {
    // Normal mode: extracted must be substantially longer
    shouldUseExtracted = extractedLength > existingLength * 1.5;
    reason = shouldUseExtracted
      ? `Extracted body (${extractedLength} chars) replaces shorter existing body (${existingLength} chars).`
      : `Kept existing body (${existingLength} chars); extracted (${extractedLength} chars) not substantially better.`;
  }

  return {
    raw: existingBodyText,
    chosenValue: shouldUseExtracted ? extractedBodyText : existingBodyText,
    chosenFrom: shouldUseExtracted ? "dom" : "unchanged",
    overrideReason: reason,
  };
}

/**
 * Build isPaywall field provenance.
 * Does not overwrite a definitive Agent 1 paywall=true with extracted null.
 */
export function buildIsPaywallProvenance(
  existingIsPaywall: boolean,
  extractedIsPaywall: boolean | null,
  extractedBodyText: string | null = null,
): { raw: boolean; chosenValue: boolean; chosenFrom: FieldProvenanceSource; overrideReason: string } | null {
  const accessibleBodyConfirmed = hasUsableAgent3BodyText(extractedBodyText);

  // A successful substantial extraction is stronger evidence of accessibility
  // than an early-stage text hint from feed/page chrome.
  if (existingIsPaywall && extractedIsPaywall !== true && accessibleBodyConfirmed) {
    return {
      raw: existingIsPaywall,
      chosenValue: false,
      chosenFrom: "dom",
      overrideReason: "Cleared early paywall hint after successful substantial article-body extraction without paywall signals.",
    };
  }

  if (extractedIsPaywall === null) return null;

  return {
    raw: existingIsPaywall,
    chosenValue: extractedIsPaywall,
    chosenFrom: extractedIsPaywall !== existingIsPaywall ? "dom" : "unchanged",
    overrideReason:
      extractedIsPaywall !== existingIsPaywall
        ? "Extractor detected paywall signals not present in Agent 1 ingest."
        : "Paywall status unchanged.",
  };
}

/**
 * Build compact rejection diagnostics from extractor diagnostics.
 * Caps arrays and strings for safe storage in artifact payloads.
 * Never throws — returns null on malformed input.
 */
function buildCompactRejectionDiagnostics(
  diag: ExtractionDiagnostics,
  title: string | null,
): RejectionDiagnostics {
  // Title is included here for admin debugging since it's not in the
  // serialized ArticleEnrichmentOutcome payload.
  return {
    title: title ? title.slice(0, 180) : null,
    selectedContainerSelector: diag.selectedContainerSelector ?? null,
    selectedContainerScore: diag.selectedContainerScore ?? null,
    selectedContainerParagraphCount: diag.selectedContainerParagraphCount ?? null,
    selectedContainerTextLength: diag.selectedContainerTextLength ?? null,
    candidateContainerCount: diag.candidateContainerCount ?? null,
    bodyRejectedReason: diag.bodyRejectedReason ?? null,
    scoreReasons: (diag.scoreReasons ?? []).slice(0, 10),
    bodySource: diag.bodySource ?? null,
    linkTextRatio: typeof diag.linkTextRatio === "number" ? diag.linkTextRatio : null,
    boilerplatePenalty: typeof diag.boilerplatePenalty === "number" ? diag.boilerplatePenalty : null,
    topCandidates: (diag.topCandidates ?? []).slice(0, 5).map((c) => ({
      selector: typeof c.selector === "string" ? c.selector : null,
      score: typeof c.score === "number" ? c.score : null,
      paragraphCount: typeof c.paragraphCount === "number" ? c.paragraphCount : null,
      textLength: typeof c.textLength === "number" ? c.textLength : null,
      reasons: Array.isArray(c.scoreReasons) ? c.scoreReasons.slice(0, 10) : [],
    })),
    stoppedAtText: diag.stoppedAtText
      ? diag.stoppedAtText.slice(0, 120)
      : null,
    stoppedAtClassOrId: diag.stoppedAtClassOrId
      ? diag.stoppedAtClassOrId.slice(0, 160)
      : null,
    excludedBlockCount: typeof diag.excludedBlockCount === "number" ? diag.excludedBlockCount : null,
  };
}

/**
 * Browser fallback options for a single article extraction attempt.
 */
export interface BrowserFallbackConfig {
  /** Timeout per browser fallback attempt in ms. */
  timeoutMs: number;
  /** If set, browser fallback is skipped for this article with the given reason. */
  skippedReason?: BrowserFallbackSkippedReason;
}

/**
 * Run the real HTTP article content extractor and build a canonical
 * `ArticleEnrichmentOutcome` from the result.
 *
 * This is the Phase 2 replacement for the Phase 1 stub extractor.
 * It:
 *  - chooses articleUrl = canonicalUrl || sourceUrl
 *  - calls extractArticleContentFromUrl()
 *  - maps the extraction result to the existing ArticleEnrichmentOutcome contract
 *  - builds SUCCESS when extraction succeeds
 *  - builds failure/skipped outcome when extraction fails
 *  - preserves Agent 1/Agent 2 upstream provenance
 *  - does not overwrite good existing fields with worse values
 *
 * Phase 3: When `browserFallback` is provided and static extraction fails
 * with a browser-eligible reason, attempts browser fallback extraction.
 * Browser success produces a normal SUCCESS outcome with method="browser-dom".
 * Browser failure metadata is attached to the outcome for admin diagnostics.
 */
export const extractAndBuildArticleOutcome = async (
  article: EnrichmentEligibleArticle,
  now: Date = new Date(),
  provenanceOverride?: ArticleUpstreamProvenance,
  forceReprocess: boolean = false,
  browserFallback?: BrowserFallbackConfig,
  telemetry?: StageBatchProbe,
  governedFetchContextOverride?: Partial<GovernedFetchContext>,
  browserSession?: Agent3BrowserSession,
): Promise<ArticleEnrichmentOutcome> => {
  const provenance = preserveOriginalArticleUrl(
    article,
    provenanceOverride ?? buildArticleProvenance(article),
  );
  const articleUrl = article.canonicalUrl || article.sourceUrl || null;
  const startedAt = now.getTime();

  if (!articleUrl) {
    const timing: EnrichmentTiming = {
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 0,
    };
    return buildSkippedOutcome({
      articleId: article.id,
      articleUrl: null,
      provenance,
      reasonCode: "NO_ARTICLE_URL",
      detail: "Article has no canonicalUrl or sourceUrl.",
      timing,
    });
  }

  // Run the real HTTP extractor
  let result: ArticleContentExtractionResult;
  try {
    const governedFetchContext: GovernedFetchContext = {
      ...(governedFetchContextOverride ?? {}),
      agent: "agent3",
      stage: "article-enrichment",
      purpose: "article_extraction",
      sourceId: article.sourceId,
      articleId: article.id,
    };
    result = await extractArticleContentFromUrl({
      articleId: article.id,
      articleUrl,
      existingTitle: article.title,
      existingBodyText: article.bodyText,
      now,
      telemetry,
      governedFetchContext,
    });
  } catch (err: unknown) {
    // A governor defer is a neutral retry boundary. It must not become an
    // UNKNOWN/failure outcome or enter browser fallback eligibility.
    if (err instanceof GovernedFetchDeferredError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();
    const timing: EnrichmentTiming = {
      startedAt: now.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt,
    };
    return buildFailureOutcome({
      articleId: article.id,
      articleUrl,
      provenance,
      reason: { code: "UNKNOWN", detail: `Unexpected extractor error: ${message}` },
      retryable: false,
      error: message,
      timing,
    });
  }

  const finishedAt = new Date();
  const timing: EnrichmentTiming = {
    startedAt: now.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt,
    fetchMs: null,
    extractMs: null,
  };

  // Handle success
  if (result.ok) {
    return buildOutcomeFromSuccess(article, result, provenance, timing, forceReprocess);
  }

  // Handle failure — check if browser fallback should be attempted
  let rejectionCode = extractorReasonToRejectionCode(result.rejectedReason);
  const retryable = isRetryableExtractionFailure(result.rejectedReason);

  // Phase 3: Browser fallback logic with per-artifact skipped reason
  const failureOutcome = buildFailureOutcome({
    articleId: article.id,
    articleUrl,
    provenance,
    reason: {
      code: rejectionCode,
      detail: `[${result.rejectedReason}] ${result.detail}`,
      httpStatus: result.statusCode,
      retryAfterAt: result.retryAfterAt,
    },
    retryable,
      method: {
        method: result.method !== "none" ? result.method : "http-dom",
        transportUrl: result.transportUrl ?? null,
        originalArticleUrl: result.originalArticleUrl ?? articleUrl,
      },
    timing,
    httpStatus: result.statusCode,
  });

  // Attach compact rejection diagnostics from the extractor result.
  failureOutcome.rejectionDiagnostics = buildCompactRejectionDiagnostics(
    result.diagnostics,
    article.title,
  );
  if (result.access) {
    const earlyAccess = provenance.earlyAccessEvidence;
    failureOutcome.access = summarizeArticleAccess(result.access, {
      previousIsPaywall: article.isPaywall,
      earlyStageClassification: earlyAccess?.classification ?? (article.isPaywall ? "PAYWALL_BLOCKED" : null),
      earlyStageSource: earlyAccess?.sourceStage ?? (article.isPaywall ? "agent1" : null),
      earlyStageEvidenceCodes: earlyAccess?.evidenceCodes,
      earlyStageContradictingEvidenceCodes: earlyAccess?.contradictingEvidenceCodes,
      sourceStage: "agent3",
      finalIsPaywall: result.access.isPaywall ?? article.isPaywall,
      overrideReason: result.access.classification === "PAYWALL_BLOCKED"
        ? "Agent 3 confirmed article-scoped blocking evidence."
        : null,
    });
  }

  // Determine browser fallback skipped reason and attempt if eligible
  if (browserFallback?.skippedReason) {
    // Runtime may suppress browser work because of a prior host observation or
    // an invocation budget. The current static result still owns eligibility:
    // an inherently ineligible failure must be reported as not_eligible rather
    // than attributing the skip to an earlier host 429.
    const eligible = isBrowserFallbackEligibleForFailure(result);
    const skippedReason = eligible ? browserFallback.skippedReason : "not_eligible";
    failureOutcome.browserFallback = buildBrowserFallbackSkippedMetadata(
      skippedReason,
      result,
    );
  } else if (browserFallback && isBrowserFallbackEligibleForFailure(result)) {
    // Browser fallback is available and the failure is eligible — attempt it
    const browserArticleUrl = getHttpsArticleUrl(articleUrl) ?? articleUrl;
    const browserArticle = browserArticleUrl === articleUrl
      ? article
      : { ...article, canonicalUrl: browserArticleUrl };
    const browserGovernorContext: BrowserNavigationGovernorContext = {
      agent: "agent3",
      stage: "article-content-browser-extraction",
      mode: governedFetchContextOverride?.mode,
      db: governedFetchContextOverride?.db,
    };
    try {
      browserSession?.assertCanStart(browserArticleUrl);
    } catch (error) {
      if (error instanceof GovernedFetchDeferredError) throw error;
      if (error instanceof Agent3BrowserSessionError && error.reason === "time_budget_exhausted") {
        throw new GovernedFetchDeferredError("browser_time_budget_exhausted", error.domainKey);
      }
      throw error;
    }
    const browserPermit = await acquireBrowserNavigationPermit({
      url: browserArticleUrl,
      context: browserGovernorContext,
    });
    if (!browserPermit.allowed) {
      throw new GovernedFetchDeferredError(browserPermit.reason, browserPermit.evidence.domainKey);
    }
    telemetry?.recordBrowserAttempt();
    telemetry?.recordNetworkRequest();
    const browserTask = () => attemptBrowserFallback(
      browserArticle,
      browserFallback.timeoutMs,
      browserGovernorContext,
      browserPermit,
      browserSession,
    );
    const browserResult = telemetry
      ? await telemetry.timed("browser", browserTask)
      : await browserTask();

    if (browserResult.ok) {
      // Browser fallback succeeded — build success outcome using shared helper
      const outcome = buildOutcomeFromSuccess(browserArticle, browserResult, provenance, timing, forceReprocess);
      outcome.method.detail = `Browser fallback extractor: ${browserResult.qualitySignals.join(", ")}`;
      outcome.browserFallback = {
        attempted: true,
        succeeded: true,
        staticStatusCode: result.statusCode ?? null,
        staticRejectedReason: result.rejectedReason,
        staticMethod: result.method !== "none" ? result.method : null,
        method: browserResult.method,
        rejectedReason: null,
        browserRejectedReason: null,
        statusCode: browserResult.statusCode,
        runtimeUnavailable: false,
        rateLimited: false,
        confidence: browserResult.confidence,
        browserDiagnostics: browserResult.diagnostics.browserNavigation
          ? {
              selectedContainerSelector: null,
              paragraphCount: null,
              totalTextLength: null,
              candidateContainerCount: null,
              stoppedAtText: null,
              stoppedAtClassOrId: null,
              topCandidates: [],
              navigation: browserResult.diagnostics.browserNavigation,
            }
          : null,
      };
      return outcome;
    }

    // Browser fallback failed — attach browser metadata to the static failure
    failureOutcome.browserFallback = buildBrowserFallbackMetadata(browserResult, result);
  } else {
    // No browser config OR failure not eligible for browser fallback
    const eligible = isBrowserFallbackEligibleForFailure(result);
    const reason: BrowserFallbackSkippedReason = !browserFallback
      ? (eligible ? "browser_disabled" : "not_eligible")
      : "not_eligible";
    failureOutcome.browserFallback = buildBrowserFallbackSkippedMetadata(reason, result);
  }

  return failureOutcome;
};

/**
 * Post-hoc classification: upgrade a failure outcome to HTTP_ACCESS_BLOCKED
 * when the static fetch or browser fallback received HTTP 403 or 429.
 *
 * Runs after all browser fallback attempts so it catches both the
 * static-only and the post-browser-fallback paths. Modifies the
 * outcome in place.
 */
const emptyAgent3HttpEvidence = (): Agent3HttpEvidenceSummary => ({
  static403: 0,
  static429: 0,
  browser403: 0,
  browser429: 0,
  accessDenied403: 0,
  rateLimited403: 0,
  rateLimited429: 0,
});

/**
 * Extract HTTP evidence from one outcome before effective-status mutation.
 * Static and browser statuses are separate events; a static 403 followed by a
 * browser 429 therefore contributes once to each event bucket. A generic 403
 * is access denied, never a rate limit, unless a future explicit evidence field
 * says otherwise.
 */
export function collectAgent3HttpEvidence(
  outcome: ArticleEnrichmentOutcome,
): Agent3HttpEvidenceSummary {
  const evidence = emptyAgent3HttpEvidence();
  const browser = outcome.browserFallback;
  const staticStatus = browser?.staticStatusCode ?? outcome.rejection?.httpStatus ?? null;
  const browserStatus = browser?.attempted ? browser.statusCode : null;

  if (staticStatus === 403) {
    evidence.static403 = 1;
    evidence.accessDenied403 += 1;
  } else if (staticStatus === 429) {
    evidence.static429 = 1;
    evidence.rateLimited429 += 1;
  }

  if (browserStatus === 403) {
    evidence.browser403 = 1;
    evidence.accessDenied403 += 1;
  } else if (browserStatus === 429) {
    evidence.browser429 = 1;
    evidence.rateLimited429 += 1;
  }

  return evidence;
}

const mergeAgent3HttpEvidence = (
  target: Agent3HttpEvidenceSummary,
  addition: Agent3HttpEvidenceSummary,
): void => {
  for (const key of Object.keys(target) as Array<keyof Agent3HttpEvidenceSummary>) {
    target[key] += addition[key];
  }
};

const recordAgent3HttpEvidence = (
  probe: StageBatchProbe,
  evidence: Agent3HttpEvidenceSummary,
): void => {
  if (evidence.accessDenied403 > 0) {
    for (let i = 0; i < evidence.accessDenied403; i += 1) probe.recordAccessDenied403();
  }
  if (evidence.rateLimited403 > 0) {
    for (let i = 0; i < evidence.rateLimited403; i += 1) probe.recordRateLimited(403);
  }
  if (evidence.rateLimited429 > 0) {
    for (let i = 0; i < evidence.rateLimited429; i += 1) probe.recordRateLimited(429);
  }
};

function classifyHttpAccessBlocked(outcome: ArticleEnrichmentOutcome): void {
  const rejection = outcome.rejection;
  const httpStatus = outcome.browserFallback?.statusCode
    ?? rejection?.httpStatus
    ?? null;
  const isHttpBlocked =
    httpStatus === 403 || httpStatus === 429 ||
    (rejection?.code === "HTTP_FORBIDDEN") ||
    outcome.browserFallback?.rateLimited === true;

  if (isHttpBlocked) {
    outcome.kind = "HTTP_ACCESS_BLOCKED";
    if (rejection) {
      if (rejection.code !== "HTTP_FORBIDDEN") {
        rejection.code = "HTTP_FORBIDDEN";
      }
      // Update httpStatus and detail to reflect the final effective status.
      // Browser fallback statusCode takes precedence over the static fetch
      // status so isRecentlyBlocked applies the correct cooldown window.
      // The detail string is also updated so isRecentlyBlocked's detail-based
      // checks don't apply the wrong cooldown (e.g. static 403 detail
      // triggering 24h cooldown when the final status was actually 429/1h).
      if (outcome.browserFallback?.statusCode != null) {
        const browserStatus = outcome.browserFallback.statusCode;
        rejection.httpStatus = browserStatus;
        if (rejection.detail && /\[http_error\] HTTP \d+/.test(rejection.detail)) {
          rejection.detail = rejection.detail.replace(
            /\[http_error\] HTTP \d+/,
            `[http_error] HTTP ${browserStatus}`,
          );
        }
      }
    }
  }
}

/**
 * Attempt browser fallback extraction for an article.
 * Returns the raw extraction result (may be ok or fail).
 */
async function attemptBrowserFallback(
  article: EnrichmentEligibleArticle,
  timeoutMs: number,
  governorContext: BrowserNavigationGovernorContext,
  governorPermit: Extract<BrowserNavigationAcquireResult, { allowed: true }>,
  browserSession?: Agent3BrowserSession,
): Promise<ArticleContentExtractionResult> {
  const articleUrl = article.canonicalUrl || article.sourceUrl || "";
  try {
    return await extractArticleContentWithBrowser({
      articleUrl,
      existingTitle: article.title,
      existingBodyText: article.bodyText,
      timeoutMs,
      governorContext,
      governorPermit,
      browserSession,
    });
  } catch (err: unknown) {
    if (err instanceof GovernedFetchDeferredError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      method: "browser-dom",
      resolvedUrl: articleUrl,
      statusCode: null,
      rejectedReason: "fetch_failed",
      detail: `Browser fallback unexpected error: ${message}`,
      confidence: 0,
      qualitySignals: ["browser_unexpected_error"],
      diagnostics: {
        selectedContainerSelector: null,
        selectedContainerScore: null,
        selectedContainerParagraphCount: null,
        selectedContainerTextLength: null,
        candidateContainerCount: 0,
        bodyRejectedReason: null,
        scoreReasons: [],
        excerptLength: null,
        bodyEqualsExcerpt: false,
        bodySource: "none",
        linkTextRatio: null,
        boilerplatePenalty: null,
        topCandidates: [],
        usedExpansion: false,
        expansionType: null,
        leadLikePenaltyApplied: false,
        stopReason: null,
        boundaryMarkersSeen: 0,
        stoppedAtText: null,
        stoppedAtClassOrId: null,
        excludedBlockCount: 0,
        skippedCandidateReasons: [],
      },
    };
  }
}

/**
 * Build BrowserFallbackMetadata from a browser extraction result.
 * Includes the original static failure reason, browser-specific rejection
 * reason, and compact browser-side diagnostics when the fallback fails.
 */
function buildBrowserFallbackMetadata(
  browserResult: ArticleContentExtractionResult,
  staticResult: ArticleContentExtractionFail,
): BrowserFallbackMetadata {
  const runtimeUnavailable =
    !browserResult.ok && browserResult.qualitySignals.includes("browser_runtime_unavailable");
  const rateLimited =
    !browserResult.ok && browserResult.statusCode === 429;

  // Determine browser-specific rejection reason:
  // "browser_runtime_unavailable" when the browser itself couldn't launch
  // otherwise the extraction result's rejectedReason
  const browserRejectedReason = runtimeUnavailable
    ? "browser_runtime_unavailable"
    : browserResult.ok
      ? null
      : (browserResult.rejectedReason || null);

  // Build compact browser diagnostics without retaining URLs, headers, bodies,
  // cookies, storage, or provider tokens.
  let browserDiagnostics: BrowserDiagnostics | null = null;
  if (!browserResult.ok || browserResult.diagnostics.browserNavigation) {
    const diag = browserResult.diagnostics;
    browserDiagnostics = {
      selectedContainerSelector: diag.selectedContainerSelector ?? null,
      paragraphCount: diag.selectedContainerParagraphCount ?? null,
      totalTextLength: diag.selectedContainerTextLength ?? null,
      candidateContainerCount: diag.candidateContainerCount ?? null,
      stoppedAtText: diag.stoppedAtText ? diag.stoppedAtText.slice(0, 120) : null,
      stoppedAtClassOrId: diag.stoppedAtClassOrId ? diag.stoppedAtClassOrId.slice(0, 160) : null,
      topCandidates: (diag.topCandidates ?? []).slice(0, 5).map((c) => ({
        selector: typeof c.selector === "string" ? c.selector : null,
        score: typeof c.score === "number" ? c.score : null,
        paragraphCount: typeof c.paragraphCount === "number" ? c.paragraphCount : null,
        textLength: typeof c.textLength === "number" ? c.textLength : null,
      })),
      navigation: diag.browserNavigation ?? null,
    };
  }

  return {
    attempted: true,
    succeeded: browserResult.ok,
    staticStatusCode: staticResult.statusCode ?? null,
    staticRejectedReason: staticResult.rejectedReason,
    staticMethod: staticResult.method !== "none" ? staticResult.method : null,
    method: browserResult.method || null,
    rejectedReason: browserResult.ok ? null : (browserResult.rejectedReason || null),
    browserRejectedReason,
    statusCode: browserResult.statusCode ?? null,
    runtimeUnavailable,
    rateLimited,
    confidence: browserResult.ok ? browserResult.confidence : null,
    browserDiagnostics,
  };
}

/**
 * Build BrowserFallbackMetadata for a skipped browser fallback attempt.
 * Sets attempted=false and the given skipped reason.
 */
function buildBrowserFallbackSkippedMetadata(
  skippedReason: BrowserFallbackSkippedReason,
  staticResult: ArticleContentExtractionFail,
): BrowserFallbackMetadata {
  return {
    attempted: false,
    succeeded: false,
    staticStatusCode: staticResult.statusCode ?? null,
    staticRejectedReason: staticResult.rejectedReason,
    staticMethod: staticResult.method !== "none" ? staticResult.method : null,
    method: null,
    rejectedReason: null,
    browserRejectedReason: null,
    statusCode: null,
    runtimeUnavailable: false,
    rateLimited: false,
    confidence: null,
    browserDiagnostics: null,
    browserFallbackSkippedReason: skippedReason,
  };
}

// ─── Source cooldown and diversity ─────────────────────────────────────────

/**
 * Maximum articles from a single source per batch.
 * Prevents one blocked source from consuming the entire batch.
 */
const DEFAULT_MAX_ARTICLES_PER_SOURCE = 5;
const MIN_MAX_ARTICLES_PER_SOURCE = 1;
const MAX_MAX_ARTICLES_PER_SOURCE = 25;

/** Cooldown threshold: consecutive failures from the same source before cooling down. */
const SOURCE_COOLDOWN_THRESHOLD = 3;

/** Failure reasons eligible for source cooldown tracking. */
const COOLDOWN_ELIGIBLE_REASONS: ReadonlySet<string> = new Set([
  "http_error",
  "fetch_failed",
  "no_article_text",
  "empty_html",
]);

/** Source cooldown entry for PipelineRun.summary. */
export interface SourceCooldownEntry {
  sourceId: string;
  hostname: string;
  reason: "http_403" | "http_429" | "browser_runtime_unavailable";
  failureCount: number;
  skippedInRun: number;
  firstFailureAt: string;
  lastFailureAt: string;
}

/**
 * Extract hostname from a URL string for admin diagnostics grouping.
 * Returns "unknown" for malformed URLs.
 */
export function extractHostname(url: string | null | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

/**
 * In-run source cooldown tracker.
 * Tracks consecutive failures per sourceId and stops selecting articles
 * from sources that repeatedly fail (HTTP 403, 429, etc.).
 */
export class SourceCooldownTracker {
  private consecutiveFailures = new Map<string, number>();
  private cooldowns = new Map<string, SourceCooldownEntry>();
  private skipCounts = new Map<string, number>();
  private hostnames = new Map<string, string>();

  /**
   * Record an extraction failure for a source.
   * If the source hits the cooldown threshold, it is added to cooldown.
   * Returns true if the source was newly added to cooldown.
   */
  recordFailure(
    sourceId: string,
    hostname: string,
    rejectedReason: string,
    statusCode: number | null,
    runtimeUnavailable: boolean = false,
  ): boolean {
    if (!COOLDOWN_ELIGIBLE_REASONS.has(rejectedReason)) return false;

    this.hostnames.set(sourceId, hostname);

    const count = (this.consecutiveFailures.get(sourceId) ?? 0) + 1;
    this.consecutiveFailures.set(sourceId, count);

    if (runtimeUnavailable) {
      return this.addToCooldown(sourceId, hostname, "browser_runtime_unavailable");
    }
    if (statusCode === 429) {
      return this.addToCooldown(sourceId, hostname, "http_429");
    }
    if (statusCode === 403 && count >= SOURCE_COOLDOWN_THRESHOLD) {
      return this.addToCooldown(sourceId, hostname, "http_403");
    }
    return false;
  }

  /** Record a success for a source (resets consecutive failure count). */
  recordSuccess(sourceId: string): void {
    this.consecutiveFailures.delete(sourceId);
  }

  /** Check if a source is in cooldown. */
  isCoolingDown(sourceId: string): boolean {
    return this.cooldowns.has(sourceId);
  }

  /** Increment skip count for a cooled-down source. */
  incrementSkip(sourceId: string): void {
    this.skipCounts.set(sourceId, (this.skipCounts.get(sourceId) ?? 0) + 1);
  }

  /** Get cooldown entries for persistence. */
  getEntries(): SourceCooldownEntry[] {
    const entries: SourceCooldownEntry[] = [];
    for (const [sourceId, entry] of this.cooldowns) {
      entries.push({
        ...entry,
        skippedInRun: this.skipCounts.get(sourceId) ?? 0,
      });
    }
    return entries;
  }

  private addToCooldown(
    sourceId: string,
    hostname: string,
    reason: SourceCooldownEntry["reason"],
  ): boolean {
    if (this.cooldowns.has(sourceId)) return false;
    const now = new Date().toISOString();
    this.cooldowns.set(sourceId, {
      sourceId,
      hostname,
      reason,
      failureCount: this.consecutiveFailures.get(sourceId) ?? 0,
      skippedInRun: 0,
      firstFailureAt: now,
      lastFailureAt: now,
    });
    return true;
  }
}

/**
 * Apply source diversity to a batch of articles.
 * Groups articles by sourceId and round-robins across groups. Without a fill
 * target, `maxPerSource` is a hard cap. With a fill target, it is a first-pass
 * diversity cap and remaining capacity is backfilled deterministically.
 */
export function applySourceDiversity<T extends { sourceId: string }>(
  articles: T[],
  maxPerSource: number,
  fillTarget?: number,
): T[] {
  const capped = Math.min(Math.max(maxPerSource, MIN_MAX_ARTICLES_PER_SOURCE), MAX_MAX_ARTICLES_PER_SOURCE);
  const target = fillTarget === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.min(Math.trunc(fillTarget), articles.length));
  const bySource = new Map<string, T[]>();

  for (const article of articles) {
    const group = bySource.get(article.sourceId) ?? [];
    group.push(article);
    bySource.set(article.sourceId, group);
  }

  // First pass round-robins up to the soft per-source cap. When a fill target
  // is supplied, a second pass backfills unused capacity from the remaining
  // candidates. This preserves source diversity without shrinking a batch
  // merely because the ready queue is temporarily dominated by one source.
  const result: T[] = [];
  const sourceIds = [...bySource.keys()];
  const indices = new Map<string, number>();
  for (const id of sourceIds) indices.set(id, 0);

  let added = true;
  while (added && result.length < target) {
    added = false;
    for (const sourceId of sourceIds) {
      const group = bySource.get(sourceId)!;
      const idx = indices.get(sourceId)!;
      if (idx < Math.min(group.length, capped)) {
        result.push(group[idx]!);
        indices.set(sourceId, idx + 1);
        added = true;
        if (result.length >= target) break;
      }
    }
  }

  if (fillTarget !== undefined) {
    added = true;
    while (added && result.length < target) {
      added = false;
      for (const sourceId of sourceIds) {
        const group = bySource.get(sourceId)!;
        const idx = indices.get(sourceId)!;
        if (idx < group.length) {
          result.push(group[idx]!);
          indices.set(sourceId, idx + 1);
          added = true;
          if (result.length >= target) break;
        }
      }
    }
  }

  return result;
}

/**
 * Controlled stub extractor (Phase 1 placeholder, retained for tests).
 *
 * This is NOT a real extractor. It exercises the full persistence contract
 * so Phase 2 only needs to swap in the real HTTP/meta/DOM extraction. It is
 * deliberately conservative and non-destructive:
 *  - If the article has no canonical/source URL → SKIPPED (NO_ARTICLE_URL).
 *  - If the article is already enriched (defensive; selection should filter)
 *    → SKIPPED (ALREADY_ENRICHED).
 *  - Otherwise → SUCCESS with feed-only provenance and NO field overrides
 *    (every field marked `unchanged`), so no real data is mutated.
 *
 * @param provenanceOverride Optional precise provenance recovered from Agent 1
 *   artifacts. When omitted, the conservative `buildArticleProvenance` fallback
 *   is used (backward-compatible with existing callers).
 */
export const stubExtractArticle = (
  article: EnrichmentEligibleArticle,
  now: Date = new Date(),
  provenanceOverride?: ArticleUpstreamProvenance,
): ArticleEnrichmentOutcome => {
  const provenance = provenanceOverride ?? buildArticleProvenance(article);
  const articleUrl = article.canonicalUrl || article.sourceUrl || null;

  const timing: EnrichmentTiming = {
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: 0,
  };

  if (!articleUrl) {
    return buildSkippedOutcome({
      articleId: article.id,
      articleUrl: null,
      provenance,
      reasonCode: "NO_ARTICLE_URL",
      detail: "Article has no canonicalUrl or sourceUrl.",
      timing,
    });
  }

  if (article.enrichmentStatus === "ENRICHED") {
    return buildSkippedOutcome({
      articleId: article.id,
      articleUrl,
      provenance,
      reasonCode: "ALREADY_ENRICHED",
      detail: "Article already enriched; skipped by stub.",
      timing,
    });
  }

  // Conservative SUCCESS: keep all feed values, mark every field `unchanged`.
  return buildSuccessOutcome({
    articleId: article.id,
    articleUrl,
    provenance,
    method: {
      method: "http-meta",
      detail: "stub-extractor (Phase 1 placeholder)",
      resolvedCanonicalUrl: articleUrl,
      redirected: false,
    },
    timing,
    quality: {
      confidence: 0.5,
      qualityScore: 50,
      signals: ["stub_extractor"],
      bodyLength: article.bodyText ? article.bodyText.length : 0,
    },
    fields: {
      title: {
        raw: article.title,
        chosenValue: article.title,
        chosenFrom: "unchanged",
        overrideReason: "Stub: no field override (Phase 1 placeholder).",
      },
      ...(article.bodyText
        ? {
            bodyText: {
              raw: article.bodyText,
              chosenValue: article.bodyText,
              chosenFrom: "unchanged",
              overrideReason: "Stub: kept feed body (Phase 1 placeholder).",
            },
          }
        : {}),
      isPaywall: {
        raw: article.isPaywall,
        chosenValue: article.isPaywall,
        chosenFrom: "unchanged",
        overrideReason: "Stub: kept Agent 1 paywall hint (Phase 1 placeholder).",
      },
    },
  });
};

// ─── Agent 3 Progress Reporting ─────────────────────────────────────────────

/**
 * Progress snapshot for Agent 3 enrichment.
 * Used by the admin UI to show how many articles still need review.
 */
export interface Agent3Progress {
  /** Immediately actionable NEW + retry-tier articles. */
  readyNew: number;
  readyRetry: number;
  /** Alias retained for existing callers: readyNew + readyRetry. */
  retryableNow: number;
  deferred: number;
  nextRetryAt: string | null;
  quarantined: number;
  nonRetryable: number;
  inProgress: number;
  totalOutstanding: number;
  exhaustedAttempts: number;
  eligibleNow: number;
  recentlyBlocked: number;
  /** Current-version permanent failures that won't be retried until extractor version changes or force reprocess. */
  nonRetryableCurrentVersionFailures: number;
  totalInScope: number;
    enrichedInScope: number;
    needingInitialEnrichment: number;
    failedRetryable: number;
    needsCurrentVersionReprocess: number;
    currentVersionComplete: number;
  selectedMode: {
    includeEnriched: boolean;
    forceReprocess: boolean;
    hasArticleFilter: boolean;
    hasSourceFilter: boolean;
  };
  latestRun: {
    pipelineRunId: string | null;
    processed: number;
    successfullyEnriched: number;
    rejected: number;
    persistedOutcomes: number;
    systemPersistFailed: number;
    durationMs: number | null;
    finishedAt: string | null;
    byKind: Record<string, number>;
    browserFallbackStats?: {
      enabled: boolean;
      attempted: number;
      succeeded: number;
      failed: number;
      runtimeUnavailable: number;
      rateLimited: number;
      stoppedReason: string | null;
    } | null;
    optionsUsed?: {
      browserFallback: boolean;
      browserFallbackMaxAttempts: number;
      browserTimeoutMs: number;
      includeEnriched: boolean;
      forceReprocess: boolean;
      maxArticles: number;
      maxArticlesPerSource: number;
    } | null;
    sourceCooldowns?: SourceCooldownEntry[] | null;
  } | null;
  remainingAfterLatestRun: number;
  /** True if the safety cap was hit and counts may be incomplete. */
  progressTruncated: boolean;
  /** Total ENRICHED articles scanned for version-aware counts. */
  progressScanned: number;
}

/**
 * Options for Agent 3 progress query.
 */
export interface Agent3ProgressOptions {
  now?: Date;
  includeEnriched?: boolean;
  forceReprocess?: boolean;
  sourceIds?: string[];
  articleIds?: number[];
  pipelineRunId?: string;
}

/**
 * Page size for scanning ENRICHED articles in progress counting.
 * Bounded to keep individual DB queries fast.
 */
const PROGRESS_SCAN_PAGE_SIZE = 500;

/**
 * Hard safety cap for progress scanning. If more than this many ENRICHED
 * articles exist in scope, scanning stops and sets progressTruncated=true.
 * This prevents unbounded memory/CPU usage while still covering production
 * scale (normal deployments have <20k articles in retention window).
 */
const PROGRESS_SCAN_SAFETY_CAP = 20_000;

/**
 * Scan ENRICHMENT_FAILED articles in scope to count non-retryable current-version
 * failures. These are articles that failed with the current extractor version and
 * a permanent failure kind (LOW_CONTENT_QUALITY, UNSUPPORTED_STRUCTURE, etc.).
 *
 * Returns the count of non-retryable failures and total scanned.
 */
async function scanNonRetryableFailures(
  baseWhere: Record<string, unknown>,
  now: Date,
  excludedArticleIds: ReadonlySet<number> = new Set(),
  blockState?: RecentBlockState,
): Promise<{
  count: number;
  readyRetry: number;
  deferred: number;
  exhaustedAttempts: number;
  nonRetryable: number;
  nextRetryAt: string | null;
  scanned: number;
  truncated: boolean;
}> {
  let count = 0;
  let readyRetry = 0;
  let deferred = 0;
  let exhaustedAttempts = 0;
  let nonRetryable = 0;
  let nextRetryAt: string | null = null;
  let scanned = 0;
  let cursor: number | undefined;

  while (scanned < PROGRESS_SCAN_SAFETY_CAP) {
    const page = await prisma.article.findMany({
      where: { ...baseWhere, enrichmentStatus: "ENRICHMENT_FAILED" },
      select: {
        id: true,
        enrichmentOutcome: true,
        enrichmentFinishedAt: true,
        enrichmentAttemptCount: true,
        enrichmentStatus: true,
        enrichmentClaim: true,
        canonicalUrl: true,
        sourceUrl: true,
      },
      take: PROGRESS_SCAN_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });

    if (!Array.isArray(page) || page.length === 0) break;
    scanned += page.length;

    for (const article of page) {
      if (excludedArticleIds.has(article.id)) continue;
      if (article.enrichmentClaim) continue;
      if (blockState && isBlockedByRecentBlockState(article, blockState)) {
        deferred++;
        const hostname = articleHostname(article);
        const retryAfter = blockState.retryAfterByArticleId.get(article.id)
          ?? blockState.retryAfterByHostname.get(hostname);
        if (retryAfter && (!nextRetryAt || Date.parse(retryAfter) < Date.parse(nextRetryAt))) {
          nextRetryAt = retryAfter;
        }
        continue;
      }
      const disposition = decideAgent3RetryDisposition({ ...article, now });
      if (disposition.state === "READY_RETRY") readyRetry++;
      if (disposition.state === "DEFERRED") {
        deferred++;
        if (!nextRetryAt || Date.parse(disposition.retryAfter) < Date.parse(nextRetryAt)) {
          nextRetryAt = disposition.retryAfter;
        }
      }
      if (disposition.state === "QUARANTINED") {
        exhaustedAttempts++;
        count++;
      }
      if (disposition.state === "NON_RETRYABLE") {
        nonRetryable++;
        count++;
      }
    }

    cursor = page[page.length - 1]!.id;
    if (page.length < PROGRESS_SCAN_PAGE_SIZE) break;
  }

  let truncated = false;
  if (scanned >= PROGRESS_SCAN_SAFETY_CAP) {
    const moreExist = await prisma.article.count({
      where: { ...baseWhere, enrichmentStatus: "ENRICHMENT_FAILED" },
      skip: PROGRESS_SCAN_SAFETY_CAP,
      take: 1,
    });
    truncated = moreExist > 0;
  }

  return { count, readyRetry, deferred, exhaustedAttempts, nonRetryable, nextRetryAt, scanned, truncated };
}

/**
 * Scan all ENRICHED articles in scope using cursor-based pagination,
 * applying needsAgent3CurrentVersionReprocess in memory.
 *
 * Returns accurate counts without the MAX_ARTICLES_PER_RUN cap.
 * Uses bounded page queries (500 at a time) for DB efficiency.
 */
async function scanReadyNewArticles(
  baseWhere: Record<string, unknown>,
  now: Date,
  excludedArticleIds: ReadonlySet<number>,
  blockState: RecentBlockState,
): Promise<{ ready: number; deferred: number }> {
  let ready = 0;
  let deferred = 0;
  let scanned = 0;
  let cursor: number | undefined;

  while (scanned < PROGRESS_SCAN_SAFETY_CAP) {
    const page = await prisma.article.findMany({
      where: { ...baseWhere, enrichmentStatus: "INGESTED", enrichmentClaim: null },
      select: {
        id: true,
        enrichmentStatus: true,
        enrichmentAttemptCount: true,
        enrichmentFinishedAt: true,
        enrichmentOutcome: true,
        canonicalUrl: true,
        sourceUrl: true,
      },
      take: PROGRESS_SCAN_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });
    if (!Array.isArray(page) || page.length === 0) break;
    scanned += page.length;
    for (const article of page) {
      if (excludedArticleIds.has(article.id)) continue;
      if (isBlockedByRecentBlockState(article, blockState)) {
        deferred++;
        continue;
      }
      if (decideAgent3RetryDisposition({ ...article, now }).state === "READY_NEW") ready++;
    }
    cursor = page[page.length - 1]!.id;
    if (page.length < PROGRESS_SCAN_PAGE_SIZE) break;
  }

  return { ready, deferred };
}

async function scanEnrichedArticleVersions(
  enrichedWhere: Record<string, unknown>,
): Promise<{ needsReprocess: number; currentComplete: number; scanned: number; truncated: boolean }> {
  let needsReprocess = 0;
  let currentComplete = 0;
  let scanned = 0;
  let cursor: string | undefined;

  while (scanned < PROGRESS_SCAN_SAFETY_CAP) {
    const page = await prisma.article.findMany({
      where: enrichedWhere,
      select: { id: true, bodyText: true, enrichmentOutcome: true },
      take: PROGRESS_SCAN_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: parseInt(cursor, 10) } } : {}),
      orderBy: { id: "asc" },
    });

    if (!Array.isArray(page) || page.length === 0) break;

    for (const article of page) {
      if (needsAgent3CurrentVersionReprocess({
        enrichmentStatus: "ENRICHED",
        bodyText: article.bodyText,
        enrichmentOutcome: article.enrichmentOutcome,
      })) {
        needsReprocess++;
      } else {
        currentComplete++;
      }
    }

    scanned += page.length;
    cursor = String(page[page.length - 1]!.id);

    // If we got fewer than a full page, we've reached the end
    if (page.length < PROGRESS_SCAN_PAGE_SIZE) break;
  }

  // Check if there are more articles beyond the safety cap
  let truncated = false;
  if (scanned >= PROGRESS_SCAN_SAFETY_CAP) {
    const moreExist = await prisma.article.count({
      where: enrichedWhere,
      skip: PROGRESS_SCAN_SAFETY_CAP,
      take: 1,
    });
    truncated = moreExist > 0;
  }

  return { needsReprocess, currentComplete, scanned, truncated };
}

/**
 * Get Agent 3 enrichment progress: eligible counts, latest run summary,
 * and remaining targets.
 *
 * Uses the same selection semantics as `selectEnrichmentEligibleArticles`
 * so the admin UI shows consistent counts.
 *
 * Uses Prisma count queries for simple counts and paged scanning for
 * version-aware ENRICHED article counts (no hard 50-row cap).
 */
export const getAgent3Progress = async (
  options?: Agent3ProgressOptions,
): Promise<Agent3Progress> => {
  const now = options?.now ?? new Date();
  const includeEnriched = options?.includeEnriched ?? false;
  const forceReprocess = options?.forceReprocess ?? false;
  const articleIds = options?.articleIds;
  const sourceIds = options?.sourceIds;
  const pipelineRunId = options?.pipelineRunId;

  // When explicit articleIds are provided, bypass freshness cutoff
  const cutoff = articleIds && articleIds.length > 0 ? undefined : getArticleRetentionCutoff(now);

  // Build base where clause for scope queries
  const baseWhere: Record<string, unknown> = {};
  if (cutoff) baseWhere.date = { gte: cutoff };
  if (articleIds && articleIds.length > 0) baseWhere.id = { in: articleIds };
  if (sourceIds && sourceIds.length > 0) baseWhere.sourceId = { in: sourceIds };

  const enrichedWhere = { ...baseWhere, enrichmentStatus: "ENRICHED" };

  // Run count queries and enriched article scan in parallel.
  // The scan pages through all ENRICHED articles for accurate version-aware counts.
  const sameRunArticleIds = pipelineRunId
    ? await readAttemptedArticleIds(pipelineRunId)
    : new Set<number>();
  const [totalInScope, needingInitialEnrichment, enrichedInScope, failedRetryable, enrichedScan] = await Promise.all([
    prisma.article.count({ where: baseWhere }),
    prisma.article.count({ where: { ...baseWhere, enrichmentStatus: { in: ["INGESTED", "ENRICHMENT_FAILED"] }, enrichmentClaim: null } }),
    prisma.article.count({ where: enrichedWhere }),
    prisma.article.count({ where: { ...baseWhere, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentClaim: null } }),
    scanEnrichedArticleVersions(enrichedWhere),
  ]);

  const needsCurrentVersionReprocess = enrichedScan.needsReprocess;
  const currentVersionComplete = enrichedScan.currentComplete;
  const recentBlockState = await scanRecentBlockState(baseWhere, now);
  const nonRetryableScan = await scanNonRetryableFailures(
    baseWhere,
    now,
    sameRunArticleIds,
    recentBlockState,
  );
  const nonRetryableCurrentVersionFailures = nonRetryableScan.nonRetryable;

  // Recently-blocked is host-aware: once a current-version 403/429/runtime
  // block is observed, other eligible articles on the same hostname are also
  // excluded until the cooldown expires.
  const recentlyBlockedCount = await countBlockedEligibleArticles(
    baseWhere,
    includeEnriched,
    recentBlockState,
  );

  // `needingInitialEnrichment` is INGESTED + ENRICHMENT_FAILED and the
  // separate failed count makes this an exact INGESTED count without a broad
  // status subtraction from policy dispositions.
  const readyNewScan = await scanReadyNewArticles(
    baseWhere,
    now,
    sameRunArticleIds,
    recentBlockState,
  );
  const readyNew = readyNewScan.ready;
  const readyRetry = nonRetryableScan.readyRetry;
  const deferred = nonRetryableScan.deferred + readyNewScan.deferred;
  const quarantined = nonRetryableScan.exhaustedAttempts;
  const nonRetryable = nonRetryableScan.nonRetryable;
  const inProgress = await prisma.articleEnrichmentClaim.count({
    where: { expiresAt: { gt: now }, article: baseWhere },
  });
  const totalOutstanding = readyNew + readyRetry + deferred + quarantined + nonRetryable + inProgress;
  const nextRetryAt = nonRetryableScan.nextRetryAt;

  // eligibleNow: same semantics as selectEnrichmentEligibleArticles (before recently-blocked filter)
  // Excludes non-retryable current-version failures (permanent extraction failures)
  // because they will always fail with the current extractor version.
  const rawEligibleNow = includeEnriched
    ? needingInitialEnrichment + needsCurrentVersionReprocess
    : needingInitialEnrichment;
  const eligibleNow = Math.max(0, rawEligibleNow - nonRetryableCurrentVersionFailures);

  // retryableNow: articles we can actually process right now
  // (excluding both recently-blocked AND non-retryable current-version failures)
  // This is the queue contract: blocked, deferred, quarantined, permanent,
  // and same-run attempted failures are not actionable in this run.
  const retryableNow = readyNew + readyRetry;

  // Find the latest Agent 3 enrichment PipelineRun
  let latestRun: Agent3Progress["latestRun"] = null;
  try {
    const latestPipelineRun = await prisma.pipelineRun.findFirst({
      where: {
        summary: { path: ["agent"], equals: "enrichment" },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        candidatesFound: true,
        inserted: true,
        skipped: true,
        failed: true,
        finishedAt: true,
        summary: true,
      },
    });

    if (latestPipelineRun) {
      const summary = (latestPipelineRun.summary ?? {}) as Record<string, unknown>;
      const byKind = (summary.byKind ?? {}) as Record<string, number>;
      const successfullyEnriched = byKind.SUCCESS ?? latestPipelineRun.inserted ?? 0;
      const rejected = Object.entries(byKind)
        .filter(([k]) => k !== "SUCCESS" && k !== "SKIPPED")
        .reduce((sum, [, v]) => sum + (v as number), 0);
      const systemPersistFailed = (summary.persistFailed as number) ?? latestPipelineRun.failed ?? 0;
      const processed = (summary.articleCount as number) ?? latestPipelineRun.candidatesFound ?? 0;
      const persistedOutcomes = (summary.persisted as number) ?? processed;

      const startedAt = latestPipelineRun.finishedAt
        ? new Date(latestPipelineRun.finishedAt.getTime() - ((summary.durationMs as number) ?? 0))
        : null;
      const durationMs = (summary.durationMs as number) ?? null;

      // Parse browser fallback stats from persisted summary (if present)
      const bfsRaw = summary.browserFallbackStats;
      const browserFallbackStats =
        bfsRaw && typeof bfsRaw === "object" && !Array.isArray(bfsRaw)
          ? {
              enabled: typeof (bfsRaw as Record<string, unknown>).enabled === "boolean"
                ? (bfsRaw as Record<string, unknown>).enabled as boolean
                : false,
              attempted: typeof (bfsRaw as Record<string, unknown>).attempted === "number"
                ? (bfsRaw as Record<string, unknown>).attempted as number
                : 0,
              succeeded: typeof (bfsRaw as Record<string, unknown>).succeeded === "number"
                ? (bfsRaw as Record<string, unknown>).succeeded as number
                : 0,
              failed: typeof (bfsRaw as Record<string, unknown>).failed === "number"
                ? (bfsRaw as Record<string, unknown>).failed as number
                : 0,
              runtimeUnavailable: typeof (bfsRaw as Record<string, unknown>).runtimeUnavailable === "number"
                ? (bfsRaw as Record<string, unknown>).runtimeUnavailable as number
                : 0,
              rateLimited: typeof (bfsRaw as Record<string, unknown>).rateLimited === "number"
                ? (bfsRaw as Record<string, unknown>).rateLimited as number
                : 0,
              stoppedReason: typeof (bfsRaw as Record<string, unknown>).stoppedReason === "string"
                ? (bfsRaw as Record<string, unknown>).stoppedReason as string
                : null,
            }
          : null;

      const ouRaw = summary.optionsUsed;
      const optionsUsed =
        ouRaw && typeof ouRaw === "object" && !Array.isArray(ouRaw)
          ? {
              browserFallback: typeof (ouRaw as Record<string, unknown>).browserFallback === "boolean"
                ? (ouRaw as Record<string, unknown>).browserFallback as boolean
                : false,
              browserFallbackMaxAttempts: typeof (ouRaw as Record<string, unknown>).browserFallbackMaxAttempts === "number"
                ? (ouRaw as Record<string, unknown>).browserFallbackMaxAttempts as number
                : 3,
              browserTimeoutMs: typeof (ouRaw as Record<string, unknown>).browserTimeoutMs === "number"
                ? (ouRaw as Record<string, unknown>).browserTimeoutMs as number
                : 25000,
              includeEnriched: typeof (ouRaw as Record<string, unknown>).includeEnriched === "boolean"
                ? (ouRaw as Record<string, unknown>).includeEnriched as boolean
                : false,
              forceReprocess: typeof (ouRaw as Record<string, unknown>).forceReprocess === "boolean"
                ? (ouRaw as Record<string, unknown>).forceReprocess as boolean
                : false,
              maxArticles: typeof (ouRaw as Record<string, unknown>).maxArticles === "number"
                ? (ouRaw as Record<string, unknown>).maxArticles as number
                : 50,
              maxArticlesPerSource: typeof (ouRaw as Record<string, unknown>).maxArticlesPerSource === "number"
                ? (ouRaw as Record<string, unknown>).maxArticlesPerSource as number
                : 5,
            }
          : null;

      // Parse source cooldowns from persisted summary (if present)
      const scRaw = summary.agent3SourceCooldowns;
      const validReasons: ReadonlySet<string> = new Set(["http_403", "http_429", "browser_runtime_unavailable"]);
      const sourceCooldowns: SourceCooldownEntry[] | null =
        Array.isArray(scRaw)
          ? scRaw
              .filter((e: unknown) => e && typeof e === "object")
              .map((e: unknown) => {
                const entry = e as Record<string, unknown>;
                const reason = typeof entry.reason === "string" ? entry.reason : "http_403";
                return {
                  sourceId: typeof entry.sourceId === "string" ? entry.sourceId : "",
                  hostname: typeof entry.hostname === "string" ? entry.hostname : "unknown",
                  reason: (validReasons.has(reason) ? reason : "http_403") as SourceCooldownEntry["reason"],
                  failureCount: typeof entry.failureCount === "number" ? entry.failureCount : 0,
                  skippedInRun: typeof entry.skippedInRun === "number" ? entry.skippedInRun : 0,
                  firstFailureAt: typeof entry.firstFailureAt === "string" ? entry.firstFailureAt : "",
                  lastFailureAt: typeof entry.lastFailureAt === "string" ? entry.lastFailureAt : "",
                };
              })
              .filter((e) => e.sourceId.length > 0)
          : null;

      latestRun = {
        pipelineRunId: latestPipelineRun.id,
        processed,
        successfullyEnriched,
        rejected,
        persistedOutcomes,
        systemPersistFailed,
        durationMs,
        finishedAt: latestPipelineRun.finishedAt?.toISOString() ?? null,
        byKind,
        browserFallbackStats,
        optionsUsed,
        sourceCooldowns,
      };
    }
  } catch {
    // PipelineRun query failure is non-fatal; progress still returns counts.
  }

  // remainingAfterLatestRun: recompute current eligible count
  // This is simply eligibleNow, since failed/rejected rows remain eligible
  // for retry and reprocessing handles already-enriched rows.
  // Legacy dashboard field: preserve the broader eligible queue count. The
  // durable workflow uses retryableNow, whose contract is exactly readyNew +
  // readyRetry and excludes deferred/quarantined/permanent rows.
  const remainingAfterLatestRun = eligibleNow;
  return {
      readyNew,
      readyRetry,
      deferred,
      nextRetryAt,
      quarantined,
      nonRetryable,
      inProgress,
      totalOutstanding,
      exhaustedAttempts: quarantined,
      eligibleNow,
      recentlyBlocked: recentlyBlockedCount,
      retryableNow,
      nonRetryableCurrentVersionFailures,
      totalInScope,
    enrichedInScope,
    needingInitialEnrichment,
    failedRetryable,
    needsCurrentVersionReprocess,
    currentVersionComplete,
    selectedMode: {
      includeEnriched,
      forceReprocess,
      hasArticleFilter: Boolean(articleIds && articleIds.length > 0),
      hasSourceFilter: Boolean(sourceIds && sourceIds.length > 0),
    },
    latestRun,
    remainingAfterLatestRun,
    progressTruncated: enrichedScan.truncated,
    progressScanned: enrichedScan.scanned,
  };
};

/**
 * Options for a full Agent 3 enrichment batch run.
 */
export interface EnrichmentBatchOptions {
  /** Run timestamp. */
  now?: Date;
  /** Maximum articles per batch. */
  maxArticles?: number;
  /** Include already-ENRICHED articles for reprocessing. */
  includeEnriched?: boolean;
  /** Force overwrite existing bodyText when new extraction is materially better. */
  forceReprocess?: boolean;
  /** Filter to specific source IDs. */
  sourceIds?: string[];
  /** Filter to specific article IDs (debug/admin). */
  articleIds?: number[];
  /** Enable browser fallback for articles rejected by static extraction. */
  browserFallback?: boolean;
  /** Maximum number of browser fallback attempts per batch (default 3, clamp 0..10). */
  browserFallbackMaxAttempts?: number;
  /** Timeout per browser fallback attempt in ms (default 25000, clamp 5000..45000). */
  browserTimeoutMs?: number;
  /** Invocation-local browser session deadline (default is derived from attempts). */
  browserBatchTimeoutMs?: number;
  /** Bypass only an article's own HTTP 403 cooldown for a bounded browser recovery batch. */
  allowBrowserRecoveryDuringHttp403Cooldown?: boolean;
  /** Maximum articles from a single source per batch (default 5, clamp 1..25). */
  maxArticlesPerSource?: number;
  /** Existing durable PipelineRun to use for same-run attempt artifacts. */
  pipelineRunId?: string;
  /** Operation-level stage telemetry probe (optional, no-op by default). */
  telemetry?: StageBatchProbe;
  /** Invocation-scoped static-429 safety state shared by Agent 3 articles. */
  static429Hostnames?: Set<string>;
}

/**
 * Result of a full Agent 3 enrichment batch run.
 */
export interface Agent3HttpEvidenceSummary {
  /** Distinct static HTTP 403 events observed across outcomes. */
  static403: number;
  /** Distinct static HTTP 429 events observed across outcomes. */
  static429: number;
  /** Distinct browser HTTP 403 events observed across outcomes. */
  browser403: number;
  /** Distinct browser HTTP 429 events observed across outcomes. */
  browser429: number;
  /** Generic 403 access-denial events (static and browser combined). */
  accessDenied403: number;
  /** Explicitly rate-limited 403 events; generic HTTP 403 never enters this bucket. */
  rateLimited403: number;
  /** HTTP 429 events (static and browser combined). */
  rateLimited429: number;
}

/**
 * Authoritative retry-policy queue counts for INTERSTITIAL_OR_CHALLENGE
 * outcomes only. These are incremented only after the per-article persistence
 * result proves the Article/artifact transaction applied. The exact disposition
 * computed once by `decideAgent3RetryDisposition` is used; it is never re-derived
 * from the outcome kind, so failed or claim-lost transitions cannot look durable.
 * INTERSTITIAL_OR_CHALLENGE is not inherently permanent; NON_RETRYABLE may
 * legitimately be terminal.
 */
export type Agent3InterstitialDispositionCounts = {
  deferred: number;
  quarantined: number;
  readyRetry: number;
  nonRetryable: number;
};

export type Agent3BatchDispositions = {
  succeeded: number;
  failedRetryable: number;
  failedPermanent: number;
  skipped: number;
  deferred: number;
  quarantined: number;
  claimLost: number;
  persistenceFailed: number;
};

export function buildAgent3BatchDispositions(input: {
  selectedCount: number;
  persist: EnrichmentBatchPersistResult;
  interstitial: Agent3InterstitialDispositionCounts;
  claimSkipped: number;
  governorDeferred: number;
  sourceCooldownSkipped: number;
}): Agent3BatchDispositions {
  const byKind = input.persist.byKind;
  const failedPermanent = Object.entries(byKind)
    .filter(([kind]) => ![
      "SUCCESS", "SKIPPED", "RETRYABLE_FAILURE", "HEADLESS_REQUIRED", "INTERSTITIAL_OR_CHALLENGE",
    ].includes(kind))
    .reduce((sum, [, count]) => sum + count, 0)
    + input.interstitial.nonRetryable;
  const result: Agent3BatchDispositions = {
    succeeded: byKind.SUCCESS,
    failedRetryable: byKind.RETRYABLE_FAILURE + input.interstitial.readyRetry,
    failedPermanent,
    skipped: byKind.SKIPPED + input.claimSkipped + input.sourceCooldownSkipped,
    deferred: byKind.HEADLESS_REQUIRED + input.interstitial.deferred + input.governorDeferred,
    quarantined: input.interstitial.quarantined,
    claimLost: input.persist.claimLost,
    persistenceFailed: input.persist.failed,
  };
  const reconciled = Object.values(result).reduce((sum, value) => sum + value, 0);
  if (reconciled !== input.selectedCount) {
    throw Object.assign(
      new Error(`Agent 3 disposition invariant failed: selected=${input.selectedCount}, dispositions=${reconciled}.`),
      { name: "InvariantError" },
    );
  }
  return result;
}

export interface EnrichmentRunResult {
  pipelineRunId: string;
  /** Every article selected into this bounded worker batch. */
  selectedCount: number;
  /** Number of articles durably claimed and processed by this worker. */
  articleCount: number;
  /** Number of selected articles another worker already owned. */
  claimSkipped: number;
  /** Number of expired leases released before selection. */
  expiredClaimsRecovered: number;
  /** Neutral governor deferrals; not publisher/network failures. */
  governorDeferred: number;
  /** Selected articles skipped before claim because their source entered cooldown. */
  sourceCooldownSkipped: number;
  /** Authoritative mutually exclusive disposition of every selected article. */
  dispositions: Agent3BatchDispositions;
  persist: EnrichmentBatchPersistResult;
  /** Authoritative retry-policy queue counts for interstitial outcomes. */
  interstitialDispositionCounts: Agent3InterstitialDispositionCounts;
  /** Per-outcome HTTP evidence; never reconstructed from aggregate counters. */
  httpEvidence: Agent3HttpEvidenceSummary;
  optionsUsed: {
    includeEnriched: boolean;
    forceReprocess: boolean;
    browserFallback: boolean;
  };
  browserFallbackStats?: BrowserFallbackRunStats;
  sourceCooldowns?: SourceCooldownEntry[];
}

/**
 * Run a full Agent 3 enrichment batch:
 *  1. create a `PipelineRun` to track the batch
 *  2. select eligible articles
 *  3. build canonical outcomes via the real HTTP extractor
 *  4. persist outcomes (row summary + artifacts)
 *  5. finalize the `PipelineRun` with an enrichment summary
 *  6. log start/finish
 *
 * Phase 2: uses `extractAndBuildArticleOutcome` which calls the real
 * `extractArticleContentFromUrl` for each article.
 *
 * Accepts optional `EnrichmentBatchOptions` for reprocessing support.
 */
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const runEnrichmentBatch = async (
  options?: EnrichmentBatchOptions,
): Promise<EnrichmentRunResult> => {
  const probe = options?.telemetry ?? createNoopStageBatchProbe();
  const now = options?.now ?? new Date();
  const forceReprocess = options?.forceReprocess ?? false;
  const includeEnriched = options?.includeEnriched ?? false;
  const maxArticles = options?.maxArticles;
  const startedAt = Date.now();

  // Phase 3: Browser fallback options
  const browserFallbackEnabled = options?.browserFallback ?? false;
  const browserFallbackMaxAttempts = clamp(
    options?.browserFallbackMaxAttempts ?? 3, 0, 10,
  );
  const browserTimeoutMs = clamp(
    options?.browserTimeoutMs ?? 25_000, 5_000, 45_000,
  );
  const browserBatchTimeoutMs = clamp(
    options?.browserBatchTimeoutMs ?? (browserTimeoutMs * Math.max(browserFallbackMaxAttempts, 1) + 5_000),
    10_000,
    120_000,
  );
  let browserAttemptsRemaining = browserFallbackEnabled ? browserFallbackMaxAttempts : 0;
  const browserSession = browserFallbackEnabled
    ? createAgent3BrowserSession({
        deadlineAt: startedAt + browserBatchTimeoutMs,
        maxNavigationsPerContext: Math.max(browserFallbackMaxAttempts, 1),
      })
    : null;
  // A static HTTP 429 is a hard no-browser boundary for this invocation.
  // Keep this host-local and invocation-scoped: it prevents amplification for
  // later same-host articles without introducing durable governor state here.
  const sameBatchStatic429Hostnames = new Set<string>();
  const browserStats: BrowserFallbackRunStats = {
    attempted: 0, succeeded: 0, failed: 0, runtimeUnavailable: 0, rateLimited: 0,
  };

  let pipelineRun: { id: string } | null = null;
  const ownsPipelineRun = !options?.pipelineRunId;

  try {
    pipelineRun = options?.pipelineRunId
      ? { id: options.pipelineRunId }
      : await createPipelineRun(0);

    await logAgentScan({
      status: "ARTICLE_CONTENT_ENRICHMENT_STARTED",
      executionTimeMs: 0,
      errorLog: `Agent 3 article enrichment batch started (Phase 3 browser fallback). includeEnriched=${includeEnriched}, forceReprocess=${forceReprocess}, browserFallback=${browserFallbackEnabled} (maxAttempts=${browserFallbackMaxAttempts}, timeout=${browserTimeoutMs}ms).`,
    });

    // `options.now` is the deterministic content/enrichment timestamp. Lease
    // recovery must use the current wall clock so a historical run timestamp
    // cannot preserve or delete claims incorrectly.
    const expiredClaimsRecovered = await recoverExpiredEnrichmentClaims(new Date());
    probe.recordDbOperation();

    // Source diversity: cap articles per source and round-robin across sources
    const maxArticlesPerSource = clamp(
      options?.maxArticlesPerSource ?? DEFAULT_MAX_ARTICLES_PER_SOURCE,
      MIN_MAX_ARTICLES_PER_SOURCE,
      MAX_MAX_ARTICLES_PER_SOURCE,
    );

    const batchLimit = clamp(
      maxArticles ?? MAX_ARTICLES_PER_RUN,
      1,
      MAX_ARTICLES_PER_RUN,
    );
    // Diversity is applied after selection, so fetch a bounded candidate pool
    // rather than allowing the soft source cap to collapse the final batch.
    const candidatePoolLimit = Math.min(
      MAX_ARTICLES_PER_RUN,
      Math.max(batchLimit, batchLimit * 5),
    );
    const articles = await selectEnrichmentEligibleArticles(
      now,
      candidatePoolLimit,
      {
        includeEnriched,
        forceReprocess,
        articleIds: options?.articleIds,
        sourceIds: options?.sourceIds,
        pipelineRunId: pipelineRun.id,
        allowBrowserRecoveryDuringHttp403Cooldown:
          options?.allowBrowserRecoveryDuringHttp403Cooldown,
      },
    );

    // Apply source diversity: round-robin across sources, cap per source.
    // Explicit articleIds bypass diversity (admin is targeting specific articles).
    const diversified = (options?.articleIds && options.articleIds.length > 0)
      ? articles.slice(0, batchLimit)
      : applySourceDiversity(articles, maxArticlesPerSource, batchLimit);

    if (options?.pipelineRunId) {
      const uniqueTargets = new Map<string, { sourceId: string; categoryId: string | null; selectedCount: number }>();
      for (const article of diversified) {
        const key = `${article.sourceId}:${article.categoryId ?? "source"}`;
        const existing = uniqueTargets.get(key);
        uniqueTargets.set(key, {
          sourceId: article.sourceId,
          categoryId: article.categoryId ?? null,
          selectedCount: (existing?.selectedCount ?? 0) + 1,
        });
      }
      await persistRunTargetManifest({
        pipelineRunId: pipelineRun.id,
        orchestrationRunId: options.pipelineRunId,
        stage: "agent3",
        targets: [...uniqueTargets.values()].map((target) => ({ ...target, disposition: "selected" as const })),
      }).catch(() => undefined);
    }

    // Recover precise upstream provenance from Agent 1 ingest artifacts.
    // This replaces the conservative fallback when artifact data exists.
    const provenanceMap = await recoverUpstreamProvenanceBatch(diversified);

    const outcomes: ArticleEnrichmentOutcome[] = [];
    const httpEvidence = emptyAgent3HttpEvidence();
    const persistResult = createEmptyEnrichmentBatchPersistResult();
    const interstitialDispositionCounts: Agent3InterstitialDispositionCounts = {
      deferred: 0,
      quarantined: 0,
      readyRetry: 0,
      nonRetryable: 0,
    };
    const attemptMarkerIds: string[] = [];
    const sourceCooldown = new SourceCooldownTracker();
    let claimSkipped = 0;
    let governorDeferred = 0;
    let sourceCooldownSkipped = 0;

    for (const article of diversified) {
      // Skip articles from sources in cooldown
      if (sourceCooldown.isCoolingDown(article.sourceId)) {
        sourceCooldown.incrementSkip(article.sourceId);
        sourceCooldownSkipped += 1;
        continue;
      }

      // Claim leases use the wall clock at the instant this article is
      // claimed. Do not reuse the batch's deterministic content timestamp.
      const leaseNow = new Date();
      const claim = await claimEnrichmentArticle(
        article.id,
        pipelineRun.id,
        leaseNow,
        undefined,
        article.enrichmentAttemptCount,
        article.enrichmentStatus,
      );
      probe.recordDbOperation();
      if (!claim) {
        claimSkipped += 1;
        await logAgentScan({
          sourceId: article.sourceId,
          categoryId: article.categoryId || undefined,
          status: "ARTICLE_CONTENT_ENRICHMENT_CLAIM_SKIPPED",
          executionTimeMs: 0,
          errorLog: `Article ${article.id} is already owned by another Agent 3 worker.`,
        }).catch(() => {});
        continue;
      }
      const provenance =
        provenanceMap.get(article.id) ?? buildArticleProvenance(article);
      const attemptNumber = claim.attemptNumber;
      const attemptStartedAt = claim.claimedAt.toISOString();
      let attemptMarkerId: string | null = null;

      // Emit a lightweight attempt marker before running extraction.
      // Non-fatal: if the marker fails, we still proceed with the outcome.
      try {
        const markerId = await persistAttemptMarker(
          article.id,
          attemptNumber,
          attemptStartedAt,
          pipelineRun.id,
          article.sourceId,
          article.categoryId,
        );
        probe.recordDbOperation();
        attemptMarkerId = markerId;
        attemptMarkerIds.push(markerId);
      } catch {
        // Attempt marker failure is non-fatal; the final result artifact is
        // the authoritative record. Continue with extraction.
      }

      // Phase 2: use the real HTTP extractor with forceReprocess option
      // Phase 3: determine browser fallback config with skipped reason if applicable
      let browserConfig: BrowserFallbackConfig | undefined;
      if (!browserFallbackEnabled) {
        // Browser globally disabled — extractAndBuildArticleOutcome handles browser_disabled/not_eligible
        browserConfig = undefined;
      } else if (sourceCooldown.isCoolingDown(article.sourceId)) {
        browserConfig = { timeoutMs: browserTimeoutMs, skippedReason: "source_cooldown" };
      } else if (sameBatchStatic429Hostnames.has(articleHostname(article))) {
        browserConfig = { timeoutMs: browserTimeoutMs, skippedReason: "static_429_host" };
      } else if (browserAttemptsRemaining <= 0) {
        const reason: BrowserFallbackSkippedReason = browserStats.runtimeUnavailable > 0
          ? "runtime_unavailable_global_stop"
          : "max_attempts_exhausted";
        browserConfig = { timeoutMs: browserTimeoutMs, skippedReason: reason };
      } else {
        browserConfig = { timeoutMs: browserTimeoutMs };
      }
      // The extractor owns mutually-exclusive fetch/extraction timing and
      // records both phases in finally-safe probe.timed() boundaries. Do not
      // wrap the whole extractor here as fetch; it also parses/scorers content
      // and may run browser fallback.
      let outcome: ArticleEnrichmentOutcome;
      try {
        outcome = await extractAndBuildArticleOutcome(
          article,
          now,
          provenance,
          forceReprocess,
          browserConfig,
          probe,
          { static429Hostnames: sameBatchStatic429Hostnames },
          browserSession ?? undefined,
        );
      } catch (error) {
        if (!(error instanceof GovernedFetchDeferredError)) throw error;
        // A governor defer performed no publisher transport/extraction work.
        // Roll back this worker's provisional attempt increment and marker in
        // the same token-owned transaction. An unconfirmed rollback is a
        // persistence failure and retains the lease for expiry recovery.
        let releaseErrored = false;
        const released = await releaseEnrichmentClaim(
          article.id,
          pipelineRun.id,
          claim.token,
          new Date(),
          { rollbackAttempt: true, attemptMarkerId },
        ).catch(() => {
          releaseErrored = true;
          return false;
        });
        probe.recordDbOperation();
        if (!released) {
          if (releaseErrored) persistResult.failed += 1;
          else persistResult.claimLost += 1;
          continue;
        }
        if (attemptMarkerId) {
          const markerIndex = attemptMarkerIds.indexOf(attemptMarkerId);
          if (markerIndex >= 0) attemptMarkerIds.splice(markerIndex, 1);
        }
        governorDeferred += 1;
        await logAgentScan({
          sourceId: article.sourceId,
          categoryId: article.categoryId || undefined,
          status: "ARTICLE_CONTENT_ENRICHMENT_DEFERRED",
          executionTimeMs: 0,
          errorLog: `Agent 3 request deferred by domain governance: ${error.reason}`,
        }).catch(() => {});
        continue;
      }
      // Observe the static 429 immediately after extraction. This is an
      // invocation-local network safety control, not persistence telemetry:
      // claim loss/CAS failure must not reopen same-host browser work later in
      // this batch, including for a different sourceId.
      if (
        outcome.browserFallback?.staticStatusCode === 429 ||
        outcome.browserFallback?.statusCode === 429
      ) {
        const hostname = articleHostname(article);
        if (hostname !== "unknown") sameBatchStatic429Hostnames.add(hostname);
      }
      if (outcome.browserFallback?.statusCode === 429) {
        // Browser 429 is a neutral retry boundary. The governor already owns
        // the durable circuit transition; Agent 3 must not create a final
        // Article outcome, persistence counter, or hard-source side effect.
        browserAttemptsRemaining--;
        let releaseErrored = false;
        const released = await releaseEnrichmentClaim(
          article.id,
          pipelineRun.id,
          claim.token,
          new Date(),
          { rollbackAttempt: true, attemptMarkerId },
        ).catch(() => {
          releaseErrored = true;
          return false;
        });
        probe.recordDbOperation();
        if (!released) {
          if (releaseErrored) persistResult.failed += 1;
          else persistResult.claimLost += 1;
          continue;
        }
        if (attemptMarkerId) {
          const markerIndex = attemptMarkerIds.indexOf(attemptMarkerId);
          if (markerIndex >= 0) attemptMarkerIds.splice(markerIndex, 1);
        }
        governorDeferred += 1;
        const navigation = outcome.browserFallback.browserDiagnostics?.navigation ?? null;
        await logAgentScan({
          sourceId: article.sourceId,
          categoryId: article.categoryId || undefined,
          status: "ARTICLE_CONTENT_ENRICHMENT_DEFERRED",
          executionTimeMs: 0,
          errorLog: `Agent 3 browser navigation received authoritative HTTP 429. ${JSON.stringify({
            domainKey: navigation?.domainKey ?? articleHostname(article),
            mainDocumentStatus: 429,
            retryAfterAt: navigation?.retryAfterAt ?? null,
            retryAfterSource: navigation?.retryAfterSource ?? null,
            mainDocumentRequests: navigation?.mainDocumentRequests ?? 1,
            firstPartySubrequests: navigation?.firstPartySubrequests ?? 0,
            thirdPartySubrequests: navigation?.thirdPartySubrequests ?? 0,
            blockedHeavyResources: navigation?.blockedHeavyResources ?? 0,
          }).slice(0, 700)}`,
        }).catch(() => {});
        continue;
      }
      if (outcome.browserFallback?.attempted && !browserConfig) probe.recordBrowserAttempt();
      // Derive and record evidence from this individual outcome before
      // classifyHttpAccessBlocked() can replace the effective rejection status.
      // The aggregate is a sum of these per-outcome events, never an input to
      // article classification. Static 403 + browser 429 records both once.
      // Keep the per-outcome observation local until persistence succeeds.
      // The final HTTP evidence summary and telemetry counters must not include
      // claim-lost or failed-persistence outcomes.
      const outcomeHttpEvidence = collectAgent3HttpEvidence(outcome);
      // Classify HTTP access blocked BEFORE source cooldown tracking so the
      // cooldown tracker uses the final effective status code. For example,
      // if static extraction got 403 but browser fallback got 429, the
      // cooldown tracker must see 429 (immediate cooldown) not 403 (threshold).
      classifyHttpAccessBlocked(outcome);

      // Persist compact diagnostics on deferred/quarantined/permanent outcomes.
      // The full extraction payload remains bounded by the existing serializer;
      // this summary adds the queue decision needed by admin/workflow tooling.
      const retryDisposition = decideAgent3RetryDisposition({
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentAttemptCount: attemptNumber,
        enrichmentFinishedAt: new Date(outcome.timing.finishedAt),
        enrichmentOutcome: outcome,
        now,
        forceReprocess,
        explicitlyTargeted: Boolean(options?.articleIds?.length),
      });
      // Persist the computed bounded retry time on the rejection summary when
      // the retry policy supplies fallback evidence. This keeps static 429
      // cooldown evidence on the durable row as well as the artifact, while
      // preserving explicit Retry-After values from the extractor.
      const isRateLimitedOutcome =
        outcome.rejection?.httpStatus === 429 ||
        outcome.browserFallback?.staticStatusCode === 429 ||
        outcome.browserFallback?.statusCode === 429;
      if (
        outcome.rejection &&
        !outcome.rejection.retryAfterAt &&
        retryDisposition.state === "DEFERRED" &&
        retryDisposition.retryAfter &&
        (outcome.kind === "INTERSTITIAL_OR_CHALLENGE" || isRateLimitedOutcome)
      ) {
        outcome.rejection.retryAfterAt = retryDisposition.retryAfter;
      }

      // The exact retry disposition is passed unchanged to persistence below.
      // Do not count it yet: before the transaction returns, Article CAS,
      // claim ownership, and artifact creation may still fail.

      if (
        outcome.kind !== "SUCCESS" &&
        outcome.kind !== "SKIPPED" &&
        (retryDisposition.state === "DEFERRED" ||
          retryDisposition.state === "QUARANTINED" ||
          retryDisposition.state === "NON_RETRYABLE" ||
          (outcome.kind === "INTERSTITIAL_OR_CHALLENGE" && retryDisposition.state === "READY_RETRY"))
      ) {
        const detail = outcome.rejection?.detail ?? outcome.error ?? "";
        const browserFallbackCouldHelp =
          outcome.browserFallback?.browserFallbackSkippedReason !== "not_eligible" &&
          (outcome.browserFallback?.runtimeUnavailable === true ||
            outcome.browserFallback?.browserFallbackSkippedReason === "browser_disabled" ||
            outcome.browserFallback?.browserFallbackSkippedReason === "static_429_host" ||
            outcome.kind === "HEADLESS_REQUIRED" ||
            outcome.kind === "INTERSTITIAL_OR_CHALLENGE");
        // READY_RETRY (interstitial out of cooldown) carries no reasonCode on
        // the disposition variant — fall back to the state label.
        const retryReasonCode = "reasonCode" in retryDisposition
          ? retryDisposition.reasonCode
          : retryDisposition.state;
        outcome.retryDiagnostics = {
          disposition: retryDisposition.state,
          reasonCode: retryReasonCode,
          attemptNumber,
          retryAfter: retryDisposition.state === "DEFERRED" ? retryDisposition.retryAfter : null,
          articleId: article.id,
          sourceId: article.sourceId,
          hostname: extractHostname(article.canonicalUrl || article.sourceUrl),
          pipelineRunId: pipelineRun.id,
          browserFallbackCouldHelp,
          evidenceSummary: JSON.stringify({
            kind: outcome.kind,
            rejectionCode: outcome.rejection?.code ?? null,
            detail: detail.slice(0, 240),
          }).slice(0, 512),
          httpStatus: outcome.rejection?.httpStatus ?? outcome.browserFallback?.statusCode ?? null,
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          previousAttemptAt: article.enrichmentFinishedAt?.toISOString() ?? null,
        };
      }

      // Track source cooldown: if this outcome is a block-type failure,
      // record it on the cooldown tracker. If the source hits the threshold,
      // subsequent articles from the same source will be skipped.
      if (outcome.kind !== "SUCCESS" && outcome.kind !== "SKIPPED") {
        const articleUrl = article.canonicalUrl || article.sourceUrl;
        const hostname = extractHostname(articleUrl);
        // Extract rejectedReason from the detail format: "[reason] detail"
        const detail = outcome.rejection?.detail || "";
        const rejectedReason = (detail.match(/^\[([^\]]+)\]/)?.[1]) || "unknown";
        const statusCode = outcome.rejection?.httpStatus ?? null;
        // Check if browser runtime was unavailable for this outcome
        const runtimeUnavailable = Boolean(
          outcome.browserFallback?.runtimeUnavailable ||
          (outcome.browserFallback?.browserRejectedReason === "browser_runtime_unavailable"),
        );
        const newlyCooledDown = sourceCooldown.recordFailure(
          article.sourceId, hostname,
          rejectedReason, statusCode, runtimeUnavailable,
        );
        if (newlyCooledDown) probe.recordHostCooldown();
      } else if (outcome.kind === "SUCCESS") {
        sourceCooldown.recordSuccess(article.sourceId);
      }

      // Consume the in-process browser work budget when browser work actually
      // ran. Durable browser counters are updated only after the outcome is
      // successfully persisted below, so claim loss cannot look like a
      // successful/failed persisted browser result.
      if (outcome.browserFallback?.attempted) {
        browserAttemptsRemaining--;
        // Runtime unavailability is an invocation-level safety stop, not a
        // durable counter. Preserve the existing no-more-browser behavior even
        // if the final Article persistence later loses its claim.
        if (outcome.browserFallback.runtimeUnavailable) {
          browserAttemptsRemaining = 0;
        }
      }

      outcomes.push(outcome);

      // Persist this article before claiming or extracting the next one. This
      // keeps the claim lifetime bounded by one article's work rather than the
      // entire batch and preserves the token/CAS protections in the persistence
      // transaction. A per-article result is merged into the existing batch
      // aggregate so PipelineRun and return-value semantics remain unchanged.
      const articlePersistResult = await probe.timed("persistence", () => persistEnrichmentBatch(
        [outcome],
        pipelineRun!.id,
        new Map([[article.id, claim.token]]),
        { retryDispositions: new Map([[article.id, retryDisposition]]) },
      ));
      probe.recordDbOperation();
      mergeEnrichmentBatchPersistResult(persistResult, articlePersistResult);

      const outcomeWasPersisted =
        articlePersistResult.persisted === 1 &&
        articlePersistResult.claimLost === 0 &&
        articlePersistResult.failed === 0;
      if (outcomeWasPersisted) {
        mergeAgent3HttpEvidence(httpEvidence, outcomeHttpEvidence);
        recordAgent3HttpEvidence(probe, outcomeHttpEvidence);
      }
      if (outcomeWasPersisted && outcome.browserFallback?.attempted) {
        browserStats.attempted++;
        if (outcome.browserFallback.succeeded) browserStats.succeeded++;
        else browserStats.failed++;
        if (outcome.browserFallback.runtimeUnavailable) browserStats.runtimeUnavailable++;
        if (outcome.browserFallback.rateLimited) browserStats.rateLimited++;

        // Stop browser fallback if a persisted outcome proves the runtime is
        // unavailable or repeated browser rate limits were persisted.
        if (outcome.browserFallback.runtimeUnavailable) {
          browserAttemptsRemaining = 0;
        }
        if (browserStats.rateLimited >= 3) {
          browserAttemptsRemaining = 0;
        }
      }

      // Interstitial disposition telemetry is persisted-only. Because this
      // runtime persists one article at a time, these aggregate fields prove
      // this exact outcome was applied: one persisted outcome, no lost claim,
      // no persistence failure, and one persisted interstitial by-kind entry.
      // NON_RETRYABLE interstitials may legitimately be terminal and therefore
      // belong in failedPermanent at the endpoint; interstitials are not
      // inherently permanent.
      if (
        outcome.kind === "INTERSTITIAL_OR_CHALLENGE" &&
        articlePersistResult.persisted === 1 &&
        articlePersistResult.claimLost === 0 &&
        articlePersistResult.failed === 0 &&
        articlePersistResult.byKind.INTERSTITIAL_OR_CHALLENGE === 1
      ) {
        switch (retryDisposition.state) {
          case "DEFERRED":
            interstitialDispositionCounts.deferred += 1;
            break;
          case "READY_RETRY":
            interstitialDispositionCounts.readyRetry += 1;
            break;
          case "QUARANTINED":
            interstitialDispositionCounts.quarantined += 1;
            break;
          case "NON_RETRYABLE":
            interstitialDispositionCounts.nonRetryable += 1;
            break;
          case "READY_NEW":
            // Failed outcomes are evaluated with ENRICHMENT_FAILED, so this
            // state is invalid here. Fail loudly rather than silently claiming
            // a successfully persisted interstitial has no disposition bucket.
            throw new Error("Unexpected READY_NEW disposition for an interstitial failure");
        }
      }
    }

    // Single PipelineRun update: finalize status + counts AND set the canonical
    // enrichment summary in one write. We avoid finalizePipelineRun here because
    // its PipelineResult summary shape is Agent 1-specific (sourcesScanned etc.
    // do not map cleanly onto an article-enrichment run), and calling it would
    // force a second update to overwrite the summary. One write is cheaper and
    // gives full control over the enrichment-specific summary shape.
    //
    // Note on field-name reuse: PipelineRun uses Agent 1 field names (candidates
    // = articles eligible for enrichment, inserted = successfully enriched).
    // These are the best available fits in the shared run-tracking schema; the
    // canonical per-kind breakdown lives in the `summary` JSON below.
    const dispositions = buildAgent3BatchDispositions({
      selectedCount: diversified.length,
      persist: persistResult,
      interstitial: interstitialDispositionCounts,
      claimSkipped,
      governorDeferred,
      sourceCooldownSkipped,
    });
    const finalSummary = buildEnrichmentRunSummary(persistResult, outcomes.length, {
      durationMs: Date.now() - startedAt,
      claimSkipped,
      expiredClaimsRecovered,
      governorDeferred,
      selectedCount: diversified.length,
      sourceCooldownSkipped,
      dispositions,
      agent3SourceCooldowns: sourceCooldown.getEntries().length > 0 ? sourceCooldown.getEntries() : undefined,
      browserFallbackStats: browserFallbackEnabled
        ? {
            enabled: true,
            ...browserStats,
            stoppedReason:
              browserStats.runtimeUnavailable > 0
                ? "runtime_unavailable"
                : browserStats.rateLimited >= 3
                  ? "rate_limited"
                  : browserFallbackMaxAttempts > 0 && browserStats.attempted >= browserFallbackMaxAttempts
                    ? "max_attempts"
                    : null,
          }
        : undefined,
      optionsUsed: {
        browserFallback: browserFallbackEnabled,
        browserFallbackMaxAttempts,
        browserTimeoutMs,
        includeEnriched,
        forceReprocess,
        maxArticles: maxArticles ?? MAX_ARTICLES_PER_RUN,
        maxArticlesPerSource,
      },
      httpEvidence: { ...httpEvidence },
    });

    if (ownsPipelineRun) {
      await prisma.pipelineRun.update({
        where: { id: pipelineRun.id },
        data: {
          status: persistResult.failed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        finishedAt: new Date(),
        targetCount: outcomes.length,
        candidatesFound: outcomes.length,
        inserted: persistResult.byKind.SUCCESS,
        skipped: persistResult.byKind.SKIPPED,
        failed: persistResult.failed + persistResult.byKind.RETRYABLE_FAILURE,
        artifactCount: attemptMarkerIds.length + persistResult.artifactIds.length,
        summary: finalSummary,
      },
    });
    } else {
      // The daily workflow owns this PipelineRun as its lock record. Persist a
      // compact Agent 3 diagnostic artifact instead of replacing that lock's
      // orchestration summary with an enrichment summary.
      const postBatchProgress = await getAgent3Progress({
        now,
        includeEnriched,
        forceReprocess,
        sourceIds: options?.sourceIds,
        articleIds: options?.articleIds,
        pipelineRunId: pipelineRun.id,
      });
      await prisma.pipelineArtifact.create({
        data: {
          pipelineRunId: pipelineRun.id,
          orchestrationRunId: pipelineRun.id,
          sourceId: null,
          categoryId: null,
          artifactType: "agent3_progress_diagnostic",
          status: "CAPTURED",
          candidateCount: outcomes.length,
          payload: {
            schemaVersion: 1,
            stage: "agent3",
            articleCount: outcomes.length,
            persisted: persistResult.persisted,
            succeeded: persistResult.byKind.SUCCESS,
            failedRetryable: persistResult.byKind.RETRYABLE_FAILURE,
            deferred: postBatchProgress.deferred,
            quarantined: postBatchProgress.quarantined,
            retryableNow: postBatchProgress.retryableNow,
            readyNew: postBatchProgress.readyNew,
            readyRetry: postBatchProgress.readyRetry,
            nextRetryAt: postBatchProgress.nextRetryAt,
            nonRetryable: postBatchProgress.nonRetryable,
            inProgress: postBatchProgress.inProgress,
            pipelineRunId: pipelineRun.id,
            httpEvidence: { ...httpEvidence },
          },
          errorLog: null,
        },
      });
    }

    const browserLog = browserFallbackEnabled
      ? ` browser=[attempted=${browserStats.attempted},succeeded=${browserStats.succeeded},failed=${browserStats.failed},runtimeUnavailable=${browserStats.runtimeUnavailable},rateLimited=${browserStats.rateLimited}]`
      : "";
    await logAgentScan({
      status: "ARTICLE_CONTENT_ENRICHMENT_FINISHED",
      executionTimeMs: Date.now() - startedAt,
      errorLog: `Agent 3 article enrichment batch finished. articles=${diversified.length}, selected=${articles.length}, attemptMarkers=${attemptMarkerIds.length}, persisted=${persistResult.persisted}, failed=${persistResult.failed}, byKind=${JSON.stringify(persistResult.byKind)}.${browserLog}`,
    });

    const cooldowns = sourceCooldown.getEntries();
    return {
      pipelineRunId: pipelineRun.id,
      selectedCount: diversified.length,
      articleCount: outcomes.length,
      claimSkipped,
      expiredClaimsRecovered,
      governorDeferred,
      sourceCooldownSkipped,
      dispositions,
      persist: persistResult,
      interstitialDispositionCounts,
      httpEvidence,
      optionsUsed: {
        includeEnriched,
        forceReprocess,
        browserFallback: browserFallbackEnabled,
      },
      ...(browserFallbackEnabled ? { browserFallbackStats: browserStats } : {}),
      ...(cooldowns.length > 0 ? { sourceCooldowns: cooldowns } : {}),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;

    // Only fail a PipelineRun created by this enrichment invocation. A daily
    // workflow passes its lock run here; changing that run's status would
    // destroy the lock before the workflow step can retry this batch.
    // Non-fatal: if this fails, the log is the authoritative failure record.
    if (pipelineRun && ownsPipelineRun) {
      try {
        await prisma.pipelineRun.update({
          where: { id: pipelineRun.id },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
          },
        });
      } catch {
        // PipelineRun update failure is non-fatal during error recovery.
      }
    }

    // Emit ARTICLE_CONTENT_ENRICHMENT_FAILED log. Non-fatal if logging fails.
    try {
      await logAgentScan({
        status: "ARTICLE_CONTENT_ENRICHMENT_FAILED",
        executionTimeMs: durationMs,
        errorLog: `Agent 3 enrichment batch failed: ${message}`,
      });
    } catch {
      // Log failure is non-fatal during error recovery.
    }

    throw err;
  } finally {
    await browserSession?.close();
  }
};
