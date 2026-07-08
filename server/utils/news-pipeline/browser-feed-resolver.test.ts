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

describe("browser-feed-resolver", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("shouldAttemptBrowserResolution", () => {
    it("returns true for normal page URLs", async () => {
      const { shouldAttemptBrowserResolution } = await import("./browser-feed-resolver");
      expect(shouldAttemptBrowserResolution("https://example.com/news")).toBe(true);
      expect(shouldAttemptBrowserResolution("https://example.com/")).toBe(true);
      expect(shouldAttemptBrowserResolution("https://example.com/sport/football")).toBe(true);
    });

    it("returns false for direct feed URLs", async () => {
      const { shouldAttemptBrowserResolution } = await import("./browser-feed-resolver");
      expect(shouldAttemptBrowserResolution("https://example.com/rss")).toBe(false);
      expect(shouldAttemptBrowserResolution("https://example.com/feed/")).toBe(false);
      expect(shouldAttemptBrowserResolution("https://example.com/feed.xml")).toBe(false);
      expect(shouldAttemptBrowserResolution("https://example.com/atom.xml")).toBe(false);
    });

    it("returns false for invalid URLs", async () => {
      const { shouldAttemptBrowserResolution } = await import("./browser-feed-resolver");
      expect(shouldAttemptBrowserResolution("not-a-url")).toBe(false);
      expect(shouldAttemptBrowserResolution("")).toBe(false);
    });

    it("returns false for non-http protocols", async () => {
      const { shouldAttemptBrowserResolution } = await import("./browser-feed-resolver");
      expect(shouldAttemptBrowserResolution("ftp://example.com")).toBe(false);
    });
  });

  describe("resolveFeedsWithBrowser", () => {
    it("returns empty candidates when fetch fails", async () => {
      safeFetchMock.mockRejectedValue(new Error("Network error"));

      const { resolveFeedsWithBrowser } = await import("./browser-feed-resolver");
      const result = await resolveFeedsWithBrowser({
        pageUrl: "https://example.com/news",
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.method).toBe("none");
    });

    it("returns empty candidates when response is not OK", async () => {
      safeFetchMock.mockResolvedValue(
        setResponseUrl(makeResponse("not found", { status: 404 }), "https://example.com/news"),
      );

      const { resolveFeedsWithBrowser } = await import("./browser-feed-resolver");
      const result = await resolveFeedsWithBrowser({
        pageUrl: "https://example.com/news",
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.method).toBe("none");
    });

    it("extracts link[rel=alternate] feed candidates from real DOM", async () => {
      const html = `<!DOCTYPE html>
<html>
<head>
  <link rel="alternate" type="application/rss+xml" href="/rss.xml" title="RSS Feed" />
  <link rel="alternate" type="application/atom+xml" href="/atom.xml" title="Atom Feed" />
  <link rel="stylesheet" href="/style.css" />
</head>
<body><p>News page</p></body>
</html>`;

      const htmlResponse = setResponseUrl(
        makeResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
        "https://example.com/news",
      );

      safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
        if (url === "https://example.com/news" && !options?.method) return htmlResponse;
        // Common path probes return 404
        return makeResponse("not found", { status: 404 });
      });

      const { resolveFeedsWithBrowser } = await import("./browser-feed-resolver");
      const result = await resolveFeedsWithBrowser({
        pageUrl: "https://example.com/news",
      });

      expect(result.method).toBe("jsdom");
      expect(result.renderedDomAvailable).toBe(true);
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);

      const feedUrls = result.candidates.map((c) => c.feedUrl);
      expect(feedUrls).toContain("https://example.com/rss.xml");
      expect(feedUrls).toContain("https://example.com/atom.xml");

      const rssCandidate = result.candidates.find((c) => c.feedUrl === "https://example.com/rss.xml");
      expect(rssCandidate?.source).toBe("dom-link");
    });

    it("extracts feed URLs from inline scripts", async () => {
      const html = `<!DOCTYPE html>
<html>
<head>
  <script>window.__CONFIG__ = {"feedUrl":"https://cdn.example.com/feeds/news.xml","title":"News"}</script>
</head>
<body></body>
</html>`;

      const htmlResponse = setResponseUrl(
        makeResponse(html, { headers: { "content-type": "text/html" } }),
        "https://example.com/news",
      );

      safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
        if (url === "https://example.com/news" && !options?.method) return htmlResponse;
        return makeResponse("not found", { status: 404 });
      });

      const { resolveFeedsWithBrowser } = await import("./browser-feed-resolver");
      const result = await resolveFeedsWithBrowser({
        pageUrl: "https://example.com/news",
      });

      const feedUrls = result.candidates.map((c) => c.feedUrl);
      expect(feedUrls).toContain("https://cdn.example.com/feeds/news.xml");
      const scriptCandidate = result.candidates.find(
        (c) => c.feedUrl === "https://cdn.example.com/feeds/news.xml",
      );
      expect(scriptCandidate?.source).toBe("inline-script");
    });

    it("extracts feed URLs from anchor tags with feed-like text", async () => {
      const html = `<!DOCTYPE html>
<html>
<body>
  <a href="/rss/latest">RSS Feed</a>
  <a href="/about">About Us</a>
  <a href="/news/daily" title="Atom Feed">Daily News</a>
</body>
</html>`;

      const htmlResponse = setResponseUrl(
        makeResponse(html, { headers: { "content-type": "text/html" } }),
        "https://example.com/news",
      );

      safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
        if (url === "https://example.com/news" && !options?.method) return htmlResponse;
        return makeResponse("not found", { status: 404 });
      });

      const { resolveFeedsWithBrowser } = await import("./browser-feed-resolver");
      const result = await resolveFeedsWithBrowser({
        pageUrl: "https://example.com/news",
      });

      const feedUrls = result.candidates.map((c) => c.feedUrl);
      expect(feedUrls).toContain("https://example.com/rss/latest");
      // Should NOT contain /about (not feed-like text)
      expect(feedUrls).not.toContain("https://example.com/about");
    });

    it("discovers feeds from common path probing", async () => {
      const html = `<!DOCTYPE html><html><head></head><body><p>Simple page</p></body></html>`;

      const htmlResponse = setResponseUrl(
        makeResponse(html, { headers: { "content-type": "text/html" } }),
        "https://example.com/news",
      );

      const rssFeedResponse = setResponseUrl(
        makeResponse('<?xml version="1.0"?><rss><channel><item><title>T</title></item></channel></rss>', {
          headers: { "content-type": "application/rss+xml" },
        }),
        "https://example.com/news/rss",
      );

      safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
        if (url === "https://example.com/news" && !options?.method) return htmlResponse;
        // The common path probe for /rss (with trailing slash stripped from basePath + /rss/)
        if (url.includes("/rss") && options?.method === "HEAD") return rssFeedResponse;
        return makeResponse("not found", { status: 404 });
      });

      const { resolveFeedsWithBrowser } = await import("./browser-feed-resolver");
      const result = await resolveFeedsWithBrowser({
        pageUrl: "https://example.com/news",
      });

      const probeCandidates = result.candidates.filter((c) => c.source === "common-path-probe");
      expect(probeCandidates.length).toBeGreaterThanOrEqual(1);
      expect(probeCandidates.some((c) => c.feedUrl.includes("/rss"))).toBe(true);
    });

    it("deduplicates candidates from different sources", async () => {
      const html = `<!DOCTYPE html>
<html>
<head>
  <link rel="alternate" type="application/rss+xml" href="/rss" title="RSS" />
</head>
<body>
  <a href="/rss">RSS Feed</a>
</body>
</html>`;

      const htmlResponse = setResponseUrl(
        makeResponse(html, { headers: { "content-type": "text/html" } }),
        "https://example.com/news",
      );

      safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
        if (url === "https://example.com/news" && !options?.method) return htmlResponse;
        return makeResponse("not found", { status: 404 });
      });

      const { resolveFeedsWithBrowser } = await import("./browser-feed-resolver");
      const result = await resolveFeedsWithBrowser({
        pageUrl: "https://example.com/news",
      });

      // /rss discovered from both dom-link and anchor-tag should be deduplicated
      const rssCandidates = result.candidates.filter(
        (c) => c.feedUrl === "https://example.com/rss",
      );
      expect(rssCandidates).toHaveLength(1);
      // First discovery source should be used (dom-link)
      expect(rssCandidates[0]?.source).toBe("dom-link");
    });

    it("extracts JSON-LD structured data feed URLs", async () => {
      const html = `<!DOCTYPE html>
<html>
<head>
  <script type="application/ld+json">
    {"@type": "WebSite", "feedUrl": "https://example.com/api/feed.json", "name": "Example"}
  </script>
</head>
<body></body>
</html>`;

      const htmlResponse = setResponseUrl(
        makeResponse(html, { headers: { "content-type": "text/html" } }),
        "https://example.com/news",
      );

      safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
        if (url === "https://example.com/news" && !options?.method) return htmlResponse;
        return makeResponse("not found", { status: 404 });
      });

      const { resolveFeedsWithBrowser } = await import("./browser-feed-resolver");
      const result = await resolveFeedsWithBrowser({
        pageUrl: "https://example.com/news",
      });

      const feedUrls = result.candidates.map((c) => c.feedUrl);
      expect(feedUrls).toContain("https://example.com/api/feed.json");
      const jsonLdCandidate = result.candidates.find(
        (c) => c.feedUrl === "https://example.com/api/feed.json",
      );
      expect(jsonLdCandidate?.source).toBe("json-ld");
    });

    it("filters out blocked paths like feedback and contact", async () => {
      const html = `<!DOCTYPE html>
<html>
<body>
  <a href="/feedback">RSS Feedback</a>
  <a href="/contact/rss-form">Contact RSS</a>
  <a href="/rss/real-feed">Real RSS</a>
</body>
</html>`;

      const htmlResponse = setResponseUrl(
        makeResponse(html, { headers: { "content-type": "text/html" } }),
        "https://example.com/news",
      );

      safeFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
        if (url === "https://example.com/news" && !options?.method) return htmlResponse;
        return makeResponse("not found", { status: 404 });
      });

      const { resolveFeedsWithBrowser } = await import("./browser-feed-resolver");
      const result = await resolveFeedsWithBrowser({
        pageUrl: "https://example.com/news",
      });

      const feedUrls = result.candidates.map((c) => c.feedUrl);
      expect(feedUrls).not.toContain("https://example.com/feedback");
      expect(feedUrls).not.toContain("https://example.com/contact/rss-form");
      expect(feedUrls).toContain("https://example.com/rss/real-feed");
    });

    it("returns method 'none' when jsdom finds no candidates", async () => {
      const html = `<!DOCTYPE html><html><head></head><body><p>No feeds here</p></body></html>`;

      const htmlResponse = setResponseUrl(
        makeResponse(html, { headers: { "content-type": "text/html" } }),
        "https://example.com/about",
      );

      safeFetchMock.mockImplementation(async () => {
        return makeResponse("not found", { status: 404 });
      });

      // Override the first call to return the HTML
      safeFetchMock.mockImplementationOnce(async () => htmlResponse);

      const { resolveFeedsWithBrowser } = await import("./browser-feed-resolver");
      const result = await resolveFeedsWithBrowser({
        pageUrl: "https://example.com/about",
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.method).toBe("none");
    });
  });

  describe("resolveWithPlaywright", () => {
    it("returns null when PLAYWRIGHT_ENABLED is not set", async () => {
      const originalEnv = process.env.PLAYWRIGHT_ENABLED;
      delete process.env.PLAYWRIGHT_ENABLED;

      const { resolveWithPlaywright } = await import("./browser-feed-resolver");
      const result = await resolveWithPlaywright({
        pageUrl: "https://example.com/news",
      });

      expect(result).toBeNull();
      process.env.PLAYWRIGHT_ENABLED = originalEnv;
    });
  });
});
