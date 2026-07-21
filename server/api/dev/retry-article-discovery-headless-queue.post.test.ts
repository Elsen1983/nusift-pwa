import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdminId = vi.fn();
const mockAssertRateLimit = vi.fn();
const mockReadBody = vi.fn();
const mockFindUnique = vi.fn();
const mockArtifactCreate = vi.fn();
const mockRunCreate = vi.fn();

(globalThis as any).defineEventHandler = (fn: any) => fn;
(globalThis as any).readBody = (...args: any[]) => mockReadBody(...args);

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
}));

vi.mock("../../utils/require-admin", () => ({
  requireAdminId: (...args: any[]) => mockRequireAdminId(...args),
}));

vi.mock("../../utils/rate-limit", () => ({
  assertRateLimit: (...args: any[]) => mockAssertRateLimit(...args),
}));

vi.mock("../../utils/prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findUnique: (...args: any[]) => mockFindUnique(...args),
      create: (...args: any[]) => mockArtifactCreate(...args),
    },
    pipelineRun: {
      create: (...args: any[]) => mockRunCreate(...args),
    },
  },
}));

describe("POST /api/dev/retry-article-discovery-headless-queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.NODE_ENV = "test";
    mockRequireAdminId.mockResolvedValue("admin-1");
    mockAssertRateLimit.mockResolvedValue(undefined);
    mockReadBody.mockResolvedValue({ artifactId: "artifact-1" });
    mockFindUnique.mockResolvedValue({
      id: "artifact-1",
      artifactType: "article_discovery_headless_required",
      status: "BROWSER_NO_CANDIDATES",
      sourceId: "source-1",
      categoryId: "category-1",
      payload: {
        targetUrl: "https://example.com/category/news",
        sourceId: "source-1",
        categoryId: "category-1",
        quality: "failed",
        confidence: "high",
        escalationReasons: ["dynamic_or_empty_html"],
      },
    });
    mockRunCreate.mockResolvedValue({ id: "run-1" });
    mockArtifactCreate.mockResolvedValue({
      id: "retry-1",
      status: "PENDING_HEADLESS",
      sourceId: "source-1",
      categoryId: "category-1",
      payload: {},
    });
  });

  async function loadHandler() {
    const mod = await import("./retry-article-discovery-headless-queue.post");
    return mod.default;
  }

  it("requires admin access", async () => {
    mockRequireAdminId.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    );

    const handler = await loadHandler();

    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("creates a fresh PENDING_HEADLESS retry artifact", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(mockAssertRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "headless-queue-retry",
      10,
      10 * 60 * 1000,
    );
    expect(mockRunCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "COMPLETED",
        targetCount: 1,
        artifactCount: 1,
      }),
      select: { id: true },
    }));
    expect(mockArtifactCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pipelineRunId: "run-1",
        sourceId: "source-1",
        categoryId: "category-1",
        artifactType: "article_discovery_headless_required",
        status: "PENDING_HEADLESS",
        candidateCount: 0,
        payload: expect.objectContaining({
          targetUrl: "https://example.com/category/news",
          retryOfArtifactId: "artifact-1",
          retryOfStatus: "BROWSER_NO_CANDIDATES",
          retryRequestedByUserId: "admin-1",
        }),
      }),
      select: expect.any(Object),
    }));
  });

  it("rejects non-retryable statuses", async () => {
    mockFindUnique.mockResolvedValue({
      id: "artifact-1",
      artifactType: "article_discovery_headless_required",
      status: "PENDING_HEADLESS",
      sourceId: "source-1",
      categoryId: null,
      payload: { targetUrl: "https://example.com", sourceId: "source-1" },
    });

    const handler = await loadHandler();

    await expect(handler({} as any)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: "Artifact status PENDING_HEADLESS is not retryable.",
    });
    expect(mockArtifactCreate).not.toHaveBeenCalled();
  });

  it("rejects artifacts without targetUrl or sourceId", async () => {
    mockFindUnique.mockResolvedValue({
      id: "artifact-1",
      artifactType: "article_discovery_headless_required",
      status: "BROWSER_NO_CANDIDATES",
      sourceId: null,
      categoryId: null,
      payload: {},
    });

    const handler = await loadHandler();

    await expect(handler({} as any)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: "Cannot retry artifact with missing targetUrl or sourceId.",
    });
  });
});
