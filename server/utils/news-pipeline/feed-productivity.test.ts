import { describe, expect, it, vi, beforeEach } from "vitest";

const newsSourceFindUniqueMock = vi.fn();
const newsSourceUpdateManyMock = vi.fn();
const sourceCategoryFindUniqueMock = vi.fn();
const sourceCategoryUpdateManyMock = vi.fn();
const feedReviewUpdateManyMock = vi.fn();
const logAgentScanMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    newsSource: {
      findUnique: (...args: any[]) => newsSourceFindUniqueMock(...args),
      updateMany: (...args: any[]) => newsSourceUpdateManyMock(...args),
    },
    sourceCategory: {
      findUnique: (...args: any[]) => sourceCategoryFindUniqueMock(...args),
      updateMany: (...args: any[]) => sourceCategoryUpdateManyMock(...args),
    },
    feedReviewRequest: {
      updateMany: (...args: any[]) => feedReviewUpdateManyMock(...args),
    },
  },
}));

vi.mock("./log", () => ({
  logAgentScan: (...args: any[]) => logAgentScanMock(...args),
}));

const baseRow = (overrides: Record<string, unknown> = {}) => ({
  currentFeedProductive: false,
  consecutiveNonProductiveRuns: 0,
  lastProductiveFeedUrl: null,
  lastProductiveAt: null,
  nextRetryAt: null,
  feedProductivityVersion: 0,
  ...overrides,
});

describe("getFeedProductivityResetData", () => {
  it("resets productivity state when the feed URL changes", async () => {
    const { getFeedProductivityResetData } = await import("./feed-productivity");

    expect(
      getFeedProductivityResetData(
        "https://example.com/feed.xml",
        "https://example.com/other-feed.xml",
      ),
    ).toEqual({
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
    });
  });

  it("does not reset when the feed URL stays the same after normalization", async () => {
    const { getFeedProductivityResetData } = await import("./feed-productivity");

    expect(
      getFeedProductivityResetData(
        "https://example.com/feed.xml/",
        "https://example.com/feed.xml",
      ),
    ).toEqual({});
  });
});

describe("markFeedRunOutcome", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("marks a productive root feed, resets the streak, and CAS-writes with the read version", async () => {
    const { markFeedRunOutcome } = await import("./feed-productivity");
    newsSourceFindUniqueMock.mockResolvedValue(baseRow({ feedProductivityVersion: 4 }));
    newsSourceUpdateManyMock.mockResolvedValue({ count: 1 });

    await markFeedRunOutcome({
      sourceId: "src-1",
      feedUrl: "https://example.com/feed.xml",
      feedRunOutcomeKind: "productive",
      shouldTrackFeedProductivity: true,
    });

    expect(newsSourceUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "src-1", feedProductivityVersion: 4 },
      data: expect.objectContaining({
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: 0,
        lastProductiveFeedUrl: "https://example.com/feed.xml",
        feedProductivityVersion: { increment: 1 },
      }),
    });
    expect(feedReviewUpdateManyMock).toHaveBeenCalled();
  });

  it("increments the consecutive non-productive counter without clearing prior productivity", async () => {
    const { markFeedRunOutcome } = await import("./feed-productivity");
    newsSourceFindUniqueMock.mockResolvedValue(baseRow({ currentFeedProductive: true }));
    newsSourceUpdateManyMock.mockResolvedValue({ count: 1 });

    await markFeedRunOutcome({
      sourceId: "src-1",
      feedRunOutcomeKind: "nonproductive",
      shouldTrackFeedProductivity: true,
    });

    expect(newsSourceUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "src-1", feedProductivityVersion: 0 },
      data: expect.objectContaining({
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: 1,
      }),
    });
    expect(feedReviewUpdateManyMock).not.toHaveBeenCalled();
  });

  it("tracks category productivity separately from root source productivity", async () => {
    const { markFeedRunOutcome } = await import("./feed-productivity");
    sourceCategoryFindUniqueMock.mockResolvedValue(baseRow());
    sourceCategoryUpdateManyMock.mockResolvedValue({ count: 1 });

    await markFeedRunOutcome({
      sourceId: "src-1",
      categoryId: "cat-1",
      feedUrl: "https://example.com/category/feed.xml",
      feedRunOutcomeKind: "productive",
      shouldTrackFeedProductivity: true,
    });

    expect(sourceCategoryUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "cat-1", feedProductivityVersion: 0 },
      data: expect.objectContaining({
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: 0,
        lastProductiveFeedUrl: "https://example.com/category/feed.xml",
      }),
    });
    expect(newsSourceUpdateManyMock).not.toHaveBeenCalled();
  });

  it("logs a diagnostic and does not throw on a CAS write conflict", async () => {
    const { markFeedRunOutcome } = await import("./feed-productivity");
    newsSourceFindUniqueMock.mockResolvedValue(baseRow({ feedProductivityVersion: 2 }));
    newsSourceUpdateManyMock.mockResolvedValue({ count: 0 });

    await expect(markFeedRunOutcome({
      sourceId: "src-1",
      feedRunOutcomeKind: "productive",
      shouldTrackFeedProductivity: true,
    })).resolves.toBeUndefined();

    expect(logAgentScanMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "FEED_PRODUCTIVITY_CAS_CONFLICT",
      sourceId: "src-1",
    }));
    expect(feedReviewUpdateManyMock).not.toHaveBeenCalled();
  });

  it("does nothing when the target row no longer exists", async () => {
    const { markFeedRunOutcome } = await import("./feed-productivity");
    newsSourceFindUniqueMock.mockResolvedValue(null);

    await markFeedRunOutcome({
      sourceId: "src-missing",
      feedRunOutcomeKind: "productive",
      shouldTrackFeedProductivity: true,
    });

    expect(newsSourceUpdateManyMock).not.toHaveBeenCalled();
  });

  it("does not read or write when feed-productivity tracking is disabled for this run", async () => {
    const { markFeedRunOutcome } = await import("./feed-productivity");

    await markFeedRunOutcome({
      sourceId: "src-1",
      feedRunOutcomeKind: "productive",
      shouldTrackFeedProductivity: false,
    });

    expect(newsSourceFindUniqueMock).not.toHaveBeenCalled();
    expect(newsSourceUpdateManyMock).not.toHaveBeenCalled();
  });
});
