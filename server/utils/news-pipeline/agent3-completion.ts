/**
 * Agent 3 workflow completion semantics.
 *
 * The durable daily pipeline marks a run COMPLETED when it has drained every
 * article that was actionable inside the current orchestration. Articles that
 * failed with a cooldown (HTTP 403/429, browser-runtime unavailable) become
 * eligible again only after the orchestration ends, so a completed run can
 * still have future-run work. This module makes that distinction explicit and
 * deterministic so the admin UI never implies the whole Agent 3 queue is
 * globally complete when it is not.
 *
 * Concepts:
 *  - current orchestration drained: no more work actionable inside the
 *    current run (same-run attempted articles excluded).
 *  - globally complete: no eligible, deferred, quarantined, non-retryable,
 *    or in-progress article work exists in scope at all.
 *  - future-run work: eligibleNow / retryableNow observed WITHOUT the
 *    just-finished orchestration id (same-run exclusion must not hide it).
 *
 * All computation is pure and bounded; the DB-backed helper runs one
 * bounded progress query (no pipelineRunId) plus a lightweight current-run
 * progress query (with pipelineRunId).
 */

import type { Agent3Progress, Agent3ProgressOptions } from "./enrichment-runtime";

// ─── Types ──────────────────────────────────────────────────────────────────

export type Agent3CompletionReason =
  /** No eligible, deferred, quarantined, non-retryable, or in-progress work exists. */
  | "globally_complete"
  /** Current orchestration drained everything actionable; future-run work exists. */
  | "current_orchestration_drained"
  /** Nothing actionable now and only deferred (cooldown/headless) work remains. */
  | "deferred_only"
  /** Nothing actionable now and only permanent (non-retryable) failures remain. */
  | "non_retryable_only";

export type Agent3CompletionSummary = {
  /** Why the workflow reports COMPLETED (or what the queue state means). */
  completionReason: Agent3CompletionReason;
  /** The current orchestration has no more actionable work. */
  currentRunDrained: boolean;
  /** No Agent 3 work remains in scope at all (eligibility + deferred + quarantined + non-retryable + in-progress). */
  globallyComplete: boolean;
  /** Articles eligible for a FUTURE run (observed without the current run's same-run exclusion). */
  eligibleNextRun: number;
  /** Articles actionable in a FUTURE run (ready new + ready retry, without same-run exclusion). */
  retryableNextRun: number;
  /** Deferred articles (cooldown / headless-required) visible to future runs. */
  deferred: number;
  /** Quarantined articles (attempt cap reached). */
  quarantined: number;
  /** Non-retryable current-version permanent failures. */
  nonRetryable: number;
  /** Earliest retry time of any deferred article (ISO) or null. */
  nextRetryAt: string | null;
};

// ─── Pure computation ───────────────────────────────────────────────────────

/**
 * Derive the completion summary from a single progress snapshot.
 *
 * `progress` MUST be a future-run view (no pipelineRunId) so the same-run
 * exclusion does not hide eligibleNextRun/retryableNextRun.
 *
 * `currentRunDrained` is passed separately: it reflects the current run's own
 * progress query (with pipelineRunId), i.e. whether the orchestration drained
 * everything actionable inside it.
 */
export function computeAgent3CompletionSummary(
  progress: Agent3Progress,
  currentRunDrained: boolean,
): Agent3CompletionSummary {
  const eligibleNextRun = Math.max(0, progress.eligibleNow ?? 0);
  const retryableNextRun = Math.max(0, progress.retryableNow ?? 0);
  const deferred = Math.max(0, progress.deferred ?? 0);
  const quarantined = Math.max(0, progress.quarantined ?? 0);
  const nonRetryable = Math.max(0, progress.nonRetryable ?? 0);
  const inProgress = Math.max(0, progress.inProgress ?? 0);
  const nextRetryAt = typeof progress.nextRetryAt === "string" && progress.nextRetryAt
    ? progress.nextRetryAt
    : null;

  const globallyComplete =
    eligibleNextRun === 0 &&
    retryableNextRun === 0 &&
    deferred === 0 &&
    quarantined === 0 &&
    nonRetryable === 0 &&
    inProgress === 0;

  let completionReason: Agent3CompletionReason;
  if (globallyComplete) {
    completionReason = "globally_complete";
  } else if (retryableNextRun === 0 && deferred > 0) {
    completionReason = "deferred_only";
  } else if (retryableNextRun === 0 && nonRetryable > 0) {
    completionReason = "non_retryable_only";
  } else {
    completionReason = "current_orchestration_drained";
  }

  return {
    completionReason,
    currentRunDrained,
    globallyComplete,
    eligibleNextRun,
    retryableNextRun,
    deferred,
    quarantined,
    nonRetryable,
    nextRetryAt,
  };
}

