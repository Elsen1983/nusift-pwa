/**
 * Agent 2 source/target health scoring utility.
 *
 * Computes a compact health summary for each Agent 2 target by reading
 * existing PipelineArtifact rows, hard-source profiles, and RSS state.
 * No DB writes — read-only normalization.
 *
 * ## Health scores
 * - healthy (70-100): recent productive discovery
 * - weak (40-69): intermittent issues, some candidates but not strong
 * - blocked (20-39): repeated failures, needs attention
 * - unsupported (0-19): determined to be unsupported
 * - unknown (50): no recent data
 *
 * ## Key behavior
 * - RSS active sources are always healthy (Agent 2 not needed)
 * - Runtime-unavailable lowers environment confidence, not source health
 * - Cooldown lowers retry readiness but not permanent score
 * - Recent productive static/browser boosts score
 * - Repeated no-candidates lowers score
 *
 * No publisher-specific special casing.
 */

import { prisma } from "../prisma";
import {
  classifyAgent2TargetLifecycle,
  isAgent2TargetResolved,
  type Agent2LifecycleState,
} from "./agent2-target-lifecycle";
import { stableTargetKey } from "./text";
import {
  classifyBrowserFailureOrigin,
  healthDescriptionForBrowserFailure,
} from "./failure-origin";

// ─── Types ──────────────────────────────────────────────────────────────────

export type Agent2TargetHealthStatus = "healthy" | "weak" | "blocked" | "unsupported" | "unknown";

