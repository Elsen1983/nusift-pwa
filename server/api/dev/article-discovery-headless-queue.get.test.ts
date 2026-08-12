import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Provide Nitro auto-imports via globalThis
// ---------------------------------------------------------------------------
const mockRequireAdminId = vi.fn();
const mockAssertRateLimit = vi.fn();
const mockGetQuery = vi.fn();
const mockFindMany = vi.fn();

(globalThis as any).defineEventHandler = (fn: any) => fn;
(globalThis as any).getQuery = (...args: any[]) => mockGetQuery(...args);

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
  createError: ({
    statusCode,
    statusMessage,
  }: {
    statusCode: number;
    statusMessage: string;
  }) => {
    const err = new Error(statusMessage) as Error & { statusCode: number };
    err.statusCode = statusCode;
    return err;
  },
}));

vi.mock("../../utils/prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findMany: (...args: any[]) => mockFindMany(...args),
    },
  },
}));

vi.mock("../../utils/require-admin", () => ({
  requireAdminId: (...args: any[]) => mockRequireAdminId(...args),
}));

vi.mock("../../utils/rate-limit", () => ({
  assertRateLimit: (...args: any[]) => mockAssertRateLimit(...args),
}));

// ---------------------------------------------------------------------------
// Tests – GET /api/dev/article-discovery-headless-queue
// ---------------------------------------------------------------------------

