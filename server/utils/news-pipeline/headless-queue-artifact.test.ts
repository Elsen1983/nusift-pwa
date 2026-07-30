import { beforeEach, describe, expect, it, vi } from "vitest";

const lockMock = vi.fn();
const findManyMock = vi.fn();
const createMock = vi.fn();
const transactionMock = vi.fn(async (callback: (tx: unknown) => unknown) =>
  callback({
    $queryRawUnsafe: lockMock,
    pipelineArtifact: {
      findMany: findManyMock,
      create: createMock,
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
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
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
