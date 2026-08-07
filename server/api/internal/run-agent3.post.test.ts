import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHeader: vi.fn(),
  readBody: vi.fn(),
  runBatch: vi.fn(),
  getProgress: vi.fn(),
  completion: vi.fn(),
  persistTelemetry: vi.fn(),
}));

(globalThis as any).defineEventHandler = (fn: any) => fn;
(globalThis as any).readBody = (...args: any[]) => mocks.readBody(...args);

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
  getHeader: (...args: any[]) => mocks.getHeader(...args),
  createError: ({ statusCode, statusMessage }: any) =>
    Object.assign(new Error(statusMessage), { statusCode, statusMessage }),
}));
vi.mock("../../utils/news-pipeline/enrichment-runtime", () => ({
  runEnrichmentBatch: (...args: any[]) => mocks.runBatch(...args),
  getAgent3Progress: (...args: any[]) => mocks.getProgress(...args),
}));
vi.mock("../../utils/news-pipeline/agent3-completion", () => ({
  computeAgent3CompletionSummaryForRun: (...args: any[]) => mocks.completion(...args),
}));
vi.mock("../../utils/news-pipeline/stage-telemetry-server", () => ({
  persistStageBatchTelemetry: (...args: any[]) => mocks.persistTelemetry(...args),
}));

