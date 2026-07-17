import { beforeEach, describe, expect, it, vi } from "vitest";

const safeFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../ssrf-guard", () => ({
  safeFetch: safeFetchMock,
}));

vi.mock("./log", () => ({
  logAgentScan: vi.fn().mockResolvedValue(undefined),
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

const makeResponse = (body: string, ok = true) => ({
  ok,
  text: async () => body,
});

describe("article-discovery", () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  it("marks only the expected Agent 2 feed states as eligible", async () => {
    const { isAgent2EligibleTarget } = await import("./article-discovery");

    expect(
      isAgent2EligibleTarget({
        rssStatus: "NO_RSS_FOUND",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 0,
      }),
    ).toBe(true);
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
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: 2,
      }),
    ).toBe(false);
    expect(
      isAgent2EligibleTarget({
        rssStatus: "PENDING_DISCOVERY",
        currentFeedProductive: false,
        consecutiveNonProductiveRuns: 10,
      }),
    ).toBe(false);
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
});
