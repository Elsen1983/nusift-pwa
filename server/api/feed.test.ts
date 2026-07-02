import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserIdMock = vi.fn();
const userSourceSubscriptionFindManyMock = vi.fn();
const userCategorySubscriptionFindManyMock = vi.fn();
const articleFindManyMock = vi.fn();

vi.mock("../utils/require-user", () => ({
  requireUserId: requireUserIdMock,
}));

vi.mock("../utils/prisma", () => ({
  prisma: {
    userSourceSubscription: {
      findMany: userSourceSubscriptionFindManyMock,
    },
    userCategorySubscription: {
      findMany: userCategorySubscriptionFindManyMock,
    },
    article: {
      findMany: articleFindManyMock,
    },
  },
}));

describe("/api/feed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireUserIdMock.mockReturnValue("user-1");
    vi.stubGlobal("defineEventHandler", (handler: any) => handler);
  });

  it("returns an empty array when the user has no active subscriptions", async () => {
    userSourceSubscriptionFindManyMock.mockResolvedValue([]);
    userCategorySubscriptionFindManyMock.mockResolvedValue([]);

    const mod = await import("./feed");
    const result = await mod.default({} as any);

    expect(result).toEqual([]);
    expect(articleFindManyMock).not.toHaveBeenCalled();
  });

  it("queries articles only for the active source and category subscriptions of the current user", async () => {
    userSourceSubscriptionFindManyMock.mockResolvedValue([
      { sourceId: "source-a" },
      { sourceId: "source-b" },
    ]);
    userCategorySubscriptionFindManyMock.mockResolvedValue([
      { categoryId: "category-x" },
    ]);
    articleFindManyMock.mockResolvedValue([
      {
        id: 11,
        title: "Scoped article",
        date: new Date("2026-07-02T12:00:00.000Z"),
        score: 7,
        isPaywall: false,
        tags: ["tag-a"],
        signals: ["signal-a"],
        reasoning: "Matched active source.",
        source: {
          frontPageUrl: "https://example.com",
          mediaName: "Example",
        },
      },
    ]);

    const mod = await import("./feed");
    const result = await mod.default({} as any);

    expect(userSourceSubscriptionFindManyMock).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        isActive: true,
      },
      select: {
        sourceId: true,
      },
    });
    expect(userCategorySubscriptionFindManyMock).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        isActive: true,
      },
      select: {
        categoryId: true,
      },
    });
    expect(articleFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { sourceId: { in: ["source-a", "source-b"] } },
            { categoryId: { in: ["category-x"] } },
          ],
        },
      }),
    );
    expect(result).toEqual([
      {
        id: 11,
        title: "Scoped article",
        source: "Example",
        sourceUrl: "https://example.com",
        date: "2026-07-02T12:00:00.000Z",
        score: 7,
        isPaywall: false,
        tags: ["tag-a"],
        signals: ["signal-a"],
        reasoning: "Matched active source.",
      },
    ]);
  });
});
