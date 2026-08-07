/**
 * Agent 2 target lifecycle normalization utility.
 *
 * Classifies Agent 2 targets into explicit lifecycle states by reading
 * existing PipelineArtifact rows, source/category RSS state, hard-source
 * profile artifacts, and optional discovery profile payloads.
 *
 * No Prisma schema changes — this is a read/normalization layer only.
 *
 * ## Architecture
 * The existing codebase derives lifecycle implicitly from scattered status
 * strings across multiple artifact types. This utility unifies that into
 * a single, explicit lifecycle model that admin views and queue filtering
 * can consume consistently.
 *
 * ## Lifecycle states
 * - rss_owned: target has active RSS feed; Agent 2 not needed
 * - static_pending: static discovery not yet run
 * - static_productive: static discovery found candidates
 * - static_failed: static discovery failed/weak/blocked
 * - browser_pending: queued for headless processing
 * - browser_productive: browser fallback found candidates
 * - browser_failed_retryable: browser failed but retryable
 * - browser_failed_terminal: browser failed terminally
 * - cooldown: target in browser rate-limit cooldown
 * - hard_source_open: hard-source profile created, no action taken
 * - hard_source_suggested: recovery suggestion generated
 * - profile_draft: discovery profile in draft state
 * - profile_active: discovery profile active and applied
 * - resolved: target resolved by any path
 * - ignored: target explicitly ignored
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type Agent2LifecycleState =
  | "rss_owned"
  | "static_pending"
  | "static_productive"
  | "static_failed"
  | "browser_pending"
  | "browser_productive"
  | "browser_failed_retryable"
  | "browser_failed_terminal"
  | "cooldown"
  | "hard_source_open"
  | "hard_source_suggested"
  | "profile_draft"
  | "profile_active"
  | "resolved"
  | "ignored";

export type Agent2LifecycleInput = {
  /** Source RSS status: ACTIVE, NO_RSS_FOUND, PENDING_DISCOVERY, etc. */
  rssStatus: string | null;
  /** Whether the current RSS feed is productive. */
  currentFeedProductive: boolean;
  /** Whether Agent 1 has an active scoped RSS feed for this target. */
  resolvedByAgent1ScopedRss: boolean;
  /** Latest static discovery quality: productive, weak, failed, blocked, null. */
  lastStaticQuality: string | null;
  /** Prompt 15A completeness evidence; omitted means legacy quality-only behavior. */
  lastStaticRetryable?: boolean;
  lastStaticDiscoveryComplete?: boolean;
  lastStaticStopReason?: string | null;
  /** Whether the latest static discovery escalated to headless. */
  lastStaticEscalated: boolean;
  /** Latest browser artifact status string. */
  lastBrowserStatus: string | null;
  /** Accepted candidate count from latest browser run. */
  lastAcceptedCount: number | null;
  /** Inserted candidate count from latest browser run. */
  lastInsertedCount: number | null;
  /** Whether the target is in browser cooldown. */
  inBrowserCooldown: boolean;
  /** Hard-source profile lifecycle state if one exists. */
  hardSourceLifecycleState: string | null;
  /** Recovery suggestion action if one exists. */
  recoverySuggestion: string | null;
  /** Discovery profile status if one exists (draft, active, disabled, superseded). */
  discoveryProfileStatus: string | null;
  /** Consecutive failed discovery attempts. */
  consecutiveFailedDiscoveryAttempts: number;
};

// ─── Classification ─────────────────────────────────────────────────────────

const BROWSER_FAILURE_STATUSES = new Set([
  "BROWSER_NO_CANDIDATES",
  "BROWSER_RUNTIME_UNAVAILABLE",
  "BROWSER_FALLBACK_DISABLED",
  "HEADLESS_PROCESSING_STALE",
]);

const BROWSER_RETRYABLE_STATUSES = new Set([
  "BROWSER_NO_CANDIDATES",
  "BROWSER_RUNTIME_UNAVAILABLE",
  "HEADLESS_PROCESSING_STALE",
]);

const BROWSER_TERMINAL_STATUSES = new Set([
  "BROWSER_FALLBACK_DISABLED",
]);

const TERMINAL_HEADLESS_STATUSES = new Set([
  "RESOLVED",
  "RESOLVED_BY_STATIC_DISCOVERY",
  "RESOLVED_BY_AGENT1_RSS",
]);

const HARD_SOURCE_ACTIVE_STATES = new Set([
  "open",
  "suggested",
  "applied",
]);

/**
 * Classify a target into its lifecycle state.
 */
