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
  lastStaticQuality: string | null;
  /** Whether the most recent static discovery quality assessment had shouldEscalateToHeadless=true. */
  lastStaticEscalated: boolean;
  lastBrowserStatus: string | null;
  lastAcceptedCount: number | null;
  lastInsertedCount: number | null;
  consecutiveFailedDiscoveryAttempts: number;
  /** Most recent artifact timestamp (used for ordering + recency). */
  lastSeenAt: Date;
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

function targetKey(sourceId: string, categoryId: string | null, targetUrl: string): string {
  return `${sourceId}|${categoryId ?? ""}|${targetUrl}`;
}

/**
 * Aggregate a single artifact into the per-target map. Updates the most
 * recent static quality / browser status / counts, and increments the
 * consecutive failed attempt counter when appropriate.
 *
 * Artifacts are assumed to be passed in createdAt-ascending order so the
 * "last" values naturally reflect the most recent artifact for each target.
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

    const productive = quality === "productive";
    // A "weak" target only counts as a failed attempt when it actually
    // escalated (shouldEscalateToHeadless=true). Weak-but-stable targets
    // are NOT hard sources per the spec ("weak with escalation").
    const failed =
      quality !== null &&
      NON_PRODUCTIVE_STATIC_QUALITIES.has(quality) &&
      (quality !== "weak" || escalated);

    if (existing) {
      existing.lastStaticQuality = quality ?? existing.lastStaticQuality;
      existing.lastStaticEscalated = escalated;
      if (productive) {
        existing.consecutiveFailedDiscoveryAttempts = 0;
      } else if (failed) {
        existing.consecutiveFailedDiscoveryAttempts += 1;
      }
      if (artifact.createdAt > existing.lastSeenAt) {
        existing.lastSeenAt = artifact.createdAt;
      }
    } else {
      byTarget.set(key, {
        targetUrl,
        sourceId,
        categoryId: artifact.categoryId,
        lastStaticQuality: quality,
        lastStaticEscalated: escalated,
        lastBrowserStatus: null,
        lastAcceptedCount: null,
        lastInsertedCount: null,
        consecutiveFailedDiscoveryAttempts: productive ? 0 : failed ? 1 : 0,
        lastSeenAt: artifact.createdAt,
      });
    }
    return;
  }

  if (artifact.artifactType === "article_discovery_headless_required") {
    const accepted = readNumber(payload.browserAccepted);
    const inserted = readNumber(payload.browserInserted);

    if (existing) {
      existing.lastBrowserStatus = artifact.status;
      existing.lastAcceptedCount = accepted;
      existing.lastInsertedCount = inserted;
      // Browser RESOLVED resets the failure streak (browser unblocked it).
      // Browser failure (no candidates / runtime unavailable / etc.) IS a
      // failed discovery attempt and increments the streak — this matches the
      // spec acceptance: "static and browser both fail → AI-inspection candidate".
      if (artifact.status === "RESOLVED" || (accepted !== null && accepted > 0)) {
        existing.consecutiveFailedDiscoveryAttempts = 0;
      } else if (BROWSER_FAILURE_STATUSES.has(artifact.status)) {
        existing.consecutiveFailedDiscoveryAttempts += 1;
      }
      if (artifact.createdAt > existing.lastSeenAt) {
        existing.lastSeenAt = artifact.createdAt;
      }
    } else {
      byTarget.set(key, {
        targetUrl,
        sourceId,
        categoryId: artifact.categoryId,
        lastStaticQuality: null,
        lastStaticEscalated: false,
        lastBrowserStatus: artifact.status,
        lastAcceptedCount: accepted,
        lastInsertedCount: inserted,
        consecutiveFailedDiscoveryAttempts:
          artifact.status === "RESOLVED" || (accepted !== null && accepted > 0)
            ? 0
            : BROWSER_FAILURE_STATUSES.has(artifact.status)
              ? 1
              : 0,
        lastSeenAt: artifact.createdAt,
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
    orderBy: { createdAt: "asc" },
    take: scanLimit,
  });

  const byTarget = new Map<string, AggregatedTarget>();
  for (const artifact of artifacts) {
    aggregateArtifact(byTarget, artifact);
  }

  const hardSources: HardSourceEntry[] = [];
  for (const target of byTarget.values()) {
    // Filter out productive static targets — never hard sources.
    if (target.lastStaticQuality === "productive") continue;

    // Filter out browser-resolved targets.
    const browserResolved =
      target.lastBrowserStatus === "RESOLVED" ||
      (target.lastAcceptedCount !== null && target.lastAcceptedCount > 0);
    if (browserResolved) continue;

    // A static target counts as failed only when it is failed/blocked, OR
    // weak WITH escalation. Weak-without-escalation targets are stable and
    // are NOT hard sources per the spec ("weak with escalation").
    const staticFailed =
      target.lastStaticQuality !== null &&
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

  return {
    generatedAt: new Date().toISOString(),
    scannedArtifacts: artifacts.length,
    hardSources,
    total: hardSources.length,
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
    lastStaticEscalated: true,
    lastInsertedCount: null,
    lastSeenAt: new Date(0),
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
}): boolean {
  if (input.lastStaticQuality === "productive") return true;
  if (
    input.lastBrowserStatus === "RESOLVED" ||
    (input.lastAcceptedCount !== null && input.lastAcceptedCount > 0)
  ) {
    return true;
  }
  return false;
}
