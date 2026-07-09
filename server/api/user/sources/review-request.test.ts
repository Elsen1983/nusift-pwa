import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Provide Nitro auto-imports via globalThis
// ---------------------------------------------------------------------------
const mockReadBody = vi.fn();

(globalThis as any).defineEventHandler = (fn: any) => fn;
(globalThis as any).readBody = (...args: any[]) => mockReadBody(...args);
(globalThis as any).createError = ({
  statusCode,
  statusMessage,
}: {
  statusCode: number;
  statusMessage: string;
}) => {
  const err = new Error(statusMessage) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
const findFirstSourceSubMock = vi.fn();
const findFirstCategorySubMock = vi.fn();
const updateManyReviewMock = vi.fn();
const newsSourceUpdateMock = vi.fn();
const sourceCategoryUpdateMock = vi.fn();
const transactionMock = vi.fn();

// Transaction-level mocks (used inside $transaction callback)
const txFindFirstMock = vi.fn();
const txCreateMock = vi.fn();

// Require-user mock
const mockRequireUserId = vi.fn();

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
  createError: ({
    statusCode,
    statusMessage,
  }: {
    statusCode: number;
    statusMessage: string;
  }) => {
    const err = new Error(statusMessage) as Error & { statusCode: number };
    err.statusCode = statusCode;
    return err;
  },
}));

vi.mock("../../../utils/prisma", () => ({
  prisma: {
    userSourceSubscription: {
      findFirst: (...args: any[]) => findFirstSourceSubMock(...args),
    },
    userCategorySubscription: {
      findFirst: (...args: any[]) => findFirstCategorySubMock(...args),
    },
    feedReviewRequest: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: (...args: any[]) => updateManyReviewMock(...args),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    newsSource: {
      update: (...args: any[]) => newsSourceUpdateMock(...args),
    },
    sourceCategory: {
      update: (...args: any[]) => sourceCategoryUpdateMock(...args),
    },
    $transaction: (...args: any[]) => transactionMock(...args),
  },
}));

vi.mock("../../../utils/require-user", () => ({
  requireUserId: (...args: any[]) => mockRequireUserId(...args),
}));

// ---------------------------------------------------------------------------
// Tests – integrity validator
// ---------------------------------------------------------------------------
describe("assertExactlyOneTarget", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects when both sourceId and categoryId are set", async () => {
    const { assertExactlyOneTarget } = await import(
      "../../../utils/feed-review-integrity"
    );
    expect(() =>
      assertExactlyOneTarget({ sourceId: "src-1", categoryId: "cat-1" }),
    ).toThrow(/must target either a source or a category, not both/);
  });

  it("rejects when neither sourceId nor categoryId is set", async () => {
    const { assertExactlyOneTarget } = await import(
      "../../../utils/feed-review-integrity"
    );
    expect(() =>
      assertExactlyOneTarget({ sourceId: null, categoryId: null }),
    ).toThrow(/must target a source or category/);
  });

  it("accepts with only sourceId", async () => {
    const { assertExactlyOneTarget } = await import(
      "../../../utils/feed-review-integrity"
    );
    expect(() =>
      assertExactlyOneTarget({ sourceId: "src-1", categoryId: null }),
    ).not.toThrow();
  });

  it("accepts with only categoryId", async () => {
    const { assertExactlyOneTarget } = await import(
      "../../../utils/feed-review-integrity"
    );
    expect(() =>
      assertExactlyOneTarget({ sourceId: null, categoryId: "cat-1" }),
    ).not.toThrow();
  });

  it("accepts SOURCE targetType with sourceId set", async () => {
    const { assertExactlyOneTarget } = await import(
      "../../../utils/feed-review-integrity"
    );
    expect(() =>
      assertExactlyOneTarget({
        sourceId: "src-1",
        categoryId: null,
        targetType: "SOURCE",
      }),
    ).not.toThrow();
  });

  it("accepts CATEGORY targetType with categoryId set", async () => {
    const { assertExactlyOneTarget } = await import(
      "../../../utils/feed-review-integrity"
    );
    expect(() =>
      assertExactlyOneTarget({
        sourceId: null,
        categoryId: "cat-1",
        targetType: "CATEGORY",
      }),
    ).not.toThrow();
  });

  it("rejects SOURCE targetType when sourceId is missing (categoryId set)", async () => {
    const { assertExactlyOneTarget } = await import(
      "../../../utils/feed-review-integrity"
    );
    expect(() =>
      assertExactlyOneTarget({
        sourceId: null,
        categoryId: "cat-1",
        targetType: "SOURCE",
      }),
    ).toThrow(/targetType is SOURCE but sourceId is not set/);
  });

  it("rejects CATEGORY targetType when categoryId is missing (sourceId set)", async () => {
    const { assertExactlyOneTarget } = await import(
      "../../../utils/feed-review-integrity"
    );
    expect(() =>
      assertExactlyOneTarget({
        sourceId: "src-1",
        categoryId: null,
        targetType: "CATEGORY",
      }),
    ).toThrow(/targetType is CATEGORY but categoryId is not set/);
  });

  it("rejects when both targets set (fails before targetType check)", async () => {
    const { assertExactlyOneTarget } = await import(
      "../../../utils/feed-review-integrity"
    );
    expect(() =>
      assertExactlyOneTarget({
        sourceId: "src-1",
        categoryId: "cat-1",
        targetType: "SOURCE",
      }),
    ).toThrow(/must target either a source or a category, not both/);
  });

  it("rejects when neither target set (fails before targetType check)", async () => {
    const { assertExactlyOneTarget } = await import(
      "../../../utils/feed-review-integrity"
    );
    expect(() =>
      assertExactlyOneTarget({
        sourceId: null,
        categoryId: null,
        targetType: "CATEGORY",
      }),
    ).toThrow(/must target a source or category/);
  });
});

