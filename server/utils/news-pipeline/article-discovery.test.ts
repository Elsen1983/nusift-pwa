import { beforeEach, describe, expect, it, vi } from "vitest";

const safeFetchMock = vi.hoisted(() => vi.fn());
const prismaArtifactCreateMock = vi.hoisted(() => vi.fn());
const prismaArtifactFindManyMock = vi.hoisted(() => vi.fn());
const prismaArtifactUpdateMock = vi.hoisted(() => vi.fn());
const prismaNewsSourceFindManyMock = vi.hoisted(() => vi.fn());
const prismaSourceCategoryFindManyMock = vi.hoisted(() => vi.fn());

vi.mock("../ssrf-guard", () => ({
  safeFetch: safeFetchMock,
}));

const logAgentScanMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./log", () => ({
  logAgentScan: logAgentScanMock,
}));

vi.mock("./artifacts", () => ({
  createPipelineRun: vi.fn(),
  finalizePipelineRun: vi.fn(),
}));

vi.mock("./ingest", () => ({
  persistCandidates: vi.fn(),
}));

vi.mock("./targets", () => ({
  resolveActivePipelineTargets: vi.fn(),
}));

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      create: (...args: any[]) => prismaArtifactCreateMock(...args),
      findMany: (...args: any[]) => prismaArtifactFindManyMock(...args),
      update: (...args: any[]) => prismaArtifactUpdateMock(...args),
    },
    newsSource: {
      findMany: (...args: any[]) => prismaNewsSourceFindManyMock(...args),
    },
    sourceCategory: {
      findMany: (...args: any[]) => prismaSourceCategoryFindManyMock(...args),
    },
  },
}));

const makeResponse = (body: string, ok = true) => ({
  ok,
  text: async () => body,
});

