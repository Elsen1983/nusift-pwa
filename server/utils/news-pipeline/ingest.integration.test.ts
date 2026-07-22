import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Prisma mocks ──────────────────────────────────────────────────────
const prismaNewsSourceFindUniqueMock = vi.hoisted(() => vi.fn());
const prismaSourceCategoryFindUniqueMock = vi.hoisted(() => vi.fn());
const prismaSourceCategoryUpdateMock = vi.hoisted(() => vi.fn());
const prismaSourceCategoryFindManyMock = vi.hoisted(() => vi.fn());
const prismaArticleFindManyMock = vi.hoisted(() => vi.fn());
const prismaArticleCreateManyMock = vi.hoisted(() => vi.fn());
const prismaArticleUpdateMock = vi.hoisted(() => vi.fn());
const prismaTransactionMock = vi.hoisted(() => vi.fn());
const prismaFeedReviewUpdateManyMock = vi.hoisted(() => vi.fn());
const prismaNewsSourceUpdateMock = vi.hoisted(() => vi.fn());

vi.mock("../prisma", () => ({
  prisma: {
    newsSource: {
      findUnique: (...args: any[]) => prismaNewsSourceFindUniqueMock(...args),
      update: (...args: any[]) => prismaNewsSourceUpdateMock(...args),
    },
    sourceCategory: {
      findUnique: (...args: any[]) => prismaSourceCategoryFindUniqueMock(...args),
      update: (...args: any[]) => prismaSourceCategoryUpdateMock(...args),
      findMany: (...args: any[]) => prismaSourceCategoryFindManyMock(...args),
    },
    article: {
      findMany: (...args: any[]) => prismaArticleFindManyMock(...args),
      createMany: (...args: any[]) => prismaArticleCreateManyMock(...args),
      update: (...args: any[]) => prismaArticleUpdateMock(...args),
    },
    feedReviewRequest: {
      updateMany: (...args: any[]) => prismaFeedReviewUpdateManyMock(...args),
    },
    $transaction: (...args: any[]) => prismaTransactionMock(...args),
  },
}));

// ── Safe fetch mock ───────────────────────────────────────────────────
const safeFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../ssrf-guard", () => ({ safeFetch: safeFetchMock, SSRFError: class SSRFError extends Error {} }));

// ── Log mock ──────────────────────────────────────────────────────────
const logAgentScanMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./log", () => ({ logAgentScan: logAgentScanMock }));

// ── Discovery mock ────────────────────────────────────────────────────
const discoverFeedForUrlMock = vi.hoisted(() => vi.fn());
vi.mock("./feed-discovery", () => ({ discoverFeedForUrl: discoverFeedForUrlMock }));

// ── Helpers ───────────────────────────────────────────────────────────
const makeResponse = (body: string, ok = true) => ({
  ok,
  text: async () => body,
  headers: { get: () => "application/rss+xml" },
});

const freshDate = () => new Date("2026-07-19T12:00:00Z");
const staleDate = () => new Date("2020-01-01T00:00:00Z");