// ─── DB-backed summary (workflow step helper) ───────────────────────────────

export type Agent3CompletionSummaryOptions = {
  /** Current run's progress query options (include pipelineRunId for same-run exclusion). */
  currentRunOptions?: Agent3ProgressOptions;
  /** Future-run progress query options (MUST NOT include pipelineRunId). */
  futureRunOptions?: Agent3ProgressOptions;
};

/**
 * Compute the completion summary for the just-finished orchestration.
 *
 * - currentRunProgress: progress WITH the current pipelineRunId (same-run
 *   exclusion) → decides currentRunDrained.
 * - futureRunProgress: progress WITHOUT pipelineRunId → decides
 *   eligibleNextRun / retryableNextRun / deferred / quarantined / nonRetryable
 *   / nextRetryAt and globallyComplete.
 *
 * Both queries are bounded by the existing PROGRESS_SCAN_SAFETY_CAP.
 */
export async function computeAgent3CompletionSummaryForRun(
  getProgress: (options: Agent3ProgressOptions) => Promise<Agent3Progress>,
  options: Agent3CompletionSummaryOptions = {},
): Promise<{ summary: Agent3CompletionSummary; currentRunProgress: Agent3Progress | null }> {
  const currentRunOptions = options.currentRunOptions ?? {};
  const futureRunOptions = options.futureRunOptions ?? {};

  const [currentRunProgress, futureRunProgress] = await Promise.all([
    getProgress(currentRunOptions),
    getProgress(futureRunOptions),
  ]);

  const currentRunDrained = (currentRunProgress.retryableNow ?? 0) === 0;
  const summary = computeAgent3CompletionSummary(futureRunProgress, currentRunDrained);
  return { summary, currentRunProgress };
}

// ─── Bounded normalization for admin API / UI ───────────────────────────────

const COMPLETION_REASONS: ReadonlySet<Agent3CompletionReason> = new Set([
  "globally_complete",
  "current_orchestration_drained",
  "deferred_only",
  "non_retryable_only",
]);

const clampCount = (value: unknown): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(Math.round(n), 1_000_000));
};

/**
 * Normalize an arbitrary (possibly legacy/unknown) completion summary from a
 * stored pipelineRun summary JSON. Old runs without the new fields produce a
 * bounded, conservative summary rather than failing the admin panel.
 */
export function normalizeAgent3CompletionSummary(
  value: unknown,
): Agent3CompletionSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const reason = typeof raw.completionReason === "string" &&
    COMPLETION_REASONS.has(raw.completionReason as Agent3CompletionReason)
    ? raw.completionReason as Agent3CompletionReason
    : null;

  // Old summaries may carry eligibleNow/retryableNow directly instead of the
  // new prefixed fields. Fall back to those so the UI can still render.
  const eligibleNextRun = clampCount(
    raw.eligibleNextRun ?? raw.eligibleNow,
  );
  const retryableNextRun = clampCount(
    raw.retryableNextRun ?? raw.retryableNow,
  );
  const deferred = clampCount(raw.deferred ?? 0);
  const quarantined = clampCount(raw.quarantined ?? 0);
  const nonRetryable = clampCount(raw.nonRetryable ?? 0);
  const nextRetryAt = typeof raw.nextRetryAt === "string" && raw.nextRetryAt
    ? raw.nextRetryAt
    : null;

  const currentRunDrained = raw.currentRunDrained === true;
  const globallyComplete = raw.globallyComplete === true;

  const hasCompletionFields =
    reason !== null ||
    "currentRunDrained" in raw ||
    "globallyComplete" in raw ||
    "eligibleNextRun" in raw ||
    "retryableNextRun" in raw ||
    "deferred" in raw ||
    "quarantined" in raw ||
    "nonRetryable" in raw;

  // Legacy summaries without any of the new fields cannot truthfully describe
  // completion semantics — return null so the UI can say "not available".
  if (!hasCompletionFields) return null;

  const effectiveReason: Agent3CompletionReason = reason ?? (
    globallyComplete
      ? "globally_complete"
      : currentRunDrained && retryableNextRun > 0
        ? "current_orchestration_drained"
        : currentRunDrained
          ? "deferred_only"
          : "globally_complete"
  );

  return {
    completionReason: effectiveReason,
    currentRunDrained,
    globallyComplete,
    eligibleNextRun,
    retryableNextRun,
    deferred,
    quarantined,
    nonRetryable,
    nextRetryAt,
  };
}
