import { beforeEach, describe, expect, it, vi } from "vitest";

const lockMock = vi.fn();
const findManyMock = vi.fn();
const createMock = vi.fn();
const updateManyMock = vi.fn();
const transactionMock = vi.fn(async (callback: (tx: unknown) => unknown) =>
  callback({
    $queryRawUnsafe: lockMock,
    pipelineArtifact: {
      findMany: findManyMock,
      create: createMock,
      updateMany: updateManyMock,
    },
  }),
);

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: transactionMock,
    pipelineArtifact: { create: createMock },
  },
}));

describe("createHeadlessQueueArtifactIfAbsent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockMock.mockResolvedValue([]);
    findManyMock.mockResolvedValue([]);
    updateManyMock.mockResolvedValue({ count: 1 });
    createMock.mockResolvedValue({
      id: "created-1",
      sourceId: "source-1",
      categoryId: null,
      status: "PENDING_HEADLESS",
      payload: {},
    });
  });

  it("locks the stable target key before the second check and creation", async () => {
    const { createHeadlessQueueArtifactIfAbsent } = await import("./headless-queue-artifact");
    const result = await createHeadlessQueueArtifactIfAbsent({
      pipelineRunId: "run-1",
      sourceId: "source-1",
      categoryId: null,
      targetUrl: "https://EXAMPLE.com:443/news/?utm_source=test#top",
      payload: { quality: "failed" },
    });

    expect(result.created).toBe(true);
    expect(lockMock).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) IS NULL AS locked",
      "article-discovery-headless:source-1||https://example.com/news",
    );
    expect(lockMock.mock.invocationCallOrder[0]).toBeLessThan(findManyMock.mock.invocationCallOrder[0]!);
    expect(findManyMock.mock.invocationCallOrder[0]).toBeLessThan(createMock.mock.invocationCallOrder[0]!);
    expect(createMock.mock.calls[0]![0].data.payload.targetKey)
      .toBe("source-1||https://example.com/news");
  });

  it("reuses an equivalent active legacy artifact instead of creating", async () => {
    findManyMock.mockResolvedValue([{
      id: "existing-1",
      sourceId: "source-1",
      categoryId: null,
      status: "HEADLESS_PROCESSING",
      payload: { targetUrl: "https://example.com/news/" },
    }]);
    const { createHeadlessQueueArtifactIfAbsent } = await import("./headless-queue-artifact");
    const result = await createHeadlessQueueArtifactIfAbsent({
      pipelineRunId: "run-2",
      sourceId: "source-1",
      categoryId: null,
      targetUrl: "https://example.com/news?fbclid=x",
      payload: {},
    });

    expect(result).toMatchObject({ created: false, artifact: { id: "existing-1" } });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refreshes an existing pending marker with namespaced static evidence using a status CAS", async () => {
    const existing = {
      id: "existing-pending",
      sourceId: "source-1",
      categoryId: null,
      status: "PENDING_HEADLESS",
      payload: {
        targetUrl: "https://example.com/news",
        targetKey: "source-1||https://example.com/news",
        browserAttempt: 4,
        claimToken: "worker-token",
      },
    };
    findManyMock.mockResolvedValue([existing]);
    const { createHeadlessQueueArtifactIfAbsent } = await import("./headless-queue-artifact");
    const result = await createHeadlessQueueArtifactIfAbsent({
      pipelineRunId: "run-refresh",
      sourceId: "source-1",
      categoryId: null,
      targetUrl: "https://example.com/news",
      payload: {
        stopReason: "rate_limited",
        rateLimitPhase: "article_detail",
        retryAfterAt: "2026-07-30T12:30:00.000Z",
        retryAfterSource: "delta_seconds",
        requestBudget: { limit: 40, used: 3, remaining: 37, exhausted: false, skippedWork: [] },
        discoveryComplete: false,
        retryable: true,
        acceptedCount: 2,
        evaluatedCount: 3,
      },
    });

    expect(result).toMatchObject({ created: false, evidenceRefreshed: true, evidenceRefreshConflict: false });
    const refreshedData = updateManyMock.mock.calls[0]![0].data.payload;
    expect(refreshedData.retryAfterAt).toBe("2026-07-30T12:30:00.000Z");
    expect(refreshedData.requestBudget).toMatchObject({ used: 3, remaining: 37 });
    expect(refreshedData.discoveryComplete).toBe(false);
    expect(refreshedData.acceptedCount).toBe(2);
    expect(refreshedData.evaluatedCount).toBe(3);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "existing-pending", status: "PENDING_HEADLESS" },
      data: { payload: expect.objectContaining({
        targetKey: "source-1||https://example.com/news",
        browserAttempt: 4,
        claimToken: "worker-token",
        staticDiscovery: expect.objectContaining({
          stopReason: "rate_limited",
          rateLimitPhase: "article_detail",
          retryAfterAt: "2026-07-30T12:30:00.000Z",
          retryAfterSource: "delta_seconds",
          discoveryComplete: false,
          retryable: true,
          acceptedCount: 2,
          evaluatedCount: 3,
        }),
        stopReason: "rate_limited",
        rateLimitPhase: "article_detail",
        retryAfterAt: "2026-07-30T12:30:00.000Z",
        retryAfterSource: "delta_seconds",
        discoveryComplete: false,
        retryable: true,
        acceptedCount: 2,
        evaluatedCount: 3,
      }) },
    });
  });

  it("reports a pending-marker CAS conflict without claiming refresh", async () => {
    findManyMock.mockResolvedValue([{
      id: "existing-pending",
      sourceId: "source-1",
      categoryId: null,
      status: "PENDING_HEADLESS",
      payload: { targetUrl: "https://example.com/news", targetKey: "source-1||https://example.com/news" },
    }]);
    updateManyMock.mockResolvedValue({ count: 0 });
    const { createHeadlessQueueArtifactIfAbsent } = await import("./headless-queue-artifact");
    const result = await createHeadlessQueueArtifactIfAbsent({
      pipelineRunId: "run-conflict",
      sourceId: "source-1",
      categoryId: null,
      targetUrl: "https://example.com/news",
      payload: { stopReason: "request_budget_exhausted", retryable: true, discoveryComplete: false },
    });

    expect(result).toMatchObject({ created: false, evidenceRefreshed: false, evidenceRefreshConflict: true });
    expect(result.artifact.payload).not.toHaveProperty("staticDiscovery");
  });

  it("does not overwrite processing or stale-processing markers", async () => {
    for (const status of ["HEADLESS_PROCESSING", "HEADLESS_PROCESSING_STALE"]) {
      findManyMock.mockResolvedValueOnce([{
        id: `existing-${status}`,
        sourceId: "source-1",
        categoryId: null,
        status,
        payload: { targetUrl: "https://example.com/news", browserClaim: "preserve" },
      }]);
      const { createHeadlessQueueArtifactIfAbsent } = await import("./headless-queue-artifact");
      const result = await createHeadlessQueueArtifactIfAbsent({
        pipelineRunId: "run-processing",
        sourceId: "source-1",
        categoryId: null,
        targetUrl: "https://example.com/news",
        payload: { stopReason: "rate_limited", retryable: true },
      });
      expect(result).toMatchObject({ created: false, evidenceRefreshed: false, evidenceRefreshConflict: false });
    }
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("allows a new artifact when only terminal history exists", async () => {
    findManyMock.mockResolvedValue([]);
    const { createHeadlessQueueArtifactIfAbsent } = await import("./headless-queue-artifact");
    const result = await createHeadlessQueueArtifactIfAbsent({
      pipelineRunId: "run-3",
      sourceId: "source-1",
      categoryId: null,
      targetUrl: "https://example.com/news",
      payload: {},
    });

    expect(result.created).toBe(true);
    expect(findManyMock.mock.calls[0]![0].where.status.in).not.toContain("RESOLVED");
  });
});
