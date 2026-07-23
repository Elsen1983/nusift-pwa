import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  newsSource: { findUnique: vi.fn() },
  sourceCategory: { findUnique: vi.fn() },
  pipelineArtifact: { findFirst: vi.fn(), findMany: vi.fn() },
  article: { findMany: vi.fn() },
}));

const discoverArticlesFromTargetMock = vi.hoisted(() => vi.fn());
const persistArticleDiscoveryArtifactMock = vi.hoisted(() => vi.fn());
const createPipelineRunMock = vi.hoisted(() => vi.fn());
const persistCandidatesMock = vi.hoisted(() => vi.fn());
const discoverArticleLinksWithBrowserMock = vi.hoisted(() => vi.fn());
const evaluateArticleLinkCandidateWithBrowserMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  promises: {
    mkdir: mkdirMock,
    writeFile: writeFileMock,
  },
}));
vi.mock("../prisma", () => ({ prisma: prismaMock }));
vi.mock("./artifacts", () => ({ createPipelineRun: createPipelineRunMock }));
vi.mock("./ingest", () => ({ persistCandidates: persistCandidatesMock }));
vi.mock("./article-discovery", () => ({
  discoverArticlesFromTarget: discoverArticlesFromTargetMock,
  persistArticleDiscoveryArtifact: persistArticleDiscoveryArtifactMock,
}));
vi.mock("./article-discovery-browser", () => ({
  discoverArticleLinksWithBrowser: discoverArticleLinksWithBrowserMock,
  evaluateArticleLinkCandidateWithBrowser: evaluateArticleLinkCandidateWithBrowserMock,
  isBrowserFallbackEnabled: () => process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK === "true",
}));

const sourceRow = {
  id: "src-1",
  mediaName: "Example",
  frontPageUrl: "https://example.com",
  rssStatus: "NO_RSS_FOUND",
  currentFeedProductive: false,
  consecutiveNonProductiveRuns: 2,
};

const categoryRow = {
  id: "cat-1",
  newsSourceId: "src-1",
  name: "Politics",
  pathUrl: "https://example.com/politics",
  rssStatus: "NO_RSS_FOUND",
  currentFeedProductive: false,
  consecutiveNonProductiveRuns: 4,
};

const stateRow = {
  id: "cat-1",
  pathUrl: "https://example.com/politics",
  rssStatus: "NO_RSS_FOUND",
  rssFeedUrl: null,
  currentFeedProductive: false,
  consecutiveNonProductiveRuns: 4,
  lastRssCheckAt: new Date("2026-07-22T10:00:00Z"),
};

const discoveryResult = {
  targetType: "category",
  sourceId: "src-1",
  categoryId: "cat-1",
  targetUrl: "https://example.com/politics",
  discoveryMethod: "jsdom",
  discoverySources: { listingPages: 1, sitemapUrls: 0, jsonldUrls: 0 },
  listingDiagnostics: [{ url: "https://example.com/politics", status: 200, htmlLength: 1000 }],
  pagesVisited: ["https://example.com/politics"],
  candidates: [{ canonicalUrl: "https://example.com/politics/a" }],
  failed: 0,
  skipSummary: {},
  rejectedItems: [],
  outcomeSummary: {
    totalEvaluated: 1,
    accepted: 1,
    rejected: 0,
    byStatus: { accepted: 1 },
    bySourceKind: { listing: 1 },
    topRejectionReasons: [],
  },
  acceptedOutcomes: [{ status: "accepted", url: "https://example.com/politics/a" }],
  rejectedOutcomes: [],
  qualityAssessment: {
    quality: "productive",
    confidence: "high",
    shouldEscalateToHeadless: false,
    escalationReasons: [],
    explanation: "ok",
  },
};

