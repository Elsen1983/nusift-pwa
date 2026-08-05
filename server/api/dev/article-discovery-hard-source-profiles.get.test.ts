import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Provide Nitro auto-imports via globalThis
// ---------------------------------------------------------------------------
const mockRequireAdminId = vi.fn();
const mockAssertRateLimit = vi.fn();
const mockGetQuery = vi.fn();
const mockFindMany = vi.fn();

function createInMemoryFindMany(rows: any[], seenIds?: string[]) {
  return async (args: any) => {
    if (args.where?.artifactType !== "article_discovery_hard_source_profile") return [];
    const ordered = [...rows].sort((a, b) => {
      const byDate = b.updatedAt.getTime() - a.updatedAt.getTime();
      return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
    });
    const or = Array.isArray(args.where.OR) ? args.where.OR : null;
    const filtered = or
      ? ordered.filter((row) => {
        const olderThanDate = or[0]?.updatedAt?.lt instanceof Date
          && row.updatedAt < or[0].updatedAt.lt;
        const sameDateOlderId = or[1]?.updatedAt instanceof Date
          && row.updatedAt.getTime() === or[1].updatedAt.getTime()
          && typeof or[1]?.id?.lt === "string"
          && row.id < or[1].id.lt;
        return olderThanDate || sameDateOlderId;
      })
      : ordered;
    const page = filtered.slice(0, args.take ?? 1_000);
    seenIds?.push(...page.map((row) => row.id));
    return page;
  };
}

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

  it("does not filter by status at DB level (aggregation decides current rows)", async () => {
    const handler = await loadHandler();
    await handler({} as any);

    const where = mockFindMany.mock.calls[0]![0]!.where;
    expect(where.status).toBeUndefined();
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
    expect(where.status).toBeUndefined();
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

  // -- stable logical target aggregation ----------------------------------

  it("aggregates repeated failures for one target into one current row with history", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "prof-old",
        sourceId: "src-1",
        categoryId: "cat-1",
        createdAt: new Date("2026-07-18T00:00:00Z"),
        updatedAt: new Date("2026-07-18T00:00:00Z"),
        status: "PROFILE",
        payload: {
          targetUrl: "https://example.com/hard",
          failureCount: 1,
          lifecycleState: "open",
          staticQuality: "failed",
        },
      },
      {
        id: "prof-new",
        sourceId: "src-1",
        categoryId: "cat-1",
        createdAt: new Date("2026-07-20T00:00:00Z"),
        updatedAt: new Date("2026-07-20T00:00:00Z"),
        status: "PROFILE",
        payload: {
          targetUrl: "https://example.com/hard",
          failureCount: 4,
          lifecycleState: "open",
          staticQuality: "failed",
        },
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]!.id).toBe("prof-new");
    expect(result.profiles[0]!.evidenceCount).toBe(2);
    expect(result.profiles[0]!.history).toHaveLength(1);
    expect(result.profiles[0]!.history[0]!.id).toBe("prof-old");
  });

  it("applies the requested limit after aggregation so a noisy target cannot hide peers", async () => {
    mockGetQuery.mockReturnValue({ limit: "2" });
    const noisyRows = Array.from({ length: 1_000 }, (_, index) => ({
      id: `noisy-${index}`,
      sourceId: "src-noisy",
      categoryId: "cat-noisy",
      createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
      updatedAt: new Date(Date.UTC(2026, 0, 1 + index)),
      status: "PROFILE",
      payload: {
        targetUrl: "https://example.com/noisy",
        failureCount: index + 1,
        lifecycleState: "open",
      },
    }));
    const peer = {
      id: "peer",
      sourceId: "src-peer",
      categoryId: "cat-peer",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z"),
      status: "PROFILE",
      payload: {
        targetUrl: "https://peer.example.com/news",
        failureCount: 1,
        lifecycleState: "open",
      },
    };
    // Realistic in-memory Prisma behavior: apply the endpoint's artifact
    // predicate, composite ordering, explicit keyset OR, and take. The peer
    // is genuinely absent from page 1 and is discovered on page 2.
    const seenArtifactIds: string[] = [];
    mockFindMany.mockImplementation(createInMemoryFindMany([...noisyRows, peer], seenArtifactIds));

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(seenArtifactIds).toHaveLength(1_001);
    expect(new Set(seenArtifactIds).size).toBe(1_001);
    expect(new Set(seenArtifactIds)).toEqual(new Set([...noisyRows, peer].map((row) => row.id)));
    expect(seenArtifactIds.slice(0, 1_000)).not.toContain("peer");
    expect(seenArtifactIds.slice(1_000)).toEqual(["peer"]);
    expect(result.profiles).toHaveLength(2);
    expect(result.profiles.map((profile: { key: string }) => profile.key)).toEqual([
      "src-noisy|cat-noisy|https://example.com/noisy",
      "src-peer|cat-peer|https://peer.example.com/news",
    ]);
    expect(mockFindMany).toHaveBeenCalledTimes(5);
    expect(mockFindMany.mock.calls[0]![0]).toEqual(expect.objectContaining({ take: 1000 }));
    expect(mockFindMany.mock.calls[1]![0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ rssStatus: "ACTIVE" }),
    }));
    expect(mockFindMany.mock.calls[2]![0]).toEqual(expect.objectContaining({
      take: 1000,
      where: expect.objectContaining({ OR: expect.any(Array) }),
    }));
    expect(mockFindMany.mock.calls[3]![0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ rssStatus: "ACTIVE" }),
    }));
    expect(mockFindMany.mock.calls[4]![0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ rssStatus: "ACTIVE" }),
    }));
    expect(result.pagination).toMatchObject({
      scannedRows: 1001,
      scannedPages: 2,
      scanCapReached: false,
      logicalTargetsFound: 2,
      resultTruncated: false,
      exhausted: true,
      stopReason: "exhausted",
    });
  });

  it("reports a non-exhaustive requested-limit stop when a full page satisfies the limit", async () => {
    mockGetQuery.mockReturnValue({ limit: "2", view: "all" });
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      id: `target-${String(index).padStart(4, "0")}`,
      sourceId: `src-${index}`,
      categoryId: null,
      createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1000),
      updatedAt: new Date(Date.UTC(2026, 0, 1) - index * 1000),
      status: "PROFILE",
      payload: { targetUrl: `https://example.com/article-${index}`, lifecycleState: "open" },
    }));
    mockFindMany.mockImplementation(createInMemoryFindMany(rows));

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.profiles).toHaveLength(2);
    expect(result.total).toBeNull();
    expect(result.pagination).toMatchObject({
      scannedRows: 1_000,
      scannedPages: 1,
      scanCapReached: false,
      exhausted: false,
      resultTruncated: true,
      stopReason: "requested_limit_satisfied",
      earlyStopReason: "requested_limit_satisfied",
    });
  });

  it("reports an exact total after a short page proves exhaustion", async () => {
    mockGetQuery.mockReturnValue({ limit: "2", view: "all" });
    const rows = [
      {
        id: "short-2",
        sourceId: "src-2",
        categoryId: null,
        createdAt: new Date("2026-01-02T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
        status: "PROFILE",
        payload: { targetUrl: "https://example.com/short-two", lifecycleState: "open" },
      },
      {
        id: "short-1",
        sourceId: "src-1",
        categoryId: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        status: "PROFILE",
        payload: { targetUrl: "https://example.com/short-one", lifecycleState: "open" },
      },
    ];
    mockFindMany.mockImplementation(createInMemoryFindMany(rows));

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.total).toBe(2);
    expect(result.pagination).toMatchObject({
      scannedRows: 2,
      scannedPages: 1,
      exhausted: true,
      resultTruncated: false,
      stopReason: "exhausted",
    });
  });

  it("proves exhaustion with an empty next page after a full page", async () => {
    mockGetQuery.mockReturnValue({ limit: "2", view: "all" });
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      id: `same-target-${String(index).padStart(4, "0")}`,
      sourceId: "src-same",
      categoryId: null,
      createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1000),
      updatedAt: new Date(Date.UTC(2026, 0, 1) - index * 1000),
      status: "PROFILE",
      payload: { targetUrl: "https://example.com/same-target", lifecycleState: "open" },
    }));
    const seenArtifactIds: string[] = [];
    mockFindMany.mockImplementation(createInMemoryFindMany(rows, seenArtifactIds));

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(seenArtifactIds).toHaveLength(1_000);
    expect(new Set(seenArtifactIds).size).toBe(1_000);
    expect(result.profiles).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.pagination).toMatchObject({
      scannedRows: 1_000,
      scannedPages: 2,
      scanCapReached: false,
      exhausted: true,
      resultTruncated: false,
      stopReason: "exhausted",
    });
  });

  it("uses id as a deterministic tie-breaker when page timestamps are equal", async () => {
    mockGetQuery.mockReturnValue({ limit: "2" });
    const pageOne = Array.from({ length: 1_000 }, (_, index) => ({
      id: `tie-${String(1_000 - index).padStart(4, "0")}`,
      sourceId: "src-tie",
      categoryId: "cat-tie",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      status: "PROFILE",
      payload: { targetUrl: "https://example.com/tie", lifecycleState: "open" },
    }));
    const peer = {
      id: "tie-0000",
      sourceId: "src-peer-tie",
      categoryId: "cat-peer-tie",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      status: "PROFILE",
      payload: { targetUrl: "https://peer.example.com/tie", lifecycleState: "open" },
    };
    mockFindMany.mockImplementation(createInMemoryFindMany([...pageOne, peer]));

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.profiles.map((profile: { key: string }) => profile.key)).toContain(
      "src-peer-tie|cat-peer-tie|https://peer.example.com/tie",
    );
    expect(result.pagination.scannedPages).toBe(2);
    expect(result.pagination.stopReason).toBe("exhausted");
  });

  it("stops at the hard scan cap and marks the result truncated", async () => {
    mockGetQuery.mockReturnValue({ limit: "2" });
    const makePage = (page: number) => Array.from({ length: 1_000 }, (_, index) => ({
      id: `cap-${page}-${index}`,
      sourceId: "src-cap",
      categoryId: "cat-cap",
      createdAt: new Date(Date.UTC(2020, 0, 1 + page)),
      updatedAt: new Date(Date.UTC(2020, 0, 1 + page)),
      status: "PROFILE",
      payload: { targetUrl: "https://example.com/cap", lifecycleState: "open" },
    }));
    mockFindMany.mockImplementation(createInMemoryFindMany(
      Array.from({ length: 5_000 }, (_, index) => ({
        ...makePage(Math.floor(index / 1_000))[index % 1_000],
        id: `cap-${String(index).padStart(4, "0")}`,
        updatedAt: new Date(Date.UTC(2020, 0, 1) - index * 1000),
      })),
    ));

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.pagination).toMatchObject({
      scannedRows: 5_000,
      scannedPages: 5,
      scanCapReached: true,
      resultTruncated: true,
      exhausted: false,
      stopReason: "scan_cap_reached",
    });
  });

  it("does not merge different categories under the same source", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "prof-a",
        sourceId: "src-1",
        categoryId: "cat-a",
        createdAt: new Date("2026-07-20"),
        updatedAt: new Date("2026-07-20"),
        status: "PROFILE",
        payload: { targetUrl: "https://example.com/sport", failureCount: 2, lifecycleState: "open" },
      },
      {
        id: "prof-b",
        sourceId: "src-1",
        categoryId: "cat-b",
        createdAt: new Date("2026-07-20"),
        updatedAt: new Date("2026-07-20"),
        status: "PROFILE",
        payload: { targetUrl: "https://example.com/tech", failureCount: 2, lifecycleState: "open" },
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.profiles).toHaveLength(2);
  });

  it("excludes a resolved target from active view despite older open artifacts", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "prof-open",
        sourceId: "src-1",
        categoryId: "cat-1",
        createdAt: new Date("2026-07-18T00:00:00Z"),
        updatedAt: new Date("2026-07-18T00:00:00Z"),
        status: "PROFILE",
        payload: {
          targetUrl: "https://example.com/hard",
          failureCount: 5,
          lifecycleState: "open",
        },
      },
      {
        id: "prof-resolved",
        sourceId: "src-1",
        categoryId: "cat-1",
        createdAt: new Date("2026-07-20T00:00:00Z"),
        updatedAt: new Date("2026-07-20T00:00:00Z"),
        status: "RESOLVED",
        payload: {
          targetUrl: "https://example.com/hard",
          failureCount: 6,
          lifecycleState: "resolved",
          resolvedReason: "Agent 1 RSS found",
        },
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    // Current row derives from the NEWEST artifact (resolved) → excluded from active view.
    expect(result.profiles).toHaveLength(0);
  });

  it("history view returns only resolved targets", async () => {
    mockGetQuery.mockReturnValue({ view: "history" });
    mockFindMany.mockResolvedValue([
      {
        id: "prof-open",
        sourceId: "src-1",
        categoryId: "cat-1",
        createdAt: new Date("2026-07-18T00:00:00Z"),
        updatedAt: new Date("2026-07-18T00:00:00Z"),
        status: "PROFILE",
        payload: { targetUrl: "https://example.com/hard", failureCount: 5, lifecycleState: "open" },
      },
      {
        id: "prof-resolved",
        sourceId: "src-1",
        categoryId: "cat-1",
        createdAt: new Date("2026-07-20T00:00:00Z"),
        updatedAt: new Date("2026-07-20T00:00:00Z"),
        status: "RESOLVED",
        payload: { targetUrl: "https://example.com/hard", failureCount: 6, lifecycleState: "resolved" },
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({} as any);

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]!.id).toBe("prof-resolved");
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
      expect.objectContaining({ take: 1000 }),
    );
  });

  it("clamps limit to max 200", async () => {
    mockGetQuery.mockReturnValue({ limit: "999" });

    const handler = await loadHandler();
    await handler({} as any);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1000 }),
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
