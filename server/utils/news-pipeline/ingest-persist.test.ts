import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaFindManyMock = vi.fn();
const prismaUpdateMock = vi.fn();
const prismaCreateManyMock = vi.fn();
const prismaCreateMock = vi.fn();
const prismaTransactionMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    article: {
      findMany: (...args: any[]) => prismaFindManyMock(...args),
      update: (...args: any[]) => prismaUpdateMock(...args),
      createMany: (...args: any[]) => prismaCreateManyMock(...args),
      create: (...args: any[]) => prismaCreateMock(...args),
    },
    $transaction: (...args: any[]) => prismaTransactionMock(...args),
  },
}));

const makeCandidate = (overrides: Record<string, unknown> = {}) => ({
  sourceId: "src-1",
  categoryId: null,
  sourceUrl: "https://example.com",
  canonicalUrl: "https://example.com/articles/1",
  rssGuid: "guid-1",
  title: "Example article",
  publishedAt: new Date("2026-07-08T10:00:00.000Z"),
  bodyText: "Body",
  contentHash: "hash-1",
  isPaywall: false,
  rawTags: [],
  rawSignals: [],
  reasoning: "RSS ingest",
  provenance: {
    origin: "rss" as const,
    feedUrl: "https://example.com/feed.xml",
    feedFormat: "rss" as const,
    discoveredFromCategoryFeed: false,
    sourcePageUrl: "https://example.com",
    fetchedAt: "2026-07-08T10:00:00.000Z",
  },
  ...overrides,
});

describe("persistCandidates", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaFindManyMock.mockResolvedValue([]);
    prismaUpdateMock.mockImplementation((args: any) => Promise.resolve(args));
    prismaCreateManyMock.mockResolvedValue({ count: 0 });
    prismaCreateMock.mockResolvedValue({ id: 1 });
    prismaTransactionMock.mockImplementation((promises: Promise<unknown>[]) => Promise.all(promises));
  });

  it("enriches an existing uncategorized article when category ingest finds the same article", async () => {
    prismaFindManyMock.mockResolvedValue([
      {
        id: 101,
        rssGuid: "guid-1",
        canonicalUrl: "https://example.com/articles/1",
        contentHash: "hash-1",
        categoryId: null,
        tags: [],
      },
    ]);

    const { persistCandidates } = await import("./ingest");
    const result = await persistCandidates([
      makeCandidate({
        categoryId: "cat-1",
        rawTags: ["NBA"],
      }),
    ]);

    expect(prismaTransactionMock).toHaveBeenCalledTimes(1);
    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 101 },
      data: {
        categoryId: "cat-1",
        tags: ["NBA"],
      },
    });
    expect(prismaCreateManyMock).not.toHaveBeenCalled();
    expect(result).toEqual({ inserted: 0, skipped: 1, failed: 0, enriched: 1 });
  });

  it("does not create a duplicate when the same candidate is persisted on retry", async () => {
    prismaFindManyMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 303,
          rssGuid: "guid-1",
          canonicalUrl: "https://example.com/articles/1",
          contentHash: "hash-1",
          categoryId: null,
          tags: [],
        },
      ]);
    prismaCreateManyMock.mockResolvedValue({ count: 1 });

    const { persistCandidates } = await import("./ingest");
    const firstAttempt = await persistCandidates([makeCandidate()]);
    const retryAttempt = await persistCandidates([makeCandidate()]);

    expect(firstAttempt).toEqual({ inserted: 1, skipped: 0, failed: 0, enriched: 0 });
    expect(retryAttempt).toEqual({ inserted: 0, skipped: 1, failed: 0, enriched: 0 });
    expect(prismaCreateManyMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates HTTP and HTTPS transport variants of the same article", async () => {
    prismaFindManyMock.mockResolvedValue([
      {
        id: 404,
        rssGuid: "http://example.com/articles/1",
        canonicalUrl: "http://example.com/articles/1",
        contentHash: "old-hash",
        categoryId: null,
        tags: [],
      },
    ]);

    const { persistCandidates } = await import("./ingest");
    const result = await persistCandidates([
      makeCandidate({
        rssGuid: "https://example.com/articles/1",
        canonicalUrl: "https://example.com/articles/1",
        contentHash: "new-hash",
      }),
    ]);

    expect(result).toEqual({ inserted: 0, skipped: 1, failed: 0, enriched: 0 });
    expect(prismaCreateManyMock).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing category assignment on duplicate articles", async () => {
    prismaFindManyMock.mockResolvedValue([
      {
        id: 202,
        rssGuid: "guid-1",
        canonicalUrl: "https://example.com/articles/1",
        contentHash: "hash-1",
        categoryId: "cat-existing",
        tags: ["Existing"],
      },
    ]);

    const { persistCandidates } = await import("./ingest");
    const result = await persistCandidates([
      makeCandidate({
        categoryId: "cat-new",
        rawTags: ["NBA"],
      }),
    ]);

    expect(prismaTransactionMock).not.toHaveBeenCalled();
    expect(prismaUpdateMock).not.toHaveBeenCalled();
    expect(prismaCreateManyMock).not.toHaveBeenCalled();
    expect(result).toEqual({ inserted: 0, skipped: 1, failed: 0, enriched: 0 });
  });

  it("isolates a poison candidate after batch insert failure", async () => {
    prismaCreateManyMock.mockRejectedValueOnce(Object.assign(new Error("constraint failure"), { code: "P2000" }));
    prismaCreateMock
      .mockResolvedValueOnce({ id: 1 })
      .mockRejectedValueOnce(Object.assign(new Error("invalid row"), { code: "P2000" }))
      .mockResolvedValueOnce({ id: 3 });

    const { persistCandidates } = await import("./ingest");
    const result = await persistCandidates([
      makeCandidate({ rssGuid: "guid-1", canonicalUrl: "https://example.com/1", contentHash: "hash-1" }),
      makeCandidate({ rssGuid: "guid-2", canonicalUrl: "https://example.com/2", contentHash: "hash-2" }),
      makeCandidate({ rssGuid: "guid-3", canonicalUrl: "https://example.com/3", contentHash: "hash-3" }),
    ]);

    expect(result).toEqual({ inserted: 2, skipped: 0, failed: 1, enriched: 0 });
    expect(prismaCreateMock).toHaveBeenCalledTimes(3);
  });

  it("keeps unique conflicts retry-safe during isolated fallback", async () => {
    prismaCreateManyMock.mockRejectedValueOnce(new Error("batch failed"));
    prismaCreateMock.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "P2002" }));

    const { persistCandidates } = await import("./ingest");
    const result = await persistCandidates([makeCandidate()]);

    expect(result).toEqual({ inserted: 0, skipped: 1, failed: 0, enriched: 0 });
  });
});

describe("normalizeParsedFeedEntries", () => {
  it("isolates a parser-poisoned feed item between valid entries", async () => {
    const poisoned = {
      title: "poison",
      get link() { throw new Error("broken item accessor"); },
      guid: "bad",
      pubDate: "",
      description: "",
      categories: [],
    };
    const { normalizeParsedFeedEntries } = await import("./ingest");
    const result = normalizeParsedFeedEntries([
      { title: "one", link: "https://example.com/1", guid: "1", pubDate: "", description: "", categories: [] },
      poisoned as any,
      { title: "three", link: "https://example.com/3", guid: "3", pubDate: "", description: "", categories: [] },
    ]);

    expect(result.malformed).toBe(1);
    expect(result.entries.map((entry) => entry.canonicalUrl)).toEqual([
      "https://example.com/1",
      "https://example.com/3",
    ]);
  });
});
