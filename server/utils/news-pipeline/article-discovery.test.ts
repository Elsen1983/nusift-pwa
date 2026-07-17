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
  });
});
