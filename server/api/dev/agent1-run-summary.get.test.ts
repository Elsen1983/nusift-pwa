import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRequireAdminId = vi.fn();
const mockAssertRateLimit = vi.fn();

(globalThis as any).defineEventHandler = (fn: any) => fn;

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
  createError: ({ statusCode, statusMessage }: { statusCode: number; statusMessage: string }) => {
    const err = new Error(statusMessage) as Error & { statusCode: number };
    err.statusCode = statusCode;
    return err;
  },
}));

vi.mock("../../utils/require-admin", () => ({
  requireAdminId: (...args: any[]) => mockRequireAdminId(...args),
}));

vi.mock("../../utils/rate-limit", () => ({
  assertRateLimit: (...args: any[]) => mockAssertRateLimit(...args),
}));

const mockPipelineArtifactFindFirst = vi.fn();
const mockPipelineRunFindUnique = vi.fn();
const mockPipelineArtifactFindMany = vi.fn();

vi.mock("../../utils/prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findFirst: (...args: any[]) => mockPipelineArtifactFindFirst(...args),
      findMany: (...args: any[]) => mockPipelineArtifactFindMany(...args),
    },
    pipelineRun: {
      findUnique: (...args: any[]) => mockPipelineRunFindUnique(...args),
    },
  },
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/dev/agent1-run-summary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireAdminId.mockResolvedValue("admin-1");
    mockAssertRateLimit.mockResolvedValue(undefined);
  });

  async function loadHandler() {
    const mod = await import("./agent1-run-summary.get");
    return mod.default;
  }

  it("requires admin access", async () => {
    mockRequireAdminId.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    );
    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns null run and empty items when no artifacts exist", async () => {
    mockPipelineArtifactFindFirst.mockResolvedValue(null);
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.run).toBeNull();
    expect(result.items).toEqual([]);
  });

  it("returns urlPolicyRejected from skipSummary payload", async () => {
    mockPipelineArtifactFindFirst.mockResolvedValue({ pipelineRunId: "run-1" });
    mockPipelineRunFindUnique.mockResolvedValue({
      id: "run-1",
      startedAt: "2026-07-29T10:00:00Z",
      finishedAt: "2026-07-29T10:05:00Z",
      targetCount: 2,
      candidatesFound: 5,
      inserted: 3,
      skipped: 2,
      failed: 0,
      artifactCount: 2,
    });
    mockPipelineArtifactFindMany.mockResolvedValue([
      {
        id: "art-1",
        createdAt: "2026-07-29T10:01:00Z",
        sourceId: "src-1",
        categoryId: null,
        status: "PASS",
        candidateCount: 3,
        payload: {
          passed: true,
          candidates: 3,
          inserted: 3,
          skipped: 2,
          failed: 0,
          skipSummary: {
            emptyLink: 0,
            outOfScope: 0,
            staleOrMissingPublishedAt: 0,
            htmlFallbackNonArticle: 0,
            htmlFallbackStale: 0,
            urlPolicyRejected: 5,
          },
        },
        errorLog: null,
      },
      {
        id: "art-2",
        createdAt: "2026-07-29T10:02:00Z",
        sourceId: "src-2",
        categoryId: null,
        status: "PASS",
        candidateCount: 2,
        payload: {
          passed: true,
          candidates: 2,
          inserted: 2,
          skipped: 0,
          failed: 0,
          skipSummary: {
            emptyLink: 0,
            outOfScope: 0,
            staleOrMissingPublishedAt: 0,
            htmlFallbackNonArticle: 0,
            htmlFallbackStale: 0,
          },
        },
        errorLog: null,
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);

    // First item has urlPolicyRejected = 5
    expect(result.items[0]!.urlPolicyRejected).toBe(5);

    // Second item has no urlPolicyRejected in skipSummary → 0
    expect(result.items[1]!.urlPolicyRejected).toBe(0);
  });

  it("returns 0 for urlPolicyRejected when skipSummary is missing or malformed", async () => {
    mockPipelineArtifactFindFirst.mockResolvedValue({ pipelineRunId: "run-2" });
    mockPipelineRunFindUnique.mockResolvedValue({
      id: "run-2",
      startedAt: "2026-07-29T10:00:00Z",
      finishedAt: "2026-07-29T10:05:00Z",
      targetCount: 1,
      candidatesFound: 0,
      inserted: 0,
      skipped: 1,
      failed: 0,
      artifactCount: 1,
    });
    mockPipelineArtifactFindMany.mockResolvedValue([
      {
        id: "art-3",
        createdAt: "2026-07-29T10:01:00Z",
        sourceId: "src-3",
        categoryId: null,
        status: "FAILED",
        candidateCount: 0,
        payload: {
          // No skipSummary at all
          passed: false,
          failed: 1,
        },
        errorLog: "Agent 1 failed.",
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.urlPolicyRejected).toBe(0);
  });

  it("returns the durable bounded failure detail separately from the summary", async () => {
    mockPipelineArtifactFindFirst.mockResolvedValue({ pipelineRunId: "run-3" });
    mockPipelineRunFindUnique.mockResolvedValue(null);
    mockPipelineArtifactFindMany.mockResolvedValue([{
      id: "art-4",
      createdAt: "2026-08-13T10:01:00Z",
      sourceId: "src-4",
      categoryId: null,
      status: "FAILED",
      candidateCount: 0,
      payload: {
        passed: false,
        failed: 1,
        failureReason: "Agent 1 failed while fetching or parsing this target.",
        failureDetail: "HTTP 503 while loading https://example.com/feed?token=[redacted]",
      },
      errorLog: null,
    }]);

    const result = await (await loadHandler())({} as any);
    expect(result.items[0]).toMatchObject({
      failureReason: "Agent 1 failed while fetching or parsing this target.",
      failureDetail: "HTTP 503 while loading https://example.com/feed?token=[redacted]",
    });
  });
});
