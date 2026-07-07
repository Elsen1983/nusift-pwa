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
});
