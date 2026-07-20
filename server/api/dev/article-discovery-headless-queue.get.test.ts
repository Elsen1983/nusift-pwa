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

  it("excludes RESOLVED_BY_STATIC_DISCOVERY by default when no status filter is provided", async () => {
    mockGetQuery.mockReturnValue({});
    mockFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    expect(where.status).toEqual({ notIn: ["RESOLVED_BY_STATIC_DISCOVERY"] });
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