// ---------------------------------------------------------------------------
// Tests – POST /api/user/sources/review-request handler
// ---------------------------------------------------------------------------
describe("POST /api/user/sources/review-request", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireUserId.mockReturnValue("user-1");
    // Default: transaction delegates to callback with mock tx
    transactionMock.mockImplementation(async (fn: any) => {
      return fn({
        feedReviewRequest: {
          findFirst: (...args: any[]) => txFindFirstMock(...args),
          create: (...args: any[]) => txCreateMock(...args),
        },
      });
    });
  });

  async function loadHandler() {
    const mod = await import("../../../api/user/sources/review-request.post");
    return mod.default;
  }

  it("creates a review request for a source subscription", async () => {
    findFirstSourceSubMock.mockResolvedValue({
      id: "sub-1",
      newsSource: { id: "src-1", mediaName: "Test Source" },
    });
    txFindFirstMock.mockResolvedValue(null);
    txCreateMock.mockResolvedValue({ id: "req-1" });
    mockReadBody.mockResolvedValue({ subscriptionId: "sub-1" });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.alreadyRequested).toBe(false);
    expect(result.reviewRequestId).toBe("req-1");
    expect(txCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        targetType: "SOURCE",
        sourceId: "src-1",
        categoryId: null,
        requestedByUserId: "user-1",
        status: "OPEN",
      }),
    });
  });

  it("creates a review request for a category subscription", async () => {
    findFirstSourceSubMock.mockResolvedValue(null);
    findFirstCategorySubMock.mockResolvedValue({
      id: "cat-sub-1",
      category: { id: "cat-1", name: "Tech" },
    });
    txFindFirstMock.mockResolvedValue(null);
    txCreateMock.mockResolvedValue({ id: "req-2" });
    mockReadBody.mockResolvedValue({ subscriptionId: "cat-sub-1" });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.alreadyRequested).toBe(false);
    expect(txCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        targetType: "CATEGORY",
        sourceId: null,
        categoryId: "cat-1",
        status: "OPEN",
      }),
    });
  });

  it("returns alreadyRequested when user already has an OPEN request", async () => {
    findFirstSourceSubMock.mockResolvedValue({
      id: "sub-1",
      newsSource: { id: "src-1", mediaName: "Test" },
    });
    txFindFirstMock.mockResolvedValue({ id: "existing-req-1" });
    mockReadBody.mockResolvedValue({ subscriptionId: "sub-1" });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.alreadyRequested).toBe(true);
    expect(result.reviewRequestId).toBe("existing-req-1");
    expect(txCreateMock).not.toHaveBeenCalled();
  });

  it("maps P2034 transaction conflict to HTTP 409", async () => {
    findFirstSourceSubMock.mockResolvedValue({
      id: "sub-1",
      newsSource: { id: "src-1", mediaName: "Test" },
    });
    const p2034Error = new Error("Transaction conflict") as any;
    p2034Error.code = "P2034";
    transactionMock.mockRejectedValue(p2034Error);
    mockReadBody.mockResolvedValue({ subscriptionId: "sub-1" });

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects with 400 when subscriptionId is missing", async () => {
    mockReadBody.mockResolvedValue({});

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects with 404 when subscription is not found", async () => {
    findFirstSourceSubMock.mockResolvedValue(null);
    findFirstCategorySubMock.mockResolvedValue(null);
    mockReadBody.mockResolvedValue({ subscriptionId: "nonexistent" });

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not mutate feed URL, rssStatus, or any source/category fields", async () => {
    findFirstSourceSubMock.mockResolvedValue({
      id: "sub-1",
      newsSource: { id: "src-1", mediaName: "Test" },
    });
    txFindFirstMock.mockResolvedValue(null);
    txCreateMock.mockResolvedValue({ id: "req-1" });
    mockReadBody.mockResolvedValue({ subscriptionId: "sub-1" });

    const handler = await loadHandler();
    await handler({} as any);

    // The handler must NOT touch NewsSource or SourceCategory tables
    expect(newsSourceUpdateMock).not.toHaveBeenCalled();
    expect(sourceCategoryUpdateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests – auto-resolve in feed-productivity
// ---------------------------------------------------------------------------
describe("auto-resolve review requests in feed-productivity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("auto-resolves OPEN requests when source becomes productive", async () => {
    updateManyReviewMock.mockResolvedValue({ count: 2 });
    newsSourceUpdateMock.mockResolvedValue({});

    const { markFeedRunOutcome } = await import(
      "../../../utils/news-pipeline/feed-productivity"
    );
    await markFeedRunOutcome({
      sourceId: "src-1",
      feedUrl: "https://example.com/feed.xml",
      productive: true,
      shouldTrackFeedProductivity: true,
    });

    expect(updateManyReviewMock).toHaveBeenCalledWith({
      where: { sourceId: "src-1", status: "OPEN" },
      data: {
        status: "AUTO_RESOLVED_VALIDATED",
        resolvedAt: expect.any(Date),
      },
    });
  });

  it("auto-resolves OPEN requests when category becomes productive", async () => {
    updateManyReviewMock.mockResolvedValue({ count: 1 });
    sourceCategoryUpdateMock.mockResolvedValue({});

    const { markFeedRunOutcome } = await import(
      "../../../utils/news-pipeline/feed-productivity"
    );
    await markFeedRunOutcome({
      sourceId: "src-1",
      categoryId: "cat-1",
      feedUrl: "https://example.com/cat/feed.xml",
      productive: true,
      shouldTrackFeedProductivity: true,
    });

    expect(updateManyReviewMock).toHaveBeenCalledWith({
      where: { categoryId: "cat-1", status: "OPEN" },
      data: {
        status: "AUTO_RESOLVED_VALIDATED",
        resolvedAt: expect.any(Date),
      },
    });
  });

  it("does not auto-resolve when feed is not productive", async () => {
    newsSourceUpdateMock.mockResolvedValue({});

    const { markFeedRunOutcome } = await import(
      "../../../utils/news-pipeline/feed-productivity"
    );
    await markFeedRunOutcome({
      sourceId: "src-1",
      productive: false,
      shouldTrackFeedProductivity: true,
    });

    expect(updateManyReviewMock).not.toHaveBeenCalled();
  });

  it("auto-resolve is a no-op when no open requests exist", async () => {
    updateManyReviewMock.mockResolvedValue({ count: 0 });
    newsSourceUpdateMock.mockResolvedValue({});

    const { markFeedRunOutcome } = await import(
      "../../../utils/news-pipeline/feed-productivity"
    );
    await markFeedRunOutcome({
      sourceId: "src-1",
      feedUrl: "https://example.com/feed.xml",
      productive: true,
      shouldTrackFeedProductivity: true,
    });

    // updateMany was called but with count 0 — no error thrown
    expect(updateManyReviewMock).toHaveBeenCalled();
  });
});
