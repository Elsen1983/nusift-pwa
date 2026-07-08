import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies
const discoverFeedForUrlMock = vi.fn();
const resolveFeedsWithBrowserMock = vi.fn();
const verifyFeedCandidateMock = vi.fn();
const logAgentScanMock = vi.fn();
const runNewsPipelineMock = vi.fn();

// Prisma mock with findMany/update/create for queue processing
const prismaFindManyMock = vi.fn();
const prismaUpdateMock = vi.fn();
const prismaSourceCategoryUpdateMock = vi.fn();
const prismaNewsSourceUpdateMock = vi.fn();

vi.mock("./feed-discovery", () => ({
  discoverFeedForUrl: discoverFeedForUrlMock,
  verifyFeedCandidate: verifyFeedCandidateMock,
}));

vi.mock("./browser-feed-resolver", () => ({
  resolveFeedsWithBrowser: resolveFeedsWithBrowserMock,
  shouldAttemptBrowserResolution: (url: string) => {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return false;
      const pathname = parsed.pathname.toLowerCase();
      if (/\/rss(?:\/|$)|\/feed(?:\/|$)|\/atom(?:\/|$)|\.rss$|\.xml$/.test(pathname)) return false;
      return true;
    } catch {
      return false;
    }
  },
}));

vi.mock("./orchestrator", () => ({
  runNewsPipeline: runNewsPipelineMock,
}));

vi.mock("./log", () => ({
  logAgentScan: logAgentScanMock,
}));

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findMany: (...args: any[]) => prismaFindManyMock(...args),
      update: (...args: any[]) => prismaUpdateMock(...args),
    },
    sourceCategory: {
      update: (...args: any[]) => prismaSourceCategoryUpdateMock(...args),
    },
    newsSource: {
      update: (...args: any[]) => prismaNewsSourceUpdateMock(...args),
    },
  },
}));

const makeFetchResult = (overrides: Record<string, unknown> = {}) => ({
  feedUrl: null,
  discoveredVia: null,
  detection: "none" as const,
  score: 0,
  scopeConfidence: "low" as const,
  topCandidates: [],
  rejectedCandidates: [],
  lastError: "No feed candidates succeeded.",
  ...overrides,
});