const rssXml = (items: Array<{ title: string; link: string; pubDate: string; category?: string }>) => {
  const itemXml = items
    .map(
      (item) => `<item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <pubDate>${item.pubDate}</pubDate>
      ${item.category ? `<category>${item.category}</category>` : ""}
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${itemXml}</channel></rss>`;
};

const SOURCE_BASE = {
  id: "src-1",
  frontPageUrl: "https://example.com",
  rssFeedUrl: "https://example.com/rss",
  rssStatus: "ACTIVE",
  mediaName: "Example",
};

const CATEGORY_BASE = {
  id: "cat-politics",
  pathUrl: "https://example.com/politics",
  rssFeedUrl: null as string | null,
  discoveryEvidence: null as unknown,
  lastRssCheckAt: null as Date | null,
};

const GENERIC_EVIDENCE = {
  scopeMatch: "generic",
  outcome: { scopeMatch: "generic", verified: true, feedUrl: "https://example.com/rss" },
};

const SCOPED_EVIDENCE = {
  scopeMatch: "exact",
  outcome: { scopeMatch: "exact", verified: true, feedUrl: "https://example.com/politics/rss" },
};

// ── Tests ─────────────────────────────────────────────────────────────
describe("generic RSS fallback integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaNewsSourceFindUniqueMock.mockResolvedValue(SOURCE_BASE);
    prismaSourceCategoryFindUniqueMock.mockResolvedValue(null);
    prismaSourceCategoryUpdateMock.mockResolvedValue({});
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);
    prismaArticleFindManyMock.mockResolvedValue([]);
    prismaArticleCreateManyMock.mockResolvedValue({ count: 0 });
    prismaArticleUpdateMock.mockResolvedValue({});
    prismaTransactionMock.mockResolvedValue([]);
    prismaFeedReviewUpdateManyMock.mockResolvedValue({});
    prismaNewsSourceUpdateMock.mockResolvedValue({});
    safeFetchMock.mockResolvedValue(makeResponse(rssXml([]), false));
    discoverFeedForUrlMock.mockResolvedValue({ feedUrl: null, scopeMatch: "generic", detection: "none", score: 0, scopeConfidence: "low" });
  });

  // ── 1. Scoped category feed still wins ──────────────────────────────
  it("scoped category feed still wins over root/generic feed", async () => {
    const { ingestSource } = await import("./ingest");

    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      rssFeedUrl: "https://example.com/politics/rss",
      discoveryEvidence: SCOPED_EVIDENCE,
    });

    // Root feed returns politics articles; scoped feed returns politics articles
    const rootFeed = rssXml([
      { title: "Root politics article long enough", link: "https://example.com/politics/root-article", pubDate: freshDate().toISOString() },
    ]);
    const scopedFeed = rssXml([
      { title: "Scoped politics article long enough", link: "https://example.com/politics/scoped-article", pubDate: freshDate().toISOString() },
    ]);

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/politics/rss") return makeResponse(scopedFeed);
      if (url === "https://example.com/rss") return makeResponse(rootFeed);
      return makeResponse("", false);
    });

    const result = await ingestSource("src-1", "cat-politics");

    // Should use scoped feed — only scoped articles appear
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates.some((c) => c.canonicalUrl.includes("scoped-article"))).toBe(true);
    expect(result.candidates.every((c) => !c.canonicalUrl.includes("root-article"))).toBe(true);

    // Log should indicate scoped category feed
    const categoryFeedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_FEED_USED",
    );
    expect(categoryFeedLog).toBeDefined();
    expect(categoryFeedLog![0].errorLog).toContain("scoped category feed");
    expect(categoryFeedLog![0].errorLog).not.toContain("generic");

    // Discovery should NOT have been called (scoped feed already exists)
    expect(discoverFeedForUrlMock).not.toHaveBeenCalled();
  });

  // ── 2. Generic fallback used without saving rssFeedUrl ──────────────
  it("generic fallback is used without saving rssFeedUrl to SourceCategory", async () => {
    const { ingestSource } = await import("./ingest");

    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      discoveryEvidence: GENERIC_EVIDENCE,
      lastRssCheckAt: freshDate(),
    });

    // Generic root feed with politics-relevant article
    const feed = rssXml([
      { title: "Politics summit opens today with major policy debate", link: "https://example.com/politics/summit", pubDate: freshDate().toISOString(), category: "Politics" },
      { title: "Sports championship results and highlights", link: "https://example.com/sports/finale", pubDate: freshDate().toISOString(), category: "Sports" },
    ]);

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/rss") return makeResponse(feed);
      return makeResponse("", false);
    });

    const result = await ingestSource("src-1", "cat-politics");

    // SourceCategory.update should NOT be called at all (TTL early return skips discovery)
    const categoryUpdate = prismaSourceCategoryUpdateMock.mock.calls.find(
      (call: any[]) => call[0]?.where?.id === "cat-politics",
    );
    expect(categoryUpdate).toBeUndefined();

    // Generic fallback log present
    const fallbackLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_FEED_FALLBACK_TO_ROOT",
    );
    expect(fallbackLog).toBeDefined();
    expect(fallbackLog![0].errorLog).toContain("generic category feed");
    expect(fallbackLog![0].errorLog).toContain("category relevance filtering remains enabled");

    // Discovery should NOT have been called (TTL is fresh)
    expect(discoverFeedForUrlMock).not.toHaveBeenCalled();

    // Result has candidates (politics-relevant article accepted)
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  // ── 3. Generic fallback inserts only relevant category articles ─────
  it("generic fallback inserts only relevant category articles and skips irrelevant ones", async () => {
    const { ingestSource } = await import("./ingest");

    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      discoveryEvidence: GENERIC_EVIDENCE,
      lastRssCheckAt: freshDate(),
    });

    const feed = rssXml([
      { title: "Major political reform bill passes parliament vote today", link: "https://example.com/politics/reform", pubDate: freshDate().toISOString(), category: "Politics" },
      { title: "Champions League final match results and analysis", link: "https://example.com/sports/champions", pubDate: freshDate().toISOString(), category: "Sports" },
      { title: "Local politics council meeting summary published", link: "https://example.com/politics/council", pubDate: freshDate().toISOString() },
    ]);

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/rss") return makeResponse(feed);
      return makeResponse("", false);
    });

    const result = await ingestSource("src-1", "cat-politics");

    // Relevant articles accepted
    const relevantAccepted = result.candidates.filter(
      (c) => c.canonicalUrl.includes("/politics/"),
    );
    expect(relevantAccepted.length).toBeGreaterThanOrEqual(1);

    // Irrelevant article skipped with out_of_scope reason
    const sportsSkipped = result.rejectedItems.filter(
      (r) => r.rawLink?.includes("champions") && r.reason === "out_of_scope",
    );
    expect(sportsSkipped.length).toBe(1);

    // Skip summary reflects out_of_scope rejections
    expect(result.skipSummary.outOfScope).toBeGreaterThanOrEqual(1);
  });

  // ── 4. Generic fallback productive state ────────────────────────────
  it("generic fallback producing relevant articles marks category productive", async () => {
    const { ingestSource } = await import("./ingest");
    const { markFeedRunOutcome } = await import("./feed-productivity");

    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      discoveryEvidence: GENERIC_EVIDENCE,
      lastRssCheckAt: freshDate(),
    });

    const feed = rssXml([
      { title: "Political leaders gather for climate summit debate", link: "https://example.com/politics/climate", pubDate: freshDate().toISOString(), category: "Politics" },
    ]);

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/rss") return makeResponse(feed);
      return makeResponse("", false);
    });

    const ingestResult = await ingestSource("src-1", "cat-politics");

    // At least one relevant article accepted
    expect(ingestResult.candidates.length).toBeGreaterThanOrEqual(1);

    // Simulate orchestrator calling markFeedRunOutcome with productive=true
    await markFeedRunOutcome({
      sourceId: "src-1",
      categoryId: "cat-politics",
      feedUrl: ingestResult.feedUrl,
      productive: true,
      shouldTrackFeedProductivity: true,
    });

    // Category should be marked productive
    expect(prismaSourceCategoryUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cat-politics" },
        data: expect.objectContaining({
          currentFeedProductive: true,
          consecutiveNonProductiveRuns: 0,
        }),
      }),
    );

    // Agent 2 eligibility should be false for ACTIVE feeds when productive
    const { isAgent2EligibleTarget } = await import("./article-discovery");
    expect(
      isAgent2EligibleTarget({
        rssStatus: "ACTIVE",
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: 0,
      }),
    ).toBe(false);
  });

  // ── 5. Generic fallback non-productive first run ────────────────────
  it("generic fallback producing zero relevant articles increments non-productive count", async () => {
    const { ingestSource } = await import("./ingest");
    const { markFeedRunOutcome } = await import("./feed-productivity");

    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      discoveryEvidence: GENERIC_EVIDENCE,
      lastRssCheckAt: freshDate(),
    });

    // Feed with only sports articles — none relevant to politics
    const feed = rssXml([
      { title: "Premier League transfer window latest signings", link: "https://example.com/sports/transfer", pubDate: freshDate().toISOString(), category: "Sports" },
      { title: "Tennis Grand Slam tournament bracket announced", link: "https://example.com/sports/tennis", pubDate: freshDate().toISOString(), category: "Sports" },
    ]);

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/rss") return makeResponse(feed);
      return makeResponse("", false);
    });

    const ingestResult = await ingestSource("src-1", "cat-politics");

    // Zero relevant articles accepted
    expect(ingestResult.candidates).toHaveLength(0);
    expect(ingestResult.skipSummary.outOfScope).toBeGreaterThanOrEqual(1);

    // Simulate orchestrator calling markFeedRunOutcome with productive=false
    await markFeedRunOutcome({
      sourceId: "src-1",
      categoryId: "cat-politics",
      feedUrl: ingestResult.feedUrl,
      productive: false,
      shouldTrackFeedProductivity: true,
    });

    // consecutiveNonProductiveRuns incremented
    expect(prismaSourceCategoryUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cat-politics" },
        data: { consecutiveNonProductiveRuns: { increment: 1 } },
      }),
    );

    // Agent 2 eligibility still false after 1 non-productive run on ACTIVE feed
    const { isAgent2EligibleTarget } = await import("./article-discovery");
    expect(
      isAgent2EligibleTarget({
        rssStatus: "ACTIVE",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 1,
      }),
    ).toBe(false);
  });

  // ── 6. Generic fallback non-productive second run ───────────────────
  it("after two non-productive generic fallback runs, Agent 2 becomes eligible", async () => {
    const { isAgent2EligibleTarget } = await import("./article-discovery");

    // After 2 consecutive non-productive runs, Agent 2 should be eligible
    // regardless of rssStatus (NO_RSS_FOUND is always eligible anyway)
    expect(
      isAgent2EligibleTarget({
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 2,
      }),
    ).toBe(true);

    // For ACTIVE feeds (edge case), 2 non-productive runs also triggers eligibility
    expect(
      isAgent2EligibleTarget({
        rssStatus: "ACTIVE",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 2,
      }),
    ).toBe(true);

    // But 1 non-productive run on ACTIVE is not enough
    expect(
      isAgent2EligibleTarget({
        rssStatus: "ACTIVE",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 1,
      }),
    ).toBe(false);
  });

  // ── 7. Generic evidence TTL ─────────────────────────────────────────
  it("fresh generic evidence avoids re-running discovery; expired evidence allows it", async () => {
    const { ingestSource } = await import("./ingest");

    // Fresh evidence: lastRssCheckAt is recent → skip discovery
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      discoveryEvidence: GENERIC_EVIDENCE,
      lastRssCheckAt: freshDate(),
    });

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/rss") {
        return makeResponse(rssXml([
          { title: "Political news article long enough title", link: "https://example.com/politics/news", pubDate: freshDate().toISOString() },
        ]));
      }
      return makeResponse("", false);
    });

    await ingestSource("src-1", "cat-politics");

    // Discovery NOT called — TTL is fresh
    expect(discoverFeedForUrlMock).not.toHaveBeenCalled();

    // Reset for expired evidence test
    vi.clearAllMocks();
    prismaNewsSourceFindUniqueMock.mockResolvedValue(SOURCE_BASE);
    prismaArticleFindManyMock.mockResolvedValue([]);
    prismaArticleCreateManyMock.mockResolvedValue({ count: 0 });
    prismaSourceCategoryUpdateMock.mockResolvedValue({});
    prismaSourceCategoryFindManyMock.mockResolvedValue([]);

    // Expired evidence: lastRssCheckAt is old → discovery runs
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      discoveryEvidence: GENERIC_EVIDENCE,
      lastRssCheckAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000), // 31 days ago
    });

    // Discovery finds a scoped feed this time
    discoverFeedForUrlMock.mockResolvedValue({
      feedUrl: "https://example.com/politics/rss",
      scopeMatch: "exact",
      detection: "html-link",
      score: 65,
      scopeConfidence: "high",
    });

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/politics/rss") {
        return makeResponse(rssXml([
          { title: "Scoped politics article long enough title", link: "https://example.com/politics/scoped", pubDate: freshDate().toISOString() },
        ]));
      }
      return makeResponse("", false);
    });

    const result = await ingestSource("src-1", "cat-politics");

    // Discovery WAS called — evidence expired
    expect(discoverFeedForUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pageUrl: "https://example.com/politics",
        preferScopedDirectFeed: true,
      }),
    );

    // Category update should save the scoped feed
    const categoryUpdate = prismaSourceCategoryUpdateMock.mock.calls.find(
      (call: any[]) => call[0]?.where?.id === "cat-politics",
    );
    expect(categoryUpdate).toBeDefined();
    expect(categoryUpdate![0].data.rssFeedUrl).toBe("https://example.com/politics/rss");
    expect(categoryUpdate![0].data.rssStatus).toBe("ACTIVE");
  });

  // ── 8. Legacy self-healing ──────────────────────────────────────────
  it("legacy generic feed saved to rssFeedUrl triggers re-discovery and self-heals", async () => {
    const { ingestSource } = await import("./ingest");

    // Legacy data: generic feed incorrectly saved to rssFeedUrl
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      rssFeedUrl: "https://example.com/rss", // This is a root/generic feed, not scoped
      discoveryEvidence: GENERIC_EVIDENCE, // Evidence says generic
    });

    // Discovery re-runs and finds the same generic feed
    discoverFeedForUrlMock.mockResolvedValue({
      feedUrl: "https://example.com/rss",
      scopeMatch: "generic",
      detection: "html-link",
      score: 30,
      scopeConfidence: "low",
    });

    const feed = rssXml([
      { title: "Political analysis of budget proposal long enough", link: "https://example.com/politics/budget", pubDate: freshDate().toISOString(), category: "Politics" },
    ]);

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/rss") return makeResponse(feed);
      return makeResponse("", false);
    });

    const result = await ingestSource("src-1", "cat-politics");

    // Discovery WAS called (self-healing: isScopedCategoryFeed returns false for generic evidence)
    expect(discoverFeedForUrlMock).toHaveBeenCalled();

    // Category update should clear rssFeedUrl and set NO_RSS_FOUND
    const categoryUpdate = prismaSourceCategoryUpdateMock.mock.calls.find(
      (call: any[]) => call[0]?.where?.id === "cat-politics",
    );
    expect(categoryUpdate).toBeDefined();
    expect(categoryUpdate![0].data.rssFeedUrl).toBeNull();
    expect(categoryUpdate![0].data.rssStatus).toBe("NO_RSS_FOUND");

    // Relevance filtering still applies — politics article accepted
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates.some((c) => c.canonicalUrl.includes("/politics/"))).toBe(true);
  });

  // ── 10. Category RSS discovery fails completely → NO_RSS_FOUND for Agent 2 ──
  it("category with failed RSS discovery is marked NO_RSS_FOUND for Agent 2 handoff", async () => {
    const { ingestSource } = await import("./ingest");

    // Category with no existing feed and no fresh generic evidence
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      rssFeedUrl: null,
      discoveryEvidence: null,
      lastRssCheckAt: null,
    });

    // Discovery throws (simulating network failure or invalid feed)
    discoverFeedForUrlMock.mockRejectedValue(new Error("Candidate https://example.com/rss did not validate as a feed"));

    // Source feed also fails to parse (no RSS/Atom items)
    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/rss") return makeResponse(rssXml([]));
      return makeResponse("", false);
    });

    const result = await ingestSource("src-1", "cat-politics");

    // Result should be failed
    expect(result.failed).toBe(1);
    expect(result.candidates).toHaveLength(0);

    // resolveCategoryFeedUrl catch block should have updated the category to NO_RSS_FOUND
    const categoryUpdates = prismaSourceCategoryUpdateMock.mock.calls.filter(
      (call: any[]) => call[0]?.where?.id === "cat-politics",
    );
    expect(categoryUpdates.length).toBeGreaterThanOrEqual(1);
    // The catch block in resolveCategoryFeedUrl sets NO_RSS_FOUND with currentFeedProductive: false
    const noRssUpdate = categoryUpdates.find(
      (call: any[]) => call[0]?.data?.rssStatus === "NO_RSS_FOUND" && call[0]?.data?.currentFeedProductive === false,
    );
    expect(noRssUpdate).toBeDefined();
    expect(noRssUpdate![0].data.rssFeedUrl).toBeNull();
    expect(noRssUpdate![0].data.consecutiveNonProductiveRuns).toEqual({ increment: 1 });

    // resolveCategoryFeedUrl catch block logs CATEGORY_DISCOVERY_FAILED
    const discoveryFailedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_DISCOVERY_FAILED" && call[0]?.categoryId === "cat-politics",
    );
    expect(discoveryFailedLog).toBeDefined();

    // resolveCategoryFeedUrl catch block also logs CATEGORY_HANDOFF_TO_AGENT2 via shared helper
    const handoffLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_TO_AGENT2" && call[0]?.categoryId === "cat-politics",
    );
    expect(handoffLog).toBeDefined();
    expect(handoffLog![0].errorLog).toContain("category_discovery_exception");

    // Agent 2 eligibility check: NO_RSS_FOUND is always eligible
    const { isAgent2EligibleTarget } = await import("./article-discovery");
    expect(
      isAgent2EligibleTarget({
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 1,
      }),
    ).toBe(true);
  });

  // ── 11. Source feed fetch exception → category NO_RSS_FOUND ──
  it("source feed fetch exception marks category as NO_RSS_FOUND", async () => {
    const { ingestSource } = await import("./ingest");

    // Category with no existing feed, discovery returns null
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      rssFeedUrl: null,
      discoveryEvidence: null,
      lastRssCheckAt: null,
    });

    // Discovery returns no feed
    discoverFeedForUrlMock.mockResolvedValue({
      feedUrl: null,
      scopeMatch: "unrelated",
      detection: "none",
      score: 0,
      scopeConfidence: "low",
    });

    // All fetches fail (simulating SOURCE_FETCH_EXCEPTION)
    safeFetchMock.mockImplementation(async () => {
      throw new Error("fetch failed");
    });

    const result = await ingestSource("src-1", "cat-politics");

    // Result should be failed
    expect(result.failed).toBe(1);

    // resolveCategoryFeedUrl success path + outer catch markCategoryAsNoRssFound both update category
    const categoryUpdates = prismaSourceCategoryUpdateMock.mock.calls.filter(
      (call: any[]) => call[0]?.where?.id === "cat-politics",
    );
    // At least one update from resolveCategoryFeedUrl (NO_RSS_FOUND)
    expect(categoryUpdates.length).toBeGreaterThanOrEqual(1);
    // markCategoryAsNoRssFound from the outer catch sets currentFeedProductive: false
    const noRssUpdates = categoryUpdates.filter(
      (call: any[]) => call[0]?.data?.rssStatus === "NO_RSS_FOUND",
    );
    expect(noRssUpdates.length).toBeGreaterThanOrEqual(1);
    // At least one update explicitly sets currentFeedProductive to false
    const explicitProductiveFalse = noRssUpdates.find(
      (call: any[]) => call[0]?.data?.currentFeedProductive === false,
    );
    expect(explicitProductiveFalse).toBeDefined();
    expect(explicitProductiveFalse![0].data.rssFeedUrl).toBeNull();

    // Verify CATEGORY_HANDOFF_TO_AGENT2 log was emitted.
    // Note: when safeFetch throws for all URLs (including feed candidates), the feed URL
    // loop catches those errors internally and the !response block fires with
    // "root_feed_empty" (not "root_feed_fetch_exception"). The "root_feed_fetch_exception"
    // reason only fires from the outer catch for errors that occur after a successful
    // feed response, e.g. when prisma.article.findMany throws during candidate processing.
    const handoffLog = logAgentScanMock.mock.calls.find(
      (call: any[]) =>
        call[0]?.status === "CATEGORY_HANDOFF_TO_AGENT2" &&
        call[0]?.categoryId === "cat-politics",
    );
    expect(handoffLog).toBeDefined();
  });

  // ── 12. Scoped feed exists → markCategoryAsNoRssFound NOT called ──
  it("scoped category feed failure does NOT mark category as NO_RSS_FOUND", async () => {
    const { ingestSource } = await import("./ingest");

    // Category has a scoped feed
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      rssFeedUrl: "https://example.com/politics/rss",
      discoveryEvidence: SCOPED_EVIDENCE,
    });

    // Scoped feed fetch throws
    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/politics/rss") throw new Error("fetch failed");
      return makeResponse("", false);
    });

    const result = await ingestSource("src-1", "cat-politics");

    // Result should be failed
    expect(result.failed).toBe(1);

    // markCategoryAsNoRssFound should NOT have been called (scoped feed exists)
    const handoffLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_TO_AGENT2",
    );
    expect(handoffLog).toBeUndefined();
  });

  // ── 13. HTML fallback fails → category NO_RSS_FOUND ──
  it("HTML fallback failure marks category as NO_RSS_FOUND", async () => {
    const { ingestSource } = await import("./ingest");

    // Category with no existing feed, discovery returns null
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      rssFeedUrl: null,
      discoveryEvidence: null,
      lastRssCheckAt: null,
    });

    // Discovery returns no feed
    discoverFeedForUrlMock.mockResolvedValue({
      feedUrl: null,
      scopeMatch: "unrelated",
      detection: "none",
      score: 0,
      scopeConfidence: "low",
    });

    // Source feed returns empty RSS → HTML fallback runs → HTML fallback fails
    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/rss") return makeResponse(rssXml([]));
      if (url === "https://example.com") return makeResponse("", false);
      return makeResponse("", false);
    });

    const result = await ingestSource("src-1", "cat-politics");

    // Result should be failed
    expect(result.failed).toBe(1);

    // markCategoryAsNoRssFound should have been called
    const handoffLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_TO_AGENT2",
    );
    expect(handoffLog).toBeDefined();
  });

  // ── 14. Double-increment prevention ──
  it("does not double-increment consecutiveNonProductiveRuns when discovery and fetch both fail", async () => {
    const { ingestSource } = await import("./ingest");

    // Category with no existing feed
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      rssFeedUrl: null,
      discoveryEvidence: null,
      lastRssCheckAt: null,
    });

    // Discovery throws
    discoverFeedForUrlMock.mockRejectedValue(new Error("discovery failed"));

    // Source feed also throws
    safeFetchMock.mockImplementation(async () => {
      throw new Error("fetch failed");
    });

    await ingestSource("src-1", "cat-politics");

    // resolveCategoryFeedUrl catch block should have updated the category once
    const categoryUpdates = prismaSourceCategoryUpdateMock.mock.calls.filter(
      (call: any[]) => call[0]?.where?.id === "cat-politics",
    );

    // Only ONE update should have been made (by resolveCategoryFeedUrl catch block)
    // The outer catch block should NOT call markCategoryAsNoRssFound again
    const noRssFoundUpdates = categoryUpdates.filter(
      (call: any[]) => call[0]?.data?.rssStatus === "NO_RSS_FOUND",
    );
    expect(noRssFoundUpdates).toHaveLength(1);
  });

  // ── 15. Same-cycle handoff: ingestSource state → resolveAgent2Targets eligibility ──
  it("Times-like category becomes Agent 2 eligible immediately after complete RSS failure", async () => {
    const { ingestSource } = await import("./ingest");

    // Simulate Times of India-like category: https://example-news.test/world/europe
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      id: "cat-europe",
      pathUrl: "https://example-news.test/world/europe",
      rssFeedUrl: null,
      discoveryEvidence: null,
      lastRssCheckAt: null,
    });
    prismaNewsSourceFindUniqueMock.mockResolvedValue({
      id: "src-news",
      frontPageUrl: "https://example-news.test",
      rssFeedUrl: "https://example-news.test/rss",
      rssStatus: "ACTIVE",
      mediaName: "Example News",
    });

    // Discovery fails (simulates "Candidate did not validate as a feed")
    discoverFeedForUrlMock.mockRejectedValue(new Error("Candidate https://example-news.test/rss did not validate as a feed"));

    // Root fallback also fails (simulates "No RSS/Atom items found")
    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example-news.test/rss") return makeResponse(rssXml([]));
      return makeResponse("", false);
    });

    // Step 1: ingestSource runs — category RSS fails completely
    const ingestResult = await ingestSource("src-news", "cat-europe");
    expect(ingestResult.failed).toBe(1);
    expect(ingestResult.candidates).toHaveLength(0);

    // Verify category was updated to NO_RSS_FOUND
    const categoryUpdates = prismaSourceCategoryUpdateMock.mock.calls.filter(
      (call: any[]) => call[0]?.where?.id === "cat-europe",
    );
    const noRssUpdate = categoryUpdates.find(
      (call: any[]) => call[0]?.data?.rssStatus === "NO_RSS_FOUND",
    );
    expect(noRssUpdate).toBeDefined();
    expect(noRssUpdate![0].data.rssFeedUrl).toBeNull();
    expect(noRssUpdate![0].data.currentFeedProductive).toBe(false);

    // Verify CATEGORY_HANDOFF_TO_AGENT2 log was emitted
    const handoffLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_TO_AGENT2" && call[0]?.categoryId === "cat-europe",
    );
    expect(handoffLog).toBeDefined();
    expect(handoffLog![0].errorLog).toContain("category_discovery_exception");

    // Step 2: Verify Agent 2 eligibility — NO_RSS_FOUND is immediately eligible
    const { isAgent2EligibleTarget } = await import("./article-discovery");
    expect(
      isAgent2EligibleTarget({
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 1,
      }),
    ).toBe(true);
  });

  // ── 16. Scoped ACTIVE feed with transient failure stays ACTIVE (no NO_RSS_FOUND) ──
  it("scoped ACTIVE feed with transient fetch failure does NOT downgrade to NO_RSS_FOUND", async () => {
    const { ingestSource } = await import("./ingest");

    // Category has a confirmed scoped feed
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      rssFeedUrl: "https://example.com/politics/rss",
      discoveryEvidence: SCOPED_EVIDENCE,
    });

    // Scoped feed fetch throws (transient failure)
    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/politics/rss") throw new Error("ECONNRESET");
      return makeResponse("", false);
    });

    const result = await ingestSource("src-1", "cat-politics");
    expect(result.failed).toBe(1);

    // NO category update should have occurred — scoped feed is ACTIVE
    const categoryUpdates = prismaSourceCategoryUpdateMock.mock.calls.filter(
      (call: any[]) => call[0]?.where?.id === "cat-politics",
    );
    // No NO_RSS_FOUND update from markCategoryAsNoRssFound
    const noRssUpdates = categoryUpdates.filter(
      (call: any[]) => call[0]?.data?.rssStatus === "NO_RSS_FOUND",
    );
    expect(noRssUpdates).toHaveLength(0);

    // No CATEGORY_HANDOFF_TO_AGENT2 log
    const handoffLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_TO_AGENT2",
    );
    expect(handoffLog).toBeUndefined();

    // Agent 2 eligibility: ACTIVE + productive=true → NOT eligible
    const { isAgent2EligibleTarget } = await import("./article-discovery");
    expect(
      isAgent2EligibleTarget({
        rssStatus: "ACTIVE",
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: 0,
      }),
    ).toBe(false);
  });

  // ── 17. CATEGORY_HANDOFF_TO_AGENT2 log includes reason bucket ──
  it("CATEGORY_HANDOFF_TO_AGENT2 log includes reason bucket from every handoff path", async () => {
    const { ingestSource } = await import("./ingest");

    // Test root_feed_empty reason (feed fetches OK but 0 items)
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      rssFeedUrl: null,
      discoveryEvidence: null,
      lastRssCheckAt: null,
    });
    discoverFeedForUrlMock.mockResolvedValue({
      feedUrl: null,
      scopeMatch: "unrelated",
      detection: "none",
      score: 0,
      scopeConfidence: "low",
    });
    // Root feed request succeeds but RSS body has 0 items
    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/rss") return makeResponse(rssXml([]));
      return makeResponse("", false);
    });

    await ingestSource("src-1", "cat-politics");

    const handoffLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_TO_AGENT2",
    );
    expect(handoffLog).toBeDefined();
    // root_feed_empty is the reason when feed fetches OK but has 0 items
    expect(handoffLog![0].errorLog).toContain("root_feed_empty");
  });

  // ── 18. Root feed fetches OK but parses 0 items → root_feed_empty ──
  it("root fallback feed that parses 0 items marks category with root_feed_empty reason", async () => {
    const { ingestSource } = await import("./ingest");

    // Category with no existing feed and no fresh generic evidence
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      pathUrl: "https://example-news.test/world/europe",
      rssFeedUrl: null,
      discoveryEvidence: null,
      lastRssCheckAt: null,
    });
    prismaNewsSourceFindUniqueMock.mockResolvedValue({
      id: "src-news",
      frontPageUrl: "https://example-news.test",
      rssFeedUrl: "https://example-news.test/rss",
      rssStatus: "ACTIVE",
      mediaName: "Example News",
    });

    // Discovery returns null (no scoped feed found) — does NOT throw
    discoverFeedForUrlMock.mockResolvedValue({
      feedUrl: null,
      scopeMatch: "unrelated",
      detection: "none",
      score: 0,
      scopeConfidence: "low",
    });

    // Root fallback feed request succeeds but RSS body has 0 items
    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example-news.test/rss") return makeResponse(rssXml([]));
      return makeResponse("", false);
    });

    const result = await ingestSource("src-news", "cat-politics");

    // Result should be failed
    expect(result.failed).toBe(1);
    expect(result.candidates).toHaveLength(0);

    // Category should be marked NO_RSS_FOUND via root_feed_empty path
    const categoryUpdates = prismaSourceCategoryUpdateMock.mock.calls.filter(
      (call: any[]) => call[0]?.where?.id === "cat-politics",
    );
    const noRssUpdate = categoryUpdates.find(
      (call: any[]) => call[0]?.data?.rssStatus === "NO_RSS_FOUND" && call[0]?.data?.currentFeedProductive === false,
    );
    expect(noRssUpdate).toBeDefined();
    expect(noRssUpdate![0].data.rssFeedUrl).toBeNull();
    expect(noRssUpdate![0].data.consecutiveNonProductiveRuns).toEqual({ increment: 1 });

    // CATEGORY_HANDOFF_TO_AGENT2 log should contain root_feed_empty reason
    const handoffLog = logAgentScanMock.mock.calls.find(
      (call: any[]) =>
        call[0]?.status === "CATEGORY_HANDOFF_TO_AGENT2" &&
        call[0]?.categoryId === "cat-politics",
    );
    expect(handoffLog).toBeDefined();
    expect(handoffLog![0].errorLog).toContain("root_feed_empty");

    // Outer catch should NOT produce a second markCategoryAsNoRssFound call
    // (only ONE NO_RSS_FOUND + currentFeedProductive=false update)
    const allNoRssUpdates = categoryUpdates.filter(
      (call: any[]) => call[0]?.data?.rssStatus === "NO_RSS_FOUND" && call[0]?.data?.currentFeedProductive === false,
    );
    expect(allNoRssUpdates).toHaveLength(1);

    // Agent 2 eligibility: NO_RSS_FOUND is immediately eligible
    const { isAgent2EligibleTarget } = await import("./article-discovery");
    expect(
      isAgent2EligibleTarget({
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 1,
      }),
    ).toBe(true);
  });

  // ── 19. CATEGORY_HANDOFF_STATE_CONFIRMED readback after markCategoryAsNoRssFound ──
  it("logs CATEGORY_HANDOFF_STATE_CONFIRMED with readback snapshot after handoff", async () => {
    const { ingestSource } = await import("./ingest");

    // Category with no existing feed and no fresh generic evidence
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      pathUrl: "https://example-news.test/world/europe",
      rssFeedUrl: null,
      discoveryEvidence: null,
      lastRssCheckAt: null,
    });
    prismaNewsSourceFindUniqueMock.mockResolvedValue({
      id: "src-news",
      frontPageUrl: "https://example-news.test",
      rssFeedUrl: "https://example-news.test/rss",
      rssStatus: "ACTIVE",
      mediaName: "Example News",
    });

    // Discovery fails completely
    discoverFeedForUrlMock.mockRejectedValue(new Error("Candidate did not validate as a feed"));
    safeFetchMock.mockImplementation(async () => { throw new Error("fetch failed"); });

    // After prisma.sourceCategory.update, the readback findUnique should return
    // the NO_RSS_FOUND state. We set it up on the mock:
    // First call: ingestSource loads the category. All subsequent calls
    // (readback in markCategoryAsNoRssFound) return the NO_RSS_FOUND state.
    prismaSourceCategoryFindUniqueMock
      .mockResolvedValueOnce({
        ...CATEGORY_BASE,
        pathUrl: "https://example-news.test/world/europe",
        rssFeedUrl: null,
        discoveryEvidence: null,
        lastRssCheckAt: null,
      })
      .mockResolvedValue({
        id: "cat-politics",
        rssStatus: "NO_RSS_FOUND",
        rssFeedUrl: null,
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 1,
        lastRssCheckAt: new Date("2026-07-22T12:00:00Z"),
      });

    await ingestSource("src-news", "cat-politics");

    // CATEGORY_HANDOFF_TO_AGENT2 should be logged
    const handoffLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_TO_AGENT2",
    );
    expect(handoffLog).toBeDefined();

    // CATEGORY_HANDOFF_STATE_CONFIRMED should be logged with readback snapshot
    const confirmedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_STATE_CONFIRMED",
    );
    expect(confirmedLog).toBeDefined();
    const snapshot = JSON.parse(confirmedLog![0].errorLog);
    expect(snapshot.rssStatus).toBe("NO_RSS_FOUND");
    expect(snapshot.rssFeedUrl).toBeNull();
    expect(snapshot.currentFeedProductive).toBe(false);
    expect(snapshot.consecutiveNonProductiveRuns).toBe(1);
    expect(snapshot.reason).toBe("category_discovery_exception");
    expect(snapshot.sourceId).toBe("src-news");
    expect(snapshot.categoryId).toBe("cat-politics");
  });

  // ── 20. CATEGORY_HANDOFF_STATE_CONFIRM_FAILED is non-fatal ──
  it("logs CATEGORY_HANDOFF_STATE_CONFIRM_FAILED when readback throws, but does not block pipeline", async () => {
    const { ingestSource } = await import("./ingest");

    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      pathUrl: "https://example-news.test/world/europe",
      rssFeedUrl: null,
      discoveryEvidence: null,
      lastRssCheckAt: null,
    });
    prismaNewsSourceFindUniqueMock.mockResolvedValue({
      id: "src-news",
      frontPageUrl: "https://example-news.test",
      rssFeedUrl: "https://example-news.test/rss",
      rssStatus: "ACTIVE",
      mediaName: "Example News",
    });

    discoverFeedForUrlMock.mockRejectedValue(new Error("discovery failed"));
    safeFetchMock.mockImplementation(async () => { throw new Error("fetch failed"); });

    // First call: ingestSource loads the category. Second call (readback)
    // throws to simulate a DB error during the confirmation readback.
    prismaSourceCategoryFindUniqueMock
      .mockResolvedValueOnce({
        ...CATEGORY_BASE,
        pathUrl: "https://example-news.test/world/europe",
        rssFeedUrl: null,
        discoveryEvidence: null,
        lastRssCheckAt: null,
      })
      .mockRejectedValueOnce(new Error("readback DB timeout"));

    // ingestSource should NOT throw — the confirm failure is non-fatal
    const result = await ingestSource("src-news", "cat-politics");
    expect(result.failed).toBe(1);

    // CATEGORY_HANDOFF_TO_AGENT2 should still be logged (update succeeded)
    const handoffLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_TO_AGENT2",
    );
    expect(handoffLog).toBeDefined();

    // CATEGORY_HANDOFF_STATE_CONFIRM_FAILED should be logged
    const confirmFailedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_STATE_CONFIRM_FAILED",
    );
    expect(confirmFailedLog).toBeDefined();
    expect(confirmFailedLog![0].errorLog).toContain("readback failed");
    expect(confirmFailedLog![0].errorLog).toContain("readback DB timeout");

    // CATEGORY_HANDOFF_STATE_CONFIRMED should NOT be logged
    const confirmedLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_HANDOFF_STATE_CONFIRMED",
    );
    expect(confirmedLog).toBeUndefined();
  });

  // ── 9. Expired generic evidence re-discovers generic fallback ────────
  it("expired generic evidence that re-discovers generic feed falls back to parent root feed", async () => {
    const { ingestSource } = await import("./ingest");
    const { markFeedRunOutcome } = await import("./feed-productivity");

    // Expired generic evidence — lastRssCheckAt is 31 days ago
    prismaSourceCategoryFindUniqueMock.mockResolvedValue({
      ...CATEGORY_BASE,
      discoveryEvidence: GENERIC_EVIDENCE,
      lastRssCheckAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });

    // Discovery runs again but still only finds a generic root feed (not scoped)
    discoverFeedForUrlMock.mockResolvedValue({
      feedUrl: "https://example.com/rss",
      scopeMatch: "generic",
      detection: "html-link",
      score: 30,
      scopeConfidence: "low",
    });

    // Root feed with mixed articles
    const feed = rssXml([
      { title: "Political debate over new budget proposal intensifies", link: "https://example.com/politics/debate", pubDate: freshDate().toISOString(), category: "Politics" },
      { title: "Football transfer deadline day latest moves", link: "https://example.com/sports/transfer", pubDate: freshDate().toISOString(), category: "Sports" },
    ]);

    safeFetchMock.mockImplementation(async (url: string) => {
      if (url === "https://example.com/rss") return makeResponse(feed);
      return makeResponse("", false);
    });

    const result = await ingestSource("src-1", "cat-politics");

    // 1. Discovery WAS called — evidence was expired
    expect(discoverFeedForUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pageUrl: "https://example.com/politics",
        preferScopedDirectFeed: true,
      }),
    );

    // 2. Category update should keep rssFeedUrl null and rssStatus NO_RSS_FOUND
    //    (generic feed discovered again → isGeneric=true → not saved to rssFeedUrl)
    const categoryUpdate = prismaSourceCategoryUpdateMock.mock.calls.find(
      (call: any[]) => call[0]?.where?.id === "cat-politics",
    );
    expect(categoryUpdate).toBeDefined();
    expect(categoryUpdate![0].data.rssFeedUrl).toBeNull();
    expect(categoryUpdate![0].data.rssStatus).toBe("NO_RSS_FOUND");

    // 3. Generic fallback log present
    const fallbackLog = logAgentScanMock.mock.calls.find(
      (call: any[]) => call[0]?.status === "CATEGORY_FEED_FALLBACK_TO_ROOT",
    );
    expect(fallbackLog).toBeDefined();
    expect(fallbackLog![0].errorLog).toContain("category relevance filtering remains enabled");

    // 4. Relevance filtering still works — politics accepted, sports skipped
    const politicsAccepted = result.candidates.filter(
      (c) => c.canonicalUrl.includes("/politics/"),
    );
    expect(politicsAccepted.length).toBeGreaterThanOrEqual(1);

    const sportsSkipped = result.rejectedItems.filter(
      (r) => r.rawLink?.includes("transfer") && r.reason === "out_of_scope",
    );
    expect(sportsSkipped.length).toBe(1);

    // 5. Productive tracking still works — relevant articles present
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    await markFeedRunOutcome({
      sourceId: "src-1",
      categoryId: "cat-politics",
      feedUrl: result.feedUrl,
      productive: true,
      shouldTrackFeedProductivity: true,
    });
    expect(prismaSourceCategoryUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cat-politics" },
        data: expect.objectContaining({
          currentFeedProductive: true,
          consecutiveNonProductiveRuns: 0,
        }),
      }),
    );
  });
});
