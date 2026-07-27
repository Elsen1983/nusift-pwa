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
    sourceCategory: {
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
// Tests – GET /api/dev/article-discovery-hard-source-profiles
// ---------------------------------------------------------------------------

describe("GET /api/dev/article-discovery-hard-source-profiles", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireAdminId.mockResolvedValue("admin-1");
    mockAssertRateLimit.mockResolvedValue(undefined);
    mockGetQuery.mockReturnValue({});
    mockFindMany.mockResolvedValue([]);
  });

  async function loadHandler() {
    const mod = await import("./article-discovery-hard-source-profiles.get");
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
    const handler = await loadHandler();
    await handler({} as any);

    expect(mockRequireAdminId).toHaveBeenCalledTimes(1);
    expect(mockAssertRateLimit).toHaveBeenCalledTimes(1);
  });

  // -- query filtering ----------------------------------------------------

  it("queries only article_discovery_hard_source_profile artifacts", async () => {
    const handler = await loadHandler();
    await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifactType: "article_discovery_hard_source_profile",
        }),
      }),
    );
  });

  // -- view filtering -----------------------------------------------------

  it("applies active view filter by default (excludes resolved profile statuses)", async () => {
    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    expect(where.status).toEqual({ notIn: ["RESOLVED", "RESOLVED_BY_AGENT1_RSS"] });
  });

  it("applies history view filter (only resolved profile statuses)", async () => {
    mockGetQuery.mockReturnValue({ view: "history" });

    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    expect(where.status).toEqual({ in: ["RESOLVED", "RESOLVED_BY_AGENT1_RSS"] });
  });

  it("applies all view filter (no status filter)", async () => {
    mockGetQuery.mockReturnValue({ view: "all" });

    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    expect(where.status).toBeUndefined();
  });

  it("defaults to active view for invalid view param", async () => {
    mockGetQuery.mockReturnValue({ view: "invalid" });

    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    expect(where.status).toEqual({ notIn: ["RESOLVED", "RESOLVED_BY_AGENT1_RSS"] });
  });

  it("returns view field in response", async () => {
    mockGetQuery.mockReturnValue({ view: "history" });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.view).toBe("history");
  });

  it("returns view=active as default in response", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.view).toBe("active");
  });

  // -- RSS-active category filtering (active view) ------------------------

  it("excludes profiles whose category has active scoped RSS in default view", async () => {
    // First call: profile artifacts. Second call: category lookup.
    let callCount = 0;
    mockFindMany.mockImplementation(async (args: any) => {
      callCount++;
      if (args.where.artifactType === "article_discovery_hard_source_profile") {
        return [
          {
            id: "prof-1",
            sourceId: "src-1",
            categoryId: "cat-eletmod",
            createdAt: new Date("2026-07-20"),
            updatedAt: new Date("2026-07-20"),
            status: "PROFILE",
            payload: {
              targetUrl: "https://telex.hu/rovat/eletmod",
              staticQuality: "failed",
              browserStatus: "BROWSER_NO_CANDIDATES",
              failureCount: 3,
              dominantReasons: ["out_of_category_scope"],
              suggestedNextAction: "ai_profile_inspection",
              profileConfidence: "high",
            },
          },
          {
            id: "prof-2",
            sourceId: "src-1",
            categoryId: "cat-belfold",
            createdAt: new Date("2026-07-20"),
            updatedAt: new Date("2026-07-20"),
            status: "PROFILE",
            payload: {
              targetUrl: "https://telex.hu/rovat/belfold",
              staticQuality: "failed",
              browserStatus: "BROWSER_NO_CANDIDATES",
              failureCount: 2,
              dominantReasons: ["stale"],
              suggestedNextAction: "manual_review",
              profileConfidence: "medium",
            },
          },
        ];
      }
      // Category lookup for RSS-active check
      if (args.where.id) {
        return [
          {
            id: "cat-eletmod",
            pathUrl: "https://telex.hu/rovat/eletmod",
            rssFeedUrl:
              "https://telex.hu/rss/archivum?filters=%7B%22superTagSlugs%22%3A%5B%22eletmod%22%5D%7D",
            discoveryEvidence: {
              scopeMatch: "exact",
              outcome: { scopeMatch: "exact" },
            },
          },
        ];
      }
      return [];
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    // prof-1 (cat-eletmod with active scoped RSS) should be filtered out
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]!.id).toBe("prof-2");
  });

  it("does not filter category profiles when RSS feed is not scoped", async () => {
    mockFindMany.mockImplementation(async (args: any) => {
      if (args.where.artifactType === "article_discovery_hard_source_profile") {
        return [
          {
            id: "prof-1",
            sourceId: "src-1",
            categoryId: "cat-sport",
            createdAt: new Date("2026-07-20"),
            updatedAt: new Date("2026-07-20"),
            status: "PROFILE",
            payload: {
              targetUrl: "https://example.com/sport",
              staticQuality: "failed",
              browserStatus: "BROWSER_NO_CANDIDATES",
              failureCount: 2,
              dominantReasons: ["stale"],
              suggestedNextAction: "manual_review",
              profileConfidence: "medium",
            },
          },
        ];
      }
      // Category has ACTIVE RSS but it's a generic root feed (not scoped)
      if (args.where.id) {
        return [
          {
            id: "cat-sport",
            pathUrl: "https://example.com/sport",
            rssFeedUrl: "https://example.com/rss",
            discoveryEvidence: { scopeMatch: "generic" },
          },
        ];
      }
      return [];
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    // Generic RSS feed → NOT scoped → profile should remain
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]!.id).toBe("prof-1");
  });

  it("does not perform category RSS check for history/all views", async () => {
    mockGetQuery.mockReturnValue({ view: "all" });
    mockFindMany.mockResolvedValue([
      {
        id: "prof-1",
        sourceId: "src-1",
        categoryId: "cat-eletmod",
        createdAt: new Date("2026-07-20"),
        updatedAt: new Date("2026-07-20"),
        status: "PROFILE",
        payload: {
          targetUrl: "https://telex.hu/rovat/eletmod",
          failureCount: 3,
        },
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    // No second query for category check
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(result.profiles).toHaveLength(1);
  });

  // -- response shape -----------------------------------------------------

  it("returns { ok, profiles, total, view }", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("profiles");
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("view");
    expect(Array.isArray(result.profiles)).toBe(true);
  });

  // -- limit --------------------------------------------------------------

  it("respects limit query param", async () => {
    mockGetQuery.mockReturnValue({ limit: "10" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    );
  });

  it("clamps limit to max 200", async () => {
    mockGetQuery.mockReturnValue({ limit: "999" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  // -- NO_RSS_FOUND categories remain in active view ----------------------

  it("keeps profiles for categories with NO_RSS_FOUND in active view", async () => {
    mockFindMany.mockImplementation(async (args: any) => {
      if (args.where.artifactType === "article_discovery_hard_source_profile") {
        return [
          {
            id: "prof-1",
            sourceId: "src-1",
            categoryId: "cat-no-rss",
            createdAt: new Date("2026-07-20"),
            updatedAt: new Date("2026-07-20"),
            status: "PROFILE",
            payload: {
              targetUrl: "https://example.com/hard",
              failureCount: 3,
            },
          },
        ];
      }
      // Category has NO RSS at all
      if (args.where.id) {
        return [
          {
            id: "cat-no-rss",
            pathUrl: "https://example.com/hard",
            rssFeedUrl: null,
            discoveryEvidence: null,
          },
        ];
      }
      return [];
    });

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.profiles).toHaveLength(1);
  });
});
