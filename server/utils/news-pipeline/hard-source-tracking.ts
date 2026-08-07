/**
 * Agent 2 hard-source tracking.
 *
 * A "hard source" is a target where:
 *   - static discovery failed or was weak with escalation, AND
 *   - browser fallback also failed, found no candidates, or was
 *     runtime-unavailable, AND
 *   - repeated attempts remain non-productive.
 *
 * This module classifies hard-source state purely from existing
 * PipelineArtifact rows — no DB schema changes are required. It is consumed
 * by the admin diagnostics panel to surface AI-inspection candidates.
 *
 * ## Acceptance rules
 * - If a source is productive statically → it is NOT a hard source.
 * - If browser fallback resolves it → it is NOT a hard source (and old
 *   hard-source/queue markers should leave the active queue view via the
 *   existing RESOLVED / RESOLVED_BY_STATIC_DISCOVERY statuses).
 * - If static and browser both fail → it IS shown as an AI-inspection
 *   candidate (recommendedNextAction: "ai_inspection_candidate").
 * - If browser was runtime-unavailable → the recommended action is
 *   "run_browser" (browser setup / retry), NOT AI inspection by default.
 *
 * The payload is intentionally compact — only the fields needed to triage
 * the target in the admin console. No raw HTML, screenshots, or DOM dumps.
 */

import { prisma } from "../prisma";
import { stableTargetKey, normalizeTargetUrl } from "./text";
import { classifyBrowserFailureOrigin } from "./failure-origin";

// ─── Types ──────────────────────────────────────────────────────────────────

export type HardSourceRecommendedNextAction =
  | "retry_static"
  | "run_browser"
  | "manual_review"
  | "ai_inspection_candidate";

export type HardSourceEntry = {
  /** Stable key: `${sourceId}|${categoryId ?? ""}|${targetUrl}` */
  key: string;
  targetUrl: string;
  sourceId: string;
  categoryId: string | null;
  /** Whether Agent 1 has already resolved this target with an active scoped RSS feed. */
  resolvedByAgent1ScopedRss: boolean;
  /** Most recent static discovery quality (productive / weak / failed / blocked). */
  lastStaticQuality: string | null;
  /** Most recent browser fallback artifact status (e.g. RESOLVED, BROWSER_NO_CANDIDATES). */
  lastBrowserStatus: string | null;
  /** Accepted candidate count from the most recent browser fallback run. */
  lastAcceptedCount: number | null;
  /** Inserted candidate count from the most recent browser fallback run. */
  lastInsertedCount: number | null;
  /**
   * Best-effort count of consecutive non-productive discovery attempts,
   * derived from the recent artifact scan window. Approximate because
   * artifacts older than the scan window are not counted.
   */
  consecutiveFailedDiscoveryAttempts: number;
  recommendedNextAction: HardSourceRecommendedNextAction;
};

export type HardSourceReport = {
  /** UTC timestamp the report was generated. */
  generatedAt: string;
  /** Number of artifacts scanned to derive the report. */
  scannedArtifacts: number;
  /** Targets classified as hard sources. */
  hardSources: HardSourceEntry[];
  /** Total hard-source count (convenience for admin summary). */
  total: number;
  /**
   * Targets that have evidence but are currently under active 429 cooldown.
   * These are NOT included in hardSources because a 429 is a temporary
   * rate-limit, not a permanent discovery failure.
   */
  cooldownOnlyCount: number;
  /**
   * Targets whose latest browser outcome was a platform/runtime or
   * configuration failure (BROWSER_RUNTIME_UNAVAILABLE / FALLBACK_DISABLED).
   * These provide no publisher evidence and are never hard sources, but they
   * remain visible here for admin diagnostics.
   */
  runtimeFailureOnlyCount: number;
  /** Total targets with any evidence (hard-sources + cooldown-only + runtime + non-qualifying). */
  evidenceTargetCount: number;
  /** Targets that qualify as hard sources (same as hardSources.length). */
  qualifyingHardSourceCount: number;
  /** Targets that were productive or resolved (excluded from report). */
  resolvedOrProductiveCount: number;
  /** Targets with transient/incomplete Prompt 15A static evidence. */
  deferredIncompleteCount: number;
};

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * How many recent Agent 2 artifacts to scan when classifying hard sources.
 * Bounded so the report stays compact and the query stays cheap.
 */
const DEFAULT_SCAN_LIMIT = 200;

