import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHeader: vi.fn(),
  readBody: vi.fn(),
  browserEnabled: vi.fn(),
  processQueue: vi.fn(),
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
vi.mock("../../utils/news-pipeline/article-discovery-browser", () => ({
  isBrowserFallbackEnabled: () => mocks.browserEnabled(),
}));
vi.mock("../../utils/news-pipeline/article-discovery-headless-queue", () => ({
  processArticleDiscoveryHeadlessQueue: (...args: any[]) => mocks.processQueue(...args),
}));
vi.mock("../../utils/news-pipeline/stage-telemetry-server", () => ({
  persistStageBatchTelemetry: (...args: any[]) => mocks.persistTelemetry(...args),
}));

describe("POST /api/internal/run-agent2-headless", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-secret";
    mocks.getHeader.mockImplementation((_event, name) =>
      name === "authorization" ? "Bearer test-secret" : "",
    );
    mocks.readBody.mockResolvedValue({
      orchestrationRunId: "run-1",
      batchSeq: 2,
      remainingBefore: 4,
      sleepMs: 0,
    });
    mocks.browserEnabled.mockReturnValue(true);
    mocks.persistTelemetry.mockResolvedValue(undefined);
    mocks.processQueue.mockResolvedValue({
      dryRun: false,
      processed: 2,
      selectedQueueItems: 2,
      remainingEligible: 0,
      targetDispositions: {
        succeeded: 1,
        failedRetryable: 0,
        failedPermanent: 1,
        skipped: 0,
        deferred: 0,
        quarantined: 0,
        claimLost: 0,
        persistenceFailed: 0,
      },
      productivity: {},
    });
  });

  const loadHandler = async () => (await import("./run-agent2-headless.post")).default;

  it("rejects requests without the cron bearer token", async () => {
    mocks.getHeader.mockReturnValue("");
    await expect((await loadHandler())({} as any)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("accepts the cron secret header used by protected internal routes", async () => {
    mocks.getHeader.mockImplementation((_event, name) =>
      name === "x-cron-secret" ? "test-secret" : "",
    );

    await expect((await loadHandler())({} as any)).resolves.toMatchObject({
      stage: "agent2-headless",
      complete: true,
    });
  });

  it("runs the bounded browser queue in write mode and returns telemetry", async () => {
    const result = await (await loadHandler())({} as any);

    expect(mocks.processQueue).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      dryRun: false,
      runBrowser: true,
      telemetry: expect.anything(),
    }));
    expect(result).toMatchObject({
      stage: "agent2-headless",
      processed: 2,
      remaining: 0,
      complete: true,
      telemetry: {
        stage: "agent2-headless",
        batchSeq: 2,
        processed: 2,
        succeeded: 1,
        failedPermanent: 1,
      },
    });
    expect(mocks.persistTelemetry).toHaveBeenCalledTimes(1);
  });

  it("does not retry completed browser work when telemetry persistence fails", async () => {
    mocks.persistTelemetry.mockRejectedValue(new Error("database unavailable"));

    await expect((await loadHandler())({} as any)).resolves.toMatchObject({
      processed: 2,
      complete: true,
    });
    expect(mocks.processQueue).toHaveBeenCalledTimes(1);
  });

  it("completes the stage after feed-first policy skips are durably removed from the active queue", async () => {
    mocks.processQueue.mockResolvedValue({
      dryRun: false,
      processed: 3,
      selectedQueueItems: 3,
      remainingEligible: 0,
      targetDispositions: {
        succeeded: 0,
        failedRetryable: 0,
        failedPermanent: 0,
        skipped: 3,
        deferred: 0,
        quarantined: 0,
        claimLost: 0,
        persistenceFailed: 0,
      },
      productivity: {},
    });

    await expect((await loadHandler())({} as any)).resolves.toMatchObject({
      stage: "agent2-headless",
      processed: 3,
      remaining: 0,
      complete: true,
      telemetry: {
        processed: 3,
        skipped: 3,
        complete: true,
      },
    });
  });
});