export function classifyAgent2TargetLifecycle(input: Agent2LifecycleInput): Agent2LifecycleState {
  // 1. Resolved by Agent 1 RSS → rss_owned
  if (input.resolvedByAgent1ScopedRss) {
    return "rss_owned";
  }

  // 2. RSS active + productive → rss_owned
  if (input.rssStatus === "ACTIVE" && input.currentFeedProductive) {
    return "rss_owned";
  }

  // 3. An active browser cooldown is the current operational state even if
  // candidates were accepted before detail evaluation hit the rate limit.
  if (input.inBrowserCooldown) {
    return "cooldown";
  }

  // 4. Browser accepted candidates → browser_productive or resolved
  if (input.lastBrowserStatus === "RESOLVED" ||
    (input.lastAcceptedCount !== null && input.lastAcceptedCount > 0)) {
    return input.lastInsertedCount !== null && input.lastInsertedCount > 0
      ? "resolved"
      : "browser_productive";
  }

  // 5. A productive-quality static artifact is not resolved when Prompt 15A
  // says the shortlist is transiently incomplete. Missing fields preserve the
  // legacy quality-only behavior.
  const staticTransientIncomplete = input.lastStaticRetryable === true
    || input.lastStaticDiscoveryComplete === false
    || input.lastStaticStopReason === "rate_limited"
    || input.lastStaticStopReason === "request_budget_exhausted";
  if (input.lastStaticQuality === "productive" && !staticTransientIncomplete) {
    return "static_productive";
  }

  // 6. Discovery profile active → profile_active
  if (input.discoveryProfileStatus === "active") {
    return "profile_active";
  }

  // 7. Discovery profile draft → profile_draft
  if (input.discoveryProfileStatus === "draft") {
    return "profile_draft";
  }

  // 8. Browser pending (PENDING_HEADLESS status not yet claimed)
  if (input.lastBrowserStatus === "PENDING_HEADLESS") {
    return "browser_pending";
  }

  // 9. Browser processing (claimed but not finished)
  if (input.lastBrowserStatus === "HEADLESS_PROCESSING") {
    return "browser_pending";
  }

  // 10. Browser failed terminally
  if (input.lastBrowserStatus !== null && BROWSER_TERMINAL_STATUSES.has(input.lastBrowserStatus)) {
    return "browser_failed_terminal";
  }

  // 11. Browser failed retryable
  if (input.lastBrowserStatus !== null && BROWSER_RETRYABLE_STATUSES.has(input.lastBrowserStatus)) {
    return "browser_failed_retryable";
  }

  // 12. Hard-source profile states
  if (input.hardSourceLifecycleState !== null && HARD_SOURCE_ACTIVE_STATES.has(input.hardSourceLifecycleState)) {
    if (input.recoverySuggestion !== null) {
      return "hard_source_suggested";
    }
    return "hard_source_open";
  }

  // 13. Static failed/weak/blocked (no browser run yet)
  if (input.lastStaticQuality !== null && input.lastStaticQuality !== "productive") {
    return "static_failed";
  }

  // 14. Static pending (no artifacts yet)
  if (input.lastStaticQuality === null && input.lastBrowserStatus === null) {
    return "static_pending";
  }

  // 15. Fallback
  return "static_failed";
}

// ─── Actionability helpers ──────────────────────────────────────────────────

const ACTIONABLE_STATES = new Set<Agent2LifecycleState>([
  "static_pending",
  "static_failed",
  "browser_pending",
  "browser_failed_retryable",
  "cooldown",
  "hard_source_open",
  "hard_source_suggested",
  "profile_draft",
  "profile_active",
]);

const RESOLVED_STATES = new Set<Agent2LifecycleState>([
  "rss_owned",
  "static_productive",
  "browser_productive",
  "resolved",
]);

const RETRYABLE_STATES = new Set<Agent2LifecycleState>([
  "static_failed",
  "browser_failed_retryable",
  "cooldown",
  "hard_source_open",
  "hard_source_suggested",
]);

/**
 * Whether the target needs further action (not resolved, not ignored, not terminal).
 */
export function isAgent2TargetActionable(state: Agent2LifecycleState): boolean {
  return ACTIONABLE_STATES.has(state);
}

/**
 * Whether the target is resolved by any path (RSS, static, browser, etc.).
 */
export function isAgent2TargetResolved(state: Agent2LifecycleState): boolean {
  return RESOLVED_STATES.has(state);
}

/**
 * Whether the target can be retried (failed but not terminal).
 */
export function isAgent2TargetRetryable(state: Agent2LifecycleState): boolean {
  return RETRYABLE_STATES.has(state);
}

// ─── Summary ────────────────────────────────────────────────────────────────

export type Agent2LifecycleSummary = {
  state: Agent2LifecycleState;
  actionable: boolean;
  resolved: boolean;
  retryable: boolean;
};

/**
 * Compute a compact lifecycle summary for a target.
 */
export function summarizeAgent2TargetLifecycle(input: Agent2LifecycleInput): Agent2LifecycleSummary {
  const state = classifyAgent2TargetLifecycle(input);
  return {
    state,
    actionable: isAgent2TargetActionable(state),
    resolved: isAgent2TargetResolved(state),
    retryable: isAgent2TargetRetryable(state),
  };
}