/**
 * Statuses that indicate a browser fallback attempt did NOT resolve the
 * target. Used to decide whether a target is a hard source.
 */
const BROWSER_FAILURE_STATUSES = new Set<string>([
  "BROWSER_NO_CANDIDATES",
  "BROWSER_RUNTIME_UNAVAILABLE",
  "BROWSER_FALLBACK_DISABLED",
  "HEADLESS_PROCESSING_STALE",
]);

/**
 * Static discovery quality labels that count as non-productive for the
 * purposes of hard-source classification.
 */
const NON_PRODUCTIVE_STATIC_QUALITIES = new Set<string>([
  "failed",
  "blocked",
  "weak",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

type RawArtifact = {
  id: string;
  artifactType: string;
  status: string;
  sourceId: string | null;
  categoryId: string | null;
  candidateCount: number;
  createdAt: Date;
  payload: unknown;
};

type AggregatedTarget = {
  targetUrl: string;
  sourceId: string;
  categoryId: string | null;
  resolvedByAgent1ScopedRss: boolean;
  lastStaticQuality: string | null;
  /** Whether the most recent static discovery quality assessment had shouldEscalateToHeadless=true. */
  lastStaticEscalated: boolean;
  /** Prompt 15A completeness evidence; absent legacy fields remain quality-only. */
  lastStaticRetryable: boolean;
  lastStaticDiscoveryComplete: boolean;
  lastStaticStopReason: string | null;
  lastBrowserStatus: string | null;
  lastAcceptedCount: number | null;
  lastInsertedCount: number | null;
  consecutiveFailedDiscoveryAttempts: number;
  /** Most recent artifact timestamp (used for ordering + recency). */
  lastSeenAt: Date;
  /** Whether consecutive failure streak is still accumulating (desc-order aggregation). */
  _streakActive: boolean;
  /** Exact rate-limit fields from persisted payload (for cooldown classification). */
  browserRateLimited: boolean;
  browserRateLimitReason: string | null;
  browserRateLimitedAt: string | null;
  browserRetryAfterAt: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * Legacy targetKey wrapper — delegates to shared stableTargetKey.
 * Returns empty string on invalid input for backward compat with callers
 * that don't check null.
 */
function targetKey(sourceId: string, categoryId: string | null, targetUrl: string): string {
  return stableTargetKey(sourceId, categoryId, targetUrl) ?? `${sourceId}|${categoryId ?? ""}|${targetUrl}`;
}

function isActiveScopedRssResolution(input: {
  categoryId: string | null;
  sourceFeedUrl: string | null;
  sourceRssStatus: string | null;
  categoryFeedUrl: string | null;
  categoryRssStatus: string | null;
}): boolean {
  if (input.categoryId) {
    return input.categoryRssStatus === "ACTIVE" && input.categoryFeedUrl !== null;
  }

  return input.sourceRssStatus === "ACTIVE" && input.sourceFeedUrl !== null;
}

/**
 * Aggregate a single artifact into the per-target map. Updates the most
 * recent static quality / browser status / counts, and increments the
 * consecutive failed attempt counter when appropriate.
 *
 * Artifacts are assumed to be passed in createdAt-ascending order so the
 * "last" values naturally reflect the most recent artifact for each target.
 */
/**
 * Aggregate a single artifact into the per-target map.
 *
 * IMPORTANT: Artifacts are now expected in createdAt-DESCENDING order
 * (newest first). The FIRST encounter of a target key is the most recent
 * artifact and sets the authoritative state. Subsequent (older) artifacts
 * only contribute to the consecutive failure streak counter.
 *
 * This ensures the most recent state is never overwritten by stale data
 * when the query uses `orderBy: { createdAt: "desc" }`.
 */
function aggregateArtifact(
  byTarget: Map<string, AggregatedTarget>,
  artifact: RawArtifact,
): void {
  const payload = isPlainObject(artifact.payload) ? artifact.payload : {};
  const targetUrl = readString(payload.targetUrl);
  const sourceId = readString(payload.sourceId) ?? artifact.sourceId;
  if (!targetUrl || !sourceId) return;

  const key = targetKey(sourceId, artifact.categoryId, targetUrl);
  const existing = byTarget.get(key);

  if (artifact.artifactType === "article_discovery_candidates") {
    // Static discovery artifact — record quality + escalation flag + failure streak.
    const qa = isPlainObject(payload.qualityAssessment) ? payload.qualityAssessment : {};
    const quality = readString(qa.quality) ?? readString(payload.quality);
    const escalated = readBoolean(qa.shouldEscalateToHeadless);
    const hasPrompt15AFields = "retryable" in payload || "discoveryComplete" in payload || "detailEvaluationStoppedReason" in payload;
    const retryable = payload.retryable === true;
    const discoveryComplete = payload.discoveryComplete !== false;
    const stopReason = readString(payload.detailEvaluationStoppedReason);
    const transientIncomplete = hasPrompt15AFields && (retryable || !discoveryComplete || stopReason === "rate_limited" || stopReason === "request_budget_exhausted");

    const productive = quality === "productive" && !transientIncomplete;
    // A "weak" target only counts as a failed attempt when it actually
    // escalated (shouldEscalateToHeadless=true). Weak-but-stable targets
    // are NOT hard sources per the spec ("weak with escalation").
    const failed =
      quality !== null &&
      !transientIncomplete &&
      NON_PRODUCTIVE_STATIC_QUALITIES.has(quality) &&
      (quality !== "weak" || escalated);

    if (existing) {
      // Older artifact: fill in missing fields and contribute to failure streak.
      // Always update lastStaticQuality if the existing entry doesn't have it
      // (can happen when the first-encounter artifact was a browser artifact).
      if (existing.lastStaticQuality === null && quality !== null) {
        existing.lastStaticQuality = quality;
        existing.lastStaticEscalated = escalated;
        existing.lastStaticRetryable = retryable;
        existing.lastStaticDiscoveryComplete = discoveryComplete;
        existing.lastStaticStopReason = stopReason;
      }
      if (existing._streakActive) {
        if (productive) {
          existing._streakActive = false; // stop counting further back
        } else if (failed) {
          existing.consecutiveFailedDiscoveryAttempts += 1;
        }
      }
    } else {
      // First (most recent) encounter — set authoritative state.
      byTarget.set(key, {
        targetUrl,
        sourceId,
        categoryId: artifact.categoryId,
        resolvedByAgent1ScopedRss: false,
        lastStaticQuality: quality,
        lastStaticEscalated: escalated,
        lastStaticRetryable: retryable,
        lastStaticDiscoveryComplete: discoveryComplete,
        lastStaticStopReason: stopReason,
        lastBrowserStatus: null,
        lastAcceptedCount: null,
        lastInsertedCount: null,
        consecutiveFailedDiscoveryAttempts: productive ? 0 : failed ? 1 : 0,
        lastSeenAt: artifact.createdAt,
        _streakActive: !productive,
        browserRateLimited: false,
        browserRateLimitReason: null,
        browserRateLimitedAt: null,
        browserRetryAfterAt: null,
      });
    }
    return;
  }

  if (artifact.artifactType === "article_discovery_headless_required") {
    const accepted = readNumber(payload.browserAccepted);
    const inserted = readNumber(payload.browserInserted);

    if (existing) {
      // Older artifact: fill in missing fields and contribute to failure streak.
      // Always update lastBrowserStatus if the existing entry doesn't have it
      // (can happen when the first-encounter artifact was a static artifact).
      if (existing.lastBrowserStatus === null) {
        existing.lastBrowserStatus = artifact.status;
        existing.lastAcceptedCount = accepted;
        existing.lastInsertedCount = inserted;
        existing.browserRateLimited = payload.browserRateLimited === true;
        existing.browserRateLimitReason = readString(payload.browserRateLimitReason);
        existing.browserRateLimitedAt = readString(payload.browserRateLimitedAt);
        existing.browserRetryAfterAt =
          readString(payload.browserRetryAfterAt) ?? readString(payload.browserCooldownUntil);
      }
      const resolved = artifact.status === "RESOLVED" || (accepted !== null && accepted > 0);
      if (existing._streakActive) {
        if (resolved) {
          existing._streakActive = false;
        } else if (BROWSER_FAILURE_STATUSES.has(artifact.status)) {
          existing.consecutiveFailedDiscoveryAttempts += 1;
        }
      }
    } else {
      // First (most recent) encounter — set authoritative state.
      const resolved = artifact.status === "RESOLVED" || (accepted !== null && accepted > 0);
      const rateLimited = payload.browserRateLimited === true;
      byTarget.set(key, {
        targetUrl,
        sourceId,
        categoryId: artifact.categoryId,
        resolvedByAgent1ScopedRss: false,
        lastStaticQuality: null,
        lastStaticEscalated: false,
        lastStaticRetryable: false,
        lastStaticDiscoveryComplete: true,
        lastStaticStopReason: null,
        lastBrowserStatus: artifact.status,
        lastAcceptedCount: accepted,
        lastInsertedCount: inserted,
        consecutiveFailedDiscoveryAttempts: resolved ? 0 : BROWSER_FAILURE_STATUSES.has(artifact.status) ? 1 : 0,
        lastSeenAt: artifact.createdAt,
        _streakActive: !resolved,
        browserRateLimited: rateLimited,
        browserRateLimitReason: readString(payload.browserRateLimitReason),
        browserRateLimitedAt: readString(payload.browserRateLimitedAt),
        browserRetryAfterAt:
          readString(payload.browserRetryAfterAt) ?? readString(payload.browserCooldownUntil),
      });
    }
  }
}

/**
 * Decide the recommended next action for a target given its aggregated state.
 *
 * Order of preference:
 * 1. Browser resolved it (accepted > 0 or status RESOLVED) → not a hard
 *    source, caller filters these out before reaching this function.
 * 2. Browser was runtime-unavailable / disabled → run_browser (retry browser
 *    setup). NOT AI inspection by default — the browser layer hasn't had a
 *    fair chance yet.
 * 3. Static + browser both failed (browser found no candidates or errored)
 *    AND repeated failures → ai_inspection_candidate.
 * 4. Static failed but no browser attempt yet → run_browser.
 * 5. Otherwise → manual_review.
 */
function recommendNextAction(
  target: AggregatedTarget,
): HardSourceRecommendedNextAction {
  const browserResolved =
    target.lastBrowserStatus === "RESOLVED" ||
    (target.lastAcceptedCount !== null && target.lastAcceptedCount > 0);
  if (browserResolved) {
    // Caller filters these out, but keep the function total.
    return "manual_review";
  }

  const browserRuntimeUnavailable =
    target.lastBrowserStatus === "BROWSER_RUNTIME_UNAVAILABLE" ||
    target.lastBrowserStatus === "BROWSER_FALLBACK_DISABLED";

  if (browserRuntimeUnavailable) {
    return "run_browser";
  }

  const browserAttemptedAndFailed =
    target.lastBrowserStatus !== null &&
    BROWSER_FAILURE_STATUSES.has(target.lastBrowserStatus);

  if (browserAttemptedAndFailed) {
    // Static + browser both failed → AI inspection candidate.
    // Require at least 2 consecutive failed attempts to avoid flagging
    // targets that failed once due to a transient issue.
    if (target.consecutiveFailedDiscoveryAttempts >= 2) {
      return "ai_inspection_candidate";
    }
    return "manual_review";
  }

  // Static failed but browser hasn't run yet.
  if (target.lastBrowserStatus === null && target.lastStaticQuality !== null) {
    return "run_browser";
  }

  return "manual_review";
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build a compact hard-source report from recent Agent 2 artifacts.
 *
 * Scans the most recent `scanLimit` article_discovery_candidates and
 * article_discovery_headless_required artifacts, aggregates them per
 * target URL, and returns only the targets classified as hard sources.
 *
 * Productive static targets and browser-resolved targets are filtered out
 * so the report stays focused on genuine AI-inspection candidates.
 */
export async function buildHardSourceReport(input?: {
  scanLimit?: number;
}): Promise<HardSourceReport> {
  const scanLimit = Math.min(
    Math.max(input?.scanLimit ?? DEFAULT_SCAN_LIMIT, 10),
    500,
  );

  const artifacts: RawArtifact[] = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: {
        in: ["article_discovery_candidates", "article_discovery_headless_required"],
      },
    },
    select: {
      id: true,
      artifactType: true,
      status: true,
      sourceId: true,
      categoryId: true,
      candidateCount: true,
      createdAt: true,
      payload: true,
    },
    orderBy: { createdAt: "desc" },
    take: scanLimit,
  });

  // Aggregate artifacts newest-first. aggregateArtifact only sets
  // lastStaticQuality / lastBrowserStatus on the FIRST encounter of each
  // target key (i.e. the most recent artifact), preserving newest state.
  const byTarget = new Map<string, AggregatedTarget>();
  for (const artifact of artifacts) {
    aggregateArtifact(byTarget, artifact);
  }

  const [activeSources, activeCategories] = await Promise.all([
    prisma.newsSource.findMany({
      where: {
        rssStatus: "ACTIVE",
        rssFeedUrl: { not: null },
      },
      select: {
        id: true,
        rssFeedUrl: true,
        rssStatus: true,
      },
    }),
    prisma.sourceCategory.findMany({
      where: {
        rssStatus: "ACTIVE",
        rssFeedUrl: { not: null },
      },
      select: {
        newsSourceId: true,
        id: true,
        rssFeedUrl: true,
        rssStatus: true,
      },
    }),
  ]);

  const activeSourceById = new Map(
    activeSources.map((source) => [source.id, source]),
  );
  const activeCategoryByKey = new Map(
    activeCategories.map((category) => [`${category.newsSourceId}|${category.id}`, category]),
  );

  const hardSources: HardSourceEntry[] = [];
  let cooldownOnlyCount = 0;
  let runtimeFailureOnlyCount = 0;
  let evidenceTargetCount = 0;
  let resolvedOrProductiveCount = 0;
  let deferredIncompleteCount = 0;
  const nowMs = Date.now();
  for (const target of byTarget.values()) {
    const activeSource = activeSourceById.get(target.sourceId) || null;
    const activeCategory =
      target.categoryId !== null
        ? activeCategoryByKey.get(`${target.sourceId}|${target.categoryId}`) || null
        : null;
    target.resolvedByAgent1ScopedRss = isActiveScopedRssResolution({
      categoryId: target.categoryId,
      sourceFeedUrl: activeSource?.rssFeedUrl || null,
      sourceRssStatus: activeSource?.rssStatus || null,
      categoryFeedUrl: activeCategory?.rssFeedUrl || null,
      categoryRssStatus: activeCategory?.rssStatus || null,
    });

    if (target.lastStaticQuality !== null || target.lastBrowserStatus !== null) {
      evidenceTargetCount += 1;
    }

    if (target.resolvedByAgent1ScopedRss) {
      resolvedOrProductiveCount += 1;
      continue;
    }

    // Prompt 15A transient/incomplete static evidence is deferred work, not
    // publisher failure. It must not become a hard source even when an older
    // or subsequent browser failure is also present.
    const staticTransientIncomplete = target.lastStaticRetryable
      || !target.lastStaticDiscoveryComplete
      || target.lastStaticStopReason === "rate_limited"
      || target.lastStaticStopReason === "request_budget_exhausted";
    if (staticTransientIncomplete) {
      deferredIncompleteCount += 1;
      continue;
    }

    // Filter out productive static targets — never hard sources.
    if (target.lastStaticQuality === "productive" && !target.lastStaticRetryable && target.lastStaticDiscoveryComplete && target.lastStaticStopReason !== "rate_limited" && target.lastStaticStopReason !== "request_budget_exhausted") {
      resolvedOrProductiveCount += 1;
      continue;
    }

    // Filter out browser-resolved targets.
    const browserResolved =
      target.lastBrowserStatus === "RESOLVED" ||
      (target.lastAcceptedCount !== null && target.lastAcceptedCount > 0);
    if (browserResolved) {
      resolvedOrProductiveCount += 1;
      continue;
    }

    const retryAfterMs = target.browserRetryAfterAt
      ? Date.parse(target.browserRetryAfterAt)
      : Number.NaN;
    if (
      target.browserRateLimited &&
      target.browserRateLimitReason === "http_429" &&
      Number.isFinite(retryAfterMs) &&
      retryAfterMs > nowMs
    ) {
      cooldownOnlyCount += 1;
      continue;
    }

    // Platform/runtime and configuration failures (BROWSER_RUNTIME_UNAVAILABLE,
    // BROWSER_FALLBACK_DISABLED) provide no evidence about the publisher and
    // must never produce or strengthen a hard-source profile — even when the
    // static side also failed. They stay visible in this bounded bucket.
    const browserOrigin = classifyBrowserFailureOrigin(target.lastBrowserStatus);
    if (browserOrigin === "platform_runtime_failure" || browserOrigin === "configuration_failure") {
      runtimeFailureOnlyCount += 1;
      continue;
    }

    // A static target counts as failed only when it is failed/blocked, OR
    // weak WITH escalation. Weak-without-escalation targets are stable and
    // are NOT hard sources per the spec ("weak with escalation").
    const staticFailed =
      target.lastStaticQuality !== null &&
      !target.lastStaticRetryable &&
      target.lastStaticDiscoveryComplete &&
      target.lastStaticStopReason !== "rate_limited" &&
      target.lastStaticStopReason !== "request_budget_exhausted" &&
      NON_PRODUCTIVE_STATIC_QUALITIES.has(target.lastStaticQuality) &&
      (target.lastStaticQuality !== "weak" || target.lastStaticEscalated);
    const browserFailed =
      target.lastBrowserStatus !== null &&
      BROWSER_FAILURE_STATUSES.has(target.lastBrowserStatus);
    if (!staticFailed && !browserFailed) continue;

    const recommendedNextAction = recommendNextAction(target);

    hardSources.push({
      key: targetKey(target.sourceId, target.categoryId, target.targetUrl),
      targetUrl: target.targetUrl,
      sourceId: target.sourceId,
      categoryId: target.categoryId,
      resolvedByAgent1ScopedRss: target.resolvedByAgent1ScopedRss,
      lastStaticQuality: target.lastStaticQuality,
      lastBrowserStatus: target.lastBrowserStatus,
      lastAcceptedCount: target.lastAcceptedCount,
      lastInsertedCount: target.lastInsertedCount,
      consecutiveFailedDiscoveryAttempts: target.consecutiveFailedDiscoveryAttempts,
      recommendedNextAction,
    });
  }

  // Sort by consecutive failure count descending so repeated failures
  // bubble to the top of the admin view. A secondary alphabetical sort on
  // targetUrl keeps the order deterministic for equal failure counts.
  // We intentionally do not expose lastSeenAt in the compact entry, so
  // recency is not the primary sort key — failure severity is.
  hardSources.sort((a, b) => {
    if (b.consecutiveFailedDiscoveryAttempts !== a.consecutiveFailedDiscoveryAttempts) {
      return b.consecutiveFailedDiscoveryAttempts - a.consecutiveFailedDiscoveryAttempts;
    }
    return b.targetUrl.localeCompare(a.targetUrl);
  });

  // Count targets that have evidence but are excluded because they
  // are under active 429 cooldown (not permanent failures).
  // Uses EXACT persisted rate-limit fields from the artifact payload,
  // not approximate status-based checks.
  return {
    generatedAt: new Date().toISOString(),
    scannedArtifacts: artifacts.length,
    hardSources,
    total: hardSources.length,
    cooldownOnlyCount,
    runtimeFailureOnlyCount,
    evidenceTargetCount,
    qualifyingHardSourceCount: hardSources.length,
    resolvedOrProductiveCount,
    deferredIncompleteCount,
  };
}

// ─── Pure helpers exported for unit testing ─────────────────────────────────

/**
 * Classify a single aggregated target's recommended next action without
 * touching the database. Exposed for unit testing the decision rules.
 */
export function classifyRecommendedNextAction(input: {
  lastStaticQuality: string | null;
  lastBrowserStatus: string | null;
  lastAcceptedCount: number | null;
  consecutiveFailedDiscoveryAttempts: number;
}): HardSourceRecommendedNextAction {
  return recommendNextAction({
    targetUrl: "",
    sourceId: "",
    categoryId: null,
    resolvedByAgent1ScopedRss: false,
    lastStaticEscalated: true,
    lastStaticRetryable: false,
    lastStaticDiscoveryComplete: true,
    lastStaticStopReason: null,
    lastInsertedCount: null,
    lastSeenAt: new Date(0),
    _streakActive: true,
    browserRateLimited: false,
    browserRateLimitReason: null,
    browserRateLimitedAt: null,
    browserRetryAfterAt: null,
    ...input,
  });
}

/**
 * Check whether a target should be excluded from the hard-source report
 * (i.e. it is NOT a hard source). Exposed for unit testing the filter rules.
 */
export function isProductiveOrResolved(input: {
  lastStaticQuality: string | null;
  lastBrowserStatus: string | null;
  lastAcceptedCount: number | null;
  resolvedByAgent1ScopedRss?: boolean;
  lastStaticRetryable?: boolean;
  lastStaticDiscoveryComplete?: boolean;
  lastStaticStopReason?: string | null;
}): boolean {
  if (input.resolvedByAgent1ScopedRss === true) return true;
  const staticTransientIncomplete = input.lastStaticRetryable === true
    || input.lastStaticDiscoveryComplete === false
    || input.lastStaticStopReason === "rate_limited"
    || input.lastStaticStopReason === "request_budget_exhausted";
  if (input.lastStaticQuality === "productive" && !staticTransientIncomplete) return true;
  if (
    input.lastBrowserStatus === "RESOLVED" ||
    (input.lastAcceptedCount !== null && input.lastAcceptedCount > 0)
  ) {
    return true;
  }
  return false;
}
