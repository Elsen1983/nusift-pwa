import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunMaintenanceCleanup = vi.fn();
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

vi.mock("../../utils/news-pipeline/maintenance-cleanup-runner", () => ({
  runMaintenanceCleanup: (...args: any[]) => mockRunMaintenanceCleanup(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRunnerResult(overrides: Record<string, any> = {}) {
  return {
    ok: true,
    dryRun: false as const,
    startedAt: "2026-07-27T12:00:00.000Z",
    finishedAt: "2026-07-27T12:00:05.000Z",
    durationMs: 5000,
    timeBudgetMs: 45_000,
    minRemainingMs: 5_000,
    stoppedReason: "complete" as const,
    pipelineArtifacts: {
      enabled: true,
      batches: 1,
      inspected: 10,
      eligibleForDeletion: 5,
      deleted: 5,
      protected: 2,
      skipped: 1,
      stoppedReason: "complete" as const,
      byStatus: { CAPTURED: 5 },
      byArtifactType: { rss_candidates: 5 },
      protectedReasons: { active_inflight_status: 2 },
      skippedReasons: { protected: 1 },
    },
    articles: {
      enabled: true,
      batches: 1,
      inspected: 3,
      eligibleForDeletion: 2,
      deleted: 2,
      protected: 1,
      skipped: 0,
      stoppedReason: "complete" as const,
      bySource: [{ sourceId: "src-1", count: 2 }],
      protectedReasons: { bookmark: 1 },
      skippedReasons: {},
    },
    errors: [],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/internal/cleanup-maintenance", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-secret";
    process.env.NUXT_CRON_SECRET = undefined as any;
    mockGetHeader.mockImplementation((_event: any, name: string) => {
      if (name === "x-cron-secret") return "test-secret";
      return "";
    });
    mockGetQuery.mockReturnValue({});
    mockRunMaintenanceCleanup.mockResolvedValue(makeRunnerResult());
  });

  async function loadHandler() {
    const mod = await import("./cleanup-maintenance.get");
    return mod.default;
  }

  it("rejects missing provided cron secret", async () => {
    mockGetHeader.mockReturnValue("");

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects invalid CRON_SECRET", async () => {
    mockGetHeader.mockImplementation((_event: any, name: string) => {
      if (name === "x-cron-secret") return "wrong-secret";
      return "";
    });

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("accepts valid CRON_SECRET via x-cron-secret header", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
  });

  it("accepts valid CRON_SECRET via Bearer token", async () => {
    mockGetHeader.mockImplementation((_event: any, name: string) => {
      if (name === "authorization") return "Bearer test-secret";
      return "";
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
  });

  it("calls runMaintenanceCleanup with default params", async () => {
    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunMaintenanceCleanup).toHaveBeenCalledWith({
      articleOlderThanDays: 7,
      articleBatchLimit: 500,
      artifactOlderThanDays: 14,
      artifactBatchLimit: 1000,
      timeBudgetMs: 45_000,
      minRemainingMs: 5_000,
      runArticles: true,
      runPipelineArtifacts: true,
    });
  });

  it("parses and clamps numeric params", async () => {
    mockGetQuery.mockReturnValue({
      articleOlderThanDays: "10",
      articleBatchLimit: "300",
      artifactOlderThanDays: "21",
      artifactBatchLimit: "800",
      timeBudgetMs: "30000",
      minRemainingMs: "3000",
    });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunMaintenanceCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        articleOlderThanDays: 10,
        articleBatchLimit: 300,
        artifactOlderThanDays: 21,
        artifactBatchLimit: 800,
        timeBudgetMs: 30_000,
        minRemainingMs: 3_000,
      }),
    );
  });

  it("clamps numeric params to valid ranges", async () => {
    mockGetQuery.mockReturnValue({
      articleOlderThanDays: "999",
      articleBatchLimit: "9999",
      artifactOlderThanDays: "0",
      artifactBatchLimit: "0",
      timeBudgetMs: "100",
      minRemainingMs: "100",
    });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunMaintenanceCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        articleOlderThanDays: 365,
        articleBatchLimit: 1000,
        artifactOlderThanDays: 1,
        artifactBatchLimit: 1,
        timeBudgetMs: 5_000,
        minRemainingMs: 1_000,
      }),
    );
  });

  it("parses runArticles=false", async () => {
    mockGetQuery.mockReturnValue({ runArticles: "false" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunMaintenanceCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ runArticles: false }),
    );
  });

  it("parses runPipelineArtifacts=false", async () => {
    mockGetQuery.mockReturnValue({ runPipelineArtifacts: "false" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunMaintenanceCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ runPipelineArtifacts: false }),
    );
  });

  it("defaults boolean params to true for invalid values", async () => {
    mockGetQuery.mockReturnValue({
      runArticles: "invalid",
      runPipelineArtifacts: "yes",
    });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRunMaintenanceCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        runArticles: true,
        runPipelineArtifacts: true,
      }),
    );
  });

  it("returns the runner result directly", async () => {
    const mockResult = makeRunnerResult({ stoppedReason: "time_budget" });
    mockRunMaintenanceCleanup.mockResolvedValue(mockResult);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result).toEqual(mockResult);
  });

  it("does not require admin auth (only CRON_SECRET)", async () => {
    // No cookie/session — just CRON_SECRET
    mockGetHeader.mockImplementation((_event: any, name: string) => {
      if (name === "x-cron-secret") return "test-secret";
      return "";
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
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

  it("returns 500 when no cron secret is configured", async () => {
    delete process.env.CRON_SECRET;
    delete process.env.NUXT_CRON_SECRET;

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});
