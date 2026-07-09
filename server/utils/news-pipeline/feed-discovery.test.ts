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

describe("buildScopedFeedCandidates", () => {
  it("includes query-parameter scoped feed candidates based on the current page path", async () => {
    const { buildScopedFeedCandidates } = await import("./feed-discovery");

    const candidates = buildScopedFeedCandidates("https://www.rte.ie/news/world");

    expect(candidates).toContain("https://www.rte.ie/feeds/rss/?index=/news/world/");
    expect(candidates).toContain("https://www.rte.ie/feeds/rss?index=/news/world/");
  });
});

describe("query-parameter scoped feed discovery", () => {
  it("discovers a valid feed served via feeds/rss?index=<path>", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://www.rte.ie/news/",
    );

    const htmlResponse = setResponseUrl(
      makeResponse(`<html><body><main>RTE News</main></body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "https://www.rte.ie/news/",
    );

    const makeFeedResponse = () =>
      setResponseUrl(
        makeResponse(
          `<?xml version="1.0"?><rss><channel><item><title>Story</title><link>https://www.rte.ie/news/ireland/example-story/</link></item></channel></rss>`,
          {
            headers: { "content-type": "application/rss+xml" },
          },
        ),
        "https://www.rte.ie/feeds/rss/?index=/news/",
      );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://www.rte.ie/news/") return htmlResponse;
      if (url.startsWith("https://www.rte.ie/feeds/rss")) return makeFeedResponse();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://www.rte.ie/news/",
      userAgent: "NuSift-Test",
      preferScopedDirectFeed: true,
    });

    expect(result.feedUrl).toBe("https://www.rte.ie/feeds/rss/?index=/news/");
    expect(result.scopeMatch).toBe("probable");
    expect(result.topCandidates.some((candidate: any) => candidate.feedUrl === "https://www.rte.ie/feeds/rss/?index=/news/")).toBe(true);
  });
});

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

// ── Feed Directory Traversal ───────────────────────────────────────────────

