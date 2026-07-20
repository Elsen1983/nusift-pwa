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
vi.mock("../ssrf-guard", () => ({ safeFetch: safeFetchMock }));

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
