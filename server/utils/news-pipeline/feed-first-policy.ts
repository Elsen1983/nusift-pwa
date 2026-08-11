/**
 * Central Agent 1 feed-first policy. This module is pure so source/category
 * scope, freshness, cooldown and escalation decisions can be tested without
 * Prisma or network calls.
 */

export const FEED_PRODUCTIVE_FRESHNESS_MS = 24 * 60 * 60 * 1000;
export const FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD = 2;

export type FeedFirstTarget = {
  targetType: "source" | "category";
  rssStatus: string | null | undefined;
  rssFeedUrl?: string | null;
  currentFeedProductive?: boolean;
  lastProductiveAt?: Date | string | null;
  consecutiveNonProductiveRuns?: number | null;
  nextRetryAt?: Date | string | null;
  scopeMatches?: boolean;
  manualOverride?: boolean;
};

export type FeedFirstPolicy = {
  productiveFreshnessMs?: number;
  nonProductiveFallbackThreshold?: number;
  allowLegacyProductiveWithoutTimestamp?: boolean;
};

export type FeedFirstDecisionReason =
  | "productive_fresh_feed"
  | "productive_feed_stale"
  | "active_feed_rate_limited"
  | "nonproductive_below_threshold"
  | "repeatedly_nonproductive"
  | "missing_or_invalid_feed"
  | "category_scope_mismatch"
  | "manual_override";

export type FeedFirstDecision = {
  runAgent2: boolean;
  reason: FeedFirstDecisionReason;
  targetType: "source" | "category";
  boundedDiagnostic: string;
  freshness: "fresh" | "stale" | "unknown" | "not_applicable";
  nonProductiveRuns: number;
};

const asTime = (value: Date | string | null | undefined): number | null => {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

const boundedPolicyNumber = (value: number | undefined, fallback: number, min: number, max: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value!)));
};

const decision = (
  target: FeedFirstTarget,
  runAgent2: boolean,
  reason: FeedFirstDecisionReason,
  freshness: FeedFirstDecision["freshness"],
  nonProductiveRuns: number,
): FeedFirstDecision => ({
  runAgent2,
  reason,
  targetType: target.targetType,
  boundedDiagnostic: `feed_first:${reason}:${target.targetType}`.slice(0, 120),
  freshness,
  nonProductiveRuns,
});

export function shouldRunAgent2Discovery(
  target: FeedFirstTarget,
  now: Date = new Date(),
  policy: FeedFirstPolicy = {},
): FeedFirstDecision {
  const freshnessMs = boundedPolicyNumber(
    policy.productiveFreshnessMs,
    FEED_PRODUCTIVE_FRESHNESS_MS,
    60 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000,
  );
  const nonProductiveThreshold = boundedPolicyNumber(
    policy.nonProductiveFallbackThreshold,
    FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD,
    1,
    10,
  );
  const nonProductiveRuns = Math.max(0, Math.floor(target.consecutiveNonProductiveRuns ?? 0));
  const retryAt = asTime(target.nextRetryAt);
  const nowMs = now.getTime();

  // A known feed cooldown is authoritative. Manual recovery cannot amplify a
  // publisher 429 unless a caller supplies a separately proven safe target.
  if (retryAt != null && retryAt > nowMs) {
    return decision(target, false, "active_feed_rate_limited", "not_applicable", nonProductiveRuns);
  }

  if (target.scopeMatches === false) {
    return decision(target, true, "category_scope_mismatch", "not_applicable", nonProductiveRuns);
  }

  if (target.manualOverride) {
    return decision(target, true, "manual_override", "not_applicable", nonProductiveRuns);
  }

  const hasFeed = Boolean(target.rssFeedUrl);
  const status = String(target.rssStatus ?? "").toUpperCase();
  if (!hasFeed || ["NO_RSS_FOUND", "PENDING_DISCOVERY", "DOMAIN_DEAD"].includes(status)) {
    return decision(target, true, "missing_or_invalid_feed", "not_applicable", nonProductiveRuns);
  }

  if (target.currentFeedProductive === true) {
    const productiveAt = asTime(target.lastProductiveAt);
    if (productiveAt == null) {
      // A productive flag without its durable timestamp cannot prove freshness.
      // Callers may explicitly opt into legacy compatibility, but the default
      // is to allow bounded fallback rather than infer freshness.
      const allowLegacy = policy.allowLegacyProductiveWithoutTimestamp === true;
      const freshness = allowLegacy ? "fresh" : "unknown";
      return decision(
        target,
        !allowLegacy,
        allowLegacy ? "productive_fresh_feed" : "productive_feed_stale",
        freshness,
        nonProductiveRuns,
      );
    }
    if (nowMs - productiveAt <= freshnessMs && productiveAt <= nowMs) {
      return decision(target, false, "productive_fresh_feed", "fresh", nonProductiveRuns);
    }
    return decision(target, true, "productive_feed_stale", "stale", nonProductiveRuns);
  }

  if (nonProductiveRuns >= nonProductiveThreshold) {
    return decision(target, true, "repeatedly_nonproductive", "not_applicable", nonProductiveRuns);
  }

  return decision(target, false, "nonproductive_below_threshold", "not_applicable", nonProductiveRuns);
}