describe("GET /api/dev/article-discovery-headless-queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireAdminId.mockResolvedValue("admin-1");
    mockAssertRateLimit.mockResolvedValue(undefined);
    mockGetQuery.mockReturnValue({});
    mockFindMany.mockResolvedValue([]);
  });

  async function loadHandler() {
    const mod = await import("./article-discovery-headless-queue.get");
    return mod.default;
  }

  // -- admin access -------------------------------------------------------

  it("requires admin access", async () => {
    mockRequireAdminId.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    );

    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("resolves admin id before querying", async () => {
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRequireAdminId).toHaveBeenCalledTimes(1);
    expect(mockAssertRateLimit).toHaveBeenCalledTimes(1);
  });

  // -- query filtering ----------------------------------------------------

  it("queries only article_discovery_headless_required artifacts", async () => {
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifactType: "article_discovery_headless_required",
        }),
      }),
    );
  });

  it("applies status filter when provided", async () => {
    mockGetQuery.mockReturnValue({ status: "PENDING_HEADLESS" });
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifactType: "article_discovery_headless_required",
          status: "PENDING_HEADLESS",
        }),
      }),
    );
  });

  it("applies active view filter by default when no view param is provided", async () => {
    mockGetQuery.mockReturnValue({});
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    // Active view uses OR filter
    expect(where.OR).toBeDefined();
    expect(Array.isArray(where.OR)).toBe(true);
  });

  it("applies explicit status filter overriding view when status is provided", async () => {
    mockGetQuery.mockReturnValue({ status: "BROWSER_FALLBACK_DISABLED" });
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    expect(where.status).toBe("BROWSER_FALLBACK_DISABLED");
    // Should NOT have OR filter since status overrides view
    expect(where.OR).toBeUndefined();
  });

  it("applies all view filter when view=all", async () => {
    mockGetQuery.mockReturnValue({ view: "all" });
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    expect(where.status).toEqual({ notIn: ["RESOLVED_BY_STATIC_DISCOVERY"] });
    expect(where.OR).toBeUndefined();
  });

  it("applies history view filter when view=history", async () => {
    mockGetQuery.mockReturnValue({ view: "history" });
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    expect(where.OR).toBeDefined();
    expect(Array.isArray(where.OR)).toBe(true);
  });

  it("defaults to active view for invalid view param", async () => {
    mockGetQuery.mockReturnValue({ view: "invalid" });
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    // Should still have OR filter (active view)
    expect(where.OR).toBeDefined();
  });

  it("returns view field in response", async () => {
    mockGetQuery.mockReturnValue({ view: "history" });
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.view).toBe("history");
  });

  it("returns view=active as default in response", async () => {
    mockGetQuery.mockReturnValue({});
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.view).toBe("active");
  });

  it("returns extended summary with active/history counts", async () => {
    const now = new Date();
    mockFindMany.mockResolvedValue([
      {
        id: "art-1",
        status: "PENDING_HEADLESS",
        artifactType: "article_discovery_headless_required",
        sourceId: "src-1",
        categoryId: null,
        createdAt: now,
        updatedAt: now,
        nextEligibleAt: new Date(now.getTime() + 30 * 60 * 1000),
        candidateCount: 0,
        payload: { targetUrl: "https://example.com", skippedDueToBrowserCooldown: true },
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.summary).toHaveProperty("activeTotal");
    expect(result.summary).toHaveProperty("historyTotal");
    expect(result.summary).toHaveProperty("retryableTotal");
    expect(result.summary).toHaveProperty("cooldownPendingTotal");
    expect(result.summary).toHaveProperty("resolvedRecentTotal");
    expect(result.summary.activeTotal).toBe(1);
    expect(result.summary.cooldownPendingTotal).toBe(1);
    expect(result.items[0]).toMatchObject({
      cooldownDeferred: true,
      nextEligibleAt: expect.any(String),
    });
  });

  it("hides retryable active failures when the same target has a newer resolved artifact", async () => {
    const failedAt = new Date("2026-07-24T10:23:04Z");
    const resolvedAt = new Date("2026-07-24T11:23:21Z");

    mockFindMany
      .mockResolvedValueOnce([
        {
          id: "failed-1",
          status: "BROWSER_NO_CANDIDATES",
          artifactType: "article_discovery_headless_required",
          sourceId: "src-1",
          categoryId: "cat-1",
          createdAt: new Date("2026-07-24T10:17:04Z"),
          updatedAt: failedAt,
          candidateCount: 0,
          payload: { targetUrl: "https://example.com/category/news" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "resolved-1",
          status: "RESOLVED",
          artifactType: "article_discovery_headless_required",
          sourceId: "src-1",
          categoryId: "cat-1",
          createdAt: new Date("2026-07-24T11:23:01Z"),
          updatedAt: resolvedAt,
          candidateCount: 3,
          payload: { targetUrl: "https://example.com/category/news" },
        },
      ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledTimes(2);
    expect(mockFindMany.mock.calls[1]![0]!.where).toMatchObject({
      artifactType: "article_discovery_headless_required",
      status: {
        in: ["RESOLVED", "RESOLVED_BY_STATIC_DISCOVERY", "RESOLVED_BY_AGENT1_RSS"],
      },
      sourceId: { in: ["src-1"] },
    });
    expect(result.items).toEqual([]);
    expect(result.summary.total).toBe(0);
    expect(result.summary.retryableTotal).toBe(0);
  });

  it("keeps retryable active failures when a resolved artifact belongs to another target", async () => {
    const now = new Date("2026-07-24T10:23:04Z");

    mockFindMany
      .mockResolvedValueOnce([
        {
          id: "failed-1",
          status: "BROWSER_NO_CANDIDATES",
          artifactType: "article_discovery_headless_required",
          sourceId: "src-1",
          categoryId: "cat-1",
          createdAt: now,
          updatedAt: now,
          candidateCount: 0,
          payload: { targetUrl: "https://example.com/category/news" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "resolved-1",
          status: "RESOLVED",
          artifactType: "article_discovery_headless_required",
          sourceId: "src-1",
          categoryId: "cat-1",
          createdAt: now,
          updatedAt: new Date("2026-07-24T11:23:21Z"),
          candidateCount: 3,
          payload: { targetUrl: "https://example.com/category/sports" },
        },
      ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "failed-1",
      status: "BROWSER_NO_CANDIDATES",
      targetUrl: "https://example.com/category/news",
    });
    expect(result.summary.retryableTotal).toBe(1);
  });

  it("respects limit query param", async () => {
    mockGetQuery.mockReturnValue({ limit: "10" });
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    );
  });

  it("clamps limit to max 200", async () => {
    mockGetQuery.mockReturnValue({ limit: "999" });
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it("clamps limit to min 1", async () => {
    mockGetQuery.mockReturnValue({ limit: "0" });
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });

  it("defaults limit to 50", async () => {
    mockGetQuery.mockReturnValue({});
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  // -- response shape -----------------------------------------------------

  it("returns { ok, items, summary, browserFallbackEnabled }", async () => {
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("browserFallbackEnabled");
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.summary).toHaveProperty("total");
    expect(result.summary).toHaveProperty("byStatus");
    expect(typeof result.browserFallbackEnabled).toBe("boolean");
  });

  it("normalizes artifacts through the headless-queue normalizer", async () => {
    const now = new Date();
    mockFindMany.mockResolvedValue([
      {
        id: "art-1",
        status: "PENDING_HEADLESS",
        artifactType: "article_discovery_headless_required",
        sourceId: "src-1",
        categoryId: null,
        createdAt: now,
        updatedAt: now,
        candidateCount: 0,
        payload: {
          targetUrl: "https://example.com/news",
          quality: "weak",
        },
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "art-1",
      status: "PENDING_HEADLESS",
      targetUrl: "https://example.com/news",
      quality: "weak",
    });
    expect(result.summary.total).toBe(1);
    expect(result.summary.byStatus).toEqual({ PENDING_HEADLESS: 1 });
  });

  // -- payload safety -----------------------------------------------------

  it("returned items do not include raw payload", async () => {
    const now = new Date();
    mockFindMany.mockResolvedValue([
      {
        id: "art-1",
        status: "RESOLVED",
        artifactType: "article_discovery_headless_required",
        sourceId: "src-1",
        categoryId: null,
        createdAt: now,
        updatedAt: now,
        candidateCount: 3,
        payload: {
          targetUrl: "https://example.com",
          candidates: [{ url: "https://example.com/1" }],
          outcomeSummary: { totalEvaluated: 10 },
          discoverySources: { listingPages: 3 },
        },
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    const item = result.items[0];
    expect(item).not.toHaveProperty("payload");
    expect(item).not.toHaveProperty("candidates");
    expect(item).not.toHaveProperty("outcomeSummary");
    expect(item).not.toHaveProperty("discoverySources");
  });
});