describe("Agent 2 local parity helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "false";
    prismaMock.newsSource.findUnique.mockResolvedValue(sourceRow);
    prismaMock.sourceCategory.findUnique.mockResolvedValue(categoryRow);
    prismaMock.pipelineArtifact.findFirst.mockResolvedValue(null);
    prismaMock.pipelineArtifact.findMany.mockResolvedValue([]);
    prismaMock.article.findMany.mockResolvedValue([]);
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    discoverArticlesFromTargetMock.mockResolvedValue(discoveryResult);
    createPipelineRunMock.mockResolvedValue({ id: "run-1" });
    persistArticleDiscoveryArtifactMock.mockResolvedValue({ id: "artifact-1" });
    persistCandidatesMock.mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });
  });

  it("builds a source target", async () => {
    const { buildAgent2Target } = await import("./agent2-dev-parity");
    const target = await buildAgent2Target({ sourceId: "src-1" });

    expect(target).toMatchObject({
      targetType: "source",
      sourceId: "src-1",
      categoryId: null,
      targetUrl: "https://example.com",
    });
  });

  it("builds a category target", async () => {
    const { buildAgent2Target } = await import("./agent2-dev-parity");
    const target = await buildAgent2Target({ sourceId: "src-1", categoryId: "cat-1" });

    expect(target).toMatchObject({
      targetType: "category",
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://example.com/politics",
    });
  });

  it("runs static mode without persistence by default", async () => {
    prismaMock.sourceCategory.findUnique.mockResolvedValueOnce(categoryRow).mockResolvedValue(stateRow);
    const { runAgent2TargetDebug } = await import("./agent2-dev-parity");

    const result = await runAgent2TargetDebug({ sourceId: "src-1", categoryId: "cat-1" });

    expect(result.persist).toBe(false);
    expect(result.static.accepted).toBe(1);
    expect(createPipelineRunMock).not.toHaveBeenCalled();
    expect(persistArticleDiscoveryArtifactMock).not.toHaveBeenCalled();
    expect(persistCandidatesMock).not.toHaveBeenCalled();
    expect(result.before).toEqual(result.after);
  });

  it("uses existing persistence helpers when persist=true", async () => {
    prismaMock.sourceCategory.findUnique
      .mockResolvedValueOnce(categoryRow)
      .mockResolvedValueOnce(stateRow)
      .mockResolvedValueOnce(stateRow);
    const { runAgent2TargetDebug } = await import("./agent2-dev-parity");

    const result = await runAgent2TargetDebug({ sourceId: "src-1", categoryId: "cat-1", persist: true });

    expect(createPipelineRunMock).toHaveBeenCalledWith(1);
    expect(persistArticleDiscoveryArtifactMock).toHaveBeenCalled();
    expect(persistCandidatesMock).toHaveBeenCalledWith(discoveryResult.candidates);
    expect(result.persistence).toMatchObject({
      pipelineRunId: "run-1",
      artifactId: "artifact-1",
      candidates: { inserted: 1, skipped: 0, failed: 0 },
    });
  });

  it("includes environment and target snapshots", async () => {
    prismaMock.sourceCategory.findUnique.mockResolvedValueOnce(categoryRow).mockResolvedValue(stateRow);
    const { runAgent2TargetDebug } = await import("./agent2-dev-parity");

    const result = await runAgent2TargetDebug({ sourceId: "src-1", categoryId: "cat-1" });

    expect(result.environment.nodeVersion).toMatch(/^v/);
    expect(result.environment.browserFallbackEnabled).toBe(false);
    expect(result.before).toMatchObject({
      sourceId: "src-1",
      categoryId: "cat-1",
      rssStatus: "NO_RSS_FOUND",
      consecutiveNonProductiveRuns: 4,
    });
  });

  it("exports a capped, non-secret fixture", async () => {
    prismaMock.pipelineArtifact.findMany.mockResolvedValue([
      {
        id: "pa-1",
        artifactType: "article_discovery_candidates",
        status: "CAPTURED",
        candidateCount: 3,
        createdAt: new Date("2026-07-22T10:00:00Z"),
        updatedAt: new Date("2026-07-22T10:00:00Z"),
        pipelineRunId: "run-1",
        sourceId: "src-1",
        categoryId: "cat-1",
        payload: { targetUrl: "https://example.com/politics", candidates: [{ huge: true }] },
        errorLog: "x".repeat(1000),
      },
    ]);
    prismaMock.article.findMany.mockResolvedValue([{ id: 1, canonicalUrl: "https://example.com/a" }]);
    const { exportAgent2Fixture } = await import("./agent2-dev-parity");

    const result = await exportAgent2Fixture({
      sourceId: "src-1",
      categoryId: "cat-1",
      out: "data/fixtures/agent2/example.json",
    });

    expect(prismaMock.pipelineArtifact.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
    expect(prismaMock.article.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }));
    const writeCall = writeFileMock.mock.calls[0];
    expect(writeCall).toBeTruthy();
    const fixture = JSON.parse(String(writeCall![1]));
    expect(JSON.stringify(fixture)).not.toContain("\"huge\":true");
    expect(fixture.artifacts[0].errorLog).toHaveLength(500);
    expect(result).toMatchObject({ artifacts: 1, articles: 1 });
  });
});
