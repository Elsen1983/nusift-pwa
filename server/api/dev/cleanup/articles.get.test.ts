import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRequireAdminId = vi.fn();
const mockAssertRateLimit = vi.fn();
const mockGetQuery = vi.fn();
const mockProcessCleanup = vi.fn();

(globalThis as any).defineEventHandler = (fn: any) => fn;
(globalThis as any).getQuery = (...args: any[]) => mockGetQuery(...args);

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
  createError: ({ statusCode, statusMessage }: { statusCode: number; statusMessage: string }) => {
    const err = new Error(statusMessage) as Error & { statusCode: number };
    err.statusCode = statusCode;
    return err;
  },
}));

vi.mock("../../../utils/require-admin", () => ({
  requireAdminId: (...args: any[]) => mockRequireAdminId(...args),
}));

vi.mock("../../../utils/rate-limit", () => ({
  assertRateLimit: (...args: any[]) => mockAssertRateLimit(...args),
}));

vi.mock("../../../utils/news-pipeline/article-retention-cleanup", () => ({
  processOldArticleRetentionCleanup: (...args: any[]) => mockProcessCleanup(...args),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/dev/cleanup/articles", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireAdminId.mockResolvedValue("admin-1");
    mockAssertRateLimit.mockResolvedValue(undefined);
    mockGetQuery.mockReturnValue({});
    mockProcessCleanup.mockResolvedValue({
      ok: true,
      dryRun: true,
      olderThanDays: 7,
      cutoff: "2026-07-20T12:00:00.000Z",
      inspected: 0,
      eligibleForDeletion: 0,
      deleted: 0,
      protected: 0,
      skipped: 0,
      limit: 100,
      durationMs: 5,
      bySource: [],
      protectedReasons: {},
      skippedReasons: {},
      sampleDeletedOrWouldDelete: [],
    });
  });

  async function loadHandler() {
    const mod = await import("./articles.get");
    return mod.default;
  }

  it("requires admin access", async () => {
    mockRequireAdminId.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    );
    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("calls assertRateLimit with cleanup-articles-inspect / 10 / 60s", async () => {
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockAssertRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "cleanup-articles-inspect",
      10,
      60 * 1000,
    );
  });

  it("always calls the utility with dryRun=true (ignores any query param)", async () => {
    mockGetQuery.mockReturnValue({ dryRun: "false" });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("defaults olderThanDays=7 and limit=100", async () => {
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ olderThanDays: 7, limit: 100 }),
    );
  });

  it("parses and clamps olderThanDays (1..365)", async () => {
    mockGetQuery.mockReturnValue({ olderThanDays: "30" });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ olderThanDays: 30 }),
    );
  });

  it("clamps olderThanDays to max 365", async () => {
    mockGetQuery.mockReturnValue({ olderThanDays: "99999" });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ olderThanDays: 365 }),
    );
  });

  it("parses and clamps limit (1..500)", async () => {
    mockGetQuery.mockReturnValue({ limit: "250" });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 250 }),
    );
  });

  it("clamps limit to max 500", async () => {
    mockGetQuery.mockReturnValue({ limit: "99999" });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500 }),
    );
  });

  it("clamps limit to min 1", async () => {
    mockGetQuery.mockReturnValue({ limit: "0" });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
  });

  it("returns the utility result directly (compact, no raw payloads)", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result).not.toHaveProperty("payload");
    expect(result).not.toHaveProperty("bodyText");
    expect(result.sampleDeletedOrWouldDelete).toEqual([]);
  });
});
