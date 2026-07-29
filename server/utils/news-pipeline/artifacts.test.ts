import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestResult } from "./types";

const prismaCreateManyMock = vi.fn();
const prismaCreateMock = vi.fn();
const prismaFindUniqueMock = vi.fn();
const prismaUpdateMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      createMany: (...args: any[]) => prismaCreateManyMock(...args),
      create: (...args: any[]) => prismaCreateMock(...args),
    },
    pipelineRun: {
      create: (...args: any[]) => prismaCreateMock(...args),
      update: (...args: any[]) => prismaUpdateMock(...args),
    },
    newsSource: {
      findUnique: (...args: any[]) => prismaFindUniqueMock(...args),
    },
    sourceCategory: {
      findUnique: (...args: any[]) => prismaFindUniqueMock(...args),
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
          alreadySeenFeedItem: 0,
          htmlFallbackNonArticle: 0,
          htmlFallbackStale: 0,
          rssStaleSkipped: 0,
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
          alreadySeenFeedItem: 0,
          htmlFallbackNonArticle: 0,
          htmlFallbackStale: 0,
          rssStaleSkipped: 0,
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
          alreadySeenFeedItem: 0,
          htmlFallbackNonArticle: 0,
          htmlFallbackStale: 0,
          rssStaleSkipped: 0,
        },
        rejectedItems: [],
        // hardCaseQueueCandidates omitted
      } as any,
    });

    expect(result).toBe(0);
    expect(prismaCreateManyMock).not.toHaveBeenCalled();
  });
});

