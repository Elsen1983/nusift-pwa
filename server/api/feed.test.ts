import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserIdMock = vi.fn();
const userFindUniqueMock = vi.fn();
const articleFindManyMock = vi.fn();

vi.mock("../utils/require-user", () => ({
  requireUserId: requireUserIdMock,
}));

vi.mock("../utils/prisma", () => ({
  prisma: {
    user: {
      findUnique: userFindUniqueMock,
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
    userFindUniqueMock.mockResolvedValue({
      sourceSubscriptions: [],
      categorySubscriptions: [],
    });

    const mod = await import("./feed");
    const result = await mod.default({} as any);

    expect(result).toEqual([]);
    expect(articleFindManyMock).not.toHaveBeenCalled();
  });

  it("queries articles only for the active source and category subscriptions of the current user", async () => {
    userFindUniqueMock.mockResolvedValue({
      sourceSubscriptions: [
        { sourceId: "source-a" },
        { sourceId: "source-b" },
      ],
      categorySubscriptions: [
        { categoryId: "category-x" },
      ],
    });
    articleFindManyMock.mockResolvedValue([
      {
        id: 11,
        title: "Scoped article",
        canonicalUrl: "https://example.com/article-1",
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
        category: {
          pathUrl: "https://example.com/section",
        },
      },
    ]);

    const mod = await import("./feed");
    const result = await mod.default({} as any);

    expect(userFindUniqueMock).toHaveBeenCalledWith({
      where: {
        id: "user-1",
      },
      select: {
        sourceSubscriptions: {
          where: { isActive: true },
          select: { sourceId: true },
        },
        categorySubscriptions: {
          where: { isActive: true },
          select: { categoryId: true },
        },
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
        canonicalUrl: "https://example.com/article-1",
        categoryPathUrl: "https://example.com/section",
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
