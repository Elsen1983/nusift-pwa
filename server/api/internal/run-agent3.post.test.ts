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
});
