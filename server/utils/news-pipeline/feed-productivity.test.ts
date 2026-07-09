import { describe, expect, it, vi, beforeEach } from "vitest";

const newsSourceUpdateMock = vi.fn();
const sourceCategoryUpdateMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    newsSource: {
      update: (...args: any[]) => newsSourceUpdateMock(...args),
    },
    sourceCategory: {
      update: (...args: any[]) => sourceCategoryUpdateMock(...args),
    },
  },
}));

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

  it("marks a productive root feed and resets the consecutive non-productive counter", async () => {
    const { markFeedRunOutcome } = await import("./feed-productivity");

    await markFeedRunOutcome({
      sourceId: "src-1",
      feedUrl: "https://example.com/feed.xml",
      productive: true,
      shouldTrackFeedProductivity: true,
    });

    expect(newsSourceUpdateMock).toHaveBeenCalledWith({
      where: { id: "src-1" },
      data: expect.objectContaining({
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: 0,
        lastProductiveFeedUrl: "https://example.com/feed.xml",
      }),
    });
  });

  it("increments the consecutive non-productive counter without clearing prior productivity", async () => {
    const { markFeedRunOutcome } = await import("./feed-productivity");

    await markFeedRunOutcome({
      sourceId: "src-1",
      productive: false,
      shouldTrackFeedProductivity: true,
    });

    expect(newsSourceUpdateMock).toHaveBeenCalledWith({
      where: { id: "src-1" },
      data: {
        consecutiveNonProductiveRuns: {
          increment: 1,
        },
      },
    });
  });

  it("tracks category productivity separately from root source productivity", async () => {
    const { markFeedRunOutcome } = await import("./feed-productivity");

    await markFeedRunOutcome({
      sourceId: "src-1",
      categoryId: "cat-1",
      feedUrl: "https://example.com/category/feed.xml",
      productive: true,
      shouldTrackFeedProductivity: true,
    });

    expect(sourceCategoryUpdateMock).toHaveBeenCalledWith({
      where: { id: "cat-1" },
      data: expect.objectContaining({
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: 0,
        lastProductiveFeedUrl: "https://example.com/category/feed.xml",
      }),
    });
  });
});