describe("discoverFeedWithBrowserFallback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns resolverPath='fetch' when fetch-based discovery succeeds", async () => {
    discoverFeedForUrlMock.mockResolvedValue(
      makeFetchResult({
        feedUrl: "https://example.com/rss.xml",
        discoveredVia: "https://example.com/news",
        detection: "html-link",
        score: 65,
        scopeConfidence: "medium",
      }),
    );

    const { discoverFeedWithBrowserFallback } = await import("./hard-case-consumer");
    const result = await discoverFeedWithBrowserFallback({
      pageUrl: "https://example.com/news",
    });

    expect(result.meta.resolverPath).toBe("fetch");
    expect(result.meta.browserAttempted).toBe(false);
    expect(result.meta.browserMethod).toBe("none");
    expect(result.meta.browserCandidateCount).toBe(0);
    expect(result.meta.browserCandidates).toEqual([]);
    expect(result.meta.browserError).toBeNull();
    expect(result.discovery.feedUrl).toBe("https://example.com/rss.xml");

    // Browser resolver should NOT have been called
    expect(resolveFeedsWithBrowserMock).not.toHaveBeenCalled();
  });

  it("returns resolverPath='jsdom' when browser fallback succeeds", async () => {
    // Fetch-based discovery fails
    discoverFeedForUrlMock.mockResolvedValue(makeFetchResult());

    // Browser resolver finds candidates
    resolveFeedsWithBrowserMock.mockResolvedValue({
      candidates: [
        { feedUrl: "https://example.com/rss", source: "dom-link" },
        { feedUrl: "https://example.com/feed.xml", source: "anchor-tag" },
      ],
      method: "jsdom",
      renderedDomAvailable: true,
    });

    // Verification succeeds for first candidate
    verifyFeedCandidateMock.mockResolvedValue({
      feedUrl: "https://example.com/rss",
      contentType: "application/rss+xml",
    });

    const { discoverFeedWithBrowserFallback } = await import("./hard-case-consumer");
    const result = await discoverFeedWithBrowserFallback(
      { pageUrl: "https://example.com/news" },
      { sourceId: "src-1", categoryId: "cat-1" },
    );

    expect(result.meta.resolverPath).toBe("jsdom");
    expect(result.meta.browserAttempted).toBe(true);
    expect(result.meta.browserMethod).toBe("jsdom");
    expect(result.meta.browserCandidateCount).toBe(2);
    expect(result.meta.browserCandidates).toHaveLength(2);
    expect(result.meta.browserCandidates[0]?.source).toBe("dom-link");
    expect(result.meta.browserError).toBeNull();
    expect(result.discovery.feedUrl).toBe("https://example.com/rss");
    expect(result.discovery.detection).toBe("browser-dom-link");

    // Log calls should include sourceId and categoryId
    const startedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0].status === "BROWSER_RESOLUTION_STARTED",
    );
    expect(startedLog).toBeDefined();
    expect(startedLog?.[0]?.sourceId).toBe("src-1");
    expect(startedLog?.[0]?.categoryId).toBe("cat-1");

    const resolvedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0].status === "BROWSER_RESOLUTION_RESOLVED",
    );
    expect(resolvedLog).toBeDefined();
    expect(resolvedLog?.[0]?.sourceId).toBe("src-1");
    expect(resolvedLog?.[0]?.errorLog).toContain("resolverPath=jsdom");
  });

  it("returns resolverPath='none' when browser attempt finds no candidates", async () => {
    discoverFeedForUrlMock.mockResolvedValue(makeFetchResult());

    resolveFeedsWithBrowserMock.mockResolvedValue({
      candidates: [],
      method: "none",
      renderedDomAvailable: false,
      error: "jsdom resolver failed: network timeout",
    });

    const { discoverFeedWithBrowserFallback } = await import("./hard-case-consumer");
    const result = await discoverFeedWithBrowserFallback(
      { pageUrl: "https://example.com/news" },
      { sourceId: "src-2" },
    );

    expect(result.meta.resolverPath).toBe("none");
    expect(result.meta.browserAttempted).toBe(true);
    expect(result.meta.browserMethod).toBe("none");
    expect(result.meta.browserCandidateCount).toBe(0);
    expect(result.meta.browserCandidates).toEqual([]);
    expect(result.meta.browserError).toBe("jsdom resolver failed: network timeout");
    expect(result.discovery.feedUrl).toBeNull();

    // Log should be target-aware
    const noCandidatesLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0].status === "BROWSER_RESOLUTION_NO_CANDIDATES",
    );
    expect(noCandidatesLog).toBeDefined();
    expect(noCandidatesLog?.[0]?.sourceId).toBe("src-2");
  });

  it("returns resolverPath='none' when browser candidates all fail verification", async () => {
    discoverFeedForUrlMock.mockResolvedValue(makeFetchResult());

    resolveFeedsWithBrowserMock.mockResolvedValue({
      candidates: [
        { feedUrl: "https://example.com/rss", source: "dom-link" },
      ],
      method: "jsdom",
      renderedDomAvailable: true,
    });

    verifyFeedCandidateMock.mockRejectedValue(new Error("HTTP 404 from https://example.com/rss"));

    const { discoverFeedWithBrowserFallback } = await import("./hard-case-consumer");
    const result = await discoverFeedWithBrowserFallback({
      pageUrl: "https://example.com/news",
    });

    expect(result.meta.resolverPath).toBe("none");
    expect(result.meta.browserAttempted).toBe(true);
    expect(result.meta.browserMethod).toBe("jsdom");
    expect(result.meta.browserCandidateCount).toBe(1);
    expect(result.meta.browserCandidates).toHaveLength(1);
    expect(result.discovery.feedUrl).toBeNull();

    // Rejected candidates should include browser-verify reason
    const rejected = result.discovery.rejectedCandidates;
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected.some((r) => r.reason.includes("browser-verify"))).toBe(true);
  });

  it("deduplicates browser candidates against fetch-rejected URLs", async () => {
    discoverFeedForUrlMock.mockResolvedValue(
      makeFetchResult({
        rejectedCandidates: [
          { feedUrl: "https://example.com/rss", detection: "direct-feed", score: 30, contentType: null, reason: "did not validate" },
        ],
      }),
    );

    resolveFeedsWithBrowserMock.mockResolvedValue({
      candidates: [
        { feedUrl: "https://example.com/rss", source: "dom-link" },
      ],
      method: "jsdom",
      renderedDomAvailable: true,
    });

    const { discoverFeedWithBrowserFallback } = await import("./hard-case-consumer");
    const result = await discoverFeedWithBrowserFallback({
      pageUrl: "https://example.com/news",
    });

    // Should report browser attempted but all duplicates
    expect(result.meta.browserAttempted).toBe(true);
    expect(result.meta.browserCandidateCount).toBe(1);
    expect(result.meta.resolverPath).toBe("none");

    // verifyFeedCandidate should NOT have been called (all were duplicates)
    expect(verifyFeedCandidateMock).not.toHaveBeenCalled();

    const duplicatesLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0].status === "BROWSER_RESOLUTION_ALL_DUPLICATES",
    );
    expect(duplicatesLog).toBeDefined();
    expect(duplicatesLog?.[0]?.sourceId).toBeUndefined();
  });
});