describe("persistAgent1TargetOutcomeArtifact – errorLog consistency", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaCreateMock.mockResolvedValue({ id: "artifact-1" });
    // Default: no category/source lookup
    prismaFindUniqueMock.mockResolvedValue(null);
  });

  const makeResult = (overrides: Partial<IngestResult> = {}): IngestResult => ({
    sourceId: "src-1",
    categoryId: "cat-1",
    candidates: [],
    failed: 0,
    feedUrl: "https://example.com/rss",
    feedFormat: "rss",
    skipSummary: {
      emptyLink: 0,
      outOfScope: 0,
      staleOrMissingPublishedAt: 0,
      alreadySeenFeedItem: 0,
      htmlFallbackNonArticle: 0,
      htmlFallbackStale: 0,
      rssStaleSkipped: 0,
    },
    rejectedItems: [],
    ...overrides,
  });

  const makePersisted = (overrides: Partial<{ inserted: number; skipped: number; failed: number; enriched: number }> = {}) => ({
    inserted: 1,
    skipped: 0,
    failed: 0,
    ...overrides,
  });

  it("sets errorLog to null for PASS status", async () => {
    const { persistAgent1TargetOutcomeArtifact } = await import("./artifacts");
    await persistAgent1TargetOutcomeArtifact({
      pipelineRunId: "run-1",
      result: makeResult(),
      persisted: makePersisted(),
    });

    expect(prismaCreateMock).toHaveBeenCalledTimes(1);
    const data = prismaCreateMock.mock.calls[0]![0].data;
    expect(data.status).toBe("PASS");
    expect(data.errorLog).toBeNull();
  });

  it("sets errorLog to handoff reason for HANDOFF_TO_AGENT2 status", async () => {
    const { persistAgent1TargetOutcomeArtifact } = await import("./artifacts");
    await persistAgent1TargetOutcomeArtifact({
      pipelineRunId: "run-1",
      result: makeResult({ feedUrl: null, candidates: [] }),
      persisted: makePersisted({ inserted: 0 }),
    });

    const data = prismaCreateMock.mock.calls[0]![0].data;
    expect(data.status).toBe("HANDOFF_TO_AGENT2");
    expect(data.errorLog).toBe(
      "No usable RSS/feed candidates were produced; target is eligible for Agent 2.",
    );
  });

  it("sets errorLog to RSS-active message for RSS_ACTIVE status", async () => {
    const { persistAgent1TargetOutcomeArtifact } = await import("./artifacts");
    await persistAgent1TargetOutcomeArtifact({
      pipelineRunId: "run-1",
      // feedUrl present, failed=0, inserted=0, candidates present → RSS_ACTIVE
      result: makeResult({ candidates: [{ fake: true }] as unknown as IngestResult["candidates"] }),
      persisted: makePersisted({ inserted: 0 }),
    });

    const data = prismaCreateMock.mock.calls[0]![0].data;
    expect(data.status).toBe("RSS_ACTIVE");
    expect(data.errorLog).toBe(
      "RSS feed active but no new articles inserted.",
    );
    // Payload failureReason must also be the RSS-active message
    expect(data.payload.failureReason).toBe(
      "RSS feed active but no new articles inserted.",
    );
  });

  it("sets errorLog to fetch/parse failure reason for FAILED status", async () => {
    const { persistAgent1TargetOutcomeArtifact } = await import("./artifacts");
    await persistAgent1TargetOutcomeArtifact({
      pipelineRunId: "run-1",
      result: makeResult({ failed: 1 }),
      persisted: makePersisted({ inserted: 0, failed: 1 }),
    });

    const data = prismaCreateMock.mock.calls[0]![0].data;
    expect(data.status).toBe("FAILED");
    expect(data.errorLog).toBe(
      "Agent 1 failed while fetching or parsing this target.",
    );
  });

  it("sets errorLog to no-inserts reason for FAILED status (feed discovered, candidates found, but none inserted)", async () => {
    const { persistAgent1TargetOutcomeArtifact } = await import("./artifacts");
    await persistAgent1TargetOutcomeArtifact({
      pipelineRunId: "run-1",
      // feedUrl=null but candidates present → not handedToAgent2, not rssActive
      result: makeResult({ feedUrl: null, candidates: [{ fake: true }] as unknown as IngestResult["candidates"] }),
      persisted: makePersisted({ inserted: 0 }),
    });

    const data = prismaCreateMock.mock.calls[0]![0].data;
    expect(data.status).toBe("FAILED");
    expect(data.errorLog).toBe(
      "Agent 1 produced no newly inserted articles for this target.",
    );
  });

  it("preserves urlPolicyRejected in skipSummary when present", async () => {
    const { persistAgent1TargetOutcomeArtifact } = await import("./artifacts");
    await persistAgent1TargetOutcomeArtifact({
      pipelineRunId: "run-url-policy",
      result: makeResult({
        skipSummary: {
          emptyLink: 0,
          outOfScope: 2,
          staleOrMissingPublishedAt: 0,
          alreadySeenFeedItem: 0,
          htmlFallbackNonArticle: 0,
          htmlFallbackStale: 0,
          rssStaleSkipped: 0,
          urlPolicyRejected: 5,
        },
      }),
      persisted: makePersisted(),
    });

    expect(prismaCreateMock).toHaveBeenCalledTimes(1);
    const payload = prismaCreateMock.mock.calls[0]![0].data.payload;
    expect(payload.skipSummary.urlPolicyRejected).toBe(5);
    expect(payload.skipSummary.outOfScope).toBe(2);
  });

  it("omits urlPolicyRejected from skipSummary when zero", async () => {
    const { persistAgent1TargetOutcomeArtifact } = await import("./artifacts");
    await persistAgent1TargetOutcomeArtifact({
      pipelineRunId: "run-no-policy",
      result: makeResult(),
      persisted: makePersisted(),
    });

    expect(prismaCreateMock).toHaveBeenCalledTimes(1);
    const payload = prismaCreateMock.mock.calls[0]![0].data.payload;
    expect(payload.skipSummary.urlPolicyRejected).toBeUndefined();
  });

  it("does not mask real fetch failures as RSS_ACTIVE (rssActive requires failed === 0)", async () => {
    const { persistAgent1TargetOutcomeArtifact } = await import("./artifacts");
    await persistAgent1TargetOutcomeArtifact({
      pipelineRunId: "run-1",
      result: makeResult({ failed: 1, candidates: [{ fake: true }] as unknown as IngestResult["candidates"] }),
      persisted: makePersisted({ inserted: 0, failed: 1 }),
    });

    const data = prismaCreateMock.mock.calls[0]![0].data;
    // Must be FAILED, not RSS_ACTIVE
    expect(data.status).toBe("FAILED");
    expect(data.errorLog).toBe(
      "Agent 1 failed while fetching or parsing this target.",
    );
  });
});
