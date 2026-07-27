import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunAgent1Batch = vi.fn();
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

vi.mock("../../utils/news-pipeline/orchestrator", () => ({
  runAgent1Batch: (...args: any[]) => mockRunAgent1Batch(...args),
}));

function makeBatchResult(overrides: Record<string, any> = {}) {
  return {
    pipelineRunId: "run-1",
    targetsResolved: 3,
    processed: 3,
    deferred: 0,
    remainingEligible: 0,
    stoppedReason: "completed",
    durationMs: 5000,
    result: {
      candidates: 10,
      inserted: 8,
      skipped: 1,
      failed: 1,
      artifactCount: 3,
    },
    deferredTargets: [],
    ...overrides,
  };
}

describe("GET /api/internal/run-agent1", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-secret";
    process.env.NUXT_CRON_SECRET = undefined as any;
    mockGetHeader.mockImplementation((_event: any, name: string) => {
      if (name === "x-cron-secret") return "test-secret";
      return "";
    });
    mockGetQuery.mockReturnValue({});
    mockRunAgent1Batch.mockResolvedValue(makeBatchResult());
  });

  async function loadHandler() {
    const mod = await import("./run-agent1.get");
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

  it("calls runAgent1Batch with default bounded params", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.agent).toBe("A1");
    expect(mockRunAgent1Batch).toHaveBeenCalledWith({
      maxTargets: 5,
      timeBudgetMs: 240_000,
      minRemainingMs: 30_000,
    });
    expect(mockRunAgent1Batch).toHaveBeenCalledTimes(1);
  });

  it("returns compact batch result shape", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result).toEqual({
      ok: true,
      agent: "A1",
      pipelineRunId: "run-1",
      targetsResolved: 3,
      processed: 3,
      deferred: 0,
      remainingEligible: 0,
      stoppedReason: "completed",
      durationMs: 5000,
      candidates: 10,
      inserted: 8,
      skipped: 1,
      failed: 1,
      artifacts: 3,
    });
  });

  it("parses custom maxTargets/timeBudgetMs/minRemainingMs from query", async () => {
    mockGetQuery.mockReturnValue({
      maxTargets: "10",
      timeBudgetMs: "120000",
      minRemainingMs: "15000",
    });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunAgent1Batch).toHaveBeenCalledWith({
      maxTargets: 10,
      timeBudgetMs: 120_000,
      minRemainingMs: 15_000,
    });
  });

  it("clamps maxTargets to [1, 50] range", async () => {
    mockGetQuery.mockReturnValue({ maxTargets: "0" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunAgent1Batch).toHaveBeenCalledWith(
      expect.objectContaining({ maxTargets: 1 }),
    );
  });

  it("clamps maxTargets upper bound to 50", async () => {
    mockGetQuery.mockReturnValue({ maxTargets: "999" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunAgent1Batch).toHaveBeenCalledWith(
      expect.objectContaining({ maxTargets: 50 }),
    );
  });

  it("clamps timeBudgetMs to [10000, 600000] range", async () => {
    mockGetQuery.mockReturnValue({ timeBudgetMs: "1000" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunAgent1Batch).toHaveBeenCalledWith(
      expect.objectContaining({ timeBudgetMs: 10_000 }),
    );
  });

  it("clamps minRemainingMs to [5000, 120000] range", async () => {
    mockGetQuery.mockReturnValue({ minRemainingMs: "1000" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunAgent1Batch).toHaveBeenCalledWith(
      expect.objectContaining({ minRemainingMs: 5_000 }),
    );
  });

  it("falls back maxTargets=abc to default 5", async () => {
    mockGetQuery.mockReturnValue({ maxTargets: "abc" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunAgent1Batch).toHaveBeenCalledWith(
      expect.objectContaining({ maxTargets: 5 }),
    );
  });

  it("handles no_targets stoppedReason", async () => {
    mockRunAgent1Batch.mockResolvedValue(makeBatchResult({
      pipelineRunId: null,
      targetsResolved: 0,
      processed: 0,
      deferred: 0,
      remainingEligible: 0,
      stoppedReason: "no_targets",
      durationMs: 10,
      result: { candidates: 0, inserted: 0, skipped: 0, failed: 0, artifactCount: 0 },
    }));

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.stoppedReason).toBe("no_targets");
    expect(result.pipelineRunId).toBeNull();
    expect(result.processed).toBe(0);
  });

  it("handles max_targets stoppedReason with deferred", async () => {
    mockRunAgent1Batch.mockResolvedValue(makeBatchResult({
      processed: 5,
      deferred: 3,
      remainingEligible: 3,
      stoppedReason: "max_targets",
      targetsResolved: 8,
    }));

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.stoppedReason).toBe("max_targets");
    expect(result.processed).toBe(5);
    expect(result.deferred).toBe(3);
    expect(result.remainingEligible).toBe(3);
  });

  it("does NOT call resolveAgent2Targets", async () => {
    const handler = await loadHandler();
    await handler({} as any);

    // Only runAgent1Batch should be called — no Agent 2 resolution
    expect(mockRunAgent1Batch).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when no cron secret is configured", async () => {
    delete process.env.CRON_SECRET;
    delete process.env.NUXT_CRON_SECRET;

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 500 });
  });

  it("falls back to NUXT_CRON_SECRET when CRON_SECRET is not set", async () => {
    delete process.env.CRON_SECRET;
    process.env.NUXT_CRON_SECRET = "nuxt-secret";

    mockGetHeader.mockImplementation((_event: any, name: string) => {
      if (name === "x-cron-secret") return "nuxt-secret";
      return "";
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
  });
});
