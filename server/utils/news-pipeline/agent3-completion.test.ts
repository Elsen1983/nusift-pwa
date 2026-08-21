import { describe, expect, it, vi } from "vitest";
import {
  computeAgent3CompletionSummary,
  computeAgent3CompletionSummaryForRun,
  normalizeAgent3CompletionSummary,
} from "./agent3-completion";
import type { Agent3Progress } from "./enrichment-runtime";

const baseProgress = (overrides: Partial<Agent3Progress> = {}): Agent3Progress => ({
  readyNew: 0,
  readyRetry: 0,
  retryableNow: 0,
  deferred: 0,
  deferredByReason: {
    http_403: 0,
    http_429: 0,
    browser_runtime_unavailable: 0,
    interstitial_or_challenge: 0,
    other_retry: 0,
  },
  nextRetryAt: null,
  quarantined: 0,
  nonRetryable: 0,
  inProgress: 0,
  totalOutstanding: 0,
  exhaustedAttempts: 0,
  eligibleNow: 0,
  recentlyBlocked: 0,
  nonRetryableCurrentVersionFailures: 0,
  totalInScope: 0,
  enrichedInScope: 0,
  needingInitialEnrichment: 0,
  failedRetryable: 0,
  needsCurrentVersionReprocess: 0,
  currentVersionComplete: 0,
  selectedMode: { includeEnriched: false, forceReprocess: false, hasArticleFilter: false, hasSourceFilter: false },
  latestRun: null,
  remainingAfterLatestRun: 0,
  progressTruncated: false,
  progressScanned: 0,
  ...overrides,
});

describe("computeAgent3CompletionSummary", () => {
  it("reports globally_complete when the queue is truly empty", () => {
    const summary = computeAgent3CompletionSummary(baseProgress(), true);
    expect(summary.completionReason).toBe("globally_complete");
    expect(summary.currentRunDrained).toBe(true);
    expect(summary.globallyComplete).toBe(true);
    expect(summary.eligibleNextRun).toBe(0);
    expect(summary.retryableNextRun).toBe(0);
  });

  it("reports current_orchestration_drained when future-run retryable work exists", () => {
    const progress = baseProgress({
      eligibleNow: 192,
      retryableNow: 175,
      readyNew: 100,
      readyRetry: 75,
      needingInitialEnrichment: 192,
      deferred: 71,
      quarantined: 23,
      nonRetryable: 12,
      nextRetryAt: "2026-08-03T04:00:00.000Z",
    });
    const summary = computeAgent3CompletionSummary(progress, true);
    expect(summary.completionReason).toBe("current_orchestration_drained");
    expect(summary.currentRunDrained).toBe(true);
    expect(summary.globallyComplete).toBe(false);
    expect(summary.eligibleNextRun).toBe(192);
    expect(summary.retryableNextRun).toBe(175);
    expect(summary.deferred).toBe(71);
    expect(summary.quarantined).toBe(23);
    expect(summary.nonRetryable).toBe(12);
    expect(summary.nextRetryAt).toBe("2026-08-03T04:00:00.000Z");
  });

  it("reports deferred_only truthfully when only deferred work remains", () => {
    const progress = baseProgress({
      deferred: 40,
      quarantined: 5,
      eligibleNow: 0,
      retryableNow: 0,
    });
    const summary = computeAgent3CompletionSummary(progress, true);
    expect(summary.completionReason).toBe("deferred_only");
    expect(summary.globallyComplete).toBe(false);
    expect(summary.retryableNextRun).toBe(0);
    expect(summary.deferred).toBe(40);
  });

  it("reports non_retryable_only when only permanent failures remain", () => {
    const progress = baseProgress({
      nonRetryable: 17,
      eligibleNow: 0,
      retryableNow: 0,
      deferred: 0,
      quarantined: 0,
    });
    const summary = computeAgent3CompletionSummary(progress, true);
    expect(summary.completionReason).toBe("non_retryable_only");
    expect(summary.globallyComplete).toBe(false);
    expect(summary.nonRetryable).toBe(17);
  });

  it("globally_complete requires no in-progress claims or actionable work either", () => {
    const withClaims = computeAgent3CompletionSummary(baseProgress({ inProgress: 2 }), true);
    expect(withClaims.globallyComplete).toBe(false);
    expect(withClaims.completionReason).toBe("current_orchestration_drained");

    const withActionable = computeAgent3CompletionSummary(baseProgress({ retryableNow: 5, readyNew: 5 }), true);
    expect(withActionable.globallyComplete).toBe(false);

    const clean = computeAgent3CompletionSummary(baseProgress({ inProgress: 0 }), true);
    expect(clean.globallyComplete).toBe(true);
  });

  it("carries currentRunDrained from the run's own progress", () => {
    const summary = computeAgent3CompletionSummary(
      baseProgress({ retryableNow: 5, readyNew: 5, eligibleNow: 5 }),
      false,
    );
    expect(summary.currentRunDrained).toBe(false);
    expect(summary.globallyComplete).toBe(false);
    expect(summary.completionReason).toBe("current_orchestration_drained");
  });
});

