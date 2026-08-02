import { describe, expect, it } from "vitest";

import {
  boundText,
  clampCount,
  clampDuration,
  createNoopStageBatchProbe,
  StageBatchTelemetryTracker,
  summarizeStageTimings,
  type StageBatchTelemetry,
} from "./stage-telemetry";

const NOW = 1_750_000_000_000;
type Stage = "agent1" | "agent2-static" | "agent2-headless" | "agent3";

const makeTracker = (overrides: Partial<{
  stage: Stage;
  batchSeq: number;
  batchSizeLimit: number;
  concurrencyLimit: number;
}> = {}) => new StageBatchTelemetryTracker({
  orchestrationRunId: "run-1",
  stage: overrides.stage ?? "agent1",
  batchSeq: overrides.batchSeq ?? 1,
  batchSizeLimit: overrides.batchSizeLimit ?? 5,
  concurrencyLimit: overrides.concurrencyLimit ?? 1,
  now: () => NOW,
});

const makeRecord = (stage: Stage, overrides: Partial<StageBatchTelemetry> = {}): StageBatchTelemetry => ({
  schemaVersion: 1,
  artifactKind: "stage_batch_telemetry",
  orchestrationRunId: "run-1",
  stage,
  batchSeq: 1,
  startedAt: new Date(NOW).toISOString(),
  finishedAt: new Date(NOW).toISOString(),
  durationMs: 1000,
  processed: 5,
  succeeded: 4,
  failedRetryable: 1,
  failedPermanent: 0,
  skipped: 0,
  deferred: 0,
  quarantined: 0,
  remainingBefore: null,
  remainingAfter: 0,
  networkRequests: 5,
  browserAttempts: 0,
  dbPersistenceOps: 1,
  logicalRequestDurationMs: 800,
  extractionMs: 100,
  productivity: {},
  batchExecutionErrors: 0,
  batchErrorClassification: null,
  batchErrorReason: null,
  securityValidationMs: 0,
  browserMs: 0,
  persistenceMs: 100,
  sleepMs: 0,
  batchSizeLimit: 5,
  concurrencyLimit: 1,
  peakConcurrency: 1,
  hostCooldownActivations: 0,
  accessDenied403: 0,
  rateLimited403: 0,
  rateLimited429: 0,
  timedOut: 0,
  noProgressReason: null,
  complete: true,
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("bounds", () => {
  it("keeps counts bounded and durations independently bounded", () => {
    expect(clampCount(2_000_000)).toBe(1_000_000);
    expect(clampCount(-1)).toBe(0);
    expect(clampCount(Number.NaN)).toBe(0);
    expect(clampDuration(-1)).toBe(0);
    expect(clampDuration(Number.NaN)).toBe(0);
    expect(clampDuration(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampDuration(46 * 60 * 1000)).toBe(46 * 60 * 1000);
    expect(clampDuration(25 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
  });

  it("normalizes bounded text", () => {
    expect(boundText("a\u0000b  c", 20)).toBe("a b c");
    expect(boundText("x".repeat(20), 5)).toBe("xxxxx");
  });
});

describe("StageBatchTelemetryTracker", () => {
  it("separates batch size from actual Phase 1 concurrency", () => {
    const record = makeTracker({ batchSizeLimit: 10, concurrencyLimit: 1 }).finalize({
      processed: 0, succeeded: 0, failedRetryable: 0, failedPermanent: 0, skipped: 0,
      deferred: 0, quarantined: 0,
      remainingBefore: null, remainingAfter: 0, complete: true,
    });
    expect(record.batchSizeLimit).toBe(10);
    expect(record.concurrencyLimit).toBe(1);
    expect(record.peakConcurrency).toBe(0);
  });

  it("records authoritative operation buckets and separate 403/429 counts", () => {
    const tracker = makeTracker();
    tracker.recordFetch(100);
    tracker.recordExtraction(25);
    tracker.recordBrowser(300);
    tracker.recordPersistence(40);
    tracker.recordNetworkRequest(3);
    tracker.recordRateLimited(403);
    tracker.recordRateLimited(429);
    tracker.recordTimeout();
    const record = tracker.finalize({
      processed: 7, succeeded: 4, failedRetryable: 1, failedPermanent: 0, skipped: 0,
      deferred: 2, quarantined: 0,
      remainingBefore: 7, remainingAfter: 2, complete: false,
    });
    expect(record).toMatchObject({
      processed: 7, succeeded: 4, failedRetryable: 1, deferred: 2,
      networkRequests: 3, logicalRequestDurationMs: 0, extractionMs: 25, browserMs: 300,
      persistenceMs: 40, rateLimited403: 1, rateLimited429: 1, timedOut: 1,
    });
  });

  it("retains duration for rejected operations and resets active count", async () => {
    let tick = NOW;
    const tracker = new StageBatchTelemetryTracker({
      orchestrationRunId: "run-1", stage: "agent3", batchSeq: 1,
      batchSizeLimit: 10, concurrencyLimit: 1, now: () => tick,
    });
    const task = tracker.timed("logicalRequest", async () => {
      tick += 46 * 60 * 1000;
      throw new Error("timeout");
    });
    await expect(task).rejects.toThrow("timeout");
    const record = tracker.finalize({
      processed: 1, succeeded: 0, failedRetryable: 1, failedPermanent: 0, skipped: 0,
      deferred: 0, quarantined: 0,
      remainingBefore: 1, remainingAfter: 1, complete: false,
    });
    expect(record.logicalRequestDurationMs).toBe(46 * 60 * 1000);
    expect(record.peakConcurrency).toBe(1);
  });

  it("measures simultaneous peaks of one, two, and three", async () => {
    for (const count of [1, 2, 3]) {
      const tracker = makeTracker({ stage: "agent3", batchSizeLimit: 10, concurrencyLimit: 1 });
      const tasks = Array.from({ length: count }, () => deferred<void>());
      const runs = tasks.map((task) => tracker.timed("extraction", () => task.promise));
      await Promise.resolve();
      const before = tracker.finalize({
        processed: count, succeeded: count, failedRetryable: 0, failedPermanent: 0, skipped: 0,
        deferred: 0, quarantined: 0,
        remainingBefore: null, remainingAfter: count, complete: false,
      });
      expect(before.peakConcurrency).toBe(count);
      tasks.forEach((task) => task.resolve());
      await Promise.all(runs);
    }
  });

  it("supports deterministic injected timestamps and long aggregation", () => {
    const tracker = makeTracker();
    const record = tracker.finalize({
      processed: 1, succeeded: 1, failedRetryable: 0, failedPermanent: 0, skipped: 0,
      deferred: 0, quarantined: 0,
      remainingBefore: null, remainingAfter: 0, complete: true,
    });
    expect(record.startedAt).toBe(new Date(NOW).toISOString());
    expect(record.finishedAt).toBe(new Date(NOW).toISOString());
    const summary = summarizeStageTimings([
      makeRecord("agent1", { durationMs: 46 * 60 * 1000 }),
      makeRecord("agent1", { durationMs: 600_001 }),
      makeRecord("agent1", { durationMs: 600_001 }),
    ])[0]!;
    expect(summary.durationMs).toBe(46 * 60 * 1000 + 1_200_002);
    expect(summary.peakConcurrency).toBe(1);
  });
});

describe("no-op probe", () => {
  it("preserves existing callers", async () => {
    const probe = createNoopStageBatchProbe();
    await expect(probe.timed("fetch", async () => 42)).resolves.toBe(42);
  });
});