// ─── Chain Pipeline Rerun Tests ────────────────────────────────────────────

const makePipelineResult = (overrides: Record<string, unknown> = {}) => ({
  sourcesScanned: 1,
  candidatesFound: 3,
  inserted: 2,
  skipped: 1,
  failed: 0,
  artifactCount: 1,
  ...overrides,
});

const makeQueueItem = (overrides: Record<string, unknown> = {}) => ({
  id: "artifact-1",
  sourceId: "src-1",
  categoryId: null as string | null,
  payload: {
    targetType: "source",
    sourceId: "src-1",
    targetUrl: "https://example.com/news",
    existingFeedUrl: null,
    queueReason: "no_feed_discovered",
  },
  ...overrides,
});

describe("processHardCaseDiscoveryQueue chain behavior", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: prisma mocks return empty
    prismaFindManyMock.mockResolvedValue([]);
    prismaUpdateMock.mockResolvedValue({});
    prismaSourceCategoryUpdateMock.mockResolvedValue({});
    prismaNewsSourceUpdateMock.mockResolvedValue({});
  });

  it("returns zeroed counts and no rerun for empty queue", async () => {
    prismaFindManyMock.mockResolvedValue([]);

    const { processHardCaseDiscoveryQueue } = await import("./hard-case-consumer");
    const result = await processHardCaseDiscoveryQueue(10);

    expect(result.processed).toBe(0);
    expect(result.resolved).toBe(0);
    expect(result.rerunTriggered).toBe(false);
    expect(result.rerunTargetCount).toBe(0);
    expect(result.rerunResult).toBeNull();
    expect(result.rerunError).toBeNull();
    expect(runNewsPipelineMock).not.toHaveBeenCalled();
  });

  it("does not trigger pipeline rerun when no targets are resolved", async () => {
    prismaFindManyMock.mockResolvedValue([makeQueueItem()]);
    discoverFeedForUrlMock.mockResolvedValue(makeFetchResult());
    resolveFeedsWithBrowserMock.mockResolvedValue({
      candidates: [],
      method: "none",
      renderedDomAvailable: false,
    });

    const { processHardCaseDiscoveryQueue } = await import("./hard-case-consumer");
    const result = await processHardCaseDiscoveryQueue(10);

    expect(result.resolved).toBe(0);
    expect(result.rerunTriggered).toBe(false);
    expect(result.rerunTargetCount).toBe(0);
    expect(result.rerunResult).toBeNull();
    expect(result.rerunError).toBeNull();
    expect(runNewsPipelineMock).not.toHaveBeenCalled();

    const skippedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0].status === "HARD_CASE_CHAIN_PIPELINE_SKIPPED",
    );
    expect(skippedLog).toBeDefined();
  });

  it("triggers targeted pipeline rerun when a source target is resolved", async () => {
    prismaFindManyMock.mockResolvedValue([makeQueueItem()]);
    // Discovery succeeds (fetch-based)
    discoverFeedForUrlMock.mockResolvedValue(
      makeFetchResult({
        feedUrl: "https://example.com/rss.xml",
        discoveredVia: "https://example.com/news",
        detection: "html-link",
        score: 65,
        scopeConfidence: "medium",
      }),
    );
    runNewsPipelineMock.mockResolvedValue(makePipelineResult());

    const { processHardCaseDiscoveryQueue } = await import("./hard-case-consumer");
    const result = await processHardCaseDiscoveryQueue(10);

    expect(result.resolved).toBe(1);
    expect(result.rerunTriggered).toBe(true);
    expect(result.rerunTargetCount).toBe(1);
    expect(result.rerunResult).not.toBeNull();
    expect(result.rerunResult?.inserted).toBe(2);
    expect(result.rerunError).toBeNull();

    // Should call runNewsPipeline with the specific sourceId
    expect(runNewsPipelineMock).toHaveBeenCalledWith(["src-1"], undefined);

    // Should log chain started and finished
    const startedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0].status === "HARD_CASE_CHAIN_PIPELINE_STARTED",
    );
    expect(startedLog).toBeDefined();
    expect(startedLog?.[0]?.errorLog).toContain("1 unique target(s)");

    const finishedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0].status === "HARD_CASE_CHAIN_PIPELINE_FINISHED",
    );
    expect(finishedLog).toBeDefined();
    expect(finishedLog?.[0]?.errorLog).toContain("inserted=2");
  });

  it("triggers targeted pipeline rerun with category-specific targets", async () => {
    prismaFindManyMock.mockResolvedValue([
      makeQueueItem({
        id: "artifact-cat",
        sourceId: "src-1",
        categoryId: "cat-1",
        payload: {
          targetType: "category",
          sourceId: "src-1",
          categoryId: "cat-1",
          targetUrl: "https://example.com/sport",
          existingFeedUrl: null,
          queueReason: "no_feed_discovered",
        },
      }),
    ]);
    discoverFeedForUrlMock.mockResolvedValue(
      makeFetchResult({
        feedUrl: "https://example.com/sport/rss",
        discoveredVia: "https://example.com/sport",
        detection: "html-link",
        score: 60,
        scopeConfidence: "medium",
      }),
    );
    runNewsPipelineMock.mockResolvedValue(makePipelineResult());

    const { processHardCaseDiscoveryQueue } = await import("./hard-case-consumer");
    const result = await processHardCaseDiscoveryQueue(10);

    expect(result.resolved).toBe(1);
    expect(result.rerunTriggered).toBe(true);
    expect(result.rerunTargetCount).toBe(1);

    // Should call runNewsPipeline with sourceId AND categoryId
    expect(runNewsPipelineMock).toHaveBeenCalledWith(["src-1"], ["cat-1"]);
  });

  it("deduplicates resolved targets before triggering rerun", async () => {
    // Two queue items for the same source (e.g., different paths resolved)
    prismaFindManyMock.mockResolvedValue([
      makeQueueItem({ id: "artifact-1", sourceId: "src-1" }),
      makeQueueItem({
        id: "artifact-2",
        sourceId: "src-1",
        payload: {
          targetType: "source",
          sourceId: "src-1",
          targetUrl: "https://example.com/tech",
          existingFeedUrl: null,
          queueReason: "no_feed_discovered",
        },
      }),
    ]);
    discoverFeedForUrlMock.mockResolvedValue(
      makeFetchResult({
        feedUrl: "https://example.com/rss.xml",
        discoveredVia: "https://example.com/news",
        detection: "html-link",
        score: 65,
      }),
    );
    runNewsPipelineMock.mockResolvedValue(makePipelineResult());

    const { processHardCaseDiscoveryQueue } = await import("./hard-case-consumer");
    const result = await processHardCaseDiscoveryQueue(10);

    // Both items resolved
    expect(result.resolved).toBe(2);
    // But only 1 unique target for rerun
    expect(result.rerunTargetCount).toBe(1);
    expect(result.rerunTriggered).toBe(true);

    // runNewsPipeline called with deduplicated sourceId (only once)
    expect(runNewsPipelineMock).toHaveBeenCalledTimes(1);
    expect(runNewsPipelineMock).toHaveBeenCalledWith(["src-1"], undefined);
  });

  it("collects mixed source and category targets correctly", async () => {
    prismaFindManyMock.mockResolvedValue([
      makeQueueItem({ id: "artifact-src", sourceId: "src-1" }),
      makeQueueItem({
        id: "artifact-cat",
        sourceId: "src-2",
        categoryId: "cat-2",
        payload: {
          targetType: "category",
          sourceId: "src-2",
          categoryId: "cat-2",
          targetUrl: "https://other.com/sport",
          existingFeedUrl: null,
          queueReason: "no_feed_discovered",
        },
      }),
    ]);
    discoverFeedForUrlMock.mockResolvedValue(
      makeFetchResult({
        feedUrl: "https://example.com/rss.xml",
        detection: "html-link",
        score: 65,
      }),
    );
    runNewsPipelineMock.mockResolvedValue(makePipelineResult());

    const { processHardCaseDiscoveryQueue } = await import("./hard-case-consumer");
    const result = await processHardCaseDiscoveryQueue(10);

    expect(result.resolved).toBe(2);
    expect(result.rerunTargetCount).toBe(2);

    // Source-level target gets its own sourceId; category target's sourceId
    // is only included as fallback when no source-level targets exist.
    // Here src-1 is source-level, so only src-1 in sourceIds; cat-2 in categoryIds.
    expect(runNewsPipelineMock).toHaveBeenCalledWith(["src-1"], ["cat-2"]);
  });

  it("falls back to category-parent sourceIds when only category targets resolved", async () => {
    prismaFindManyMock.mockResolvedValue([
      makeQueueItem({
        id: "artifact-cat",
        sourceId: "src-3",
        categoryId: "cat-3",
        payload: {
          targetType: "category",
          sourceId: "src-3",
          categoryId: "cat-3",
          targetUrl: "https://other.com/tech",
          existingFeedUrl: null,
          queueReason: "no_feed_discovered",
        },
      }),
    ]);
    discoverFeedForUrlMock.mockResolvedValue(
      makeFetchResult({
        feedUrl: "https://other.com/tech/rss",
        detection: "html-link",
        score: 60,
      }),
    );
    runNewsPipelineMock.mockResolvedValue(makePipelineResult());

    const { processHardCaseDiscoveryQueue } = await import("./hard-case-consumer");
    const result = await processHardCaseDiscoveryQueue(10);

    expect(result.resolved).toBe(1);
    expect(result.rerunTriggered).toBe(true);
    // Fallback: use category-parent sourceId so hydratePipelineTargets works
    expect(runNewsPipelineMock).toHaveBeenCalledWith(["src-3"], ["cat-3"]);
  });

  it("captures rerunError when pipeline rerun fails", async () => {
    prismaFindManyMock.mockResolvedValue([makeQueueItem()]);
    discoverFeedForUrlMock.mockResolvedValue(
      makeFetchResult({
        feedUrl: "https://example.com/rss.xml",
        detection: "html-link",
        score: 65,
      }),
    );
    runNewsPipelineMock.mockRejectedValue(new Error("Database connection lost"));

    const { processHardCaseDiscoveryQueue } = await import("./hard-case-consumer");
    const result = await processHardCaseDiscoveryQueue(10);

    expect(result.resolved).toBe(1);
    expect(result.rerunTriggered).toBe(true);
    expect(result.rerunResult).toBeNull();
    expect(result.rerunError).toBe("Database connection lost");

    const finishedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0].status === "HARD_CASE_CHAIN_PIPELINE_FINISHED",
    );
    expect(finishedLog).toBeDefined();
    expect(finishedLog?.[0]?.errorLog).toContain("failed");
  });
});