describe("computeAgent3CompletionSummaryForRun", () => {
  it("uses current-run progress for drained status and future-run progress for next-run counts", async () => {
    const getProgress = vi.fn(async (options: { pipelineRunId?: string }) => {
      if (options.pipelineRunId) {
        return baseProgress({ retryableNow: 0, readyNew: 0, readyRetry: 0 });
      }
      return baseProgress({
        eligibleNow: 175,
        retryableNow: 175,
        readyNew: 100,
        readyRetry: 75,
        deferred: 71,
      });
    });

    const { summary, currentRunProgress } = await computeAgent3CompletionSummaryForRun(
      getProgress,
      {
        currentRunOptions: { pipelineRunId: "run-1" },
        futureRunOptions: {},
      },
    );

    expect(getProgress).toHaveBeenCalledTimes(2);
    expect(summary.currentRunDrained).toBe(true);
    expect(summary.globallyComplete).toBe(false);
    expect(summary.eligibleNextRun).toBe(175);
    expect(summary.retryableNextRun).toBe(175);
    expect(summary.deferred).toBe(71);
    expect(currentRunProgress?.retryableNow).toBe(0);
  });
});

describe("normalizeAgent3CompletionSummary", () => {
  it("normalizes a stored summary", () => {
    const normalized = normalizeAgent3CompletionSummary({
      completionReason: "current_orchestration_drained",
      currentRunDrained: true,
      globallyComplete: false,
      eligibleNextRun: 175,
      retryableNextRun: 71,
      deferred: 71,
      quarantined: 23,
      nonRetryable: 12,
      nextRetryAt: "2026-08-03T04:00:00.000Z",
    });
    expect(normalized).toMatchObject({
      completionReason: "current_orchestration_drained",
      eligibleNextRun: 175,
      retryableNextRun: 71,
      deferred: 71,
    });
  });

  it("falls back to legacy eligibleNow/retryableNow fields", () => {
    const normalized = normalizeAgent3CompletionSummary({
      currentRunDrained: true,
      globallyComplete: false,
      eligibleNow: 192,
      retryableNow: 175,
    });
    expect(normalized?.eligibleNextRun).toBe(192);
    expect(normalized?.retryableNextRun).toBe(175);
    expect(normalized?.completionReason).toBe("current_orchestration_drained");
  });

  it("returns null for legacy summaries without the new fields", () => {
    expect(normalizeAgent3CompletionSummary({ kind: "daily_news_pipeline_workflow" })).toBeNull();
    expect(normalizeAgent3CompletionSummary(null)).toBeNull();
    expect(normalizeAgent3CompletionSummary("string")).toBeNull();
  });

  it("clamps unbounded counts", () => {
    const normalized = normalizeAgent3CompletionSummary({
      currentRunDrained: true,
      globallyComplete: false,
      eligibleNextRun: Number.POSITIVE_INFINITY,
      deferred: -5,
      quarantined: 2e9,
    });
    expect(normalized?.eligibleNextRun).toBe(0);
    expect(normalized?.deferred).toBe(0);
    expect(normalized?.quarantined).toBe(1_000_000);
  });
});
