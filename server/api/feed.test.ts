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
    delete process.env.NUXT_PIPELINE_TERMINAL_STAGE;
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
        {
          categoryId: "category-x",
          category: {
            pathUrl: "https://example.com/section",
          },
        },
      ],
    });
    articleFindManyMock.mockResolvedValue([
      {
        id: 11,
        title: "Scoped article",
        canonicalUrl: "https://example.com/article-1",
        bodyText: "A".repeat(500),
        publicationStatus: "PUBLISHED",
        publicationReadyAt: new Date("2026-07-02T12:05:00.000Z"),
        enrichmentStatus: "ENRICHED",
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
          select: {
            categoryId: true,
            category: {
              select: {
                pathUrl: true,
              },
            },
          },
        },
      },
    });
    expect(articleFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          publicationStatus: "PUBLISHED",
          publicationStage: "agent3",
          publicationReadyAt: { not: null },
          enrichmentStatus: "ENRICHED",
          canonicalUrl: { not: null },
          title: { not: "" },
          bodyText: { not: null },
          OR: [
            { sourceId: { in: ["source-a", "source-b"] } },
            { categoryId: { in: ["category-x"] } },
            { category: { pathUrl: { in: ["https://example.com/section"] } } },
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
        sourceTargetUrl: "https://example.com/section",
        canonicalUrl: "https://example.com/article-1",
        articleDomain: "example.com",
        isExternalPublisher: false,
        bodyText: "A".repeat(500),
        categoryPathUrl: "https://example.com/section",
        date: "2026-07-02T12:00:00.000Z",
        score: 7,
        isPaywall: false,
        accessClassification: null,
        tags: ["tag-a"],
        signals: ["signal-a"],
        reasoning: "Matched active source.",
      },
    ]);
  });

  it("defensively excludes malformed legacy rows from the returned feed", async () => {
    userFindUniqueMock.mockResolvedValue({
      sourceSubscriptions: [{ sourceId: "source-a" }],
      categorySubscriptions: [],
    });
    const source = { frontPageUrl: "https://example.com", mediaName: "Example" };
    const base = {
      title: "Published article",
      date: new Date("2026-07-02T12:00:00.000Z"),
      score: 7,
      isPaywall: false,
        enrichmentOutcome: null,
        tags: [],
      signals: [],
      reasoning: null,
      source,
      category: null,
    };
    articleFindManyMock.mockResolvedValue([
      { id: 1, ...base, canonicalUrl: "https://example.com/published", bodyText: "A".repeat(500) },
      { id: 2, ...base, canonicalUrl: null, bodyText: "A".repeat(500) },
      { id: 3, ...base, canonicalUrl: "https://example.com/empty", bodyText: "   " },
      { id: 4, ...base, canonicalUrl: "https://example.com/missing-body", bodyText: null },
      { id: 5, ...base, canonicalUrl: "https://example.com/short-body", bodyText: "A".repeat(499) },
    ]);

    const mod = await import("./feed");
    const result = await mod.default({} as any);

    expect(result.map((article: { id: number }) => article.id)).toEqual([1]);
    expect(articleFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        publicationStatus: "PUBLISHED",
        publicationStage: "agent3",
        publicationReadyAt: { not: null },
        enrichmentStatus: "ENRICHED",
        canonicalUrl: { not: null },
        title: { not: "" },
        bodyText: { not: null },
      }),
    }));
  });

  it("uses the configured terminal stage so legacy agent3 rows are excluded when agent4 is terminal", async () => {
    process.env.NUXT_PIPELINE_TERMINAL_STAGE = "agent4";
    userFindUniqueMock.mockResolvedValue({
      sourceSubscriptions: [{ sourceId: "source-a" }],
      categorySubscriptions: [],
    });
    articleFindManyMock.mockResolvedValue([]);

    const mod = await import("./feed");
    await mod.default({} as any);

    expect(articleFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        publicationStatus: "PUBLISHED",
        publicationStage: "agent4",
      }),
    }));
  });

  it("also matches articles by subscribed category pathUrl to tolerate legacy category-id drift", async () => {
    userFindUniqueMock.mockResolvedValue({
      sourceSubscriptions: [],
      categorySubscriptions: [
        {
          categoryId: "category-a",
          category: {
            pathUrl: "https://bleacherreport.com/nba",
          },
        },
      ],
    });
    articleFindManyMock.mockResolvedValue([]);

    const mod = await import("./feed");
    await mod.default({} as any);

    expect(articleFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          publicationStatus: "PUBLISHED",
          publicationStage: "agent3",
          publicationReadyAt: { not: null },
          enrichmentStatus: "ENRICHED",
          canonicalUrl: { not: null },
          title: { not: "" },
          bodyText: { not: null },
          OR: [
            { categoryId: { in: ["category-a"] } },
            { category: { pathUrl: { in: ["https://bleacherreport.com/nba"] } } },
          ],
        },
      }),
    );
  });
});
