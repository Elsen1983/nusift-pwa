import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaCreateManyMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      createMany: (...args: any[]) => prismaCreateManyMock(...args),
    },
  },
}));

const makeTaxonomyEvidence = (overrides: Record<string, unknown> = {}) => ({
  sectionIds: [],
  tagIds: [],
  categorySlugs: [],
  collectionIds: [],
  routeNames: [],
  canonicalSectionHandles: [],
  feedParams: [],
  matchedFeedUrls: [],
  ...overrides,
});

const makeHardCaseCandidate = (overrides: Record<string, unknown> = {}) => ({
  targetType: "category" as const,
  sourceId: "src-1",
  categoryId: "cat-1",
  targetUrl: "https://example.com/sport",
  existingFeedUrl: null,
  queueReason: "no_feed_discovered" as const,
  discovery: {
    feedUrl: null as string | null,
    discoveredVia: null as string | null,
    detection: "none",
    score: 0,
    scopeConfidence: "low",
    scopeMatch: "unrelated" as const,
    taxonomyEvidence: makeTaxonomyEvidence(),
    topCandidates: [],
    rejectedCandidates: [],
    lastError: "No feed candidates succeeded.",
  },
  ...overrides,
});

describe("serializeHardCaseDiscoveryCandidate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaCreateManyMock.mockResolvedValue({ count: 1 });
  });

  it("preserves structured taxonomyEvidence as an object with all keys", async () => {
    const taxonomyEvidence = makeTaxonomyEvidence({
      sectionIds: ["42"],
      tagIds: ["7", "11"],
      categorySlugs: ["sport", "football"],
      canonicalSectionHandles: ["sport"],
      feedParams: ["42"],
    });

    const { persistHardCaseDiscoveryArtifacts } = await import("./artifacts");
    await persistHardCaseDiscoveryArtifacts({
      pipelineRunId: "run-1",
      result: {
        sourceId: "src-1",
        categoryId: "cat-1",
        candidates: [],
        failed: 0,
        feedUrl: null,
        feedFormat: null,
        skipSummary: {
          emptyLink: 0,
          outOfScope: 0,
          staleOrMissingPublishedAt: 0,
          htmlFallbackNonArticle: 0,
          htmlFallbackStale: 0,
        },
        rejectedItems: [],
        hardCaseQueueCandidates: [
          makeHardCaseCandidate({
            discovery: {
              feedUrl: null,
              discoveredVia: null,
              detection: "none",
              score: 25,
              scopeConfidence: "low",
              scopeMatch: "probable",
              taxonomyEvidence,
              topCandidates: [
                {
                  feedUrl: "https://example.com/sport/rss",
                  detection: "taxonomy-extraction",
                  score: 60,
                  contentType: "application/rss+xml",
                  scopeMatch: "probable",
                },
              ],
              rejectedCandidates: [
                {
                  feedUrl: "https://example.com/rss.xml",
                  detection: "html-link",
                  score: 30,
                  contentType: null,
                  scopeMatch: "generic",
                  reason: "did not validate as a feed",
                },
              ],
              lastError: "No feed verified.",
            },
          }),
        ],
      } as any,
    });

    expect(prismaCreateManyMock).toHaveBeenCalledTimes(1);
    const payload = prismaCreateManyMock.mock.calls[0]![0].data[0].payload;

    // taxonomyEvidence must be preserved as structured object
    expect(payload.discovery.taxonomyEvidence).toBeDefined();
    expect(typeof payload.discovery.taxonomyEvidence).toBe("object");
    expect(Array.isArray(payload.discovery.taxonomyEvidence)).toBe(false);
    expect(payload.discovery.taxonomyEvidence.sectionIds).toEqual(["42"]);
    expect(payload.discovery.taxonomyEvidence.tagIds).toEqual(["7", "11"]);
    expect(payload.discovery.taxonomyEvidence.categorySlugs).toEqual(["sport", "football"]);
    expect(payload.discovery.taxonomyEvidence.canonicalSectionHandles).toEqual(["sport"]);
    expect(payload.discovery.taxonomyEvidence.feedParams).toEqual(["42"]);
    // Must NOT be flattened into arrays
    expect(payload.discovery.taxonomyEvidence).toHaveProperty("collectionIds");
    expect(payload.discovery.taxonomyEvidence).toHaveProperty("routeNames");
    expect(payload.discovery.taxonomyEvidence).toHaveProperty("matchedFeedUrls");

    // scopeMatch must be preserved
    expect(payload.discovery.scopeMatch).toBe("probable");

    // topCandidates and rejectedCandidates preserved
    expect(payload.discovery.topCandidates).toHaveLength(1);
    expect(payload.discovery.topCandidates[0].scopeMatch).toBe("probable");
    expect(payload.discovery.rejectedCandidates).toHaveLength(1);
    expect(payload.discovery.rejectedCandidates[0].reason).toBe("did not validate as a feed");
  });

  it("passes through required fields and applies fallbacks only for optional ones", async () => {
    const { persistHardCaseDiscoveryArtifacts } = await import("./artifacts");
    await persistHardCaseDiscoveryArtifacts({
      pipelineRunId: "run-2",
      result: {
        sourceId: "src-2",
        categoryId: null,
        candidates: [],
        failed: 0,
        feedUrl: null,
        feedFormat: null,
        skipSummary: {
          emptyLink: 0,
          outOfScope: 0,
          staleOrMissingPublishedAt: 0,
          htmlFallbackNonArticle: 0,
          htmlFallbackStale: 0,
        },
        rejectedItems: [],
        hardCaseQueueCandidates: [
          makeHardCaseCandidate({
            targetType: "source",
            categoryId: null,
            discovery: {
              feedUrl: null,
              discoveredVia: null,
              detection: "none",
              score: 0,
              scopeConfidence: "low",
              topCandidates: [],
              rejectedCandidates: [],
              // scopeMatch, taxonomyEvidence, lastError omitted — genuinely optional
            },
          }),
        ],
      } as any,
    });

    const payload = prismaCreateManyMock.mock.calls[0]![0].data[0].payload;

    // Required fields pass through directly (no fallback needed)
    expect(payload.discovery.score).toBe(0);
    expect(payload.discovery.scopeConfidence).toBe("low");
    expect(payload.discovery.discoveredVia).toBeNull();
    expect(payload.discovery.topCandidates).toEqual([]);
    expect(payload.discovery.rejectedCandidates).toEqual([]);

    // Optional field fallbacks apply
    expect(payload.discovery.scopeMatch).toBe("generic");
    expect(payload.discovery.taxonomyEvidence).toBeNull();
    expect(payload.discovery.lastError).toBeNull();
  });

  it("returns 0 when no hard-case queue candidates", async () => {
    const { persistHardCaseDiscoveryArtifacts } = await import("./artifacts");
    const result = await persistHardCaseDiscoveryArtifacts({
      pipelineRunId: "run-3",
      result: {
        sourceId: "src-3",
        candidates: [],
        failed: 0,
        feedUrl: null,
        feedFormat: null,
        skipSummary: {
          emptyLink: 0,
          outOfScope: 0,
          staleOrMissingPublishedAt: 0,
          htmlFallbackNonArticle: 0,
          htmlFallbackStale: 0,
        },
        rejectedItems: [],
        // hardCaseQueueCandidates omitted
      } as any,
    });

    expect(result).toBe(0);
    expect(prismaCreateManyMock).not.toHaveBeenCalled();
  });
});
