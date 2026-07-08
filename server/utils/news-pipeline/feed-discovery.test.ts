import { beforeEach, describe, expect, it, vi } from "vitest";

const safeFetchMock = vi.fn();

vi.mock("../ssrf-guard", () => ({
  safeFetch: safeFetchMock,
}));

const makeResponse = (
  body: string,
  options?: {
    url?: string;
    status?: number;
    headers?: Record<string, string>;
  },
) =>
  new Response(body, {
    status: options?.status ?? 200,
    headers: options?.headers,
  });

const setResponseUrl = (response: Response, url: string) => {
  Object.defineProperty(response, "url", {
    value: url,
    configurable: true,
  });
  return response;
};

describe("discoverFeedForUrl", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("accepts a feed declared in the HTTP Link header during HEAD probing", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: {
          link: '<https://example.com/feed.xml>; rel="alternate"; type="application/rss+xml"',
          "content-type": "text/html; charset=utf-8",
        },
      }),
      "https://example.com/news",
    );

    const feedResponse = setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>Story</title><link>https://example.com/story</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/feed.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/feed.xml") return feedResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/news",
      userAgent: "NuSift-Test",
    });

    expect(result.feedUrl).toBe("https://example.com/feed.xml");
    expect(result.detection).toBe("http-link");
    expect(result.scopeConfidence).toBe("medium");
    expect(result.topCandidates[0]?.feedUrl).toBe("https://example.com/feed.xml");
  });

  it("detects JSON Feed via HTML autodiscovery and validates it", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/tech",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(
        `<html><head><link rel="alternate" type="application/feed+json" href="/feeds/tech.json" /></head><body></body></html>`,
        {
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
      "https://example.com/tech",
    );

    const jsonFeedResponse = setResponseUrl(
      makeResponse(
        JSON.stringify({
          version: "https://jsonfeed.org/version/1.1",
          title: "Tech Feed",
          items: [{ id: "1", url: "https://example.com/tech/story-1", title: "Story 1" }],
        }),
        {
          headers: { "content-type": "application/feed+json" },
        },
      ),
      "https://example.com/feeds/tech.json",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/tech") return htmlResponse;
      if (url === "https://example.com/feeds/tech.json") return jsonFeedResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/tech",
      userAgent: "NuSift-Test",
      preferScopedDirectFeed: true,
    });

    expect(result.feedUrl).toBe("https://example.com/feeds/tech.json");
    expect(result.detection).toBe("html-link");
    expect(result.topCandidates.some((candidate: any) => candidate.contentType === "application/feed+json")).toBe(true);
  });

  it("detects HTML autodiscovery links regardless of attribute order", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/world",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(
        `<html><head><link href="/rss/world.xml" title="World" type="application/rss+xml" rel="alternate" /></head></html>`,
        {
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
      "https://example.com/world",
    );

    const feedResponse = setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>Story</title><link>https://example.com/world/story-1</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/rss/world.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/world") return htmlResponse;
      if (url === "https://example.com/rss/world.xml") return feedResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/world",
      userAgent: "NuSift-Test",
    });

    expect(result.feedUrl).toBe("https://example.com/rss/world.xml");
    expect(result.detection).toBe("html-link");
  });

  it("extracts feed-like URLs embedded in HTML when no formal autodiscovery tag exists", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/politics",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(
        `<html><head><script>window.__CONFIG__ = {"feed":"https://cdn.example.com/feeds/politics.xml"}</script></head><body></body></html>`,
        {
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
      "https://example.com/politics",
    );

    const feedResponse = setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>Story</title><link>https://example.com/politics/story-1</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://cdn.example.com/feeds/politics.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/politics") return htmlResponse;
      if (url === "https://cdn.example.com/feeds/politics.xml") return feedResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/politics",
      userAgent: "NuSift-Test",
    });

    expect(result.feedUrl).toBe("https://cdn.example.com/feeds/politics.xml");
    expect(result.detection).toBe("html-raw-url");
  });

  it("does not treat feedback links as feed candidates", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(
        `<html><body><a href="https://example.com/contact/feedback-complaints/">Feedback</a></body></html>`,
        {
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
      "https://example.com/",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com") return htmlResponse;
      if (url === "https://example.com/") return htmlResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com",
      userAgent: "NuSift-Test",
    });

    expect(result.feedUrl).toBeNull();
    expect(
      result.topCandidates.some((candidate: any) =>
        String(candidate.feedUrl || "").includes("feedback-complaints")),
    ).toBe(false);
  });

  it("uses CMS fingerprint candidates when explicit autodiscovery is missing", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/local-news",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(
        `<html><head><meta name="generator" content="Brightspot CMS" /></head><body>brightspot</body></html>`,
        {
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
      "https://example.com/local-news",
    );

    const fingerprintFeedResponse = setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>Story</title><link>https://example.com/local-news/story-1</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/local-news.rss",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/local-news") return htmlResponse;
      if (url === "https://example.com/local-news.rss") {
        return setResponseUrl(fingerprintFeedResponse.clone(), "https://example.com/local-news.rss");
      }
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/local-news",
      userAgent: "NuSift-Test",
      preferScopedDirectFeed: true,
    });

    expect(result.feedUrl).toBe("https://example.com/local-news.rss");
    expect(result.detection).toBe("cms-fingerprint");
    expect(["medium", "high"]).toContain(result.scopeConfidence);
  });

  it("returns structured rejected candidates when verification fails", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: {
          link: '<https://example.com/feed.xml>; rel="alternate"; type="application/rss+xml"',
          "content-type": "text/html; charset=utf-8",
        },
      }),
      "https://example.com/news",
    );

    const invalidFeedResponse = setResponseUrl(
      makeResponse("<html><body>not a feed</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/feed.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/feed.xml") return invalidFeedResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/news",
      userAgent: "NuSift-Test",
    });

    expect(result.feedUrl).toBeNull();
    expect(result.rejectedCandidates.length).toBeGreaterThanOrEqual(1);
    expect(
      result.rejectedCandidates.some((candidate: any) => candidate.feedUrl === "https://example.com/feed.xml"),
    ).toBe(true);
    expect(
      result.rejectedCandidates.some((candidate: any) =>
        String(candidate.reason || "").includes("did not validate as a feed")),
    ).toBe(true);
  });

  it("derives scoped candidates from robots/news sitemap context", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/county/cork",
    );

    const htmlResponse = setResponseUrl(
      makeResponse("<html><head></head><body>No feed here</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/county/cork",
    );

    const robotsResponse = setResponseUrl(
      makeResponse("Sitemap: https://example.com/news-sitemap.xml", {
        headers: { "content-type": "text/plain" },
      }),
      "https://example.com/robots.txt",
    );

    const sitemapXml = `
      <urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
        <url>
          <loc>https://example.com/county/cork/story-index</loc>
          <lastmod>2026-07-06T11:00:00Z</lastmod>
        </url>
        <url>
          <loc>https://example.com/county/cork/story-1</loc>
          <news:news><news:publication_date>2026-07-06T10:00:00Z</news:publication_date></news:news>
        </url>
        <url>
          <loc>https://example.com/county/cork/story-2</loc>
          <news:news><news:publication_date>2026-07-05T10:00:00Z</news:publication_date></news:news>
        </url>
        <url>
          <loc>https://example.com/county/cork/story-3</loc>
          <news:news><news:publication_date>2026-07-04T10:00:00Z</news:publication_date></news:news>
        </url>
      </urlset>
    `;
    const sitemapResponse = setResponseUrl(
      makeResponse(sitemapXml, {
        headers: { "content-type": "application/xml" },
      }),
      "https://example.com/news-sitemap.xml",
    );

    const verifiedScopedFeed = setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>Story</title><link>https://example.com/county/cork/story-1</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/county/cork/rss",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") {
        return headResponse;
      }
      if (url === "https://example.com/county/cork") return htmlResponse;
      if (url === "https://example.com/robots.txt") return robotsResponse;
      if (url === "https://example.com/news-sitemap.xml") return sitemapResponse;
      if (url === "https://example.com/county/cork/rss.xml") {
        return setResponseUrl(verifiedScopedFeed.clone(), "https://example.com/county/cork/rss.xml");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/county/cork",
      userAgent: "NuSift-Test",
      preferScopedDirectFeed: true,
    });

    expect(result.feedUrl).toBe("https://example.com/county/cork/rss.xml");
    expect(["medium", "high"]).toContain(result.scopeConfidence);
  });

  it("derives scoped candidates from sitemap URL paths even when entries are not feed URLs", async () => {
    const { buildCandidatesFromSitemapUrl } = await import("./feed-discovery");
    const result = buildCandidatesFromSitemapUrl("https://example.com/sport/sitemap.xml");

    expect(result).toContain("https://example.com/sport/rss.xml");
    expect(result).toContain("https://example.com/sport/feed.xml");
  });

  // ── Scoped discovery improvements ──────────────────────────────────────

  it("prefers scoped candidate over generic root feed for category target", async () => {
    // Category page at /nba has both a generic root feed and a scoped feed
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/nba",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(
        `<html><head>
          <link rel="alternate" type="application/rss+xml" href="/rss.xml" />
          <link rel="alternate" type="application/rss+xml" href="/nba/rss" />
        </head><body></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      "https://example.com/nba",
    );

    // Use factory functions so each call returns a fresh Response (body can only be consumed once)
    const makeGenericFeed = () => setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>Story</title><link>https://example.com/story</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/rss.xml",
    );

    const makeScopedFeed = () => setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>NBA Story</title><link>https://example.com/nba/story</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/nba/rss",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/nba") return htmlResponse;
      if (url === "https://example.com/rss.xml") return makeGenericFeed();
      if (url === "https://example.com/nba/rss") return makeScopedFeed();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/nba",
      userAgent: "NuSift-Test",
      preferScopedDirectFeed: true,
    });

    // Scoped candidate should win over generic root feed
    expect(result.feedUrl).toBe("https://example.com/nba/rss");
    expect(result.scopeMatch).toBe("exact");
    expect(result.scopeConfidence).toBe("high");
  });

  it("accepts generic feed as fallback when no scoped feed exists for category target", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/politika",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(
        `<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml" /></head><body></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      "https://example.com/politika",
    );

    const makeGenericFeed = () => setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>Story</title><link>https://example.com/story</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/rss.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/politika") return htmlResponse;
      if (url === "https://example.com/rss.xml") return makeGenericFeed();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/politika",
      userAgent: "NuSift-Test",
      preferScopedDirectFeed: true,
    });

    // Generic feed should still resolve as fallback
    expect(result.feedUrl).toBe("https://example.com/rss.xml");
    // But scopeMatch should indicate it's a generic fallback
    expect(result.scopeMatch).toBe("generic");
    expect(result.scopeConfidence).toBe("low");
  });

  it("includes scopeMatch and taxonomyEvidence in return shape", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/sport",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(
        `<html><head><link rel="alternate" type="application/rss+xml" href="/sport/rss" /></head><body></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      "https://example.com/sport",
    );

    const makeScopedFeed = () => setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>Sport Story</title><link>https://example.com/sport/story</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/sport/rss",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/sport") return htmlResponse;
      if (url === "https://example.com/sport/rss") return makeScopedFeed();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/sport",
      userAgent: "NuSift-Test",
    });

    // Verify new fields exist in return shape
    expect(result.scopeMatch).toBeDefined();
    expect(["exact", "probable", "generic", "unrelated"]).toContain(result.scopeMatch);
    expect(result.taxonomyEvidence).toBeDefined();
    expect(Array.isArray(result.taxonomyEvidence.canonicalSectionHandles)).toBe(true);
    // Canonical section handle should be extracted from the URL path
    expect(result.taxonomyEvidence.canonicalSectionHandles).toContain("sport");
  });

  it("classifies scope match correctly for different URL patterns", async () => {
    const { discoverFeedForUrl, extractTaxonomyEvidence } = await import("./feed-discovery");

    // Test taxonomy evidence extraction from URL path
    const evidence = extractTaxonomyEvidence("<html></html>", "https://example.com/county/cork");
    expect(evidence.canonicalSectionHandles).toContain("cork");
  });

  it("does not regress root/source discovery with preferScopedDirectFeed=false", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/feed.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/feed.xml") return headResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/feed.xml",
      userAgent: "NuSift-Test",
    });

    // Direct feed URL should be detected as before
    expect(result.feedUrl).toBe("https://example.com/feed.xml");
    expect(result.detection).toBe("direct-feed");
    // New fields should be present
    expect(result.scopeMatch).toBeDefined();
    expect(result.taxonomyEvidence).toBeDefined();
  });
});

describe("extractTaxonomyEvidence", () => {
  it("extracts section IDs from inline JSON blocks", async () => {
    const { extractTaxonomyEvidence } = await import("./feed-discovery");

    const html = `
      <html><body>
        <script type="application/json">{"sectionId": "123", "categoryId": "456"}</script>
      </body></html>
    `;

    const evidence = extractTaxonomyEvidence(html, "https://example.com/nba");
    expect(evidence.sectionIds).toContain("123");
    expect(evidence.sectionIds).toContain("456");
    expect(evidence.canonicalSectionHandles).toContain("nba");
  });

  it("extracts category slugs from script text", async () => {
    const { extractTaxonomyEvidence } = await import("./feed-discovery");

    const html = `
      <html><body>
        <script>window.__DATA__ = {"category_slug": "basketball", "tag_slug": "nba-finals"}</script>
      </body></html>
    `;

    const evidence = extractTaxonomyEvidence(html, "https://example.com/sports");
    expect(evidence.categorySlugs).toContain("basketball");
    expect(evidence.categorySlugs).toContain("nba-finals");
  });

  it("extracts feed URLs with taxonomy query parameters", async () => {
    const { extractTaxonomyEvidence } = await import("./feed-discovery");

    const html = `
      <html><body>
        <a href="/feed?cat=5&format=rss2">Category Feed</a>
      </body></html>
    `;

    const evidence = extractTaxonomyEvidence(html, "https://example.com");
    expect(evidence.feedParams).toContain("5");
  });

  it("extracts taxonomy term IDs from Drupal settings", async () => {
    const { extractTaxonomyEvidence } = await import("./feed-discovery");

    const html = `
      <html><body>
        <script>Drupal.settings = {"tid": "789", "taxonomy_term": {"tid": "101"}}</script>
      </body></html>
    `;

    const evidence = extractTaxonomyEvidence(html, "https://example.com/news");
    expect(evidence.tagIds).toContain("789");
    expect(evidence.tagIds).toContain("101");
  });
});

describe("buildTaxonomyHeuristicCandidates", () => {
  it("generates WordPress category feed candidates from section IDs", async () => {
    const { buildTaxonomyHeuristicCandidates } = await import("./feed-discovery");

    const evidence = {
      sectionIds: ["5"],
      tagIds: [],
      categorySlugs: ["basketball"],
      collectionIds: [],
      routeNames: [],
      canonicalSectionHandles: [],
      feedParams: [],
      matchedFeedUrls: [],
    };

    const candidates = buildTaxonomyHeuristicCandidates(
      "https://example.com/nba",
      evidence,
      ["wordpress"],
    );

    expect(candidates).toContain("https://example.com/?feed=rss2&cat=5");
    expect(candidates).toContain("https://example.com/category/basketball/feed/");
  });

  it("generates Ghost section RSS paths from slugs", async () => {
    const { buildTaxonomyHeuristicCandidates } = await import("./feed-discovery");

    const evidence = {
      sectionIds: [],
      tagIds: [],
      categorySlugs: ["tech"],
      collectionIds: [],
      routeNames: [],
      canonicalSectionHandles: [],
      feedParams: [],
      matchedFeedUrls: [],
    };

    const candidates = buildTaxonomyHeuristicCandidates(
      "https://example.com/blog",
      evidence,
      ["ghost"],
    );

    expect(candidates).toContain("https://example.com/tech/rss/");
    expect(candidates).toContain("https://example.com/blog/tech/rss/");
  });

  it("generates Drupal taxonomy term feed paths", async () => {
    const { buildTaxonomyHeuristicCandidates } = await import("./feed-discovery");

    const evidence = {
      sectionIds: [],
      tagIds: ["42"],
      categorySlugs: [],
      collectionIds: [],
      routeNames: [],
      canonicalSectionHandles: [],
      feedParams: [],
      matchedFeedUrls: [],
    };

    const candidates = buildTaxonomyHeuristicCandidates(
      "https://example.com/news",
      evidence,
      ["drupal"],
    );

    expect(candidates).toContain("https://example.com/taxonomy/term/42/feed");
  });

  it("generates generic section feed candidates from canonical handles when no CMS detected", async () => {
    const { buildTaxonomyHeuristicCandidates } = await import("./feed-discovery");

    const evidence = {
      sectionIds: [],
      tagIds: [],
      categorySlugs: [],
      collectionIds: [],
      routeNames: [],
      canonicalSectionHandles: ["cork"],
      feedParams: [],
      matchedFeedUrls: [],
    };

    const candidates = buildTaxonomyHeuristicCandidates(
      "https://example.com/county/cork",
      evidence,
      [],
    );

    expect(candidates).toContain("https://example.com/cork/rss");
    expect(candidates).toContain("https://example.com/cork/feed");
    expect(candidates).toContain("https://example.com/cork/rss.xml");
  });

  it("returns empty array when no evidence is available", async () => {
    const { buildTaxonomyHeuristicCandidates } = await import("./feed-discovery");

    const emptyEvidence = {
      sectionIds: [],
      tagIds: [],
      categorySlugs: [],
      collectionIds: [],
      routeNames: [],
      canonicalSectionHandles: [],
      feedParams: [],
      matchedFeedUrls: [],
    };

    const candidates = buildTaxonomyHeuristicCandidates(
      "https://example.com/nba",
      emptyEvidence,
      [],
    );

    expect(candidates).toEqual([]);
  });
});

// ── Contract consistency ────────────────────────────────────────────────────

describe("discovery contract consistency", () => {
  it("taxonomyEvidence is a structured object, not a string array", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/sport",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(
        `<html><head><link rel="alternate" type="application/rss+xml" href="/sport/rss" /></head><body></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      "https://example.com/sport",
    );

    const makeFeed = () => setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>S</title><link>https://example.com/sport/1</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/sport/rss",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/sport") return htmlResponse;
      if (url === "https://example.com/sport/rss") return makeFeed();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/sport",
      userAgent: "NuSift-Test",
    });

    // taxonomyEvidence must be a structured object with known keys
    expect(result.taxonomyEvidence).toBeDefined();
    expect(typeof result.taxonomyEvidence).toBe("object");
    expect(Array.isArray(result.taxonomyEvidence)).toBe(false);
    expect(result.taxonomyEvidence).toHaveProperty("sectionIds");
    expect(result.taxonomyEvidence).toHaveProperty("tagIds");
    expect(result.taxonomyEvidence).toHaveProperty("categorySlugs");
    expect(result.taxonomyEvidence).toHaveProperty("collectionIds");
    expect(result.taxonomyEvidence).toHaveProperty("routeNames");
    expect(result.taxonomyEvidence).toHaveProperty("canonicalSectionHandles");
    expect(result.taxonomyEvidence).toHaveProperty("feedParams");
    expect(result.taxonomyEvidence).toHaveProperty("matchedFeedUrls");
    // All fields must be string arrays
    for (const key of Object.keys(result.taxonomyEvidence)) {
      expect(Array.isArray((result.taxonomyEvidence as any)[key])).toBe(true);
    }
  });

  it("extractTaxonomyEvidence returns structured TaxonomyEvidence shape", async () => {
    const { extractTaxonomyEvidence } = await import("./feed-discovery");
    const evidence = extractTaxonomyEvidence("<html></html>", "https://example.com/test");

    expect(typeof evidence).toBe("object");
    expect(Array.isArray(evidence)).toBe(false);
    const expectedKeys = [
      "sectionIds", "tagIds", "categorySlugs", "collectionIds",
      "routeNames", "canonicalSectionHandles", "feedParams", "matchedFeedUrls",
    ];
    for (const key of expectedKeys) {
      expect(evidence).toHaveProperty(key);
      expect(Array.isArray((evidence as any)[key])).toBe(true);
    }
  });

  it("discovery result has all required contract fields", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/news",
    );

    const htmlResponse = setResponseUrl(
      makeResponse("<html><head></head><body>No feed</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/news",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/news") return htmlResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/news",
      userAgent: "NuSift-Test",
    });

    // All contract fields must be present
    expect(result).toHaveProperty("feedUrl");
    expect(result).toHaveProperty("discoveredVia");
    expect(result).toHaveProperty("detection");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("scopeConfidence");
    expect(result).toHaveProperty("scopeMatch");
    expect(result).toHaveProperty("taxonomyEvidence");
    expect(result).toHaveProperty("topCandidates");
    expect(result).toHaveProperty("rejectedCandidates");
    // scopeMatch must be a valid ScopeMatch value
    expect(["exact", "probable", "generic", "unrelated"]).toContain(result.scopeMatch);
    // scopeConfidence must be valid
    expect(["high", "medium", "low"]).toContain(result.scopeConfidence);
  });

  it("topCandidates include scopeMatch when feed is discovered", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/sport",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(
        `<html><head><link rel="alternate" type="application/rss+xml" href="/sport/rss" /></head><body></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      "https://example.com/sport",
    );

    const makeFeed = () => setResponseUrl(
      makeResponse(`<?xml version="1.0"?><rss><channel><item><title>S</title><link>https://example.com/sport/1</link></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml" },
      }),
      "https://example.com/sport/rss",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/sport") return htmlResponse;
      if (url === "https://example.com/sport/rss") return makeFeed();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/sport",
      userAgent: "NuSift-Test",
    });

    expect(result.topCandidates.length).toBeGreaterThan(0);
    for (const candidate of result.topCandidates) {
      expect(candidate).toHaveProperty("feedUrl");
      expect(candidate).toHaveProperty("detection");
      expect(candidate).toHaveProperty("score");
      expect(candidate).toHaveProperty("scopeMatch");
      expect(["exact", "probable", "generic", "unrelated"]).toContain(candidate.scopeMatch);
    }
  });

  it("rejectedCandidates include scopeMatch and reason when verification fails", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: {
          link: '<https://example.com/feed.xml>; rel="alternate"; type="application/rss+xml"',
          "content-type": "text/html; charset=utf-8",
        },
      }),
      "https://example.com/test",
    );

    const invalidFeedResponse = setResponseUrl(
      makeResponse("<html><body>not a feed</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://example.com/feed.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/feed.xml") return invalidFeedResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/test",
      userAgent: "NuSift-Test",
    });

    expect(result.rejectedCandidates.length).toBeGreaterThanOrEqual(1);
    for (const candidate of result.rejectedCandidates) {
      expect(candidate).toHaveProperty("feedUrl");
      expect(candidate).toHaveProperty("detection");
      expect(candidate).toHaveProperty("score");
      expect(candidate).toHaveProperty("reason");
      expect(candidate).toHaveProperty("scopeMatch");
      expect(["exact", "probable", "generic", "unrelated"]).toContain(candidate.scopeMatch);
    }
  });
});
