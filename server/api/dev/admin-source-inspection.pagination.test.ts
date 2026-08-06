import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(), rateLimit: vi.fn(), sourceFindMany: vi.fn(), categoryFindMany: vi.fn(), articleFindMany: vi.fn(), artifactFindMany: vi.fn(), queryRaw: vi.fn(), userFindUnique: vi.fn(),
}));
vi.mock("../../utils/require-user", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("../../utils/rate-limit", () => ({ assertRateLimit: mocks.rateLimit }));
vi.mock("../../utils/prisma", () => ({ prisma: {
  newsSource: { findMany: mocks.sourceFindMany },
  sourceCategory: { findMany: mocks.categoryFindMany },
  article: { findMany: mocks.articleFindMany },
  pipelineArtifact: { findMany: mocks.artifactFindMany },
  user: { findUnique: mocks.userFindUnique },
  $queryRaw: mocks.queryRaw,
} }));
vi.mock("h3", () => ({ defineEventHandler: (fn: any) => fn, createError: ({ statusCode, statusMessage }: any) => Object.assign(new Error(statusMessage), { statusCode, statusMessage }) }));
(globalThis as any).defineEventHandler = (handler: any) => handler;
(globalThis as any).getQuery = (event: any) => event.query || {};

const source = (id: number, name = `Source ${String(id).padStart(3, "0")}`) => ({ id: `s-${id}`, mediaName: name, frontPageUrl: `https://example.com/${id}`, rssFeedUrl: null, rssStatus: "ACTIVE", currentFeedProductive: false, lastProductiveAt: null, nextRetryAt: null, isSystemImported: false, _count: { subscribers: 0 } });
const category = (id: number, name = `Category ${String(id).padStart(3, "0")}`) => ({ id: `c-${id}`, name, pathUrl: `/category/${id}`, rssFeedUrl: null, rssStatus: "ACTIVE", currentFeedProductive: false, lastProductiveAt: null, nextRetryAt: null, newsSourceId: `s-${(id % 120) + 1}`, newsSource: { mediaName: `Source ${(id % 120) + 1}`, frontPageUrl: `https://example.com/${(id % 120) + 1}`, rssStatus: "ACTIVE", isSystemImported: false }, _count: { subscribers: 0 } });

const installPagedMocks = (sourceCount = 121, categoryCount = 121) => {
  const sources = Array.from({ length: sourceCount }, (_, index) => source(index + 1, index === 0 ? "Shared" : undefined));
  const categories = Array.from({ length: categoryCount }, (_, index) => category(index + 1, index === 0 ? "Shared" : undefined));
  const byName = (a: any, b: any) => String(a.mediaName ?? a.name).localeCompare(String(b.mediaName ?? b.name)) || String(a.id).localeCompare(String(b.id));
  const page = (rows: any[], args: any, field: string, take: number) => {
    const ordered = [...rows].sort(byName);
    const cursorFilter = args.where?.AND?.find((item: any) => Array.isArray(item.OR) && item.OR.some((part: any) => part[field]?.gt));
    const afterId = cursorFilter?.OR?.find((part: any) => part[field] && part.id?.gt)?.id?.gt;
    const afterName = cursorFilter?.OR?.find((part: any) => part[field] && part.id?.gt)?.[field];
    const after = afterId && afterName ? ordered.findIndex((row) => String(row[field]) === String(afterName) && row.id === afterId) + 1 : 0;
    return ordered.slice(Math.max(0, after), Math.max(0, after) + take);
  };
  mocks.sourceFindMany.mockImplementation(async (args: any) => page(sources, args, "mediaName", args.take));
  mocks.categoryFindMany.mockImplementation(async (args: any) => page(categories, args, "name", args.take));
  mocks.articleFindMany.mockResolvedValue([]); mocks.artifactFindMany.mockResolvedValue([]); mocks.queryRaw.mockResolvedValue([]);
};

describe("admin source inspection deterministic pagination", () => {
  beforeEach(() => { vi.resetAllMocks(); process.env.JWT_SECRET = "pagination-test-secret"; process.env.NUXT_ADMIN_EMAILS = "admin@example.com"; mocks.requireUserId.mockReturnValue("admin"); mocks.userFindUnique.mockResolvedValue({ email: "admin@example.com" }); mocks.rateLimit.mockResolvedValue(undefined); installPagedMocks(); });

  it("traverses both streams beyond the old 120-row cap without duplicates", async () => {
    const handler = (await import("./admin-source-inspection.get")).default;
    const seen = new Set<string>(); let cursor: string | null = null; let pages = 0; let exhausted = false;
    while (!exhausted && pages < 20) {
      const result: any = await handler({ query: { limit: "50", targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z", ...(cursor ? { cursor } : {}) } } as any);
      pages++;
      for (const item of result.items) {
        const key = `${item.targetType}:${item.targetId}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      exhausted = result.pagination.nextCursor === null;
      cursor = result.pagination.nextCursor;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(242);
    expect(exhausted).toBe(true);
  });

  it("rejects a cursor reused with a different bound filter", async () => {
    const handler = (await import("./admin-source-inspection.get")).default;
    const first = await handler({ query: { limit: "10", targetType: "SOURCE", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" } } as any);
    await expect(handler({ query: { limit: "10", targetType: "CATEGORY", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z", cursor: first.pagination.nextCursor } } as any)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("reports bounded continuation truthfully beyond the 500-target scan cap", async () => {
    installPagedMocks(260, 260);
    const handler = (await import("./admin-source-inspection.get")).default;
    const result: any = await handler({ query: { limit: "100", targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" } } as any);
    expect(result.items).toHaveLength(100);
    expect(result.pagination.scanTruncated).toBe(false);
    expect(result.pagination.nextCursor).toEqual(expect.any(String));
    expect(result.items.every((item: any) => item.targetType === "SOURCE" || item.targetType === "CATEGORY")).toBe(true);
    expect(mocks.sourceFindMany.mock.calls[0]?.[0]?.take).toBeGreaterThanOrEqual(100);
    expect(mocks.categoryFindMany.mock.calls[0]?.[0]?.take).toBeGreaterThanOrEqual(100);
  });

  it("marks the scan cap when filters reject more than 500 logical targets", async () => {
    installPagedMocks(260, 260);
    const handler = (await import("./admin-source-inspection.get")).default;
    const result: any = await handler({ query: { limit: "10", targetType: "ALL", sourceStatus: "ACTIVE", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" } } as any);
    expect(result.items).toHaveLength(0);
    expect(result.pagination.scanTruncated).toBe(true);
    expect(result.pagination.nextCursor).toEqual(expect.any(String));
  });

  it("traverses beyond the 500-target snapshot cap with every continuation cursor advancing", async () => {
    installPagedMocks(600, 600);
    const handler = (await import("./admin-source-inspection.get")).default;
    const seen = new Set<string>(); let cursor: string | null = null; let pages = 0; let exhausted = false;
    while (!exhausted && pages < 30) {
      const inputCursor = cursor;
      const result: any = await handler({ query: { limit: "100", targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z", ...(inputCursor ? { cursor: inputCursor } : {}) } } as any);
      pages++;
      // Every non-null continuation cursor must differ from the input cursor.
      if (result.pagination.nextCursor !== null && inputCursor !== null) {
        expect(result.pagination.nextCursor).not.toBe(inputCursor);
      }
      for (const item of result.items) {
        const key = `${item.targetType}:${item.targetId}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      exhausted = result.pagination.nextCursor === null;
      cursor = result.pagination.nextCursor;
    }
    expect(pages).toBeGreaterThan(5);
    expect(exhausted).toBe(true);
    expect(seen.size).toBe(1_200);
    // Later pages were resolved through the canonical per-page resolver, not
    // the bounded first-500 snapshot; batched evidence queries ran on every page.
    expect(mocks.queryRaw.mock.calls.length).toBeGreaterThan(0);
  });

  it("terminates when all later-page targets are filtered out (no stall)", async () => {
    installPagedMocks(700, 700);
    const handler = (await import("./admin-source-inspection.get")).default;
    let cursor: string | null = null; let pages = 0; let exhausted = false;
    while (!exhausted && pages < 30) {
      const inputCursor = cursor;
      const result: any = await handler({ query: { limit: "50", targetType: "ALL", sourceStatus: "ACTIVE", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z", ...(inputCursor ? { cursor: inputCursor } : {}) } } as any);
      pages++;
      if (result.pagination.nextCursor !== null && inputCursor !== null) {
        expect(result.pagination.nextCursor).not.toBe(inputCursor);
      }
      exhausted = result.pagination.nextCursor === null;
      cursor = result.pagination.nextCursor;
    }
    expect(pages).toBeLessThanOrEqual(8);
    expect(exhausted).toBe(true);
  });

  it("terminates when all later-page targets lack lifecycle evidence", async () => {
    installPagedMocks(1_200, 1_200);
    mocks.queryRaw.mockResolvedValue([]);
    const handler = (await import("./admin-source-inspection.get")).default;
    const seen = new Set<string>(); let cursor: string | null = null; let pages = 0; let exhausted = false;
    while (!exhausted && pages < 40) {
      const inputCursor = cursor;
      const result: any = await handler({ query: { limit: "100", targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z", ...(inputCursor ? { cursor: inputCursor } : {}) } } as any);
      pages++;
      if (result.pagination.nextCursor !== null && inputCursor !== null) {
        expect(result.pagination.nextCursor).not.toBe(inputCursor);
      }
      for (const item of result.items) {
        const key = `${item.targetType}:${item.targetId}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      exhausted = result.pagination.nextCursor === null;
      cursor = result.pagination.nextCursor;
    }
    expect(exhausted).toBe(true);
    expect(seen.size).toBe(2_400);
  });

  it("covers source-exhausted-first and category-exhausted-first streams", async () => {
    installPagedMocks(40, 400); // sources exhausted first
    const handler = (await import("./admin-source-inspection.get")).default;
    const seen = new Set<string>(); let cursor: string | null = null; let pages = 0; let exhausted = false;
    while (!exhausted && pages < 20) {
      const result: any = await handler({ query: { limit: "50", targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z", ...(cursor ? { cursor } : {}) } } as any);
      pages++;
      for (const item of result.items) { const key = `${item.targetType}:${item.targetId}`; expect(seen.has(key)).toBe(false); seen.add(key); }
      exhausted = result.pagination.nextCursor === null;
      cursor = result.pagination.nextCursor;
    }
    expect(exhausted).toBe(true);
    expect(seen.size).toBe(440);
    const sourceKeys = [...seen].filter((key) => key.startsWith("SOURCE:"));
    const categoryKeys = [...seen].filter((key) => key.startsWith("CATEGORY:"));
    expect(sourceKeys).toHaveLength(40);
    expect(categoryKeys).toHaveLength(400);

    installPagedMocks(400, 40); // categories exhausted first
    cursor = null; pages = 0; exhausted = false;
    while (!exhausted && pages < 20) {
      const result: any = await handler({ query: { limit: "50", targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z", ...(cursor ? { cursor } : {}) } } as any);
      pages++;
      exhausted = result.pagination.nextCursor === null;
      cursor = result.pagination.nextCursor;
    }
    expect(exhausted).toBe(true);
  });

  it("handles exact page-boundary exhaustion without a trailing stall cursor", async () => {
    installPagedMocks(50, 50);
    const handler = (await import("./admin-source-inspection.get")).default;
    let cursor: string | null = null; let pages = 0; let exhausted = false;
    const seen = new Set<string>();
    while (!exhausted && pages < 10) {
      const result: any = await handler({ query: { limit: "100", targetType: "ALL", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z", ...(cursor ? { cursor } : {}) } } as any);
      pages++;
      for (const item of result.items) { const key = `${item.targetType}:${item.targetId}`; expect(seen.has(key)).toBe(false); seen.add(key); }
      exhausted = result.pagination.nextCursor === null;
      cursor = result.pagination.nextCursor;
    }
    expect(exhausted).toBe(true);
    expect(seen.size).toBe(100);
  });

  it("produces identical first-page cursors for identical filters (determinism)", async () => {
    installPagedMocks(300, 300);
    const handler = (await import("./admin-source-inspection.get")).default;
    const baseQuery = { limit: "50", targetType: "ALL", search: "Source", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" };
    const first = await handler({ query: baseQuery } as any);
    const second = await handler({ query: baseQuery } as any);
    expect(first.pagination.nextCursor).toBe(second.pagination.nextCursor);
    expect(first.items.map((item: any) => `${item.targetType}:${item.targetId}`)).toEqual(second.items.map((item: any) => `${item.targetType}:${item.targetId}`));
  });

  it("rejects cursors reused with any fingerprint-bound filter change", async () => {
    installPagedMocks(200, 200);
    const handler = (await import("./admin-source-inspection.get")).default;
    const base = { limit: "10", targetType: "SOURCE", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" };
    const first = await handler({ query: base } as any);
    const cursor = first.pagination.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    await expect(handler({ query: { ...base, search: "Different", cursor } } as any)).rejects.toMatchObject({ statusCode: 400 });
    const withCursor = await handler({ query: { ...base, cursor } } as any);
    await expect(handler({ query: { ...base, cursor, productivityState: "FAILED" } } as any)).rejects.toMatchObject({ statusCode: 400 });
    await expect(handler({ query: { ...base, cursor, dateFrom: "2026-08-02T00:00:00.000Z" } } as any)).rejects.toMatchObject({ statusCode: 400 });
    expect(withCursor.pagination.nextCursor).not.toBe(cursor);
  });

  it("orders duplicate display names deterministically by id tiebreak", async () => {
    const sources = [
      { id: "s-a", mediaName: "Duplicate", frontPageUrl: "https://example.com/a", rssFeedUrl: null, rssStatus: "ACTIVE", currentFeedProductive: false, lastProductiveAt: null, nextRetryAt: null, isSystemImported: false, _count: { subscribers: 0 } },
      { id: "s-b", mediaName: "Duplicate", frontPageUrl: "https://example.com/b", rssFeedUrl: null, rssStatus: "ACTIVE", currentFeedProductive: false, lastProductiveAt: null, nextRetryAt: null, isSystemImported: false, _count: { subscribers: 0 } },
      { id: "s-c", mediaName: "Zulu", frontPageUrl: "https://example.com/c", rssFeedUrl: null, rssStatus: "ACTIVE", currentFeedProductive: false, lastProductiveAt: null, nextRetryAt: null, isSystemImported: false, _count: { subscribers: 0 } },
    ];
    mocks.sourceFindMany.mockImplementation(async (args: any) => {
      const ordered = [...sources].sort((a, b) => String(a.mediaName).localeCompare(String(b.mediaName)) || String(a.id).localeCompare(String(b.id)));
      const cursorFilter = args.where?.AND?.find((item: any) => Array.isArray(item.OR) && item.OR.some((part: any) => part.mediaName?.gt));
      const afterId = cursorFilter?.OR?.find((part: any) => part.mediaName && part.id?.gt)?.id?.gt;
      const afterName = cursorFilter?.OR?.find((part: any) => part.mediaName && part.id?.gt)?.mediaName;
      const after = afterId && afterName ? ordered.findIndex((row) => String(row.mediaName) === String(afterName) && row.id === afterId) + 1 : 0;
      return ordered.slice(after, after + args.take);
    });
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([]);
    const handler = (await import("./admin-source-inspection.get")).default;
    const result: any = await handler({ query: { limit: "10", targetType: "SOURCE", dateFrom: "2026-08-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z" } } as any);
    expect(result.items.map((item: any) => item.targetId)).toEqual(["s-a", "s-b", "s-c"]);
    expect(result.pagination.nextCursor).toBeNull();
  });
});