describe("POST /api/internal/run-agent3", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-secret";
    delete process.env.NUXT_AGENT3_WORKFLOW_BROWSER_FALLBACK;
    mocks.getHeader.mockImplementation((_event, name) =>
      name === "x-cron-secret" ? "test-secret" : "",
    );
    mocks.readBody.mockResolvedValue({ orchestrationRunId: "run-1", action: "batch" });
    mocks.persistTelemetry.mockResolvedValue(undefined);
    mocks.runBatch.mockResolvedValue({
      articleCount: 2,
      persist: {
        failed: 0,
        claimLost: 0,
        byKind: { SUCCESS: 1, RETRYABLE_FAILURE: 1 },
      },
    });
    mocks.getProgress.mockResolvedValue({
      readyNew: 0,
      readyRetry: 1,
      retryableNow: 1,
      deferred: 2,
      quarantined: 0,
      nextRetryAt: null,
    });
  });

  const loadHandler = async () => (await import("./run-agent3.post")).default;

  it("rejects an invalid internal secret", async () => {
    mocks.getHeader.mockReturnValue("wrong");
    await expect((await loadHandler())({} as any)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("runs Agent 3 with a bounded browser fallback budget and reprocessing disabled", async () => {
    const result = await (await loadHandler())({} as any);

    expect(mocks.runBatch).toHaveBeenCalledWith(expect.objectContaining({
      maxArticles: 10,
      includeEnriched: false,
      forceReprocess: false,
      browserFallback: true,
      browserFallbackMaxAttempts: 2,
      browserTimeoutMs: 25_000,
      maxArticlesPerSource: 2,
      pipelineRunId: "run-1",
    }));
    expect(result).toMatchObject({
      stage: "agent3",
      processed: 2,
      succeeded: 1,
      failedRetryable: 1,
      remaining: 1,
      complete: false,
    });
  });

  it("supports an emergency environment opt-out for workflow browser fallback", async () => {
    process.env.NUXT_AGENT3_WORKFLOW_BROWSER_FALLBACK = "false";

    await (await loadHandler())({} as any);

    expect(mocks.runBatch).toHaveBeenCalledWith(expect.objectContaining({
      browserFallback: false,
      browserFallbackMaxAttempts: 2,
      maxArticlesPerSource: 2,
    }));
  });

  it("runs a bounded browser recovery batch after the normal queue drains", async () => {
    mocks.getProgress
      .mockResolvedValueOnce({ retryableNow: 0, deferred: 12 })
      .mockResolvedValueOnce({
        readyNew: 0,
        readyRetry: 0,
        retryableNow: 0,
        deferred: 10,
        quarantined: 0,
        nextRetryAt: null,
      });

    const result = await (await loadHandler())({} as any);

    expect(mocks.runBatch).toHaveBeenCalledWith(expect.objectContaining({
      maxArticles: 2,
      browserFallback: true,
      browserFallbackMaxAttempts: 2,
      allowBrowserRecoveryDuringHttp403Cooldown: true,
    }));
    expect(result).toMatchObject({ processed: 2, remaining: 10, complete: false });
  });

  it("computes completion using current-run and future-run scopes", async () => {
    mocks.readBody.mockResolvedValue({ orchestrationRunId: "run-1", action: "completion" });
    mocks.completion.mockResolvedValue({
      summary: { completionReason: "current_orchestration_drained" },
    });

    await expect((await loadHandler())({} as any)).resolves.toEqual({
      action: "completion",
      summary: { completionReason: "current_orchestration_drained" },
    });
    expect(mocks.completion.mock.calls[0]![1]).toEqual({
      currentRunOptions: expect.objectContaining({ pipelineRunId: "run-1" }),
      futureRunOptions: expect.not.objectContaining({ pipelineRunId: expect.anything() }),
    });
  });

  it("reports DEFERRED interstitials in deferred, not failedPermanent or quarantined", async () => {
    mocks.runBatch.mockResolvedValue({
      articleCount: 1,
      persist: { failed: 0, claimLost: 0, byKind: { INTERSTITIAL_OR_CHALLENGE: 1 } },
      interstitialDispositionCounts: { deferred: 1, quarantined: 0, readyRetry: 0, nonRetryable: 0 },
    });

    const result = await (await loadHandler())({} as any);

    expect(result.telemetry).toMatchObject({
      processed: 1,
      succeeded: 0,
      failedRetryable: 0,
      failedPermanent: 0,
      deferred: 1,
      quarantined: 0,
    });
  });

  it("does not expose non-persisted interstitial dispositions as durable telemetry", async () => {
    mocks.runBatch.mockResolvedValue({
      articleCount: 3,
      persist: {
        persisted: 0,
        failed: 1,
        claimLost: 2,
        byKind: { INTERSTITIAL_OR_CHALLENGE: 0 },
      },
      // Runtime must leave all four persisted-only buckets at zero when these
      // disposition attempts lost their claims or failed to persist.
      interstitialDispositionCounts: { deferred: 0, quarantined: 0, readyRetry: 0, nonRetryable: 0 },
    });

    const result = await (await loadHandler())({} as any);

    expect(result.telemetry).toMatchObject({
      processed: 3,
      failedRetryable: 0,
      failedPermanent: 0,
      deferred: 0,
      quarantined: 0,
      claimLost: 2,
      persistenceFailed: 1,
    });
  });

  it("maps persisted NON_RETRYABLE interstitials to failedPermanent exactly once", async () => {
    mocks.runBatch.mockResolvedValue({
      articleCount: 1,
      persist: {
        persisted: 1,
        failed: 0,
        claimLost: 0,
        byKind: { INTERSTITIAL_OR_CHALLENGE: 1 },
      },
      interstitialDispositionCounts: { deferred: 0, quarantined: 0, readyRetry: 0, nonRetryable: 1 },
    });

    const result = await (await loadHandler())({} as any);

    expect(result.telemetry).toMatchObject({
      processed: 1,
      failedRetryable: 0,
      failedPermanent: 1,
      deferred: 0,
      quarantined: 0,
    });
  });

  it("reports QUARANTINED interstitials in quarantined (terminal), not deferred", async () => {
    mocks.runBatch.mockResolvedValue({
      articleCount: 1,
      persist: { failed: 0, claimLost: 0, byKind: { INTERSTITIAL_OR_CHALLENGE: 1 } },
      interstitialDispositionCounts: { deferred: 0, quarantined: 1, readyRetry: 0, nonRetryable: 0 },
    });

    const result = await (await loadHandler())({} as any);

    expect(result.telemetry).toMatchObject({
      failedPermanent: 0,
      deferred: 0,
      quarantined: 1,
    });
  });

  it("reports READY_RETRY interstitials as failedRetryable without double counting", async () => {
    mocks.runBatch.mockResolvedValue({
      articleCount: 3,
      persist: {
        failed: 0,
        claimLost: 0,
        byKind: { INTERSTITIAL_OR_CHALLENGE: 1, RETRYABLE_FAILURE: 1, SUCCESS: 1 },
      },
      interstitialDispositionCounts: { deferred: 0, quarantined: 0, readyRetry: 1, nonRetryable: 0 },
    });

    const result = await (await loadHandler())({} as any);

    // RETRYABLE_FAILURE (byKind) + one READY_RETRY interstitial = 2, exactly.
    expect(result.telemetry).toMatchObject({
      processed: 3,
      succeeded: 1,
      failedRetryable: 2,
      failedPermanent: 0,
      deferred: 0,
      quarantined: 0,
    });
  });

  it("mixed batch: terminal outcomes count failedPermanent, recoverable interstitials never do", async () => {
    mocks.runBatch.mockResolvedValue({
      articleCount: 4,
      persist: {
        failed: 0,
        claimLost: 0,
        byKind: { INTERSTITIAL_OR_CHALLENGE: 3, PAYWALL_BLOCKED: 1 },
      },
      interstitialDispositionCounts: { deferred: 2, quarantined: 1, readyRetry: 0, nonRetryable: 0 },
    });

    const result = await (await loadHandler())({} as any);

    expect(result.telemetry).toMatchObject({
      processed: 4,
      failedPermanent: 1, // PAYWALL_BLOCKED only
      deferred: 2,
      quarantined: 1,
    });
  });
});
