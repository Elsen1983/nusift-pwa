import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunNewsPipeline = vi.fn();
const mockResolveAgent2Targets = vi.fn();
const mockGetHeader = vi.hoisted(() => vi.fn());

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
}));

vi.mock("../../utils/news-pipeline/orchestrator", () => ({
  runNewsPipeline: (...args: any[]) => mockRunNewsPipeline(...args),
}));

vi.mock("../../utils/news-pipeline/article-discovery", () => ({
  resolveAgent2Targets: (...args: any[]) => mockResolveAgent2Targets(...args),
}));

describe("GET /api/internal/run-agent1", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "test-secret";
    process.env.NUXT_CRON_SECRET = undefined as any;
    mockGetHeader.mockImplementation((_event: any, name: string) => {
      if (name === "x-cron-secret") return "test-secret";
      return "";
    });
    mockRunNewsPipeline.mockResolvedValue({
      sourcesScanned: 3,
      candidatesFound: 10,
      inserted: 8,
      skipped: 1,
      failed: 1,
      artifactCount: 3,
    });
    mockResolveAgent2Targets.mockResolvedValue({
      targets: [{ sourceId: "src-1" }, { sourceId: "src-2" }],
      diagnostics: { totalActive: 5, eligible: 2, skipped: 3, skippedReasons: {} },
    });
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

  it("calls Agent 1 only (runNewsPipeline) with no arguments", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.agent).toBe("A1");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockRunNewsPipeline).toHaveBeenCalledWith();
    expect(mockRunNewsPipeline).toHaveBeenCalledTimes(1);
  });

  it("returns agent2EligibleAfterRun from resolveAgent2Targets", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.agent2EligibleAfterRun).toBe(2);
    expect(result.agent2EligibleAfterRunError).toBeNull();
    expect(mockResolveAgent2Targets).toHaveBeenCalledTimes(1);
  });

  it("returns null agent2EligibleAfterRun when resolveAgent2Targets fails", async () => {
    mockResolveAgent2Targets.mockRejectedValue(new Error("DB connection lost"));

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.agent).toBe("A1");
    expect(result.agent2EligibleAfterRun).toBeNull();
    expect(result.agent2EligibleAfterRunError).toBe("DB connection lost");
  });

  it("includes result payload from runNewsPipeline", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.result).toEqual({
      sourcesScanned: 3,
      candidatesFound: 10,
      inserted: 8,
      skipped: 1,
      failed: 1,
      artifactCount: 3,
    });
  });

  it("does NOT call runArticleDiscoveryBatch", async () => {
    const handler = await loadHandler();
    await handler({} as any);

    // Only runNewsPipeline and resolveAgent2Targets should be called
    expect(mockRunNewsPipeline).toHaveBeenCalledTimes(1);
    expect(mockResolveAgent2Targets).toHaveBeenCalledTimes(1);
  });
});
