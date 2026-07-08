import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaFindManyMock = vi.fn();
const prismaUpdateMock = vi.fn();
const prismaCreateManyMock = vi.fn();
const prismaTransactionMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    article: {
      findMany: (...args: any[]) => prismaFindManyMock(...args),
      update: (...args: any[]) => prismaUpdateMock(...args),
      createMany: (...args: any[]) => prismaCreateManyMock(...args),
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
    expect(result).toEqual({ inserted: 0, skipped: 1, failed: 0 });
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
    expect(result).toEqual({ inserted: 0, skipped: 1, failed: 0 });
  });
});
