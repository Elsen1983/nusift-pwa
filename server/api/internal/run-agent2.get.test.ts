import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunArticleDiscoveryBatch = vi.fn();
const mockGetHeader = vi.hoisted(() => vi.fn());
const mockGetQuery = vi.hoisted(() => vi.fn());

(globalThis as any).defineEventHandler = (fn: any) => fn;

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
  createError: ({
    statusCode,
    statusMessage,
  }: {
    statusCode: number;
    statusMessage: string;
  }) => {
    const err = new Error(statusMessage) as Error & {
      statusCode: number;
      statusMessage: string;
    };
    err.statusCode = statusCode;
    err.statusMessage = statusMessage;
    return err;
  },
  getHeader: (...args: any[]) => mockGetHeader(...args),
  getQuery: (...args: any[]) => mockGetQuery(...args),
}));

vi.mock("../../utils/news-pipeline/article-discovery", () => ({
  runArticleDiscoveryBatch: (...args: any[]) => mockRunArticleDiscoveryBatch(...args),
}));

describe("GET /api/internal/run-agent2", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-secret";
    process.env.NUXT_CRON_SECRET = undefined as any;
    mockGetHeader.mockImplementation((_event: any, name: string) => {
      if (name === "x-cron-secret") return "test-secret";
      return "";
    });
    mockGetQuery.mockReturnValue({});
    mockRunArticleDiscoveryBatch.mockResolvedValue({
      pipelineRunId: "run-1",
      targets: [{ sourceId: "src-1" }],
      result: {
        sourcesScanned: 1,
        candidatesFound: 5,
        inserted: 3,
        skipped: 1,
        failed: 1,
        artifactCount: 1,
      },
      stoppedReason: "completed",
      processed: 1,
      deferred: 0,
      remainingEligible: 0,
    });
  });

  async function loadHandler() {
    const mod = await import("./run-agent2.get");
    return mod.default;
  }

  it("returns 401 when no secret is provided", async () => {
    mockGetHeader.mockReturnValue("");

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("returns 401 when wrong secret is provided", async () => {
    mockGetHeader.mockImplementation((_event: any, name: string) => {
      if (name === "x-cron-secret") return "wrong-secret";
      return "";
    });

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("calls runArticleDiscoveryBatch with default bounded params", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.agent).toBe("A2");
    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith({
      maxTargets: 5,
      timeBudgetMs: 240_000,
      minRemainingMs: 30_000,
    });
    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledTimes(1);
  });

  it("returns bounded batch result shape", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result).toEqual({
      ok: true,
      agent: "A2",
      runId: "run-1",
      targetsResolved: 1,
      processed: 1,
      deferred: 0,
      remainingEligible: 0,
      stoppedReason: "completed",
      candidates: 5,
      inserted: 3,
      skipped: 1,
      failed: 1,
      artifacts: 1,
    });
  });

  it("parses custom maxTargets/timeBudgetMs/minRemainingMs from query", async () => {
    mockGetQuery.mockReturnValue({
      maxTargets: "10",
      timeBudgetMs: "120000",
      minRemainingMs: "15000",
    });

    mockRunArticleDiscoveryBatch.mockResolvedValue({
      pipelineRunId: "run-2",
      targets: [],
      result: { sourcesScanned: 0, candidatesFound: 0, inserted: 0, skipped: 0, failed: 0, artifactCount: 0 },
      stoppedReason: "no_targets",
      processed: 0,
      deferred: 0,
      remainingEligible: 0,
    });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith({
      maxTargets: 10,
      timeBudgetMs: 120_000,
      minRemainingMs: 15_000,
    });
  });

  it("clamps maxTargets to [1, 50] range", async () => {
    mockGetQuery.mockReturnValue({ maxTargets: "0" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ maxTargets: 1 }),
    );
  });

  it("clamps maxTargets upper bound to 50", async () => {
    mockGetQuery.mockReturnValue({ maxTargets: "999" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ maxTargets: 50 }),
    );
  });

  it("clamps timeBudgetMs to [10000, 600000] range", async () => {
    mockGetQuery.mockReturnValue({ timeBudgetMs: "1000" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ timeBudgetMs: 10_000 }),
    );
  });

  it("clamps minRemainingMs to [5000, 120000] range", async () => {
    mockGetQuery.mockReturnValue({ minRemainingMs: "1000" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ minRemainingMs: 5_000 }),
    );
  });

  it("falls back maxTargets=abc to default 5", async () => {
    mockGetQuery.mockReturnValue({ maxTargets: "abc" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ maxTargets: 5 }),
    );
  });

  it("falls back timeBudgetMs=abc to default 240000", async () => {
    mockGetQuery.mockReturnValue({ timeBudgetMs: "abc" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ timeBudgetMs: 240_000 }),
    );
  });

  it("falls back minRemainingMs=abc to default 30000", async () => {
    mockGetQuery.mockReturnValue({ minRemainingMs: "abc" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ minRemainingMs: 30_000 }),
    );
  });

  it("falls back maxTargets=NaN to default 5", async () => {
    mockGetQuery.mockReturnValue({ maxTargets: NaN });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ maxTargets: 5 }),
    );
  });

  it("falls back maxTargets=Infinity to default 5", async () => {
    mockGetQuery.mockReturnValue({ maxTargets: Infinity });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ maxTargets: 5 }),
    );
  });

  it("handles negative maxTargets by clamping to 1", async () => {
    mockGetQuery.mockReturnValue({ maxTargets: "-3" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ maxTargets: 1 }),
    );
  });

  it("handles fractional maxTargets by flooring", async () => {
    mockGetQuery.mockReturnValue({ maxTargets: "3.7" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunArticleDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ maxTargets: 3 }),
    );
  });

  it("handles no_targets stoppedReason", async () => {
    mockRunArticleDiscoveryBatch.mockResolvedValue({
      pipelineRunId: null,
      targets: [],
      result: { sourcesScanned: 0, candidatesFound: 0, inserted: 0, skipped: 0, failed: 0, artifactCount: 0 },
      stoppedReason: "no_targets",
      processed: 0,
      deferred: 0,
      remainingEligible: 0,
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.stoppedReason).toBe("no_targets");
    expect(result.runId).toBeNull();
    expect(result.processed).toBe(0);
  });

  it("handles max_targets stoppedReason with deferred", async () => {
    mockRunArticleDiscoveryBatch.mockResolvedValue({
      pipelineRunId: "run-3",
      targets: [{}, {}, {}, {}, {}],
      result: { sourcesScanned: 5, candidatesFound: 20, inserted: 15, skipped: 3, failed: 2, artifactCount: 5 },
      stoppedReason: "max_targets",
      processed: 5,
      deferred: 3,
      remainingEligible: 3,
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.stoppedReason).toBe("max_targets");
    expect(result.processed).toBe(5);
    expect(result.deferred).toBe(3);
    expect(result.remainingEligible).toBe(3);
  });
});