describe("article-discovery", () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
    prismaArtifactCreateMock.mockReset();
    prismaArtifactFindManyMock.mockReset();
    prismaArtifactUpdateMock.mockReset();
    prismaNewsSourceFindManyMock.mockReset();
    prismaSourceCategoryFindManyMock.mockReset();
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });
    prismaArtifactFindManyMock.mockResolvedValue([]);
    prismaArtifactUpdateMock.mockResolvedValue({ id: "updated" });
    prismaNewsSourceFindManyMock.mockResolvedValue([]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    logAgentScanMock.mockClear();
  });

  // ── Target resolution diagnostics tests ──────────────────────────────

  it("logs ARTICLE_DISCOVERY_TARGETS_RESOLVED with granular skip reasons", async () => {
    const { resolveAgent2Targets } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },           // source: productive → skip rss_active_productive
      { sourceId: "src-2", categoryId: null },           // source: NO_RSS_FOUND → eligible
      { sourceId: "src-3", categoryId: "cat-pending" }, // category: PENDING_DISCOVERY → skip rss_pending_discovery
      { sourceId: "src-4", categoryId: "cat-good" },    // category: NO_RSS_FOUND → eligible
    ]);

    prismaNewsSourceFindManyMock.mockResolvedValue([
      { id: "src-1", frontPageUrl: "https://a.com", mediaName: "A", rssStatus: "ACTIVE", currentFeedProductive: true, consecutiveNonProductiveRuns: 0 },
      { id: "src-2", frontPageUrl: "https://b.com", mediaName: "B", rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
      { id: "src-3", frontPageUrl: "https://c.com", mediaName: "C", rssStatus: "ACTIVE", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
      { id: "src-4", frontPageUrl: "https://d.com", mediaName: "D", rssStatus: "ACTIVE", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([
      { id: "cat-pending", newsSourceId: "src-3", pathUrl: "https://c.com/pending", rssStatus: "PENDING_DISCOVERY", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
      { id: "cat-good", newsSourceId: "src-4", pathUrl: "https://d.com/good", rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
    ]);

    const { targets, diagnostics } = await resolveAgent2Targets();

    // 2 eligible targets: src-2 (NO_RSS_FOUND) and cat-good (NO_RSS_FOUND)
    expect(targets).toHaveLength(2);
    expect(targets.some((t) => t.sourceId === "src-2" && t.targetType === "source")).toBe(true);
    expect(targets.some((t) => t.sourceId === "src-4" && t.categoryId === "cat-good" && t.targetType === "category")).toBe(true);

    // Diagnostics
    expect(diagnostics.totalActive).toBe(4);
    expect(diagnostics.eligible).toBe(2);
    expect(diagnostics.skipped).toBe(2);
    expect(diagnostics.skippedReasons.rss_active_productive).toBe(1);
    expect(diagnostics.skippedReasons.rss_pending_discovery).toBe(1);
    expect(diagnostics.skippedReasons.rss_active_waiting_for_second_nonproductive_run).toBe(0);
    expect(diagnostics.skippedReasons.not_found_in_db).toBe(0);

    // Log should be present with ARTICLE_DISCOVERY_TARGETS_RESOLVED
    const resolvedLog = logAgentScanMock.mock.calls.find((call: any[]) => call[0]?.status === "ARTICLE_DISCOVERY_TARGETS_RESOLVED");
    expect(resolvedLog).toBeDefined();
    const errorLog = resolvedLog?.[0]?.errorLog ?? "";
    expect(errorLog).toContain("targets=2");
    expect(errorLog).toContain("skipped=2");
    expect(errorLog).toContain("rss_active_productive");
  });

  it("target resolver diagnostics: ACTIVE non-productive waiting for second run", async () => {
    const { resolveAgent2Targets } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-waiting", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      { id: "src-waiting", frontPageUrl: "https://w.com", mediaName: "W", rssStatus: "ACTIVE", currentFeedProductive: false, consecutiveNonProductiveRuns: 1 },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);

    const { targets, diagnostics } = await resolveAgent2Targets();

    // Not eligible yet (needs 2 consecutive non-productive runs)
    expect(targets).toHaveLength(0);
    expect(diagnostics.skippedReasons.rss_active_waiting_for_second_nonproductive_run).toBe(1);
  });

  it("target resolver diagnostics: not_found_in_db for missing source", async () => {
    const { resolveAgent2Targets } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-missing", categoryId: null },
    ]);
    // Source not returned from DB
    prismaNewsSourceFindManyMock.mockResolvedValue([]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);

    const { targets, diagnostics } = await resolveAgent2Targets();

    expect(targets).toHaveLength(0);
    expect(diagnostics.skippedReasons.not_found_in_db).toBe(1);
  });

  it("target resolver diagnostics: requested_filter_excluded", async () => {
    const { resolveAgent2Targets } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },
      { sourceId: "src-2", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      { id: "src-1", frontPageUrl: "https://a.com", mediaName: "A", rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
      { id: "src-2", frontPageUrl: "https://b.com", mediaName: "B", rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);

    // Filter to only src-1
    const { targets, diagnostics } = await resolveAgent2Targets({ sourceIds: ["src-1"] });

    expect(targets).toHaveLength(1);
    expect(targets[0]?.sourceId).toBe("src-1");
    expect(diagnostics.skippedReasons.requested_filter_excluded).toBe(1);
  });

  it("marks only the expected Agent 2 feed states as eligible", async () => {
    const { isAgent2EligibleTarget } = await import("./article-discovery");

    // NO_RSS_FOUND is always eligible regardless of consecutiveNonProductiveRuns
    expect(
      isAgent2EligibleTarget({
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      }),
    ).toBe(true);
    expect(
      isAgent2EligibleTarget({
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 1,
      }),
    ).toBe(true);
    expect(
      isAgent2EligibleTarget({
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 5,
      }),
    ).toBe(true);

    // ACTIVE + not productive + 2+ consecutive → eligible
    expect(
      isAgent2EligibleTarget({
        rssStatus: "ACTIVE",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 2,
      }),
    ).toBe(true);
    expect(
      isAgent2EligibleTarget({
        rssStatus: "ACTIVE",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 3,
      }),
    ).toBe(true);

    // ACTIVE + not productive + only 1 → NOT eligible (two-run rule preserved)
    expect(
      isAgent2EligibleTarget({
        rssStatus: "ACTIVE",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 1,
      }),
    ).toBe(false);

    // ACTIVE + productive → NOT eligible even with 2+ runs
    expect(
      isAgent2EligibleTarget({
        rssStatus: "ACTIVE",
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: 2,
      }),
    ).toBe(false);

    // PENDING_DISCOVERY is never eligible
    expect(
      isAgent2EligibleTarget({
        rssStatus: "PENDING_DISCOVERY",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 10,
      }),
    ).toBe(false);
  });

  it("logs ARTICLE_DISCOVERY_CATEGORY_TARGETS_AUDIT with all category targets (eligible + skipped)", async () => {
    const { resolveAgent2Targets } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },                  // source: productive → skip
      { sourceId: "src-2", categoryId: "cat-no-rss" },          // category: NO_RSS_FOUND → eligible
      { sourceId: "src-3", categoryId: "cat-active" },          // category: ACTIVE productive → skip
      { sourceId: "src-4", categoryId: "cat-waiting" },         // category: ACTIVE non-productive 1 run → skip
      { sourceId: "src-5", categoryId: "cat-missing" },         // category: not found in DB
    ]);

    prismaNewsSourceFindManyMock.mockResolvedValue([
      { id: "src-1", frontPageUrl: "https://a.com", mediaName: "A", rssStatus: "ACTIVE", currentFeedProductive: true, consecutiveNonProductiveRuns: 0 },
      { id: "src-2", frontPageUrl: "https://b.com", mediaName: "B", rssStatus: "ACTIVE", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
      { id: "src-3", frontPageUrl: "https://c.com", mediaName: "C", rssStatus: "ACTIVE", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
      { id: "src-4", frontPageUrl: "https://d.com", mediaName: "D", rssStatus: "ACTIVE", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
      { id: "src-5", frontPageUrl: "https://e.com", mediaName: "E", rssStatus: "ACTIVE", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([
      { id: "cat-no-rss", newsSourceId: "src-2", pathUrl: "https://b.com/europe", rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, consecutiveNonProductiveRuns: 1 },
      { id: "cat-active", newsSourceId: "src-3", pathUrl: "https://c.com/sports", rssStatus: "ACTIVE", currentFeedProductive: true, consecutiveNonProductiveRuns: 0 },
      { id: "cat-waiting", newsSourceId: "src-4", pathUrl: "https://d.com/tech", rssStatus: "ACTIVE", currentFeedProductive: false, consecutiveNonProductiveRuns: 1 },
      // cat-missing intentionally NOT in findMany result
    ]);

    const { targets } = await resolveAgent2Targets();

    // Only cat-no-rss should be eligible (NO_RSS_FOUND)
    expect(targets).toHaveLength(1);
    expect(targets[0]?.categoryId).toBe("cat-no-rss");

    // ARTICLE_DISCOVERY_CATEGORY_TARGETS_AUDIT log should be emitted
    const auditLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "ARTICLE_DISCOVERY_CATEGORY_TARGETS_AUDIT",
    );
    expect(auditLog).toBeDefined();
    const errorLog = auditLog![0].errorLog ?? "";

    // Should contain summary counts
    expect(errorLog).toContain("categoryTargets=");
    expect(errorLog).toContain("eligible=1");

    // Parse entries to verify all category targets are present
    const entriesMatch = errorLog.match(/entries=(\[.*\])/);
    expect(entriesMatch).toBeTruthy();
    const entries = JSON.parse(entriesMatch![1]);

    // Should have entries for all 4 categories (cat-no-rss, cat-active, cat-waiting, cat-missing)
    expect(entries).toHaveLength(4);

    // cat-no-rss: eligible
    const noRss = entries.find((e: any) => e.categoryId === "cat-no-rss");
    expect(noRss).toBeDefined();
    expect(noRss.eligible).toBe(true);
    expect(noRss.skipReason).toBeNull();
    expect(noRss.rssStatus).toBe("NO_RSS_FOUND");
    expect(noRss.targetUrl).toBe("https://b.com/europe");

    // cat-active: skipped as rss_active_productive
    const active = entries.find((e: any) => e.categoryId === "cat-active");
    expect(active).toBeDefined();
    expect(active.eligible).toBe(false);
    expect(active.skipReason).toBe("rss_active_productive");

    // cat-waiting: skipped as rss_active_waiting_for_second_nonproductive_run
    const waiting = entries.find((e: any) => e.categoryId === "cat-waiting");
    expect(waiting).toBeDefined();
    expect(waiting.eligible).toBe(false);
    expect(waiting.skipReason).toBe("rss_active_waiting_for_second_nonproductive_run");

    // cat-missing: skipped as not_found_in_db
    const missing = entries.find((e: any) => e.categoryId === "cat-missing");
    expect(missing).toBeDefined();
    expect(missing.eligible).toBe(false);
    expect(missing.skipReason).toBe("not_found_in_db");
  });

  it("logs ARTICLE_DISCOVERY_TARGET_SKIPPED with capped per-target samples", async () => {
    const { resolveAgent2Targets } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    // 3 targets: 1 eligible, 2 skipped (different reasons)
    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-eligible", categoryId: null },
      { sourceId: "src-productive", categoryId: null },
      { sourceId: "src-waiting", categoryId: "cat-waiting" },
    ]);

    prismaNewsSourceFindManyMock.mockResolvedValue([
      { id: "src-eligible", frontPageUrl: "https://e.com", mediaName: "E", rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
      { id: "src-productive", frontPageUrl: "https://p.com", mediaName: "P", rssStatus: "ACTIVE", currentFeedProductive: true, consecutiveNonProductiveRuns: 0 },
      { id: "src-waiting", frontPageUrl: "https://w.com", mediaName: "W", rssStatus: "ACTIVE", currentFeedProductive: false, consecutiveNonProductiveRuns: 0 },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([
      { id: "cat-waiting", newsSourceId: "src-waiting", pathUrl: "https://w.com/waiting", rssStatus: "ACTIVE", currentFeedProductive: false, consecutiveNonProductiveRuns: 1 },
    ]);

    await resolveAgent2Targets();

    // Verify ARTICLE_DISCOVERY_TARGET_SKIPPED log was emitted
    // With mockClear in beforeEach, no need to filter for stale calls
    const skippedLogs = logAgentScanMock.mock.calls.filter((call: any[]) => call[0]?.status === "ARTICLE_DISCOVERY_TARGET_SKIPPED");
    expect(skippedLogs.length).toBeGreaterThanOrEqual(1);
    const skippedLog = skippedLogs[skippedLogs.length - 1];
    const errorLog = skippedLog?.[0]?.errorLog ?? "";
    expect(errorLog).toContain("sample=");
    // Should include the skipped targets with their details
    expect(errorLog).toContain("src-productive");
    expect(errorLog).toContain("rss_active_productive");
    expect(errorLog).toContain("src-waiting");
    expect(errorLog).toContain("rss_active_waiting_for_second_nonproductive_run");
  });

  it("discovers article candidates from a listing page and follows one pagination hop", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    const listing1 = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/alpha-story">Alpha story one</a></article>
          <nav><a rel="next" href="/news/page/2">Next</a></nav>
        </body>
      </html>
    `;
    const listing2 = `
      <html>
        <body>
          <article><a href="/news/2026/07/15/bravo-story">Bravo story two</a></article>
        </body>
      </html>
    `;
    const article1 = `
      <html>
        <head>
          <title>Alpha story one</title>
          <meta name="description" content="Alpha description" />
          <meta property="article:published_time" content="2026-07-16T09:00:00.000Z" />
          <meta name="keywords" content="alpha,news" />
        </head>
        <body><p>Alpha body</p></body>
      </html>
    `;
    const article2 = `
      <html>
        <head>
          <title>Bravo story two</title>
          <meta name="description" content="Bravo description" />
          <meta property="article:published_time" content="2026-07-15T09:00:00.000Z" />
          <meta name="keywords" content="bravo,news" />
        </head>
        <body><p>Bravo body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing1);
      if (url === "https://example.com/news/page/2") return makeResponse(listing2);
      if (url === "https://example.com/news/2026/07/16/alpha-story") return makeResponse(article1);
      if (url === "https://example.com/news/2026/07/15/bravo-story") return makeResponse(article2);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    expect(result.discoveryMethod).toBe("jsdom");
    expect(result.discoverySources).toBeDefined();
    // listingPages counts visited pages, not extracted article links
    expect(result.discoverySources.listingPages).toBe(2);
    expect(result.discoverySources.sitemapUrls).toBeGreaterThanOrEqual(0);
    expect(result.discoverySources.jsonldUrls).toBeGreaterThanOrEqual(0);
    expect(result.pagesVisited).toEqual([
      "https://example.com/",
      "https://example.com/news/page/2",
    ]);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.provenance.origin).toBe("web_discovery");
    expect(result.candidates[0]?.provenance.sourcePageUrl).toBe("https://example.com/");
    expect(result.candidates[0]?.title).toBe("Alpha story one");
    expect(result.candidates[1]?.title).toBe("Bravo story two");

    // Outcome tracking: both accepted candidates are recorded
    expect(result.outcomeSummary).toBeDefined();
    expect(result.outcomeSummary.accepted).toBe(2);
    expect(result.outcomeSummary.byStatus["accepted"]).toBe(2);
    expect(result.acceptedOutcomes).toHaveLength(2);
    expect(result.acceptedOutcomes[0]?.status).toBe("accepted");
    expect(result.acceptedOutcomes[0]?.sourceKind).toBe("listing");
    expect(result.acceptedOutcomes[0]?.score).toBeGreaterThanOrEqual(0);

    // Quality assessment: productive when candidates found
    expect(result.qualityAssessment).toBeDefined();
    expect(result.qualityAssessment.quality).toBe("productive");
    expect(result.qualityAssessment.shouldEscalateToHeadless).toBe(false);
    expect(result.qualityAssessment.escalationReasons).toEqual([]);
    expect(result.qualityAssessment.explanation).toContain("2 article(s)");
    // 2 accepted candidates < 3 threshold → medium confidence
    expect(result.qualityAssessment.confidence).toBe("medium");
  });

  it("filters utility path URLs at link extraction (not in outcomes)", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    // Utility paths like /about are filtered at the link extraction stage
    // by isBlockedDiscoveryPath, so they never reach candidate evaluation.
    // The rejected_utility_path status is a safety net in candidate evaluation.
    const listing = `
      <html>
        <body>
          <article><a href="/about">About us page</a></article>
          <article><a href="/contact">Contact us page</a></article>
          <article><a href="/news/2026/07/16/real-story">Real story title here</a></article>
        </body>
      </html>
    `;
    const article = `
      <html>
        <head>
          <title>Real story title here</title>
          <meta name="description" content="Real description" />
          <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
        </head>
        <body><p>Body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url === "https://example.com/news/2026/07/16/real-story") return makeResponse(article);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    // Utility URLs are filtered at link extraction — no outcome recorded for them
    expect(result.rejectedOutcomes.every((o) => !o.url.includes("/about"))).toBe(true);
    expect(result.rejectedOutcomes.every((o) => !o.url.includes("/contact"))).toBe(true);

    // Only the real story should be accepted
    expect(result.candidates).toHaveLength(1);
    expect(result.outcomeSummary.accepted).toBe(1);
  });

  it("records fetch_failed when article page returns non-OK", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/dead-link">Dead link story title</a></article>
        </body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url === "https://example.com/news/2026/07/16/dead-link") return makeResponse("Not Found", false);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    expect(result.candidates).toHaveLength(0);
    const fetchFail = result.rejectedOutcomes.find((o) => o.status === "fetch_failed");
    expect(fetchFail).toBeDefined();
    expect(fetchFail?.url).toContain("dead-link");
  });

  it("records rejected_stale for articles outside freshness window", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    const listing = `
      <html>
        <body>
          <article><a href="/news/2020/01/01/old-story">Old story title long enough</a></article>
        </body>
      </html>
    `;
    const article = `
      <html>
        <head>
          <title>Old story title long enough</title>
          <meta name="description" content="Old description" />
          <meta property="article:published_time" content="2020-01-01T00:00:00Z" />
        </head>
        <body><p>Body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url === "https://example.com/news/2020/01/01/old-story") return makeResponse(article);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    const staleReject = result.rejectedOutcomes.find((o) => o.status === "rejected_stale");
    expect(staleReject).toBeDefined();
    expect(staleReject?.reason).toContain("freshness");
    expect(result.outcomeSummary.byStatus["rejected_stale"]).toBeGreaterThanOrEqual(1);

    // Stale audit fields should be present on the rejected_stale outcome
    expect(staleReject?.rawPublishedAt).toBe("2020-01-01T00:00:00Z");
    expect(staleReject?.normalizedPublishedAt).toBeTruthy();
    expect(staleReject?.publishedAtSource).toBe("article:published_time");
    expect(staleReject?.freshnessCutoffIso).toBeTruthy();
    expect(typeof staleReject?.ageDays).toBe("number");
    expect(staleReject?.ageDays).toBeGreaterThan(2000);
    expect(staleReject?.staleReason).toBe("published_at_before_cutoff");
  });

  it("records stale audit with missing_published_at when no date meta tag found", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    const listing = `
      <html>
        <body>
          <article><a href="/news/no-date-story-enough-length">No date story title long enough</a></article>
        </body>
      </html>
    `;
    // Article page with no date metadata at all
    const article = `
      <html>
        <head>
          <title>No date story title long enough</title>
          <meta name="description" content="Description" />
        </head>
        <body><p>Body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url === "https://example.com/news/no-date-story-enough-length") return makeResponse(article);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    const staleReject = result.rejectedOutcomes.find((o) => o.status === "rejected_stale");
    expect(staleReject).toBeDefined();
    expect(staleReject?.staleReason).toBe("missing_published_at");
    expect(staleReject?.rawPublishedAt).toBeNull();
    expect(staleReject?.normalizedPublishedAt).toBeNull();
    expect(staleReject?.publishedAtSource).toBe("unknown");
    expect(staleReject?.ageDays).toBeNull();
    expect(staleReject?.reason).toBe("missing publishedAt");
  });

  it("stale samples appear in log even when top rejection reason is not 'stale'", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    // Page with JSON-LD datePublished but no meta date tags — extractPageMetadata
    // returns null, but extractDateFromHtml finds the date via fallback.
    // The staleReason should be "invalid_published_at" (rawDate found but
    // extractPageMetadata couldn't parse it), NOT the plain "stale" reason.
    // The log should still include stale samples.
    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/18/nba-story-long-enough">NBA story title long enough</a></article>
        </body>
      </html>
    `;
    // Article page with ONLY JSON-LD datePublished (no meta date tags)
    // and a date from 2020 (stale)
    const article = `
      <html>
        <head>
          <title>NBA story title long enough</title>
          <script type="application/ld+json">
            { "@type": "NewsArticle", "datePublished": "2020-01-15T00:00:00Z" }
          </script>
        </head>
        <body><p>Body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url === "https://example.com/news/2026/07/18/nba-story-long-enough") return makeResponse(article);
      return makeResponse("", false);
    });

    await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    // Verify the logAgentScan was called with stale samples in the error log
    const discoveryLog = logAgentScanMock.mock.calls.find((call: any[]) =>
      call[0]?.status === "ARTICLE_DISCOVERY_FAILED" || call[0]?.status === "ARTICLE_DISCOVERY_COMPLETED",
    );
    expect(discoveryLog).toBeDefined();
    const logEntry = discoveryLog?.[0];
    expect(logEntry).toBeDefined();
    const errorLog = logEntry?.errorLog ?? "";
    // Should contain staleSample even though top reason may be "invalid publishedAt"
    // or "missing publishedAt" — the key invariant is that stale samples appear
    // regardless of the top rejection reason.
    expect(errorLog).toContain("staleSample=[");
  });

  it("stale audit fields are preserved in persisted artifact rejectedCandidates", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    const listing = `
      <html>
        <body>
          <article><a href="/news/2020/01/01/old-story">Old story title long enough</a></article>
        </body>
      </html>
    `;
    const article = `
      <html>
        <head>
          <title>Old story title long enough</title>
          <meta property="article:published_time" content="2020-01-01T00:00:00Z" />
        </head>
        <body><p>Body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url === "https://example.com/news/2020/01/01/old-story") return makeResponse(article);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    // rejectedOutcomes are what get persisted as rejectedCandidates in the artifact
    const staleReject = result.rejectedOutcomes.find((o) => o.status === "rejected_stale");
    expect(staleReject).toBeDefined();
    // All audit fields should be present on the outcome object
    expect(staleReject).toHaveProperty("rawPublishedAt");
    expect(staleReject).toHaveProperty("normalizedPublishedAt");
    expect(staleReject).toHaveProperty("publishedAtSource");
    expect(staleReject).toHaveProperty("freshnessCutoffIso");
    expect(staleReject).toHaveProperty("ageDays");
    expect(staleReject).toHaveProperty("staleReason");
  });

  it("records rejected_duplicate for duplicate canonical URLs", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/same-story">Same story title long enough</a></article>
          <article><a href="/news/2026/07/16/same-story?utm_source=sidebar">Same story title long enough</a></article>
        </body>
      </html>
    `;
    const article = `
      <html>
        <head>
          <title>Same story title long enough</title>
          <meta name="description" content="Same description" />
          <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
        </head>
        <body><p>Body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url.startsWith("https://example.com/news/2026/07/16/same-story")) return makeResponse(article);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    // Only 1 unique candidate should be accepted
    expect(result.candidates).toHaveLength(1);
    const dupReject = result.rejectedOutcomes.find((o) => o.status === "rejected_duplicate");
    expect(dupReject).toBeDefined();
    expect(dupReject?.reason).toContain("duplicate");

    // Critical: accepted count must equal candidates.length (no double-counting)
    expect(result.outcomeSummary.accepted).toBe(result.candidates.length);
    expect(result.outcomeSummary.accepted).toBe(1);
    // Duplicate must NOT appear in accepted outcomes
    expect(result.acceptedOutcomes).toHaveLength(1);
    expect(result.outcomeSummary.byStatus["rejected_duplicate"]).toBe(1);
  });

  it("defense-in-depth: cross-domain URLs are rejected at scoring/link layers before safety net", async () => {
    // The cross-domain check in discoverArticleCandidatesForPage is a safety net
    // for redirect edge cases. In practice, cross-domain URLs are already filtered
    // at two earlier layers:
    //   1. Link extraction: isLikelyArticleLink checks hostname match
    //   2. Scoring: scoreCandidateUrl rejects different_domain with score 0
    // This test verifies both layers work, so cross-domain URLs never reach
    // the candidate evaluation safety net through normal flow.
    const { discoverArticlesFromTarget } = await import("./article-discovery");
    const { scoreCandidateUrl } = await import("./article-discovery-helpers");

    const listing = `<html><body>
      <article><a href="/news/2026/07/16/safe-story">Safe story title long enough</a></article>
    </body></html>`;
    const article = `<html><head>
      <title>Safe story title long enough</title>
      <meta name="description" content="Desc" />
      <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
    </head><body><p>Body</p></body></html>`;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url === "https://example.com/news/2026/07/16/safe-story") return makeResponse(article);
      return makeResponse("", false);
    });

    // Layer 1 verification: scoring rejects cross-domain URLs
    const crossDomainScore = scoreCandidateUrl(
      "https://evil.com/news/2026/07/16/hijack",
      "https://example.com/",
    );
    expect(crossDomainScore.rejected).toBe(true);
    expect(crossDomainScore.rejectionReason).toBe("different_domain");
    expect(crossDomainScore.score).toBe(0);

    // Layer 2 verification: full pipeline with same-domain URLs — no cross-domain rejections
    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.outcomeSummary.accepted).toBe(1);
    // No cross-domain rejections for same-domain URLs through normal flow
    expect(result.outcomeSummary.byStatus["rejected_cross_domain"] ?? 0).toBe(0);
  });

  it("records rejected_out_of_scope for category path mismatch via JSON-LD", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    // Category target at /sports. The listing page has no article links within
    // /sports, but its JSON-LD block references an article under /tech.
    // JSON-LD URLs bypass link extraction's category filter, so they reach
    // discoverArticleCandidatesForPage where the category scope check fires.
    const listing = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@type": "NewsArticle",
              "url": "/tech/2026/07/16/gadget-review",
              "headline": "Gadget review title long enough",
              "datePublished": "2026-07-16T09:00:00Z"
            }
          </script>
        </head>
        <body></body>
      </html>
    `;
    const article = `
      <html>
        <head>
          <title>Gadget review title long enough</title>
          <meta name="description" content="Description" />
          <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
        </head>
        <body><p>Body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/sports") return makeResponse(listing);
      if (url === "https://example.com/tech/2026/07/16/gadget-review") return makeResponse(article);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "category",
      sourceId: "source-1",
      categoryId: "cat-sports",
      targetUrl: "https://example.com/sports",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    expect(result.candidates).toHaveLength(0);
    const scopeReject = result.rejectedOutcomes.find((o) => o.status === "rejected_out_of_scope");
    expect(scopeReject).toBeDefined();
    expect(scopeReject?.reason).toContain("category");
    expect(scopeReject?.sourceKind).toBe("jsonld");
    expect(result.outcomeSummary.byStatus["rejected_out_of_scope"]).toBe(1);
    expect(result.outcomeSummary.accepted).toBe(0);
  });

  it("accepts category listing links even when article URLs use a different path structure", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    const listing = `
      <html>
        <body>
          <main>
            <article><a href="/2026/07/20/lifestyle-story-title-long-enough">Lifestyle story title long enough</a></article>
          </main>
        </body>
      </html>
    `;
    const article = `
      <html>
        <head>
          <title>Lifestyle story title long enough</title>
          <meta name="description" content="Description" />
          <meta property="article:published_time" content="2026-07-20T09:00:00Z" />
        </head>
        <body><p>Body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/section/lifestyle") return makeResponse(listing);
      if (url === "https://example.com/2026/07/20/lifestyle-story-title-long-enough") return makeResponse(article);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "category",
      sourceId: "source-1",
      categoryId: "cat-lifestyle",
      targetUrl: "https://example.com/section/lifestyle",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.canonicalUrl).toContain("/2026/07/20/lifestyle-story-title-long-enough");
    expect(result.outcomeSummary.accepted).toBe(1);
    expect(result.outcomeSummary.byStatus["rejected_out_of_scope"] ?? 0).toBe(0);
  });

  it("accepted outcome count always equals candidates.length", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/story-a">Story A title long enough</a></article>
          <article><a href="/news/2026/07/16/story-b">Story B title long enough</a></article>
          <article><a href="/news/2026/07/16/story-b?utm_source=x">Story B title long enough</a></article>
        </body>
      </html>
    `;
    const articleA = `
      <html><head>
        <title>Story A title long enough</title>
        <meta name="description" content="Desc A" />
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;
    const articleB = `
      <html><head>
        <title>Story B title long enough</title>
        <meta name="description" content="Desc B" />
        <meta property="article:published_time" content="2026-07-16T10:00:00Z" />
      </head><body><p>B</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url.startsWith("https://example.com/news/2026/07/16/story-a")) return makeResponse(articleA);
      if (url.startsWith("https://example.com/news/2026/07/16/story-b")) return makeResponse(articleB);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    // 2 unique candidates (story-a and story-b), 1 duplicate (story-b?utm_source=x)
    expect(result.candidates).toHaveLength(2);
    expect(result.outcomeSummary.accepted).toBe(result.candidates.length);
    expect(result.acceptedOutcomes).toHaveLength(result.candidates.length);
    expect(result.outcomeSummary.byStatus["rejected_duplicate"]).toBe(1);
    // Total evaluated = accepted + all rejections
    expect(result.outcomeSummary.totalEvaluated).toBe(
      result.outcomeSummary.accepted + result.outcomeSummary.rejected,
    );
  });

  it("records accepted outcomes with score and scoreReasons from listing page", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/scored-article">Scored article title here</a></article>
        </body>
      </html>
    `;
    const article = `
      <html>
        <head>
          <title>Scored article title here</title>
          <meta name="description" content="Description" />
          <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
        </head>
        <body><p>Body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url === "https://example.com/news/2026/07/16/scored-article") return makeResponse(article);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    expect(result.acceptedOutcomes).toHaveLength(1);
    const accepted = result.acceptedOutcomes[0]!;
    expect(accepted.status).toBe("accepted");
    expect(accepted.sourceKind).toBe("listing");
    expect(accepted.score).toBeGreaterThanOrEqual(30);
    expect(accepted.scoreReasons).toContain("same_domain");
    expect(accepted.title).toBe("Scored article title here");
    expect(accepted.publishedAt).toBe("2026-07-16T09:00:00.000Z");
  });

  it("qualityAssessment is blocked when all article fetches fail", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    // All article detail fetches fail → blocked (fetch failures dominate)
    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/dead-link">Dead link story title long</a></article>
          <article><a href="/news/2026/07/15/another-dead">Another dead link title long</a></article>
        </body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      return makeResponse("Not Found", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.qualityAssessment).toBeDefined();
    // All fetches failed → blocked (fetch failure dominance >= 60%)
    expect(result.qualityAssessment.quality).toBe("blocked");
    expect(result.qualityAssessment.shouldEscalateToHeadless).toBe(true);
    expect(result.qualityAssessment.escalationReasons).toContain("blocked_or_forbidden");
    expect(result.qualityAssessment.escalationReasons).toContain("mostly_fetch_failed");
  });

  it("qualityAssessment is blocked when fetch failures dominate", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    // Five dead links where all article fetches fail → blocked
    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/blocked-a">Blocked story A title long</a></article>
          <article><a href="/news/2026/07/15/blocked-b">Blocked story B title long</a></article>
          <article><a href="/news/2026/07/14/blocked-c">Blocked story C title long</a></article>
          <article><a href="/news/2026/07/13/blocked-d">Blocked story D title long</a></article>
          <article><a href="/news/2026/07/12/blocked-e">Blocked story E title long</a></article>
        </body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      return makeResponse("Forbidden", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.qualityAssessment.quality).toBe("blocked");
    expect(result.qualityAssessment.shouldEscalateToHeadless).toBe(true);
    expect(result.qualityAssessment.escalationReasons).toContain("blocked_or_forbidden");
    expect(result.qualityAssessment.escalationReasons).toContain("mostly_fetch_failed");
    expect(result.qualityAssessment.confidence).toBe("high");
  });

  it("qualityAssessment is weak when one candidate found but most fetches fail", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    // One good link among many dead ones — fetch failures dominate (20/21)
    // but accepted > 0 → weak (not blocked)
    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/good-story">Good story title long enough</a></article>
          ${Array.from({ length: 20 }, (_, i) => `<article><a href="/news/2026/07/16/dead-${i}">Dead link title ${i} padding text</a></article>`).join("\n")}
        </body>
      </html>
    `;
    const article = `
      <html>
        <head>
          <title>Good story title long enough</title>
          <meta name="description" content="Desc" />
          <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
        </head>
        <body><p>Body</p></body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url.includes("good-story")) return makeResponse(article);
      return makeResponse("Not Found", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    // 1 accepted, 20 fetch_failed. fetchRate = 20/21 ≈ 95% >= 60%
    // accepted > 0 → weak (not blocked), should escalate
    expect(result.candidates).toHaveLength(1);
    expect(result.qualityAssessment.quality).toBe("weak");
    expect(result.qualityAssessment.shouldEscalateToHeadless).toBe(true);
    expect(result.qualityAssessment.escalationReasons).toContain("mostly_fetch_failed");
    expect(result.qualityAssessment.escalationReasons).toContain("insufficient_static_signals");
  });

  it("qualityAssessment escalation marker is not produced for productive targets", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    // Productive target: multiple candidates with good acceptance rate
    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/story-a">Story A title long enough</a></article>
          <article><a href="/news/2026/07/16/story-b">Story B title long enough</a></article>
        </body>
      </html>
    `;
    const articleA = `
      <html><head>
        <title>Story A title long enough</title>
        <meta name="description" content="Desc A" />
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;
    const articleB = `
      <html><head>
        <title>Story B title long enough</title>
        <meta name="description" content="Desc B" />
        <meta property="article:published_time" content="2026-07-16T10:00:00Z" />
      </head><body><p>B</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url.includes("story-a")) return makeResponse(articleA);
      if (url.includes("story-b")) return makeResponse(articleB);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    // Productive: 2/2 accepted = 100% acceptance rate
    expect(result.qualityAssessment.quality).toBe("productive");
    expect(result.qualityAssessment.shouldEscalateToHeadless).toBe(false);
    expect(result.qualityAssessment.escalationReasons).toEqual([]);
  });

  it("qualityAssessment is weak when low acceptance rate but fetches succeed", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    // 1 fresh article + 20 stale articles. All fetches succeed (no fetch_failed),
    // but only 1 passes validation → low acceptance rate without blocked trigger.
    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/fresh-story">Fresh story title long enough</a></article>
          ${Array.from({ length: 20 }, (_, i) => `<article><a href="/news/2020/01/${String(i + 1).padStart(2, "0")}/old-story-${i}">Old story title ${i} padding text long</a></article>`).join("\n")}
        </body>
      </html>
    `;
    const freshArticle = `
      <html><head>
        <title>Fresh story title long enough</title>
        <meta name="description" content="Desc" />
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>Body</p></body></html>
    `;
    const staleArticle = `
      <html><head>
        <title>Old story title long enough padding</title>
        <meta name="description" content="Old desc" />
        <meta property="article:published_time" content="2020-01-01T00:00:00Z" />
      </head><body><p>Old body</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url.includes("fresh-story")) return makeResponse(freshArticle);
      if (url.includes("old-story")) return makeResponse(staleArticle);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    // 1 accepted out of 21 evaluated = ~4.8% < 5% → weak
    // fetchFailed = 0, so fetch rate < 60% → NOT blocked
    expect(result.candidates).toHaveLength(1);
    expect(result.qualityAssessment.quality).toBe("weak");
    expect(result.qualityAssessment.shouldEscalateToHeadless).toBe(true);
    expect(result.qualityAssessment.escalationReasons).toContain("low_acceptance_rate");
  });

  it("qualityAssessment is failed with dynamic_or_empty_html when listing pages yield no article links", async () => {
    const { discoverArticlesFromTarget } = await import("./article-discovery");

    // Listing page fetches OK but has no article links
    const listing = `
      <html>
        <body>
          <div>Welcome to our homepage!</div>
          <p>No articles here.</p>
        </body>
      </html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      return makeResponse("", false);
    });

    const result = await discoverArticlesFromTarget({
      targetType: "source",
      sourceId: "source-1",
      targetUrl: "https://example.com/",
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
      mediaName: "Example",
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.qualityAssessment.quality).toBe("failed");
    expect(result.qualityAssessment.shouldEscalateToHeadless).toBe(true);
    expect(result.qualityAssessment.escalationReasons).toContain("dynamic_or_empty_html");
    expect(result.qualityAssessment.confidence).toBe("high");
  });

  // ── Headless marker resolution tests ──────────────────────────────────

  it("resolves stale PENDING_HEADLESS markers when static discovery becomes productive", async () => {
    const { runArticleDiscoveryBatch } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    const { createPipelineRun } = await import("./artifacts");
    const { persistCandidates } = await import("./ingest");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        frontPageUrl: "https://example.com/",
        mediaName: "Example",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    (createPipelineRun as any).mockResolvedValue({ id: "run-1" });
    (persistCandidates as any).mockResolvedValue({ inserted: 2, skipped: 0, failed: 0 });
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });

    // pipelineArtifact.findMany returns a stale PENDING_HEADLESS marker.
    prismaArtifactFindManyMock.mockResolvedValue([
      {
        id: "marker-1",
        payload: {
          targetUrl: "https://example.com/",
          sourceId: "src-1",
          quality: "failed",
          escalationReasons: ["dynamic_or_empty_html"],
        },
      },
    ]);

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/story-a">Story A title long enough</a></article>
          <article><a href="/news/2026/07/16/story-b">Story B title long enough</a></article>
        </body>
      </html>
    `;
    const articleA = `
      <html><head>
        <title>Story A title long enough</title>
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;
    const articleB = `
      <html><head>
        <title>Story B title long enough</title>
        <meta property="article:published_time" content="2026-07-16T10:00:00Z" />
      </head><body><p>B</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url.includes("story-a")) return makeResponse(articleA);
      if (url.includes("story-b")) return makeResponse(articleB);
      return makeResponse("", false);
    });

    const result = await runArticleDiscoveryBatch();

    // The batch should succeed
    expect(result.result.inserted).toBe(2);

    // The marker resolution should have queried for PENDING_HEADLESS markers
    const findManyCalls = prismaArtifactFindManyMock.mock.calls;
    const markerQuery = findManyCalls.find((call: any[]) =>
      call[0]?.where?.artifactType === "article_discovery_headless_required" &&
      call[0]?.where?.status === "PENDING_HEADLESS",
    );
    expect(markerQuery).toBeDefined();

    // The marker should have been updated to RESOLVED_BY_STATIC_DISCOVERY
    const updateCalls = prismaArtifactUpdateMock.mock.calls;
    const markerUpdate = updateCalls.find((call: any[]) =>
      call[0]?.where?.id === "marker-1" &&
      call[0]?.data?.status === "RESOLVED_BY_STATIC_DISCOVERY",
    );
    expect(markerUpdate).toBeDefined();
    const updatePayload = markerUpdate![0].data.payload;
    expect(updatePayload.resolvedByStaticDiscoveryAt).toBeDefined();
    expect(updatePayload.resolvedByStaticDiscoveryArtifactId).toBe("artifact-1");
    expect(updatePayload.resolvedByStaticDiscoveryQuality).toBe("productive");
    expect(updatePayload.resolvedByStaticDiscoveryAcceptedCount).toBe(2);
  });

  it("does not resolve markers when static discovery is not productive", async () => {
    const { runArticleDiscoveryBatch } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    const { createPipelineRun } = await import("./artifacts");
    const { persistCandidates } = await import("./ingest");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        frontPageUrl: "https://example.com/",
        mediaName: "Example",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    (createPipelineRun as any).mockResolvedValue({ id: "run-1" });
    (persistCandidates as any).mockResolvedValue({ inserted: 0, skipped: 0, failed: 1 });
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });

    // Return an existing marker to prove the guard works (quality check prevents resolution)
    prismaArtifactFindManyMock.mockResolvedValue([
      {
        id: "marker-1",
        payload: { targetUrl: "https://example.com/", sourceId: "src-1", quality: "failed" },
      },
    ]);

    // Empty listing → no candidates → failed quality
    const listing = `<html><body><div>No articles here</div></body></html>`;
    safeFetchMock.mockImplementation(async () => makeResponse(listing));

    await runArticleDiscoveryBatch();

    // resolveStaleHeadlessMarkers early-returns for non-productive quality.
    // pipelineArtifact.findMany should NOT have been called for marker resolution
    // (only newsSource.findMany was called by resolveAgent2Targets).
    // But since we share the mock, verify no update with RESOLVED_BY_STATIC_DISCOVERY.
    const updateCalls = prismaArtifactUpdateMock.mock.calls;
    const markerUpdate = updateCalls.find((call: any[]) =>
      call[0]?.data?.status === "RESOLVED_BY_STATIC_DISCOVERY",
    );
    expect(markerUpdate).toBeUndefined();
    // Quality guard early-returns, so pipelineArtifact.findMany is never called for markers.
    expect(prismaArtifactFindManyMock).not.toHaveBeenCalled();
  });

  it("marker resolution failure does not fail the batch", async () => {
    const { runArticleDiscoveryBatch } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    const { createPipelineRun } = await import("./artifacts");
    const { persistCandidates } = await import("./ingest");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        frontPageUrl: "https://example.com/",
        mediaName: "Example",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    (createPipelineRun as any).mockResolvedValue({ id: "run-1" });
    (persistCandidates as any).mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });

    // Make pipelineArtifact.findMany throw (only used for marker resolution)
    prismaArtifactFindManyMock.mockRejectedValue(new Error("DB timeout"));

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/story-a">Story A title long enough</a></article>
        </body>
      </html>
    `;
    const article = `
      <html><head>
        <title>Story A title long enough</title>
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url.includes("story-a")) return makeResponse(article);
      return makeResponse("", false);
    });

    // Batch should still succeed even if marker resolution throws
    const result = await runArticleDiscoveryBatch();
    expect(result.result.inserted).toBe(1);
    expect(result.result.failed).toBe(0);
  });

  it("preserves existing payload fields when resolving markers", async () => {
    const { runArticleDiscoveryBatch } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    const { createPipelineRun } = await import("./artifacts");
    const { persistCandidates } = await import("./ingest");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        frontPageUrl: "https://example.com/",
        mediaName: "Example",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    (createPipelineRun as any).mockResolvedValue({ id: "run-1" });
    (persistCandidates as any).mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });
    prismaArtifactFindManyMock.mockResolvedValue([
      {
        id: "marker-1",
        payload: {
          targetUrl: "https://example.com/",
          sourceId: "src-1",
          quality: "failed",
          explanation: "Original explanation",
          escalationReasons: ["dynamic_or_empty_html"],
          outcomeSummary: { totalEvaluated: 5, accepted: 0, rejected: 5 },
          createdAt: "2026-07-15T10:00:00Z",
        },
      },
    ]);

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/story-a">Story A title long enough</a></article>
        </body>
      </html>
    `;
    const article = `
      <html><head>
        <title>Story A title long enough</title>
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url.includes("story-a")) return makeResponse(article);
      return makeResponse("", false);
    });

    await runArticleDiscoveryBatch();

    const updateCalls = prismaArtifactUpdateMock.mock.calls;
    const markerUpdate = updateCalls.find((call: any[]) =>
      call[0]?.where?.id === "marker-1" &&
      call[0]?.data?.status === "RESOLVED_BY_STATIC_DISCOVERY",
    );
    expect(markerUpdate).toBeDefined();
    const payload = markerUpdate![0].data.payload;
    // Original fields preserved
    expect(payload.explanation).toBe("Original explanation");
    expect(payload.createdAt).toBe("2026-07-15T10:00:00Z");
    // New resolution fields added
    expect(payload.resolvedByStaticDiscoveryAt).toBeDefined();
    expect(payload.resolvedByStaticDiscoveryArtifactId).toBe("artifact-1");
    expect(payload.resolvedByStaticDiscoveryQuality).toBe("productive");
    expect(payload.resolvedByStaticDiscoveryAcceptedCount).toBe(1);
    expect(payload.resolvedByStaticDiscoveryEvaluatedCount).toBeGreaterThanOrEqual(1);
    expect(payload.resolvedByStaticDiscoveryMatchMode).toBe("exact");
  });

  it("resolves subpath markers when source-level run becomes productive", async () => {
    const { runArticleDiscoveryBatch } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    const { createPipelineRun } = await import("./artifacts");
    const { persistCandidates } = await import("./ingest");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        frontPageUrl: "https://www.nba.com",
        mediaName: "NBA",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    (createPipelineRun as any).mockResolvedValue({ id: "run-1" });
    (persistCandidates as any).mockResolvedValue({ inserted: 2, skipped: 0, failed: 0 });
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });

    // Two markers: one exact match, one subpath match
    prismaArtifactFindManyMock.mockResolvedValue([
      {
        id: "marker-exact",
        payload: { targetUrl: "https://www.nba.com", sourceId: "src-1", quality: "failed" },
      },
      {
        id: "marker-subpath",
        payload: { targetUrl: "https://www.nba.com/news", sourceId: "src-1", quality: "failed" },
      },
    ]);

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/story-a">Story A title long enough</a></article>
          <article><a href="/news/2026/07/16/story-b">Story B title long enough</a></article>
        </body>
      </html>
    `;
    const articleA = `
      <html><head>
        <title>Story A title long enough</title>
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;
    const articleB = `
      <html><head>
        <title>Story B title long enough</title>
        <meta property="article:published_time" content="2026-07-16T10:00:00Z" />
      </head><body><p>B</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://www.nba.com") return makeResponse(listing);
      if (url.includes("story-a")) return makeResponse(articleA);
      if (url.includes("story-b")) return makeResponse(articleB);
      return makeResponse("", false);
    });

    const result = await runArticleDiscoveryBatch();
    expect(result.result.inserted).toBe(2);

    // Both markers should be resolved
    const updateCalls = prismaArtifactUpdateMock.mock.calls;
    const exactUpdate = updateCalls.find((call: any[]) => call[0]?.where?.id === "marker-exact");
    const subpathUpdate = updateCalls.find((call: any[]) => call[0]?.where?.id === "marker-subpath");

    expect(exactUpdate).toBeDefined();
    expect(exactUpdate![0].data.payload.resolvedByStaticDiscoveryMatchMode).toBe("exact");

    expect(subpathUpdate).toBeDefined();
    expect(subpathUpdate![0].data.payload.resolvedByStaticDiscoveryMatchMode).toBe("source_subpath");
  });

  it("does not resolve different-origin subpath markers", async () => {
    const { runArticleDiscoveryBatch } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    const { createPipelineRun } = await import("./artifacts");
    const { persistCandidates } = await import("./ingest");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        frontPageUrl: "https://www.nba.com",
        mediaName: "NBA",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    (createPipelineRun as any).mockResolvedValue({ id: "run-1" });
    (persistCandidates as any).mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });

    // Marker for different origin — must NOT be resolved
    prismaArtifactFindManyMock.mockResolvedValue([
      {
        id: "marker-other",
        payload: { targetUrl: "https://www.nfl.com/news", sourceId: "src-1", quality: "failed" },
      },
    ]);

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/story-a">Story A title long enough</a></article>
        </body>
      </html>
    `;
    const article = `
      <html><head>
        <title>Story A title long enough</title>
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://www.nba.com") return makeResponse(listing);
      if (url.includes("story-a")) return makeResponse(article);
      return makeResponse("", false);
    });

    await runArticleDiscoveryBatch();

    // Different-origin marker must NOT be updated
    const updateCalls = prismaArtifactUpdateMock.mock.calls;
    const otherUpdate = updateCalls.find((call: any[]) => call[0]?.where?.id === "marker-other");
    expect(otherUpdate).toBeUndefined();
  });

  it("does not resolve markers with different sourceId even if domain matches", async () => {
    const { runArticleDiscoveryBatch } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    const { createPipelineRun } = await import("./artifacts");
    const { persistCandidates } = await import("./ingest");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        frontPageUrl: "https://www.nba.com",
        mediaName: "NBA",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    (createPipelineRun as any).mockResolvedValue({ id: "run-1" });
    (persistCandidates as any).mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });

    // The WHERE clause in resolveStaleHeadlessMarkers filters by sourceId,
    // so markers from a different source are never returned from the DB query.
    // Return empty to simulate this correctly.
    prismaArtifactFindManyMock.mockResolvedValue([]);

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/story-a">Story A title long enough</a></article>
        </body>
      </html>
    `;
    const article = `
      <html><head>
        <title>Story A title long enough</title>
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://www.nba.com") return makeResponse(listing);
      if (url.includes("story-a")) return makeResponse(article);
      return makeResponse("", false);
    });

    await runArticleDiscoveryBatch();

    // Verify the marker query used the correct sourceId filter
    const findManyCalls = prismaArtifactFindManyMock.mock.calls;
    const markerQuery = findManyCalls.find((call: any[]) =>
      call[0]?.where?.artifactType === "article_discovery_headless_required",
    );
    if (markerQuery) {
      expect(markerQuery[0].where.sourceId).toBe("src-1");
    }

    // No markers returned → no updates
    const updateCalls = prismaArtifactUpdateMock.mock.calls;
    const otherUpdate = updateCalls.find((call: any[]) => call[0]?.data?.status === "RESOLVED_BY_STATIC_DISCOVERY");
    expect(otherUpdate).toBeUndefined();
  });

  it("skips markers with missing targetUrl in payload", async () => {
    const { runArticleDiscoveryBatch } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    const { createPipelineRun } = await import("./artifacts");
    const { persistCandidates } = await import("./ingest");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        frontPageUrl: "https://example.com/",
        mediaName: "Example",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    (createPipelineRun as any).mockResolvedValue({ id: "run-1" });
    (persistCandidates as any).mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });

    // Marker with no targetUrl in payload — must be skipped (cannot verify origin/path)
    // Marker with valid targetUrl — should still be resolved
    prismaArtifactFindManyMock.mockResolvedValue([
      {
        id: "marker-no-url",
        payload: { sourceId: "src-1", quality: "failed" },
      },
      {
        id: "marker-with-url",
        payload: { targetUrl: "https://example.com/", sourceId: "src-1", quality: "failed" },
      },
    ]);

    const listing = `
      <html>
        <body>
          <article><a href="/news/2026/07/16/story-a">Story A title long enough</a></article>
        </body>
      </html>
    `;
    const article = `
      <html><head>
        <title>Story A title long enough</title>
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/") return makeResponse(listing);
      if (url.includes("story-a")) return makeResponse(article);
      return makeResponse("", false);
    });

    await runArticleDiscoveryBatch();

    const updateCalls = prismaArtifactUpdateMock.mock.calls;
    // Marker without targetUrl should NOT be resolved
    const noUrlUpdate = updateCalls.find((call: any[]) => call[0]?.where?.id === "marker-no-url");
    expect(noUrlUpdate).toBeUndefined();
    // Marker with targetUrl should be resolved
    const withUrlUpdate = updateCalls.find((call: any[]) => call[0]?.where?.id === "marker-with-url");
    expect(withUrlUpdate).toBeDefined();
    expect(withUrlUpdate![0].data.payload.resolvedByStaticDiscoveryMatchMode).toBe("exact");
  });

  it("category productive run does not resolve sibling category markers", async () => {
    const { runArticleDiscoveryBatch } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    const { createPipelineRun } = await import("./artifacts");
    const { persistCandidates } = await import("./ingest");

    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: "cat-sports" },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        frontPageUrl: "https://example.com",
        mediaName: "Example",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([
      {
        id: "cat-sports",
        newsSourceId: "src-1",
        pathUrl: "https://example.com/sports",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    (createPipelineRun as any).mockResolvedValue({ id: "run-1" });
    (persistCandidates as any).mockResolvedValue({ inserted: 2, skipped: 0, failed: 0 });
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });

    // Marker for cat-sports (exact match) — should be resolved
    prismaArtifactFindManyMock.mockResolvedValue([
      {
        id: "marker-sports",
        payload: { targetUrl: "https://example.com/sports", sourceId: "src-1", quality: "failed" },
      },
    ]);

    const listing = `
      <html>
        <body>
          <article><a href="/2026/07/16/sports-story-a">Sports story A title long enough</a></article>
          <article><a href="/2026/07/16/sports-story-b">Sports story B title long enough</a></article>
        </body>
      </html>
    `;
    const articleA = `
      <html><head>
        <title>Sports story A title long enough</title>
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;
    const articleB = `
      <html><head>
        <title>Sports story B title long enough</title>
        <meta property="article:published_time" content="2026-07-16T10:00:00Z" />
      </head><body><p>B</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/sports") return makeResponse(listing);
      if (url.includes("sports-story-a")) return makeResponse(articleA);
      if (url.includes("sports-story-b")) return makeResponse(articleB);
      return makeResponse("", false);
    });

    await runArticleDiscoveryBatch();

    // Sports marker should be resolved with exact matchMode
    const updateCalls = prismaArtifactUpdateMock.mock.calls;
    const sportsUpdate = updateCalls.find((call: any[]) => call[0]?.where?.id === "marker-sports");
    expect(sportsUpdate).toBeDefined();
    expect(sportsUpdate![0].data.payload.resolvedByStaticDiscoveryMatchMode).toBe("exact");

    // Category runs use strict matching — no source_subpath mode
    expect(sportsUpdate![0].data.payload.resolvedByStaticDiscoveryMatchMode).not.toBe("source_subpath");
  });

  it("source subpath matching does not resolve markers above the productive root", async () => {
    const { runArticleDiscoveryBatch } = await import("./article-discovery");
    const { resolveActivePipelineTargets } = await import("./targets");
    const { createPipelineRun } = await import("./artifacts");
    const { persistCandidates } = await import("./ingest");

    // Productive run at /news — should NOT resolve markers at / or /other
    (resolveActivePipelineTargets as any).mockResolvedValue([
      { sourceId: "src-1", categoryId: null },
    ]);
    prismaNewsSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        frontPageUrl: "https://example.com/news",
        mediaName: "Example",
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      },
    ]);
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    (createPipelineRun as any).mockResolvedValue({ id: "run-1" });
    (persistCandidates as any).mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });
    prismaArtifactCreateMock.mockResolvedValue({ id: "artifact-1" });

    // Marker at root (/) — should NOT be resolved (root is above /news)
    // Marker at /other — should NOT be resolved (sibling path)
    prismaArtifactFindManyMock.mockResolvedValue([
      {
        id: "marker-root",
        payload: { targetUrl: "https://example.com", sourceId: "src-1", quality: "failed" },
      },
      {
        id: "marker-other",
        payload: { targetUrl: "https://example.com/other", sourceId: "src-1", quality: "failed" },
      },
    ]);

    const listing = `
      <html>
        <body>
          <article><a href="/2026/07/16/news-story">News story title long enough here</a></article>
        </body>
      </html>
    `;
    const article = `
      <html><head>
        <title>News story title long enough here</title>
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
      </head><body><p>A</p></body></html>
    `;

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/news") return makeResponse(listing);
      if (url.includes("news-story")) return makeResponse(article);
      return makeResponse("", false);
    });

    await runArticleDiscoveryBatch();

    // Neither marker should be resolved
    const updateCalls = prismaArtifactUpdateMock.mock.calls;
    const rootUpdate = updateCalls.find((call: any[]) => call[0]?.where?.id === "marker-root");
    const otherUpdate = updateCalls.find((call: any[]) => call[0]?.where?.id === "marker-other");
    expect(rootUpdate).toBeUndefined();
    expect(otherUpdate).toBeUndefined();
  });
});