export type Agent2TargetHealth = {
  sourceId: string;
  categoryId: string | null;
  targetUrl: string;
  health: Agent2TargetHealthStatus;
  score: number;
  lastProductiveAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastStaticStatus: string | null;
  lastBrowserStatus: string | null;
  currentLifecycleState: Agent2LifecycleState;
  recommendedAction: string | null;
  // ── Browser cooldown observability ──────────────────────────────────
  browserCooldownUntil: string | null;
  browserRateLimitedAt: string | null;
  browserRetryAfterAt: string | null;
  browserRateLimitReason: string | null;
  lastBrowserCooldownSkipAt: string | null;
  // ── Browser timing observability ───────────────────────────────────
  lastBrowserAttemptAt: string | null;
  lastBrowserFinishedAt: string | null;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SCAN_LIMIT = 300;
const BROWSER_FAILURE_STATUSES = new Set([
  "BROWSER_NO_CANDIDATES",
  "BROWSER_RUNTIME_UNAVAILABLE",
  "BROWSER_FALLBACK_DISABLED",
  "HEADLESS_PROCESSING_STALE",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Legacy targetKey wrapper — delegates to shared stableTargetKey.
 */
function targetKey(sourceId: string, categoryId: string | null, targetUrl: string): string {
  return stableTargetKey(sourceId, categoryId, targetUrl) ?? `${sourceId}|${categoryId ?? ""}|${targetUrl}`;
}

// ─── Scoring logic ──────────────────────────────────────────────────────────

function computeHealthScore(input: {
  rssActive: boolean;
  rssProductive: boolean;
  lastStaticQuality: string | null;
  lastBrowserStatus: string | null;
  lastAcceptedCount: number | null;
  consecutiveFailures: number;
  lastProductiveAt: Date | null;
  lastFailureAt: Date | null;
  inCooldown: boolean;
  hardSourceLifecycleState: string | null;
}): { health: Agent2TargetHealthStatus; score: number; recommendedAction: string | null } {
  const {
    rssActive,
    rssProductive,
    lastStaticQuality,
    lastBrowserStatus,
    lastAcceptedCount,
    consecutiveFailures,
    lastProductiveAt,
    lastFailureAt,
    inCooldown,
    hardSourceLifecycleState,
  } = input;

  // RSS active + productive → always healthy
  if (rssActive && rssProductive) {
    return { health: "healthy", score: 95, recommendedAction: null };
  }

  // RSS active but not productive → weak (needs monitoring)
  if (rssActive && !rssProductive) {
    return { health: "weak", score: 55, recommendedAction: "Monitor RSS feed productivity." };
  }

  let score = 50; // baseline
  let recommendedAction: string | null = null;

  // Recent productive discovery boosts score
  if (lastProductiveAt) {
    const daysSinceProductive = (Date.now() - lastProductiveAt.getTime()) / (24 * 60 * 60 * 1000);
    if (daysSinceProductive < 7) score += 30;
    else if (daysSinceProductive < 30) score += 15;
    else if (daysSinceProductive < 90) score += 5;
  }

  // Browser accepted candidates
  if (lastAcceptedCount !== null && lastAcceptedCount > 0) {
    score += 20;
  }

  // Static quality
  if (lastStaticQuality === "productive") {
    score += 15;
  } else if (lastStaticQuality === "weak") {
    score -= 5;
  } else if (lastStaticQuality === "failed") {
    score -= 15;
  } else if (lastStaticQuality === "blocked") {
    score -= 20;
  }

  // Browser failures — only genuine publisher evidence lowers the source
  // score. Platform/runtime failures (BROWSER_RUNTIME_UNAVAILABLE) and
  // configuration failures (BROWSER_FALLBACK_DISABLED) never reduce source
  // health as if the publisher failed; they stay visible via the
  // recommendedAction and lastBrowserStatus fields.
  if (lastBrowserStatus !== null && BROWSER_FAILURE_STATUSES.has(lastBrowserStatus)) {
    const browserOrigin = classifyBrowserFailureOrigin(lastBrowserStatus);
    if (browserOrigin === "publisher_content_failure") {
      score -= 10;
    }
    const healthNote = healthDescriptionForBrowserFailure(lastBrowserStatus);
    if (healthNote) {
      recommendedAction = healthNote;
    }
  }

  // Consecutive failures
  if (consecutiveFailures >= 5) {
    score -= 30;
    recommendedAction = recommendedAction ?? "Source appears unsupported — consider AI inspection or marking unsupported.";
  } else if (consecutiveFailures >= 3) {
    score -= 20;
    recommendedAction = recommendedAction ?? "Repeated failures — needs attention.";
  } else if (consecutiveFailures >= 2) {
    score -= 10;
  }

  // Cooldown reduces temporary readiness, not permanent score
  if (inCooldown) {
    score -= 5;
    recommendedAction = recommendedAction ?? "In browser cooldown — will retry automatically.";
  }

  // Hard-source profile states
  if (hardSourceLifecycleState === "open") {
    score = Math.min(score, 35);
    recommendedAction = recommendedAction ?? "Hard-source profile open — review recovery suggestions.";
  } else if (hardSourceLifecycleState === "suggested") {
    score = Math.min(score, 30);
    recommendedAction = recommendedAction ?? "Recovery suggestion available — review and apply.";
  } else if (hardSourceLifecycleState === "applied") {
    score = Math.min(score, 40);
    recommendedAction = recommendedAction ?? "Discovery profile applied — monitor for improvement.";
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Determine health status
  let health: Agent2TargetHealthStatus;
  if (score >= 70) health = "healthy";
  else if (score >= 40) health = "weak";
  else if (score >= 20) health = "blocked";
  else if (consecutiveFailures >= 5) health = "unsupported";
  else health = "blocked";

  // No recent data at all → unknown
  if (!lastProductiveAt && !lastFailureAt && lastStaticQuality === null) {
    health = "unknown";
    score = 50;
    recommendedAction = null;
  }

  return { health, score, recommendedAction };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build a compact health report for all Agent 2 targets.
 * Read-only — no DB writes.
 */
export async function buildAgent2HealthReport(input?: {
  scanLimit?: number;
}): Promise<Agent2TargetHealth[]> {
  const scanLimit = Math.min(
    Math.max(input?.scanLimit ?? DEFAULT_SCAN_LIMIT, 10),
    500,
  );

  // Scan recent static + browser artifacts
  const artifacts = await prisma.pipelineArtifact.findMany({
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

  // Aggregate per-target (artifacts are newest-first due to desc ordering).
  // First encounter of a key = most recent artifact, sets authoritative state.
  // Subsequent (older) artifacts only contribute to failure streak.
  type TargetAgg = {
    targetUrl: string;
    sourceId: string;
    categoryId: string | null;
    lastStaticQuality: string | null;
    lastStaticEscalated: boolean;
    lastBrowserStatus: string | null;
    lastAcceptedCount: number | null;
    lastInsertedCount: number | null;
    consecutiveFailures: number;
    lastProductiveAt: Date | null;
    lastFailureAt: Date | null;
    lastSeenAt: Date;
    inCooldown: boolean;
    browserCooldownUntil: string | null;
    browserRateLimitedAt: string | null;
    browserRetryAfterAt: string | null;
    browserRateLimitReason: string | null;
    lastBrowserCooldownSkipAt: string | null;
    lastBrowserAttemptAt: string | null;
    lastBrowserFinishedAt: string | null;
    /** Whether consecutive failure streak is still accumulating (desc-order). */
    _streakActive: boolean;
  };

  const byTarget = new Map<string, TargetAgg>();

  for (const artifact of artifacts) {
    const payload = isPlainObject(artifact.payload) ? artifact.payload : {};
    const targetUrl = readString(payload.targetUrl);
    const sourceId = readString(payload.sourceId) ?? artifact.sourceId;
    if (!targetUrl || !sourceId) continue;

    const key = targetKey(sourceId, artifact.categoryId, targetUrl);
    const existing = byTarget.get(key);

    if (artifact.artifactType === "article_discovery_candidates") {
      const qa = isPlainObject(payload.qualityAssessment) ? payload.qualityAssessment : {};
      const quality = readString(qa.quality) ?? readString(payload.quality);
      const escalated = qa.shouldEscalateToHeadless === true;
      const productive = quality === "productive";

      if (existing) {
        // Older artifact: only contribute to failure streak if active.
        if (existing._streakActive) {
          if (productive) {
            existing._streakActive = false;
          } else if (quality !== null && quality !== "productive") {
            existing.consecutiveFailures += 1;
            existing.lastFailureAt = artifact.createdAt;
          }
        }
      } else {
        // First (most recent) encounter — set authoritative state.
        byTarget.set(key, {
          targetUrl,
          sourceId,
          categoryId: artifact.categoryId,
          lastStaticQuality: quality,
          lastStaticEscalated: escalated,
          lastBrowserStatus: null,
          lastAcceptedCount: null,
          lastInsertedCount: null,
          consecutiveFailures: productive ? 0 : quality !== null ? 1 : 0,
          lastProductiveAt: productive ? artifact.createdAt : null,
          lastFailureAt: !productive && quality !== null ? artifact.createdAt : null,
          lastSeenAt: artifact.createdAt,
          inCooldown: false,
          browserCooldownUntil: null,
          browserRateLimitedAt: null,
          browserRetryAfterAt: null,
          browserRateLimitReason: null,
          lastBrowserCooldownSkipAt: null,
          lastBrowserAttemptAt: null,
          lastBrowserFinishedAt: null,
          _streakActive: !productive,
        });
      }
    } else if (artifact.artifactType === "article_discovery_headless_required") {
      const accepted = readNumber(payload.browserAccepted);
      const inserted = readNumber(payload.browserInserted);
      const resolved = artifact.status === "RESOLVED" || (accepted !== null && accepted > 0);
      const rateLimited = payload.browserRateLimited === true || payload.skippedDueToBrowserCooldown === true;

      if (existing) {
        // Older artifact: only contribute to failure streak if active.
        // Platform/runtime failures are NOT publisher failures and must not
        // drive the streak that can classify a source as "unsupported".
        if (existing._streakActive) {
          if (resolved) {
            existing._streakActive = false;
          } else if (
            BROWSER_FAILURE_STATUSES.has(artifact.status) &&
            classifyBrowserFailureOrigin(artifact.status) === "publisher_content_failure"
          ) {
            existing.consecutiveFailures += 1;
            existing.lastFailureAt = artifact.createdAt;
          }
        }
        if (rateLimited) existing.inCooldown = true;
        // Cooldown metadata: keep newest (first encounter sets it).
        const cdUntil = readString(payload.browserCooldownUntil);
        if (cdUntil) existing.browserCooldownUntil = cdUntil;
        const rlAt = readString(payload.browserRateLimitedAt);
        if (rlAt) existing.browserRateLimitedAt = rlAt;
        const retryAfter = readString(payload.browserRetryAfterAt);
        if (retryAfter) existing.browserRetryAfterAt = retryAfter;
        const rlReason = readString(payload.browserRateLimitReason);
        if (rlReason) existing.browserRateLimitReason = rlReason;
        const lastSkip = readString(payload.lastBrowserCooldownSkipAt);
        if (lastSkip) existing.lastBrowserCooldownSkipAt = lastSkip;
        const attemptAt = readString(payload.headlessProcessingStartedAt);
        if (attemptAt) existing.lastBrowserAttemptAt = attemptAt;
        const finishedAt = readString(payload.browserFallbackFinishedAt);
        if (finishedAt) existing.lastBrowserFinishedAt = finishedAt;
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
          consecutiveFailures: resolved ? 0 :
            BROWSER_FAILURE_STATUSES.has(artifact.status) &&
            classifyBrowserFailureOrigin(artifact.status) === "publisher_content_failure" ? 1 : 0,
          lastProductiveAt: resolved ? artifact.createdAt : null,
          lastFailureAt: !resolved &&
            BROWSER_FAILURE_STATUSES.has(artifact.status) &&
            classifyBrowserFailureOrigin(artifact.status) === "publisher_content_failure" ? artifact.createdAt : null,
          lastSeenAt: artifact.createdAt,
          inCooldown: rateLimited,
          browserCooldownUntil: readString(payload.browserCooldownUntil),
          browserRateLimitedAt: readString(payload.browserRateLimitedAt),
          browserRetryAfterAt: readString(payload.browserRetryAfterAt),
          browserRateLimitReason: readString(payload.browserRateLimitReason),
          lastBrowserCooldownSkipAt: readString(payload.lastBrowserCooldownSkipAt),
          lastBrowserAttemptAt: readString(payload.headlessProcessingStartedAt),
          lastBrowserFinishedAt: readString(payload.browserFallbackFinishedAt),
          _streakActive: !resolved,
        });
      }
    }
  }

  // Fetch RSS state for context
  const [activeSources, activeCategories] = await Promise.all([
    prisma.newsSource.findMany({
      where: { rssStatus: "ACTIVE" },
      select: { id: true, rssStatus: true, currentFeedProductive: true },
    }),
    prisma.sourceCategory.findMany({
      where: { rssStatus: "ACTIVE" },
      select: { newsSourceId: true, id: true, rssStatus: true, currentFeedProductive: true },
    }),
  ]);

  const sourceById = new Map(activeSources.map((s) => [s.id, s]));
  const categoryByKey = new Map(
    activeCategories.map((c) => [`${c.newsSourceId}|${c.id}`, c]),
  );

  // Compute health for each target
  const results: Agent2TargetHealth[] = [];

  for (const [, target] of byTarget) {
    const source = sourceById.get(target.sourceId);
    const category = target.categoryId
      ? categoryByKey.get(`${target.sourceId}|${target.categoryId}`)
      : null;

    const rssActive = category
      ? category.rssStatus === "ACTIVE"
      : source?.rssStatus === "ACTIVE";
    const rssProductive = category
      ? category.currentFeedProductive
      : source?.currentFeedProductive ?? false;

    // Compute lifecycle state
    const lifecycleState = classifyAgent2TargetLifecycle({
      rssStatus: category?.rssStatus ?? source?.rssStatus ?? null,
      currentFeedProductive: rssProductive,
      resolvedByAgent1ScopedRss: false,
      lastStaticQuality: target.lastStaticQuality,
      lastStaticEscalated: target.lastStaticEscalated,
      lastBrowserStatus: target.lastBrowserStatus,
      lastAcceptedCount: target.lastAcceptedCount,
      lastInsertedCount: target.lastInsertedCount,
      inBrowserCooldown: target.inCooldown,
      hardSourceLifecycleState: null,
      recoverySuggestion: null,
      discoveryProfileStatus: null,
      consecutiveFailedDiscoveryAttempts: target.consecutiveFailures,
    });

    // Skip resolved targets (they're healthy by definition)
    if (isAgent2TargetResolved(lifecycleState)) {
      results.push({
        sourceId: target.sourceId,
        categoryId: target.categoryId,
        targetUrl: target.targetUrl,
        health: "healthy",
        score: 90,
        lastProductiveAt: target.lastProductiveAt?.toISOString() ?? null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        lastStaticStatus: target.lastStaticQuality,
        lastBrowserStatus: target.lastBrowserStatus,
        currentLifecycleState: lifecycleState,
        recommendedAction: null,
        browserCooldownUntil: target.browserCooldownUntil,
        browserRateLimitedAt: target.browserRateLimitedAt,
        browserRetryAfterAt: target.browserRetryAfterAt,
        browserRateLimitReason: target.browserRateLimitReason,
        lastBrowserCooldownSkipAt: target.lastBrowserCooldownSkipAt,
        lastBrowserAttemptAt: target.lastBrowserAttemptAt,
        lastBrowserFinishedAt: target.lastBrowserFinishedAt,
      });
      continue;
    }

    const { health, score, recommendedAction } = computeHealthScore({
      rssActive: rssActive ?? false,
      rssProductive,
      lastStaticQuality: target.lastStaticQuality,
      lastBrowserStatus: target.lastBrowserStatus,
      lastAcceptedCount: target.lastAcceptedCount,
      consecutiveFailures: target.consecutiveFailures,
      lastProductiveAt: target.lastProductiveAt,
      lastFailureAt: target.lastFailureAt,
      inCooldown: target.inCooldown,
      hardSourceLifecycleState: null,
    });

    results.push({
      sourceId: target.sourceId,
      categoryId: target.categoryId,
      targetUrl: target.targetUrl,
      health,
      score,
      lastProductiveAt: target.lastProductiveAt?.toISOString() ?? null,
      lastFailureAt: target.lastFailureAt?.toISOString() ?? null,
      consecutiveFailures: target.consecutiveFailures,
      lastStaticStatus: target.lastStaticQuality,
      lastBrowserStatus: target.lastBrowserStatus,
      currentLifecycleState: lifecycleState,
      recommendedAction,
      browserCooldownUntil: target.browserCooldownUntil,
      browserRateLimitedAt: target.browserRateLimitedAt,
      browserRetryAfterAt: target.browserRetryAfterAt,
      browserRateLimitReason: target.browserRateLimitReason,
      lastBrowserCooldownSkipAt: target.lastBrowserCooldownSkipAt,
      lastBrowserAttemptAt: target.lastBrowserAttemptAt,
      lastBrowserFinishedAt: target.lastBrowserFinishedAt,
    });
  }

  // Sort by health: worst first, then by score ascending
  const healthOrder: Record<Agent2TargetHealthStatus, number> = {
    unsupported: 0,
    blocked: 1,
    weak: 2,
    unknown: 3,
    healthy: 4,
  };
  results.sort((a, b) => {
    const hDiff = healthOrder[a.health] - healthOrder[b.health];
    if (hDiff !== 0) return hDiff;
    return a.score - b.score;
  });

  return results;
}
