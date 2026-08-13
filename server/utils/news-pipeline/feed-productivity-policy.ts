import { FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD } from "./feed-first-policy";

/**
 * Pure Agent 1 feed-productivity state transition. Mirrors the durable
 * source/category `currentFeedProductive`/`consecutiveNonProductiveRuns`
 * columns so persistence-layer CAS writes can stay a thin wrapper around a
 * fully unit-testable decision.
 */

export type FeedRunOutcomeKind =
  | "productive"
  | "nonproductive"
  | "invalid_feed"
  | "rate_limited"
  | "governor_or_robots_defer"
  | "manual_remap"
  | "unknown";

export type FeedProductivityState = {
  currentFeedProductive: boolean;
  consecutiveNonProductiveRuns: number;
  lastProductiveFeedUrl: string | null;
  lastProductiveAt: Date | null;
  nextRetryAt: Date | null;
};

export type FeedProductivityOutcome = {
  kind: FeedRunOutcomeKind;
  feedUrl?: string | null;
};

export type FeedProductivityPolicyOptions = {
  now?: Date;
  /** Consecutive confirmed-nonproductive runs required to demote productivity. Bounded 1-10. */
  demotionThreshold?: number;
};

const boundedThreshold = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(10, Math.max(1, Math.floor(value as number)));
};

const asBoundedRuns = (value: number): number => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/**
 * Pure, deterministic feed-productivity transition. A single nonproductive run
 * never immediately erases previously proven productivity; only a confirmed
 * streak at the exact threshold demotes it. `invalid_feed` is a stronger,
 * unambiguous signal (feed confirmed gone) and demotes immediately without
 * waiting for the streak. Neutral outcomes (rate limits, governor/robots
 * defers, and an unclassifiable caller input) never mutate state.
 */
export function applyFeedProductivityOutcome(
  state: FeedProductivityState,
  outcome: FeedProductivityOutcome,
  options: FeedProductivityPolicyOptions = {},
): FeedProductivityState {
  const now = options.now ?? new Date();
  const threshold = boundedThreshold(options.demotionThreshold, FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD);
  const consecutiveNonProductiveRuns = asBoundedRuns(state.consecutiveNonProductiveRuns);

  if (outcome.kind === "productive") {
    return {
      currentFeedProductive: true,
      consecutiveNonProductiveRuns: 0,
      lastProductiveFeedUrl: outcome.feedUrl ?? null,
      lastProductiveAt: now,
      nextRetryAt: null,
    };
  }

  if (outcome.kind === "nonproductive") {
    const nextRuns = consecutiveNonProductiveRuns + 1;
    return {
      ...state,
      consecutiveNonProductiveRuns: nextRuns,
      // Below threshold this is a transient blip: proven productivity stands.
      // At the exact threshold, the streak is confirmed and demotes it.
      currentFeedProductive: nextRuns >= threshold ? false : state.currentFeedProductive,
    };
  }

  if (outcome.kind === "invalid_feed") {
    // A confirmed-gone feed is unambiguous; demote immediately rather than
    // waiting through the nonproductive streak threshold.
    return {
      ...state,
      currentFeedProductive: false,
    };
  }

  if (outcome.kind === "manual_remap") {
    return {
      ...state,
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
    };
  }

  // rate_limited, governor_or_robots_defer, unknown: neutral, no-op.
  return { ...state };
}
