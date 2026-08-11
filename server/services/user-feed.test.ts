import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadUserFeed, countScopedPublishableArticles } from "./user-feed";

const makeDb = () => ({
  user: { findUnique: vi.fn() },
  article: { findMany: vi.fn() },
});

const publishableArticle = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  title: "Published",
  canonicalUrl: "https://example.com/1",
  date: new Date("2026-08-01T00:00:00.000Z"),
  score: 5,      isPaywall: false,
      accessClassification: null,
      tags: [],
      signals: [],
  reasoning: null,
  bodyText: "A".repeat(600),
  source: { frontPageUrl: "https://example.com", mediaName: "Example" },
  category: null,
  ...overrides,
});

describe("shared user-feed service", () => {
  beforeEach(() => {
    delete process.env.NUXT_PIPELINE_TERMINAL_STAGE;
  });

  it("returns an empty feed when the user has no active subscriptions", async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ sourceSubscriptions: [], categorySubscriptions: [] });
    await expect(loadUserFeed(db, "user-1")).resolves.toEqual([]);
    expect(db.article.findMany).not.toHaveBeenCalled();
  });

  it("queries only subscription-scoped publishable articles and maps output", async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({
      sourceSubscriptions: [{ sourceId: "source-a" }],
      categorySubscriptions: [{ categoryId: "category-x", category: { pathUrl: "https://example.com/x" } }],
    });
    db.article.findMany.mockResolvedValue([publishableArticle()]);
    const result = await loadUserFeed(db, "user-1");
    expect(db.article.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        publicationStatus: "PUBLISHED",
        publicationStage: "agent3",
        publicationReadyAt: { not: null },
        enrichmentStatus: "ENRICHED",
        OR: [
          { sourceId: { in: ["source-a"] } },
          { categoryId: { in: ["category-x"] } },
          { category: { pathUrl: { in: ["https://example.com/x"] } } },
        ],
      }),
    }));
    expect(result).toEqual([{
      id: 1,
      title: "Published",
      source: "Example",
      sourceUrl: "https://example.com",
      sourceTargetUrl: "https://example.com",
      canonicalUrl: "https://example.com/1",
      articleDomain: "example.com",
      isExternalPublisher: false,
      categoryPathUrl: null,
      date: "2026-08-01T00:00:00.000Z",
      score: 5,
      isPaywall: false,
      accessClassification: null,
      tags: [],
      signals: [],
      reasoning: "",
      bodyText: "A".repeat(600),
    }]);
  });

  it("marks a canonical article URL on another domain without changing source attribution", async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ sourceSubscriptions: [{ sourceId: "source-a" }], categorySubscriptions: [] });
    db.article.findMany.mockResolvedValue([
      publishableArticle({
        canonicalUrl: "https://publisher.example/story/1",
        source: { frontPageUrl: "https://aggregator.example", mediaName: "Aggregator" },
      }),
    ]);

    const [article] = await loadUserFeed(db, "user-1");

    expect(article).toMatchObject({
      source: "Aggregator",
      articleDomain: "publisher.example",
      isExternalPublisher: true,
    });
  });

  it("maps only validated structured access classifications and never exposes raw evidence", async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ sourceSubscriptions: [{ sourceId: "source-a" }], categorySubscriptions: [] });
    db.article.findMany.mockResolvedValue([
      publishableArticle({ id: 1, isPaywall: true, enrichmentOutcome: { access: { classification: "PAYWALL_BLOCKED", evidenceCodes: ["secret raw evidence"] } } }),
      publishableArticle({ id: 2, isPaywall: true, enrichmentOutcome: { access: { classification: "METERED_OR_DECLARED", evidenceCodes: ["secret raw evidence"] } } }),
      publishableArticle({ id: 3, isPaywall: true, enrichmentOutcome: { access: { classification: "not-valid", rawHtml: "secret" } } }),
    ]);
    const result = await loadUserFeed(db, "user-1");
    expect(result.map((article: { accessClassification: unknown }) => article.accessClassification)).toEqual([
      "PAYWALL_BLOCKED",
      "METERED_OR_DECLARED",
      null,
    ]);
    expect(JSON.stringify(result)).not.toContain("secret raw evidence");
    expect(JSON.stringify(result)).not.toContain("rawHtml");
  });

  it("defensively excludes malformed legacy rows from the returned feed", async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ sourceSubscriptions: [{ sourceId: "source-a" }], categorySubscriptions: [] });
    db.article.findMany.mockResolvedValue([
      publishableArticle({ id: 1 }),
      publishableArticle({ id: 2, canonicalUrl: null }),
      publishableArticle({ id: 3, bodyText: "   " }),
    ]);
    const result = await loadUserFeed(db, "user-1");
    expect(result.map((article: { id: number }) => article.id)).toEqual([1]);
  });

  it("counts publishable articles with cursor paging across multiple pages", async () => {
    const db = makeDb();
    db.article.findMany.mockImplementation(async (args: any) => {
      const cursor = args.cursor?.id ?? 0;
      if (cursor === 0) return Array.from({ length: 500 }, (_, index) => publishableArticle({ id: index + 1 }));
      if (cursor === 500) return Array.from({ length: 250 }, (_, index) => publishableArticle({ id: 501 + index }));
      return [];
    });
    const scope = { sourceIds: ["source-a"], categoryIds: [], categoryPathUrls: [] };
    const count = await countScopedPublishableArticles(db, scope, new Date());
    expect(db.article.findMany).toHaveBeenCalledTimes(2);
    expect(count).toBe(750);
  });

  it("returns zero when the scope has no predicates", async () => {
    const db = makeDb();
    const scope = { sourceIds: [], categoryIds: [], categoryPathUrls: [] };
    await expect(countScopedPublishableArticles(db, scope, new Date())).resolves.toBe(0);
    expect(db.article.findMany).not.toHaveBeenCalled();
  });
});