describe("feed directory traversal", () => {
  it("resolves a scoped feed via a feed directory page linked from the target page", async () => {
    // Target page at /category/arizona-news has no direct feed, but links to
    // a feed directory page at /rss-feeds that lists category feeds.
    const headResponse = setResponseUrl(
      makeResponse("", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/category/arizona-news",
    );

    const targetHtml = `
      <html><head></head><body>
        <h1>Arizona News</h1>
        <a href="/rss-feeds">All RSS Feeds</a>
      </body></html>
    `;
    const targetResponse = setResponseUrl(
      makeResponse(targetHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/category/arizona-news",
    );

    const directoryHtml = `
      <html><head><title>RSS Feeds Directory</title></head><body>
        <h1>Available RSS Feeds</h1>
        <ul>
          <li><a href="/feed/1001.xml">Arizona News - RSS Feed</a></li>
          <li><a href="/feed/1002.xml">California News - RSS Feed</a></li>
          <li><a href="/feed/1003.xml">Texas News - RSS Feed</a></li>
          <li><a href="/feed/1004.xml">Florida News - RSS Feed</a></li>
          <li><a href="/feed/1005.xml">New York News - RSS Feed</a></li>
          <li><a href="/feed/1006.xml">Sports - RSS Feed</a></li>
          <li><a href="/feed/1007.xml">Weather - RSS Feed</a></li>
        </ul>
      </body></html>
    `;
    const directoryResponse = setResponseUrl(
      makeResponse(directoryHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/rss-feeds",
    );

    const makeFeedResponse = () => setResponseUrl(
      makeResponse(
        `<?xml version="1.0"?><rss><channel><title>Arizona News</title><item><title>Story 1</title><link>https://example.com/arizona/story-1</link></item></channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      ),
      "https://example.com/feed/1001.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/category/arizona-news") return targetResponse;
      if (url === "https://example.com/rss-feeds") return directoryResponse;
      if (url === "https://example.com/feed/1001.xml") return makeFeedResponse();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/category/arizona-news",
      userAgent: "NuSift-Test",
      preferScopedDirectFeed: true,
    });

    expect(result.feedUrl).toBe("https://example.com/feed/1001.xml");
    expect(result.detection).toBe("directory-traversal");
    expect(result.taxonomyEvidence.directoryTraversal).toBeDefined();
    expect(result.taxonomyEvidence.directoryTraversal!.traversedUrl).toBe("https://example.com/rss-feeds");
    expect(result.taxonomyEvidence.directoryTraversal!.matchedLabel).toContain("Arizona");
    expect(result.taxonomyEvidence.directoryTraversal!.candidateCount).toBeGreaterThanOrEqual(5);
  });

  it("does not run directory traversal when a direct feed is already found", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/news",
    );

    const htmlWithFeed = `
      <html><head>
        <link rel="alternate" type="application/rss+xml" href="/rss.xml" />
      </head><body>
        <a href="/rss-directory">All RSS Feeds</a>
      </body></html>
    `;
    const htmlResponse = setResponseUrl(
      makeResponse(htmlWithFeed, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/news",
    );

    const makeFeed = () => setResponseUrl(
      makeResponse(
        `<?xml version="1.0"?><rss><channel><item><title>S</title><link>https://example.com/story</link></item></channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      ),
      "https://example.com/rss.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/news") return htmlResponse;
      if (url === "https://example.com/rss.xml") return makeFeed();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/news",
      userAgent: "NuSift-Test",
    });

    // Should find the direct feed, not traverse to directory
    expect(result.feedUrl).toBe("https://example.com/rss.xml");
    expect(result.detection).not.toBe("directory-traversal");
    expect(result.taxonomyEvidence.directoryTraversal).toBeUndefined();

    // Should NOT have fetched the directory page
    const fetchCalls = safeFetchMock.mock.calls.map((c: any[]) => c[0] as string);
    expect(fetchCalls).not.toContain("https://example.com/rss-directory");
  });

  it("accepts opaque feed URLs when the label-to-target match is strong", async () => {
    // The directory has a feed at an opaque numeric URL, but the label matches
    const headResponse = setResponseUrl(
      makeResponse("", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://news.example.com/topics/breaking-news",
    );

    const targetHtml = `
      <html><body>
        <a href="/feeds-index">News Feeds</a>
      </body></html>
    `;
    const targetResponse = setResponseUrl(
      makeResponse(targetHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://news.example.com/topics/breaking-news",
    );

    const directoryHtml = `
      <html><body>
        <h1>RSS Directory</h1>
        <ul>
          <li><a href="https://cdn.example.com/s/feed-abc123.xml">Breaking News - RSS</a></li>
          <li><a href="https://cdn.example.com/s/feed-def456.xml">World News - RSS</a></li>
          <li><a href="https://cdn.example.com/s/feed-ghi789.xml">Technology - RSS</a></li>
          <li><a href="https://cdn.example.com/s/feed-jkl012.xml">Entertainment - RSS</a></li>
          <li><a href="https://cdn.example.com/s/feed-mno345.xml">Science - RSS</a></li>
        </ul>
      </body></html>
    `;
    const directoryResponse = setResponseUrl(
      makeResponse(directoryHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://news.example.com/feeds-index",
    );

    const makeOpaqueFeed = () => setResponseUrl(
      makeResponse(
        `<?xml version="1.0"?><rss><channel><title>Breaking News</title><item><title>Story</title><link>https://news.example.com/topics/breaking-news/1</link></item></channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      ),
      "https://cdn.example.com/s/feed-abc123.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://news.example.com/topics/breaking-news") return targetResponse;
      if (url === "https://news.example.com/feeds-index") return directoryResponse;
      if (url === "https://cdn.example.com/s/feed-abc123.xml") return makeOpaqueFeed();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://news.example.com/topics/breaking-news",
      userAgent: "NuSift-Test",
      preferScopedDirectFeed: true,
    });

    // Should match "Breaking News" label against target "breaking-news"
    expect(result.feedUrl).toBe("https://cdn.example.com/s/feed-abc123.xml");
    expect(result.detection).toBe("directory-traversal");
    expect(result.taxonomyEvidence.directoryTraversal!.matchedLabel).toContain("Breaking");
  });

  it("rejects non-directory second-level pages cleanly", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/sport",
    );

    // Target page links to what looks like a directory URL, but it's just a normal page
    const targetHtml = `
      <html><body>
        <a href="/rss-feeds">RSS Feeds</a>
      </body></html>
    `;
    const targetResponse = setResponseUrl(
      makeResponse(targetHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/sport",
    );

    // This page is NOT a feed directory - just a normal article page
    const normalPageHtml = `
      <html><body>
        <h1>About RSS Feeds</h1>
        <p>RSS feeds are a great way to stay updated...</p>
        <a href="/about">About Us</a>
      </body></html>
    `;
    const normalPageResponse = setResponseUrl(
      makeResponse(normalPageHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/rss-feeds",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/sport") return targetResponse;
      if (url === "https://example.com/rss-feeds") return normalPageResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/sport",
      userAgent: "NuSift-Test",
    });

    // Should not find any feed since the directory page is not actually a directory
    expect(result.feedUrl).toBeNull();
    expect(result.taxonomyEvidence.directoryTraversal).toBeUndefined();
  });

  it("remains bounded - only fetches one directory page", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/local",
    );

    // Target page has multiple directory-like links
    const targetHtml = `
      <html><body>
        <a href="/rss-directory">RSS Directory</a>
        <a href="/feed-index">Feed Index</a>
        <a href="/all-feeds">All Feeds</a>
      </body></html>
    `;
    const targetResponse = setResponseUrl(
      makeResponse(targetHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/local",
    );

    const directoryHtml = `
      <html><body>
        <h1>RSS Directory</h1>
        <ul>
          <li><a href="/feed/local.xml">Local - RSS</a></li>
          <li><a href="/feed/sport.xml">Sport - RSS</a></li>
          <li><a href="/feed/world.xml">World - RSS</a></li>
          <li><a href="/feed/tech.xml">Tech - RSS</a></li>
          <li><a href="/feed/biz.xml">Business - RSS</a></li>
        </ul>
      </body></html>
    `;
    const directoryResponse = setResponseUrl(
      makeResponse(directoryHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/rss-directory",
    );

    const makeFeed = () => setResponseUrl(
      makeResponse(
        `<?xml version="1.0"?><rss><channel><item><title>S</title><link>https://example.com/local/1</link></item></channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      ),
      "https://example.com/feed/local.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/local") return targetResponse;
      if (url === "https://example.com/rss-directory") return directoryResponse;
      if (url === "https://example.com/feed/local.xml") return makeFeed();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    await discoverFeedForUrl({
      pageUrl: "https://example.com/local",
      userAgent: "NuSift-Test",
    });

    // Count how many directory-like URLs were fetched (excluding HEAD and main page)
    const fetchCalls = safeFetchMock.mock.calls
      .map((c: any[]) => ({ url: c[0] as string, opts: c[1] }))
      .filter((c) => c.opts?.method !== "HEAD");

    // Should only have fetched the main page + one directory page + the matched feed
    // Not /feed-index or /all-feeds
    const directoryFetches = fetchCalls.filter(
      (c) => c.url === "https://example.com/feed-index" || c.url === "https://example.com/all-feeds",
    );
    expect(directoryFetches).toHaveLength(0);
  });

  it("does not run directory traversal when mainPageHtml is empty", async () => {
    // If the main page returns a non-HTML content type (like a direct feed),
    // mainPageHtml will be empty and traversal should not run
    const headResponse = setResponseUrl(
      makeResponse("", { headers: { "content-type": "application/xml" } }),
      "https://example.com/feed",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/feed",
      userAgent: "NuSift-Test",
    });

    // No feed found, but also no directory traversal attempted
    expect(result.taxonomyEvidence.directoryTraversal).toBeUndefined();
  });
});

describe("feed directory traversal - edge cases", () => {
  it("rejects a page that merely mentions RSS in text but has no feed structure", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/sport",
    );

    const targetHtml = `
      <html><body>
        <a href="/rss-feeds">RSS Feeds</a>
      </body></html>
    `;
    const targetResponse = setResponseUrl(
      makeResponse(targetHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/sport",
    );

    // Page mentions RSS several times in text but has no actual feed links
    const mentionPageHtml = `
      <html><body>
        <h1>How to Subscribe to RSS</h1>
        <p>RSS feeds are a great way to follow news. Many sites offer RSS feeds.</p>
        <p>You can use an RSS reader to subscribe to RSS feeds from your favorite sites.</p>
        <a href="/about">About Us</a>
        <a href="/contact">Contact</a>
      </body></html>
    `;
    const mentionResponse = setResponseUrl(
      makeResponse(mentionPageHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/rss-feeds",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/sport") return targetResponse;
      if (url === "https://example.com/rss-feeds") return mentionResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/sport",
      userAgent: "NuSift-Test",
    });

    // Should NOT classify this as a directory page
    expect(result.feedUrl).toBeNull();
    expect(result.taxonomyEvidence.directoryTraversal).toBeUndefined();
  });

  it("accepts a directory with moderate feed links inside list structure", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/tech",
    );

    const targetHtml = `
      <html><body>
        <a href="/feed-list">Feed List</a>
      </body></html>
    `;
    const targetResponse = setResponseUrl(
      makeResponse(targetHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/tech",
    );

    // Only 3 feed links but inside a list — should pass with composite scoring
    const directoryHtml = `
      <html><body>
        <h1>Our Feeds</h1>
        <ul>
          <li><a href="/feed/1.xml">Technology - RSS Feed</a></li>
          <li><a href="/feed/2.xml">Science - RSS Feed</a></li>
          <li><a href="/feed/3.xml">Gadgets - RSS Feed</a></li>
        </ul>
      </body></html>
    `;
    const directoryResponse = setResponseUrl(
      makeResponse(directoryHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/feed-list",
    );

    const makeFeed = () => setResponseUrl(
      makeResponse(
        `<?xml version="1.0"?><rss><channel><title>Tech</title><item><title>S</title><link>https://example.com/tech/1</link></item></channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      ),
      "https://example.com/feed/1.xml",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/tech") return targetResponse;
      if (url === "https://example.com/feed-list") return directoryResponse;
      if (url === "https://example.com/feed/1.xml") return makeFeed();
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/tech",
      userAgent: "NuSift-Test",
      preferScopedDirectFeed: true,
    });

    expect(result.feedUrl).toBe("https://example.com/feed/1.xml");
    expect(result.detection).toBe("directory-traversal");
  });

  it("generic labels like 'news' should not over-match unrelated targets", async () => {
    const headResponse = setResponseUrl(
      makeResponse("", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/sport/cricket",
    );

    const targetHtml = `
      <html><body>
        <a href="/rss-directory">RSS Directory</a>
      </body></html>
    `;
    const targetResponse = setResponseUrl(
      makeResponse(targetHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/sport/cricket",
    );

    // Directory has "News" label that overlaps with generic tokens but doesn't match "cricket"
    const directoryHtml = `
      <html><body>
        <h1>RSS Directory</h1>
        <ul>
          <li><a href="/feed/a.xml">News - RSS</a></li>
          <li><a href="/feed/b.xml">Sports News - RSS</a></li>
          <li><a href="/feed/c.xml">Local News - RSS</a></li>
          <li><a href="/feed/d.xml">Breaking News - RSS</a></li>
          <li><a href="/feed/e.xml">World News - RSS</a></li>
        </ul>
      </body></html>
    `;
    const directoryResponse = setResponseUrl(
      makeResponse(directoryHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/rss-directory",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/sport/cricket") return targetResponse;
      if (url === "https://example.com/rss-directory") return directoryResponse;
      return makeResponse("not found", { status: 404 });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/sport/cricket",
      userAgent: "NuSift-Test",
      preferScopedDirectFeed: true,
    });

    // None of these generic labels should match "cricket"
    expect(result.feedUrl).toBeNull();
  });
});

describe("feed directory traversal helpers", () => {
  it("findDirectoryUrl picks the best-scoring directory link", async () => {
    const html = `
      <html><body>
        <a href="/about">About Us</a>
        <a href="/rss-feeds">All RSS Feeds</a>
        <a href="/random">Random page</a>
      </body></html>
    `;

    // Test via discoverFeedForUrl to exercise the helper in context
    const headResponse = setResponseUrl(
      makeResponse("", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/test",
    );
    const targetResponse = setResponseUrl(
      makeResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/test",
    );

    safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === "HEAD") return headResponse;
      if (url === "https://example.com/test") return targetResponse;
      // Return non-directory page to test classification
      return makeResponse("<html><body><p>Not a directory</p></body></html>", { headers: { "content-type": "text/html" } });
    });

    const { discoverFeedForUrl } = await import("./feed-discovery");
    const result = await discoverFeedForUrl({
      pageUrl: "https://example.com/test",
      userAgent: "NuSift-Test",
    });

    // No feed found, but the directory URL should have been attempted
    // (the mock returns a non-directory page, so it should abort)
    expect(result.feedUrl).toBeNull();
    expect(result.taxonomyEvidence.directoryTraversal).toBeUndefined();
  });
});
