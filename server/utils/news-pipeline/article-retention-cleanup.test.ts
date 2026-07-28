import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const articleFindMany = vi.fn();
const bookmarkGroupBy = vi.fn();
const ratingGroupBy = vi.fn();
const readActivityGroupBy = vi.fn();
const articleDeleteMany = vi.fn();
const logAgentScanMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    article: {
      findMany: (...args: any[]) => articleFindMany(...args),
      deleteMany: (...args: any[]) => articleDeleteMany(...args),
    },
    bookmark: { groupBy: (...args: any[]) => bookmarkGroupBy(...args) },
    articleRating: { groupBy: (...args: any[]) => ratingGroupBy(...args) },
    userReadActivity: { groupBy: (...args: any[]) => readActivityGroupBy(...args) },
  },
}));

vi.mock("./log", () => ({
  logAgentScan: (...args: any[]) => logAgentScanMock(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-27T12:00:00Z");
const OLD_DATE = new Date("2026-07-10T12:00:00Z"); // 17 days old → past 7d cutoff
const RECENT_DATE = new Date("2026-07-25T12:00:00Z"); // 2 days old → within 7d cutoff

function makeArticle(overrides: Partial<{
  id: number;
  title: string;
  sourceId: string;
  sourceUrl: string | null;
  publishedAt: Date | null;
  createdAt: Date;
}> = {}) {
  // NOTE: publishedAt may legitimately be null, so we only fall back to
  // OLD_DATE when the caller did not specify the key at all (undefined).
  return {
    id: overrides.id ?? 1,
    title: overrides.title ?? "Old article",
    sourceId: overrides.sourceId ?? "src-1",
    sourceUrl: overrides.sourceUrl ?? "https://example.com/a/1",
    publishedAt: overrides.publishedAt === undefined ? OLD_DATE : overrides.publishedAt,
    createdAt: overrides.createdAt ?? OLD_DATE,
  };
}

// Default: one old, unprotected candidate.
function defaultCandidateFindMany() {
  articleFindMany.mockImplementation(async (args: any) => {
    // publishedAt branch
    if (args.where.publishedAt && args.where.publishedAt.lt) {
      return [makeArticle({ id: 1 })];
    }
    // createdAt branch (publishedAt: null)
    return [];
  });
  bookmarkGroupBy.mockResolvedValue([]);
  ratingGroupBy.mockResolvedValue([]);
  readActivityGroupBy.mockResolvedValue([]);
  articleDeleteMany.mockResolvedValue({ count: 1 });
}

async function loadFn() {
  const mod = await import("./article-retention-cleanup");
  return mod.processOldArticleRetentionCleanup;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("processOldArticleRetentionCleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    logAgentScanMock.mockResolvedValue(undefined);
    defaultCandidateFindMany();
  });

  // -- eligibility ---------------------------------------------------------

  it("marks an old, unprotected article as eligible for deletion in dry-run", async () => {
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.inspected).toBe(1);
    expect(result.eligibleForDeletion).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.protected).toBe(0);
    expect(result.sampleDeletedOrWouldDelete).toHaveLength(1);
    expect(result.sampleDeletedOrWouldDelete[0]!.id).toBe("1");
  });

  it("default cutoff matches the shared article retention policy", async () => {
    const fn = await loadFn();
    const { getArticleRetentionCutoff } = await import("./article-retention-policy");
    const now = new Date("2026-07-28T12:00:00Z");

    const result = await fn({ dryRun: true, now });

    // The cleanup's reported cutoff should match the shared policy's cutoff
    expect(result.cutoff).toBe(getArticleRetentionCutoff(now).toISOString());
  });

  it("skips recent articles (within the retention window)", async () => {
    articleFindMany.mockImplementation(async () => []);
    bookmarkGroupBy.mockResolvedValue([]);
    ratingGroupBy.mockResolvedValue([]);
    readActivityGroupBy.mockResolvedValue([]);

    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    expect(result.inspected).toBe(0);
    expect(result.eligibleForDeletion).toBe(0);
  });

  // -- protection by Bookmark (saved / read-later) -------------------------

  it("protects articles with a Bookmark (saved/read-later) relation", async () => {
    articleFindMany.mockImplementation(async (args: any) => {
      if (args.where.publishedAt) return [makeArticle({ id: 5 })];
      return [];
    });
    bookmarkGroupBy.mockResolvedValue([{ articleId: 5, _count: { _all: 1 } }]);
    ratingGroupBy.mockResolvedValue([]);
    readActivityGroupBy.mockResolvedValue([]);

    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
    expect(result.protectedReasons.bookmark).toBe(1);
    expect(result.skippedReasons.protected).toBe(1);
    expect(result.sampleDeletedOrWouldDelete).toHaveLength(0);
  });

  // -- protection by ArticleRating (favorite-like) -------------------------

  it("protects articles with an ArticleRating (favorite-like) relation", async () => {
    articleFindMany.mockImplementation(async (args: any) => {
      if (args.where.publishedAt) return [makeArticle({ id: 7 })];
      return [];
    });
    bookmarkGroupBy.mockResolvedValue([]);
    ratingGroupBy.mockResolvedValue([{ articleId: 7, _count: { _all: 1 } }]);
    readActivityGroupBy.mockResolvedValue([]);

    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
    expect(result.protectedReasons.rating).toBe(1);
  });

  // -- protection by UserReadActivity (read/interacted in v1) ---------------

  it("protects articles with a UserReadActivity (read/interacted) relation", async () => {
    articleFindMany.mockImplementation(async (args: any) => {
      if (args.where.publishedAt) return [makeArticle({ id: 9 })];
      return [];
    });
    bookmarkGroupBy.mockResolvedValue([]);
    ratingGroupBy.mockResolvedValue([]);
    readActivityGroupBy.mockResolvedValue([{ articleId: 9, _count: { _all: 3 } }]);

    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
    expect(result.protectedReasons.readActivity).toBe(1);
  });

  it("counts each protection relation separately even when multiple protect the same article", async () => {
    articleFindMany.mockImplementation(async (args: any) => {
      if (args.where.publishedAt) return [makeArticle({ id: 11 })];
      return [];
    });
    bookmarkGroupBy.mockResolvedValue([{ articleId: 11, _count: { _all: 1 } }]);
    ratingGroupBy.mockResolvedValue([{ articleId: 11, _count: { _all: 1 } }]);
    readActivityGroupBy.mockResolvedValue([{ articleId: 11, _count: { _all: 1 } }]);

    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    // Protected once (unique article) but counted in all three reasons.
    expect(result.protected).toBe(1);
    expect(result.protectedReasons.bookmark).toBe(1);
    expect(result.protectedReasons.rating).toBe(1);
    expect(result.protectedReasons.readActivity).toBe(1);
    expect(result.eligibleForDeletion).toBe(0);
  });

  // -- null publishedAt falls back to createdAt -----------------------------

  it("falls back to createdAt when publishedAt is null", async () => {
    articleFindMany.mockImplementation(async (args: any) => {
      // publishedAt branch → none
      if (args.where.publishedAt) return [];
      // createdAt branch → one old article with null publishedAt
      return [
        makeArticle({
          id: 2,
          publishedAt: null,
          createdAt: OLD_DATE,
          sourceUrl: "https://example.com/a/2",
        }),
      ];
    });

    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    expect(result.inspected).toBe(1);
    expect(result.eligibleForDeletion).toBe(1);
    expect(result.sampleDeletedOrWouldDelete).toHaveLength(1);
    const sample = result.sampleDeletedOrWouldDelete[0]!;
    expect(sample.publishedAt).toBeNull();
    expect(sample.effectiveDate).toBe(OLD_DATE.toISOString());
  });

  // -- dry-run does not delete ---------------------------------------------

  it("dryRun=true never calls article.deleteMany", async () => {
    const fn = await loadFn();
    await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    expect(articleDeleteMany).not.toHaveBeenCalled();
  });

  // -- dryRun=false deletes only selected ids ------------------------------

  it("dryRun=false deletes only the eligible ids via bounded deleteMany", async () => {
    articleFindMany.mockImplementation(async (args: any) => {
      if (args.where.publishedAt) return [
        makeArticle({ id: 1 }),
        makeArticle({ id: 2, sourceUrl: "https://example.com/a/2" }),
      ];
      return [];
    });
    bookmarkGroupBy.mockResolvedValue([{ articleId: 2, _count: { _all: 1 } }]);
    ratingGroupBy.mockResolvedValue([]);
    readActivityGroupBy.mockResolvedValue([]);
    articleDeleteMany.mockResolvedValue({ count: 1 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, olderThanDays: 7, now: NOW });

    expect(result.dryRun).toBe(false);
    expect(result.eligibleForDeletion).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.protected).toBe(1);
    expect(articleDeleteMany).toHaveBeenCalledTimes(1);
    expect(articleDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [1] } },
      }),
    );
  });

  it("reports a deleteCountMismatch when deleteMany count differs from selected", async () => {
    articleFindMany.mockImplementation(async (args: any) => {
      if (args.where.publishedAt) return [makeArticle({ id: 1 })];
      return [];
    });
    articleDeleteMany.mockResolvedValue({ count: 0 }); // nothing actually deleted

    const fn = await loadFn();
    const result = await fn({ dryRun: false, olderThanDays: 7, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.skippedReasons.deleteCountMismatch).toBe(1);
  });

  // -- limit clamping ------------------------------------------------------

  it("clamps limit to max 500", async () => {
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, limit: 99999, now: NOW });

    expect(result.limit).toBe(500);
    // findMany take should be 500
    const takeArg = articleFindMany.mock.calls[0]![0].take;
    expect(takeArg).toBe(500);
  });

  it("clamps limit to min 1", async () => {
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, limit: 0, now: NOW });

    expect(result.limit).toBe(1);
  });

  it("uses default limit 100 when not provided", async () => {
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    expect(result.limit).toBe(100);
  });

  it("clamps olderThanDays to a sane range", async () => {
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 0, now: NOW });

    expect(result.olderThanDays).toBe(1); // min 1
  });

  // -- result shape / payload safety ---------------------------------------

  it("never exposes raw bodyText or large payloads in the result", async () => {
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    const sample = result.sampleDeletedOrWouldDelete[0]!;
    expect(sample).not.toHaveProperty("bodyText");
    expect(sample).not.toHaveProperty("contentHash");
    expect(sample).not.toHaveProperty("reasoning");
    expect(Object.keys(sample).sort()).toEqual(
      ["createdAt", "effectiveDate", "id", "publishedAt", "sourceId", "title", "url"].sort(),
    );
  });

  it("caps sampleDeletedOrWouldDelete at 20 entries", async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      makeArticle({ id: i + 1, sourceUrl: `https://example.com/a/${i + 1}` }),
    );
    articleFindMany.mockImplementation(async (args: any) => {
      if (args.where.publishedAt) return many.slice(0, args.take);
      return [];
    });

    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, limit: 50, now: NOW });

    expect(result.inspected).toBe(50);
    expect(result.eligibleForDeletion).toBe(50);
    expect(result.sampleDeletedOrWouldDelete.length).toBeLessThanOrEqual(20);
  });

  it("aggregates bySource for eligible articles", async () => {
    articleFindMany.mockImplementation(async (args: any) => {
      if (args.where.publishedAt) return [
        makeArticle({ id: 1, sourceId: "src-A" }),
        makeArticle({ id: 2, sourceId: "src-A" }),
        makeArticle({ id: 3, sourceId: "src-B" }),
      ];
      return [];
    });

    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 7, now: NOW });

    expect(result.bySource).toEqual(
      expect.arrayContaining([
        { sourceId: "src-A", count: 2 },
        { sourceId: "src-B", count: 1 },
      ]),
    );
  });

  // -- failure logging -----------------------------------------------------

  it("logs ARTICLE_RETENTION_CLEANUP_FAILED and re-throws on DB error", async () => {
    articleFindMany.mockRejectedValue(new Error("DB connection lost"));

    const fn = await loadFn();
    await expect(fn({ dryRun: false, olderThanDays: 7, now: NOW })).rejects.toThrow(
      "DB connection lost",
    );

    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ARTICLE_RETENTION_CLEANUP_FAILED" }),
    );
  });
});
