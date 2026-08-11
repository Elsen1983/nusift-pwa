import {
  FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD,
  shouldRunAgent2Discovery,
} from "./feed-first-policy";

/** Trusted feed assignment provenance used for compatibility diagnostics. */
export const RSS_OWNED_TRUSTED_PROVENANCES: ReadonlySet<string> = new Set([
  "USER_SUBMITTED",
  "ADMIN_CONFIRMED",
]);

export const RSS_OWNED_NON_PRODUCTIVE_ESCALATION_THRESHOLD = FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD;

export type RssOwnedTargetInput = {
  rssStatus: string | null | undefined;
  rssFeedUrl?: string | null;
  feedProvenance?: string | null;
  currentFeedProductive?: boolean;
  lastProductiveAt?: Date | string | null;
  consecutiveNonProductiveRuns?: number;
  nextRetryAt?: Date | string | null;
  manualOverride?: boolean;
  scopeMatches?: boolean;
};

export type RssOwnedTargetEvaluation = {
  rssOwned: boolean;
  eligibleForAgent2: boolean;
  reason:
    | "not_rss_owned"
    | "rss_owned_productive"
    | "rss_owned_waiting_evidence"
    | "rss_owned_repeatedly_non_productive"
    | "rss_owned_invalid_feed"
    | "rss_owned_scope_mismatch"
    | "rss_owned_rate_limited";
};

export function isRssOwnedTarget(input: RssOwnedTargetInput): boolean {
  return (
    input.rssStatus === "ACTIVE" &&
    Boolean(input.rssFeedUrl) &&
    RSS_OWNED_TRUSTED_PROVENANCES.has(input.feedProvenance ?? "")
  );
}

const hasTrustedFeedAssignment = (input: RssOwnedTargetInput): boolean =>
  Boolean(input.rssFeedUrl) && RSS_OWNED_TRUSTED_PROVENANCES.has(input.feedProvenance ?? "");

/** Compatibility adapter. The feed-first policy remains the sole decision source. */
export function evaluateRssOwnedTargetForAgent2(
  input: RssOwnedTargetInput,
): RssOwnedTargetEvaluation {
  const rssOwned = hasTrustedFeedAssignment(input);
  const result = shouldRunAgent2Discovery({
    targetType: "category",
    rssStatus: input.rssStatus,
    rssFeedUrl: input.rssFeedUrl,
    currentFeedProductive: input.currentFeedProductive,
    lastProductiveAt: input.lastProductiveAt,
    consecutiveNonProductiveRuns: input.consecutiveNonProductiveRuns,
    nextRetryAt: input.nextRetryAt,
    scopeMatches: input.scopeMatches,
    manualOverride: input.manualOverride,
  });

  if (!rssOwned) {
    return { rssOwned: false, eligibleForAgent2: result.runAgent2, reason: "not_rss_owned" };
  }

  switch (result.reason) {
    case "productive_fresh_feed":
      return { rssOwned: true, eligibleForAgent2: false, reason: "rss_owned_productive" };
    case "active_feed_rate_limited":
      return { rssOwned: true, eligibleForAgent2: false, reason: "rss_owned_rate_limited" };
    case "nonproductive_below_threshold":
      return { rssOwned: true, eligibleForAgent2: false, reason: "rss_owned_waiting_evidence" };
    case "repeatedly_nonproductive":
      return { rssOwned: true, eligibleForAgent2: true, reason: "rss_owned_repeatedly_non_productive" };
    case "category_scope_mismatch":
      return { rssOwned: true, eligibleForAgent2: true, reason: "rss_owned_scope_mismatch" };
    case "productive_feed_stale":
    case "missing_or_invalid_feed":
    case "manual_override":
      return { rssOwned: true, eligibleForAgent2: true, reason: "rss_owned_invalid_feed" };
  }
}

export function rssOwnedSkipReason(
  evaluation: RssOwnedTargetEvaluation,
): RssOwnedTargetSkipReason | null {
  if (evaluation.eligibleForAgent2 || !evaluation.rssOwned) return null;
  if (evaluation.reason === "rss_owned_productive") return "rss_owned_productive";
  return "rss_owned_waiting_evidence";
}

export type RssOwnedTargetSkipReason =
  | "rss_owned_productive"
  | "rss_owned_waiting_evidence";
