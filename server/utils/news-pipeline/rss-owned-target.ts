/**
 * RSS-owned target predicate.
 *
 * A target (source or category) is \"RSS-owned\" when a valid, trusted feed is
 * assigned to it. RSS-owned targets must NOT enter routine Agent 2 static
 * discovery while the feed is valid and productive — Agent 2 only escalates
 * under bounded, documented conditions.
 *
 * Trusted provenance (verified or explicitly trusted manual state):
 *  - USER_SUBMITTED  — user submitted the feed directly
 *  - ADMIN_CONFIRMED — admin confirmed the feed through review requests
 *
 * Escalation to Agent 2 happens ONLY when:
 *  - the feed is permanently invalidated (DOMAIN_DEAD) or invalid (FAILED
 *    with at least one confirmed non-productive run),
 *  - the feed is repeatedly non-productive (>= NON_PRODUCTIVE_ESCALATION_THRESHOLD
 *    consecutive non-productive runs),
 *  - category scope validation fails (caller-provided scopeMismatch),
 *  - an administrator explicitly requests discovery (caller bypass).
 *
 * A temporary RSS fetch failure never immediately removes RSS ownership: a
 * single FAILED status without a confirmed non-productive run keeps the target
 * RSS-owned and skips Agent 2 (bounded health/cooldown evidence).
 *
 * No publisher-specific hardcoding — fully generic.
 */

export const RSS_OWNED_TRUSTED_PROVENANCES: ReadonlySet<string> = new Set([
  "USER_SUBMITTED",
  "ADMIN_CONFIRMED",
]);

/** Documented non-productivity threshold before an RSS-owned target escalates. */
export const RSS_OWNED_NON_PRODUCTIVE_ESCALATION_THRESHOLD = 2;

export type RssOwnedTargetInput = {
  rssStatus: string | null | undefined;
  rssFeedUrl?: string | null;
  feedProvenance?: string | null;
  currentFeedProductive?: boolean;
  consecutiveNonProductiveRuns?: number;
  /** Caller-supplied category-scope check; true when scope matches. */
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
    | "rss_owned_scope_mismatch";
};

/**
 * Generic RSS-owned predicate: active source/category relationship (implied by
 * the caller passing a DB row), active feed URL, verified or explicitly
 * trusted manual feed state, and not permanently invalidated.
 */
export function isRssOwnedTarget(input: RssOwnedTargetInput): boolean {
  return (
    input.rssStatus === "ACTIVE" &&
    Boolean(input.rssFeedUrl) &&
    RSS_OWNED_TRUSTED_PROVENANCES.has(input.feedProvenance ?? "")
  );
}

/**
 * Status-agnostic ownership gate used inside the escalation evaluation: a
 * target with a trusted feed assignment remains "RSS-owned" even while the
 * feed is FAILED or DOMAIN_DEAD, so those states produce their documented
 * escalation reasons instead of falling through as not-owned.
 */
function hasTrustedFeedAssignment(input: RssOwnedTargetInput): boolean {
  return (
    Boolean(input.rssFeedUrl) &&
    RSS_OWNED_TRUSTED_PROVENANCES.has(input.feedProvenance ?? "")
  );
}

/**
 * Evaluate whether an RSS-owned target may enter Agent 2 discovery.
 *
 * Non-RSS-owned targets are always eligible (normal rules apply).
 * RSS-owned targets skip Agent 2 unless a documented escalation condition
 * holds.
 */
export function evaluateRssOwnedTargetForAgent2(
  input: RssOwnedTargetInput,
): RssOwnedTargetEvaluation {
  if (!hasTrustedFeedAssignment(input)) {
    return { rssOwned: false, eligibleForAgent2: true, reason: "not_rss_owned" };
  }

  // Category-scope mismatch is a documented escalation condition.
  if (input.scopeMatches === false) {
    return { rssOwned: true, eligibleForAgent2: true, reason: "rss_owned_scope_mismatch" };
  }

  // Permanently unreachable / dead domain → escalate.
  if (input.rssStatus === "DOMAIN_DEAD") {
    return { rssOwned: true, eligibleForAgent2: true, reason: "rss_owned_invalid_feed" };
  }

  // Invalid feed: only escalate after at least one confirmed non-productive
  // run, so a single temporary fetch failure never removes RSS ownership.
  if (input.rssStatus === "FAILED") {
    const nonProductiveRuns = Math.max(0, input.consecutiveNonProductiveRuns ?? 0);
    if (nonProductiveRuns >= 1) {
      return { rssOwned: true, eligibleForAgent2: true, reason: "rss_owned_invalid_feed" };
    }
    return { rssOwned: true, eligibleForAgent2: false, reason: "rss_owned_waiting_evidence" };
  }

  // Productive feed → never routine Agent 2.
  if (input.currentFeedProductive === true) {
    return { rssOwned: true, eligibleForAgent2: false, reason: "rss_owned_productive" };
  }

  // Non-productive under the documented threshold → bounded evidence window.
  const nonProductiveRuns = Math.max(0, input.consecutiveNonProductiveRuns ?? 0);
  if (nonProductiveRuns >= RSS_OWNED_NON_PRODUCTIVE_ESCALATION_THRESHOLD) {
    return {
      rssOwned: true,
      eligibleForAgent2: true,
      reason: "rss_owned_repeatedly_non_productive",
    };
  }

  return { rssOwned: true, eligibleForAgent2: false, reason: "rss_owned_waiting_evidence" };
}

/**
 * Map the RSS-owned evaluation to the Agent 2 skip-reason vocabulary used by
 * the target resolution diagnostics. Returns null when the target is eligible
 * for Agent 2.
 */
export function rssOwnedSkipReason(
  evaluation: RssOwnedTargetEvaluation,
): RssOwnedTargetSkipReason | null {
  if (evaluation.eligibleForAgent2 || !evaluation.rssOwned) return null;
  switch (evaluation.reason) {
    case "rss_owned_productive":
      return "rss_owned_productive";
    case "rss_owned_waiting_evidence":
      return "rss_owned_waiting_evidence";
    default:
      return null;
  }
}

export type RssOwnedTargetSkipReason =
  | "rss_owned_productive"
  | "rss_owned_waiting_evidence";
