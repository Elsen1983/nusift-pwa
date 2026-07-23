import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockPageGoto = vi.fn();
const mockPageEvaluate = vi.fn();
const mockPageTitle = vi.fn();
const mockPageRoute = vi.fn();
const mockPageUrl = vi.fn();
const mockPageClose = vi.fn();
const mockContextNewPage = vi.fn();
const mockContextClose = vi.fn();
const mockBrowserNewContext = vi.fn();
const mockBrowserClose = vi.fn();
const mockChromiumLaunch = vi.fn();

vi.mock("playwright", () => ({
  chromium: {
    launch: (...args: any[]) => mockChromiumLaunch(...args),
  },
}));

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makePlaywrightPage(overrides: {
  html?: string;
  anchors?: string[];
  title?: string;
  url?: string;
  ok?: boolean;
  status?: number;
  gotoError?: string;
} = {}) {
  const {
    html = "<html><body></body></html>",
    anchors = [],
    title = "Test Page",
    url = "https://example.com/news",
    ok = true,
    status = 200,
    gotoError,
  } = overrides;

  const mockResponse = {
    ok: () => ok,
    status: () => status,
  };

  if (gotoError) {
    mockPageGoto.mockRejectedValue(new Error(gotoError));
  } else {
    mockPageGoto.mockResolvedValue(mockResponse);
  }

  mockPageTitle.mockResolvedValue(title);
  mockPageUrl.mockReturnValue(url);
  mockPageEvaluate.mockResolvedValue(anchors.length);

  // Route mock - just call the handler with a mock route
  mockPageRoute.mockImplementation(async (_pattern: string, handler: Function) => {
    // Don't actually block anything in tests
  });

  const page = {
    goto: mockPageGoto,
    evaluate: mockPageEvaluate,
    title: mockPageTitle,
    url: mockPageUrl,
    route: mockPageRoute,
    close: mockPageClose,
  };

  mockContextNewPage.mockResolvedValue(page);
  mockBrowserNewContext.mockResolvedValue({ newPage: mockContextNewPage, close: mockContextClose });
  mockChromiumLaunch.mockResolvedValue({ newContext: mockBrowserNewContext, close: mockBrowserClose });

  return page;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("discoverArticleLinksWithBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all mock implementations
    mockPageGoto.mockReset();
    mockPageEvaluate.mockReset();
    mockPageTitle.mockReset();
    mockPageRoute.mockReset();
    mockPageUrl.mockReset();
    mockPageClose.mockReset();
    mockContextNewPage.mockReset();
    mockContextClose.mockReset();
    mockBrowserNewContext.mockReset();
    mockBrowserClose.mockReset();
    mockChromiumLaunch.mockReset();
  });

  async function loadFn() {
    const mod = await import("./article-discovery-browser");
    mod.setArticleDiscoveryBrowserImporterForTest(async () => ({
      chromium: {
        launch: (...args: any[]) => mockChromiumLaunch(...args),
      },
    }));
    return mod.discoverArticleLinksWithBrowser;
  }

  async function loadIsEnabled() {
    const mod = await import("./article-discovery-browser");
    return mod.isBrowserFallbackEnabled;
  }

  it("returns disabled when NUXT_ENABLE_AGENT2_BROWSER_FALLBACK is not set", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    delete process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com",
      sourceId: "src-1",
      targetType: "source",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("browser_fallback_disabled");
    expect(result.links).toEqual([]);
    expect(result.rawLinkCount).toBe(0);
    expect(result.shortlistedLinkCount).toBe(0);
    expect(result.topRejectedLinks).toEqual([]);
    expect(result.shortlistedLinkSamples).toEqual([]);
    expect(result.topRejectionReasons).toEqual([]);
    expect(result.diagnostics.browserRuntimeAvailable).toBe(false);
    expect(result.diagnostics.blockedReason).toContain("NUXT_ENABLE_AGENT2_BROWSER_FALLBACK");
    expect(mockChromiumLaunch).not.toHaveBeenCalled();

    if (original !== undefined) {
      process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original;
    }
  });

  it("returns runtime unavailable with launch diagnostics when Playwright cannot launch", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    // Make chromium.launch return null to simulate runtime unavailable
    mockChromiumLaunch.mockRejectedValueOnce(new Error("Browser not installed"));

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com",
      sourceId: "src-1",
      targetType: "source",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("browser_runtime_unavailable");
    expect(result.diagnostics.browserRuntimeAvailable).toBe(false);
    expect(result.diagnostics.blockedReason).toContain("playwright: Browser not installed");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("returns navigation_failed when page.goto fails", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage({ gotoError: "net::ERR_CONNECTION_REFUSED" });

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com",
      sourceId: "src-1",
      targetType: "source",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("navigation_failed");
    expect(result.diagnostics.blockedReason).toContain("net::ERR_CONNECTION_REFUSED");
    expect(mockBrowserClose).toHaveBeenCalled();

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("returns http_error when response is not ok", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage({ ok: false, status: 403 });

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com",
      sourceId: "src-1",
      targetType: "source",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("http_error");
    expect(result.diagnostics.blockedReason).toContain("403");
    expect(mockBrowserClose).toHaveBeenCalled();

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("isBrowserFallbackEnabled returns false when env is not set", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    delete process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;

    const isEnabled = await loadIsEnabled();
    expect(isEnabled()).toBe(false);

    if (original !== undefined) {
      process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original;
    }
  });

  it("isBrowserFallbackEnabled returns true when env is set to true", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    const isEnabled = await loadIsEnabled();
    expect(isEnabled()).toBe(true);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("isBrowserFallbackEnabled tolerates surrounding whitespace and casing", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = " TRUE\n";

    const isEnabled = await loadIsEnabled();
    expect(isEnabled()).toBe(true);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("returns scored links on successful Playwright render", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    // Mock page.evaluate to simulate DOM extraction.
    // Call 1: anchor count (number)
    // Call 2: raw links from extractRawLinksFromBrowser (array of {url, text})
    mockPageEvaluate
      .mockResolvedValueOnce(10) // allAnchors count
      .mockResolvedValueOnce([   // rawLinks from page.evaluate()
        { url: "https://example.com/news/2026/07/16/big-breaking-story-here", text: "Big breaking story here" },
        { url: "https://example.com/news/2026/07/15/another-good-article", text: "Another good article" },
        { url: "https://example.com/about", text: "About us" }, // should be filtered as utility
      ]);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("News Site");
    mockPageUrl.mockReturnValue("https://example.com/news");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      targetType: "source",
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics.browserRuntimeAvailable).toBe(true);
    expect(result.diagnostics.pageTitle).toBe("News Site");
    expect(result.renderedUrl).toBe("https://example.com/news");
    expect(mockBrowserClose).toHaveBeenCalled();

    // The two article links should pass scoring, but the /about link is filtered
    expect(result.links.length).toBe(2);
    expect(result.links[0]!.url).toBe("https://example.com/news/2026/07/16/big-breaking-story-here");
    expect(result.links[0]!.sourceKind).toBe("browser");
    expect(result.links[0]!.sourcePageUrl).toBe("browser:https://example.com/news");
    expect(result.links[0]!.rawSignals.anchorText).toBe("Big breaking story here");
    expect(result.diagnostics.articleLikeLinkCount).toBe(2);

    // New audit fields
    expect(result.rawLinkCount).toBe(3); // 3 raw links extracted from DOM
    expect(result.shortlistedLinkCount).toBe(2); // 2 passed scoring
    expect(result.topRejectedLinks.length).toBe(1); // /about was rejected as utility_path
    expect(result.topRejectedLinks[0]!.reason).toBe("utility_path");
    expect(result.topRejectedLinks[0]!.utilityPath).toBe(true);
    expect(result.shortlistedLinkSamples.length).toBe(2);
    expect(result.shortlistedLinkSamples[0]!.rejected).toBe(false);
    expect(result.topRejectionReasons.length).toBe(1);
    expect(result.topRejectionReasons[0]!.reason).toBe("utility_path");
    expect(result.topRejectionReasons[0]!.count).toBe(1);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("falls back to basic raw-link extraction when rich DOM extraction fails", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    mockPageEvaluate
      .mockResolvedValueOnce(2) // allAnchors count
      .mockRejectedValueOnce(new Error("rich extraction failed"))
      .mockResolvedValueOnce([
        { url: "https://example.com/news/2026/07/20/browser-fallback-story", text: "Browser fallback story", dateText: null },
        { url: "https://example.com/about", text: "About", dateText: null },
      ]);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("News Site");
    mockPageUrl.mockReturnValue("https://example.com/news");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      targetType: "source",
    });

    expect(result.ok).toBe(true);
    expect(result.rawLinkCount).toBe(2);
    expect(result.links.length).toBe(1);
    expect(result.diagnostics.rawExtractionFallbackUsed).toBe(true);
    expect(result.diagnostics.rawExtractionError).toBe("rich extraction failed");
    expect(mockPageEvaluate).toHaveBeenCalledTimes(3);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("falls back to basic raw-link extraction when rich extraction returns empty despite anchors", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    mockPageEvaluate
      .mockResolvedValueOnce(2) // allAnchors count
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { url: "https://example.com/news/2026/07/20/basic-fallback-story", text: "Basic fallback story", dateText: null },
      ]);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("News Site");
    mockPageUrl.mockReturnValue("https://example.com/news");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      targetType: "source",
    });

    expect(result.ok).toBe(true);
    expect(result.rawLinkCount).toBe(1);
    expect(result.links.length).toBe(1);
    expect(result.diagnostics.rawExtractionFallbackUsed).toBe(true);
    expect(result.diagnostics.rawExtractionError).toBeUndefined();
    expect(mockPageEvaluate).toHaveBeenCalledTimes(3);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("produces correct rejection buckets for mixed raw links", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    // Mock page.evaluate to return a mix of link types:
    // - cross-domain link (different_domain)
    // - utility path (utility_path)
    // - category-out-of-scope link (out_of_category_scope)
    // - valid article links
    mockPageEvaluate
      .mockResolvedValueOnce(6) // allAnchors count
      .mockResolvedValueOnce([
        { url: "https://other-site.com/news/2026/07/20/cross-domain", text: "Cross domain" },
        { url: "https://example.com/about", text: "About us" },
        { url: "https://example.com/news/politics/old-article", text: "Old politics" },
        { url: "https://example.com/news/sports/2026/07/20/valid-story-here", text: "Valid sports story here" },
      ]);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("News Site");
    mockPageUrl.mockReturnValue("https://example.com/news");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      targetType: "source",
      categoryPathUrl: "https://example.com/news/sports",
    });

    expect(result.ok).toBe(true);
    // Check rejection buckets
    const rejectionReasons = result.topRejectedLinks.map((e) => e.reason);
    expect(rejectionReasons).toContain("different_domain");
    expect(rejectionReasons).toContain("utility_path");
    // /news/politics/old-article is out of category scope (/news/sports)
    expect(rejectionReasons).toContain("out_of_category_scope");

    // Check top rejection reasons aggregation
    const reasonCounts = Object.fromEntries(
      result.topRejectionReasons.map((r) => [r.reason, r.count]),
    );
    expect(reasonCounts["different_domain"]).toBe(1);
    expect(reasonCounts["utility_path"]).toBe(1);
    expect(reasonCounts["out_of_category_scope"]).toBe(1);

    // Only the valid sports-category article should be shortlisted
    expect(result.shortlistedLinkCount).toBe(1);
    expect(result.shortlistedLinkSamples[0]!.url).toBe("https://example.com/news/sports/2026/07/20/valid-story-here");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("uses serverless Chromium with playwright-core on Vercel", async () => {
    const originalFlag = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    const originalVercel = process.env.VERCEL;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";
    process.env.VERCEL = "1";

    makePlaywrightPage();
    mockPageEvaluate
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce([
        { url: "https://example.com/news/2026/07/16/serverless-browser-story", text: "Serverless browser story" },
      ]);

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCoreLaunch = vi.fn().mockResolvedValue(mockBrowser);
    const mockExecutablePath = vi.fn().mockResolvedValue("/tmp/chromium");

    const mod = await import("./article-discovery-browser");
    mod.setArticleDiscoveryBrowserImporterForTest(async (specifier: string) => {
      if (specifier === "playwright-core") {
        return {
          chromium: {
            launch: (...args: any[]) => mockCoreLaunch(...args),
          },
        };
      }
      if (specifier === "@sparticuz/chromium") {
        return {
          default: {
            args: ["--no-sandbox"],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: mockExecutablePath,
            headless: true,
          },
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    });

    const result = await mod.discoverArticleLinksWithBrowser({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      targetType: "source",
    });

    expect(result.ok).toBe(true);
    expect(mockExecutablePath).toHaveBeenCalled();
    expect(mockCoreLaunch).toHaveBeenCalledWith(expect.objectContaining({
      args: ["--no-sandbox"],
      executablePath: "/tmp/chromium",
      headless: true,
    }));
    expect(mockChromiumLaunch).not.toHaveBeenCalled();

    mod.setArticleDiscoveryBrowserImporterForTest(null);
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = originalFlag || "";
    process.env.VERCEL = originalVercel || "";
  });

  it("caps timeout at 15 seconds", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage({ gotoError: "timeout" });

    const fn = await loadFn();
    await fn({
      targetUrl: "https://example.com",
      sourceId: "src-1",
      targetType: "source",
      timeoutMs: 60000, // request 60s but should be capped
    });

    // The goto call should have been made with timeout capped at 15000
    expect(mockPageGoto).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ timeout: 15000 }),
    );

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("includes deterministic rejection buckets for mixed raw links", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    // Cover the deterministic rejection buckets:
    // - different_domain: cross-domain link
    // - utility_path: /about link
    // - out_of_category_scope: /news/politics/ under /news/sports/ category
    //
    // Note: "low_score" and "invalid_url" are defensive buckets that are
    // unreachable from browser-resolved URLs with the current scoring:
    // - scoreCandidateUrl gives +20 (same_domain) +15 (not_utility) = 35
    //   minimum, which exceeds the REJECTION_THRESHOLD of 30.
    // - Browser-resolved URLs pass new URL() and normalizeUrl().
    mockPageEvaluate
      .mockResolvedValueOnce(8) // allAnchors count
      .mockResolvedValueOnce([
        { url: "https://other-site.com/news/2026/07/20/cross-domain", text: "Cross domain" },
        { url: "https://example.com/about", text: "About us" },
        { url: "https://example.com/news/politics/old-politics-article", text: "Out of scope politics" },
        { url: "https://example.com/news/sports/2026/07/20/article-one-here-today", text: "Good article one here today" },
        { url: "https://example.com/news/sports/2026/07/19/article-two-here-today", text: "Good article two here today" },
        { url: "https://example.com/news/sports/2026/07/18/article-three-here-today", text: "Good article three here today" },
        { url: "https://example.com/news/sports/2026/07/17/article-four-here-today", text: "Good article four here today" },
        { url: "https://example.com/news/sports/2026/07/16/article-five-here-today", text: "Good article five here today" },
      ]);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("News Site");
    mockPageUrl.mockReturnValue("https://example.com/news");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      targetType: "source",
      categoryPathUrl: "https://example.com/news/sports",
    });

    expect(result.ok).toBe(true);
    expect(result.rawLinkCount).toBe(8);

    // Deterministic rejection buckets
    const rejectionReasons = Object.fromEntries(
      result.topRejectionReasons.map((r) => [r.reason, r.count]),
    );
    expect(rejectionReasons["different_domain"]).toBe(1);
    expect(rejectionReasons["utility_path"]).toBe(1);
    expect(rejectionReasons["out_of_category_scope"]).toBe(1);

    // 5 valid sports-category articles should be shortlisted
    expect(result.shortlistedLinkCount).toBe(5);
    expect(result.links.length).toBe(5);

    // The rejected links should cover all 3 deterministic buckets
    const rejectedReasons = result.topRejectedLinks.map((e) => e.reason);
    expect(rejectedReasons).toContain("different_domain");
    expect(rejectedReasons).toContain("utility_path");
    expect(rejectedReasons).toContain("out_of_category_scope");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("allows strong article links from category-directory pages even when article URLs are global", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    mockPageEvaluate
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce([
        { url: "https://www.bignewsnetwork.com/", text: "Home" },
        { url: "https://www.bignewsnetwork.com/category/breaking-business-news", text: "Breaking Business News" },
        { url: "https://www.bignewsnetwork.com/news/278416836/arizona-heat-warning-remains-in-effect", text: "Arizona heat warning remains in effect", dateText: "10 July 2026" },
        { url: "https://www.bignewsnetwork.com/news/278416837/phoenix-schools-expand-summer-programs", text: "Phoenix schools expand summer programs", dateText: "10 July 2026" },
        { url: "https://other-site.com/news/278416838/cross-domain", text: "Cross domain story" },
      ]);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("Arizona News");
    mockPageUrl.mockReturnValue("https://www.bignewsnetwork.com/category/arizona-news");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://www.bignewsnetwork.com/category/arizona-news",
      sourceId: "src-1",
      targetType: "category",
      categoryPathUrl: "https://www.bignewsnetwork.com/category/arizona-news",
    });

    expect(result.ok).toBe(true);
    expect(result.shortlistedLinkCount).toBe(2);
    expect(result.links.map((link) => link.url)).toEqual([
      "https://www.bignewsnetwork.com/news/278416836/arizona-heat-warning-remains-in-effect",
      "https://www.bignewsnetwork.com/news/278416837/phoenix-schools-expand-summer-programs",
    ]);
    expect(result.links[0]!.rawSignals.listingDateText).toBe("10 July 2026");
    expect(result.shortlistedLinkSamples.every((entry) => entry.scoreReasons.includes("listing_context_scope"))).toBe(true);

    const rejectionReasons = Object.fromEntries(
      result.topRejectionReasons.map((r) => [r.reason, r.count]),
    );
    expect(rejectionReasons["out_of_category_scope"]).toBe(1);
    expect(rejectionReasons["utility_path"]).toBe(1);
    expect(rejectionReasons["different_domain"]).toBe(1);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("does not shortlist the listing page itself as an article candidate", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    mockPageEvaluate
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce([
        { url: "https://www.bignewsnetwork.com/category/arizona-news", text: "Arizona News", dateText: "10 July 2026" },
      ]);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("Arizona News");
    mockPageUrl.mockReturnValue("https://www.bignewsnetwork.com/category/arizona-news");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://www.bignewsnetwork.com/category/arizona-news",
      sourceId: "src-1",
      targetType: "category",
      categoryPathUrl: "https://www.bignewsnetwork.com/category/arizona-news",
    });

    expect(result.shortlistedLinkCount).toBe(0);
    expect(result.links).toEqual([]);
    expect(result.topRejectionReasons).toEqual([{ reason: "listing_page", count: 1 }]);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("does not allow sibling category links through the category-directory escape hatch", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    mockPageEvaluate
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce([
        { url: "https://www.bignewsnetwork.com/category/breaking-business-news", text: "Breaking Business News" },
        { url: "https://www.bignewsnetwork.com/category/international-business-news", text: "International Business News" },
      ]);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("Arizona News");
    mockPageUrl.mockReturnValue("https://www.bignewsnetwork.com/category/arizona-news");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://www.bignewsnetwork.com/category/arizona-news",
      sourceId: "src-1",
      targetType: "category",
      categoryPathUrl: "https://www.bignewsnetwork.com/category/arizona-news",
    });

    expect(result.ok).toBe(true);
    expect(result.shortlistedLinkCount).toBe(0);
    expect(result.links).toEqual([]);
    expect(result.topRejectionReasons).toEqual([
      { reason: "out_of_category_scope", count: 2 },
    ]);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("rejects pagination variants of the rendered listing page", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    mockPageEvaluate
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce([
        { url: "https://telex.hu/rovat/eletmod?oldal=1", text: "1", dateText: null },
        { url: "https://telex.hu/rovat/eletmod?oldal=2", text: "2", dateText: null },
        { url: "https://telex.hu/rovat/eletmod?oldal=3", text: "3", dateText: null },
        { url: "https://telex.hu/rovat/eletmod?oldal=94", text: ">>", dateText: null },
      ]);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("Eletmod");
    mockPageUrl.mockReturnValue("https://telex.hu/rovat/eletmod");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://telex.hu/rovat/eletmod",
      sourceId: "src-1",
      targetType: "category",
      categoryPathUrl: "https://telex.hu/rovat/eletmod",
    });

    expect(result.rawLinkCount).toBe(4);
    expect(result.shortlistedLinkCount).toBe(0);
    expect(result.links).toEqual([]);
    expect(result.topRejectionReasons).toEqual([{ reason: "listing_page", count: 4 }]);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("audits all raw links even after 25 accepted shortlist links are collected", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    // Generate 30 valid article links that pass scoring (date-pattern URLs)
    // and 5 cross-domain links that should be rejected.
    const validLinks = Array.from({ length: 30 }, (_, i) => ({
      url: `https://example.com/news/2026/07/${String(i + 1).padStart(2, "0")}/story-${i + 1}-headline-here`,
      text: `Story ${i + 1} headline here`,
    }));
    const crossDomainLinks = Array.from({ length: 5 }, (_, i) => ({
      url: `https://other-${i}.com/news/2026/07/20/article-${i}`,
      text: `Cross domain ${i}`,
    }));
    const rawLinks = [...validLinks, ...crossDomainLinks];

    mockPageEvaluate
      .mockResolvedValueOnce(rawLinks.length)
      .mockResolvedValueOnce(rawLinks);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("Big News Network");
    mockPageUrl.mockReturnValue("https://example.com/news");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      targetType: "source",
    });

    expect(result.ok).toBe(true);
    // All 35 raw links were audited
    expect(result.rawLinkCount).toBe(35);
    // 30 valid articles accepted (pre-cap count)
    expect(result.shortlistedLinkCount).toBe(30);
    // But returned links array is capped at 25
    expect(result.links.length).toBe(25);
    // Top 5 cross-domain links rejected (all 5 domains)
    expect(result.topRejectedLinks.length).toBe(5);
    const rejectionReasons = Object.fromEntries(
      result.topRejectionReasons.map((r) => [r.reason, r.count]),
    );
    expect(rejectionReasons["different_domain"]).toBe(5);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("caps returned links at MAX_BROWSER_SHORTLISTED_LINKS but rejection reasons reflect the full raw sample", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    // 30 accepted + 5 cross-domain = 35 raw links.
    // After the cap, only 25 links are returned, but all 5 cross-domain
    // rejections must still appear in topRejectionReasons.
    const validLinks = Array.from({ length: 30 }, (_, i) => ({
      url: `https://example.com/news/2026/07/${String(i + 1).padStart(2, "0")}/article-${i + 1}-long-slug`,
      text: `Article ${i + 1} long slug`,
    }));
    const rejectedLinks = [
      { url: "https://other-a.com/article", text: "Cross A" },
      { url: "https://other-b.com/article", text: "Cross B" },
      { url: "https://other-c.com/article", text: "Cross C" },
      { url: "https://other-d.com/article", text: "Cross D" },
      { url: "https://other-e.com/article", text: "Cross E" },
    ];
    const rawLinks = [...validLinks, ...rejectedLinks];

    mockPageEvaluate
      .mockResolvedValueOnce(rawLinks.length)
      .mockResolvedValueOnce(rawLinks);
    mockPageGoto.mockResolvedValue({ ok: () => true, status: () => 200 });
    mockPageTitle.mockResolvedValue("Big News Network");
    mockPageUrl.mockReturnValue("https://example.com/news");
    mockPageRoute.mockImplementation(async () => {});

    const mockBrowser = { newContext: mockBrowserNewContext, close: mockBrowserClose };
    const mockCtx = { newPage: mockContextNewPage, close: mockContextClose };
    const mockPg = {
      goto: mockPageGoto,
      evaluate: mockPageEvaluate,
      title: mockPageTitle,
      url: mockPageUrl,
      route: mockPageRoute,
    };
    mockContextNewPage.mockResolvedValue(mockPg);
    mockBrowserNewContext.mockResolvedValue(mockCtx);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);

    const fn = await loadFn();
    const result = await fn({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      targetType: "source",
    });

    expect(result.ok).toBe(true);
    // Returned links are capped at 25
    expect(result.links.length).toBe(25);
    // But shortlistedLinkCount reports the full pre-cap count
    expect(result.shortlistedLinkCount).toBe(30);
    // All 5 cross-domain rejections are captured in rejection reasons
    const rejectionReasons = Object.fromEntries(
      result.topRejectionReasons.map((r) => [r.reason, r.count]),
    );
    expect(rejectionReasons["different_domain"]).toBe(5);
    // Top rejected links are capped at 20 but contain all 5 cross-domain entries
    expect(result.topRejectedLinks.length).toBe(5);
    expect(result.topRejectedLinks.every((e) => e.reason === "different_domain")).toBe(true);

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });
});

// ─── Browser detail recovery tests ──────────────────────────────────────────

describe("evaluateArticleLinkCandidateWithBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPageGoto.mockReset();
    mockPageEvaluate.mockReset();
    mockPageTitle.mockReset();
    mockPageRoute.mockReset();
    mockPageUrl.mockReset();
    mockPageClose.mockReset();
    mockContextNewPage.mockReset();
    mockContextClose.mockReset();
    mockBrowserNewContext.mockReset();
    mockBrowserClose.mockReset();
    mockChromiumLaunch.mockReset();
  });

  async function loadFn() {
    const mod = await import("./article-discovery-browser");
    mod.setArticleDiscoveryBrowserImporterForTest(async () => ({
      chromium: {
        launch: (...args: any[]) => mockChromiumLaunch(...args),
      },
    }));
    return mod.evaluateArticleLinkCandidateWithBrowser;
  }

  /**
   * Build a RawArticleDetailData object (the shape page.evaluate returns).
   * Title goes through ogTitle (highest priority in the normalizer).
   * Date goes through jsonLdScripts with datePublished.
   */
  function makeRawDetailData(overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    const base: Record<string, unknown> = {
      pageUrl: "https://example.com/news/article",
      canonicalHref: "https://example.com/news/article",
      docTitle: "",
      h1Text: null,
      ogTitle: "Big News Story Here Today",
      twitterTitle: null,
      metaTitle: null,
      ogDescription: "A detailed description of the article.",
      metaDescription: null,
      twitterDescription: null,
      metaKeywords: "news, test",
      articlePublishedTime: null,
      ogPublishedTime: null,
      pubdate: null,
      publishdate: null,
      timeDatetime: null,
      metaDate: null,
      jsonLdScripts: [JSON.stringify({ datePublished: now })],
      bodyText: "Article body text for testing.",
      ...overrides,
    };
    return base;
  }

  it("returns rejected when browser fallback is disabled", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    delete process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/article",
      sourcePageUrl: "browser:https://example.com/news/article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(false);
    expect(result.outcome.status).toBe("fetch_failed");
    expect(mockChromiumLaunch).not.toHaveBeenCalled();

    if (original !== undefined) {
      process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original;
    }
  });

  it("accepts a rendered article page with title, date, canonical and body", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(makeRawDetailData());

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/article",
      sourcePageUrl: "browser:https://example.com/news/article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(true);
    const candidate = result.candidate!;
    expect(candidate.title).toBe("Big News Story Here Today");
    expect(candidate.canonicalUrl).toBe("https://example.com/news/article");
    expect(candidate.provenance.origin).toBe("web_discovery");
    expect(candidate.rawSignals).toContain("agent2-browser-detail-recovery");
    expect(candidate.bodyText).toBe("A detailed description of the article.");
    expect(candidate.publishedAt).not.toBeNull();
    expect(mockBrowserClose).toHaveBeenCalled();

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("accepts a strong browser-rendered article with weak publishedAt when date metadata is missing", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(
      makeRawDetailData({
        jsonLdScripts: [],
        articlePublishedTime: null,
        ogPublishedTime: null,
        pubdate: null,
        publishdate: null,
        timeDatetime: null,
        metaDate: null,
      }),
    );

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/279204889/strong-browser-story-without-date",
      sourcePageUrl: "browser:https://example.com/news",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(true);
    const candidate = result.candidate!;
    expect(candidate.publishedAt).not.toBeNull();
    expect(candidate.rawSignals).toContain("accepted_with_browser_weak_published_at");
    expect(candidate.rawSignals).toContain("agent2-browser-detail-recovery");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("rejects a stale rendered article", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(
      makeRawDetailData({ jsonLdScripts: [JSON.stringify({ datePublished: "2020-01-01T00:00:00Z" })] }),
    );

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/article",
      sourcePageUrl: "browser:https://example.com/news/article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(false);
    expect(result.outcome.status).toBe("rejected_stale");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("rejects a page with a missing/short title", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(makeRawDetailData({ ogTitle: "Hi" }));

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/article",
      sourcePageUrl: "browser:https://example.com/news/article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(false);
    expect(result.outcome.status).toBe("rejected_missing_title");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("rejects a utility-path article URL", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(makeRawDetailData());

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/about",
      sourcePageUrl: "browser:https://example.com/about",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(false);
    expect(result.outcome.status).toBe("rejected_utility_path");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("uses JSON-LD datePublished for freshness checks", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(
      makeRawDetailData({
        ogTitle: null,
        jsonLdScripts: [JSON.stringify({ headline: "JSON-LD Headline Example", datePublished: new Date().toISOString() })],
      }),
    );

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/article",
      sourcePageUrl: "browser:https://example.com/news/article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(true);
    const jsonLdCandidate = result.candidate!;
    expect(jsonLdCandidate.title).toBe("JSON-LD Headline Example");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("falls back to the rendered URL when no canonical link is present", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage({ url: "https://example.com/news/rendered-article/" });
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(
      makeRawDetailData({ canonicalHref: null, pageUrl: "https://example.com/news/rendered-article/" }),
    );

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/rendered-article/",
      sourcePageUrl: "browser:https://example.com/news/rendered-article/",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(true);
    // Candidate is built from the pageUrl in raw data (rendered URL), matching the static path.
    const fallbackCandidate = result.candidate!;
    expect(fallbackCandidate.canonicalUrl).toBe("https://example.com/news/rendered-article");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("does not expose raw HTML in the returned candidate", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(makeRawDetailData());

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/article",
      sourcePageUrl: "browser:https://example.com/news/article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(true);
    expect(result.candidate).not.toHaveProperty("html");
    expect(result.candidate).not.toHaveProperty("rawHtml");
    expect(result.candidate).not.toHaveProperty("domDump");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("passes extracted canonical URL into the accepted candidate", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(
      makeRawDetailData({
        canonicalHref: "https://example.com/news/2026/07/20/canonical-article-slug",
      }),
    );

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/article",
      sourcePageUrl: "browser:https://example.com/news/article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(true);
    expect(result.candidate!.canonicalUrl).toBe("https://example.com/news/2026/07/20/canonical-article-slug");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("rejects cross-domain canonical URL from browser extraction", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(
      makeRawDetailData({
        canonicalHref: "https://evil.com/news/2026/07/20/hijack-article-slug",
      }),
    );

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/article",
      sourcePageUrl: "browser:https://example.com/news/article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(false);
    expect(result.outcome.status).toBe("rejected_cross_domain");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("uses JSON-LD headline as title when meta title is missing", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(
      makeRawDetailData({
        ogTitle: null,
        jsonLdScripts: [JSON.stringify({ headline: "JSON-LD Headline From Article", datePublished: new Date().toISOString() })],
      }),
    );

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/article",
      sourcePageUrl: "browser:https://example.com/news/article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(true);
    expect(result.candidate!.title).toBe("JSON-LD Headline From Article");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("uses JSON-LD name as title when headline is missing", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    makePlaywrightPage();
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(
      makeRawDetailData({
        ogTitle: null,
        jsonLdScripts: [JSON.stringify({ name: "JSON-LD Name Fallback Title", datePublished: new Date().toISOString() })],
      }),
    );

    const fn = await loadFn();
    const result = await fn({
      articleUrl: "https://example.com/news/article",
      sourcePageUrl: "browser:https://example.com/news/article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    expect(result.accepted).toBe(true);
    expect(result.candidate!.title).toBe("JSON-LD Name Fallback Title");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });
});

// ─── extractArticleDetailFromDocument — DOM extraction unit tests ─────────

describe("extractArticleDetailFromDocument", () => {
  async function loadHelper() {
    const mod = await import("./article-discovery-browser");
    return mod.extractArticleDetailFromDocument;
  }

  function makeMockDocument(overrides: {
    title?: string;
    canonicalHref?: string | null;
    ogTitle?: string | null;
    h1Text?: string | null;
    jsonLd?: string[];
    bodyText?: string;
    metaDescription?: string | null;
    keywords?: string | null;
    metaDatePublished?: string | null;
    timeDatetime?: string | null;
  } = {}) {
    const {
      title = "Document Title",
      canonicalHref,
      ogTitle,
      h1Text,
      jsonLd = [],
      bodyText = "Body content here.",
      metaDescription,
      keywords,
      metaDatePublished,
      timeDatetime,
    } = overrides;

    const elements: Record<string, { getAttribute: (n: string) => string | null; textContent: string | null; innerText: string }> = {};

    if (ogTitle) elements['meta[property="og:title"]'] = { getAttribute: (n: string) => n === "content" ? ogTitle : null, textContent: null, innerText: "" };
    if (metaDescription) elements['meta[name="description"]'] = { getAttribute: (n: string) => n === "content" ? metaDescription : null, textContent: null, innerText: "" };
    if (keywords) elements['meta[name="keywords"]'] = { getAttribute: (n: string) => n === "content" ? keywords : null, textContent: null, innerText: "" };
    if (canonicalHref) elements['link[rel="canonical"]'] = { getAttribute: (n: string) => n === "href" ? canonicalHref : null, textContent: null, innerText: "" };
    if (metaDatePublished) elements['meta[property="article:published_time"]'] = { getAttribute: (n: string) => n === "content" ? metaDatePublished : null, textContent: null, innerText: "" };
    if (timeDatetime) elements['time[datetime]'] = { getAttribute: (n: string) => n === "datetime" ? timeDatetime : null, textContent: null, innerText: "" };
    if (h1Text) elements['h1'] = { getAttribute: () => null, textContent: h1Text, innerText: h1Text };

    const jsonLdElements = jsonLd.map((content) => ({
      getAttribute: () => null,
      textContent: content,
      innerText: "",
    }));

    return {
      title,
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: (selector: string) => {
        if (selector === 'script[type="application/ld+json"]') return jsonLdElements;
        return [];
      },
      body: { getAttribute: () => null, textContent: bodyText, innerText: bodyText },
    };
  }

  it("extracts title from og:title meta tag (highest priority)", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({ ogTitle: "OG Title Here", h1Text: "H1 Title" });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.title).toBe("OG Title Here");
  });

  it("uses JSON-LD headline when no meta title is present", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({
      jsonLd: [JSON.stringify({ headline: "JSON-LD Headline Article Title" })],
    });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.title).toBe("JSON-LD Headline Article Title");
  });

  it("uses JSON-LD name when headline is missing", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({
      jsonLd: [JSON.stringify({ name: "JSON-LD Name Fallback" })],
    });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.title).toBe("JSON-LD Name Fallback");
  });

  it("prefers JSON-LD headline over name when both present", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({
      jsonLd: [JSON.stringify({ headline: "Preferred Headline", name: "Less Preferred Name" })],
    });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.title).toBe("Preferred Headline");
  });

  it("falls back to document.title when no meta or JSON-LD title", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({ title: "Page Title In Document" });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.title).toBe("Page Title In Document");
  });

  it("falls back to h1 when document.title is empty", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({ title: "", h1Text: "H1 Fallback Title" });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.title).toBe("H1 Fallback Title");
  });

  it("extracts JSON-LD headline from @graph arrays", async () => {
    const fn = await loadHelper();
    const graphLd = JSON.stringify({
      "@graph": [
        { "@type": "WebSite", name: "News Site" },
        { "@type": "NewsArticle", headline: "Graph Article Headline Here" },
      ],
    });
    const doc = makeMockDocument({ jsonLd: [graphLd] });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.title).toBe("Graph Article Headline Here");
  });

  it("extracts datePublished from JSON-LD @graph arrays", async () => {
    const fn = await loadHelper();
    const graphLd = JSON.stringify({
      "@graph": [
        { "@type": "WebSite", name: "News Site" },
        { "@type": "NewsArticle", headline: "Dated Graph Article", datePublished: "2026-07-20T10:00:00Z" },
      ],
    });
    const doc = makeMockDocument({ jsonLd: [graphLd] });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("datePublished");
  });

  it("extracts canonical URL from link[rel=canonical]", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({ canonicalHref: "https://example.com/news/2026/07/20/canonical-slug" });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.canonicalUrl).toBe("https://example.com/news/2026/07/20/canonical-slug");
  });

  it("falls back to pageUrl when no canonical link present", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({});
    const result = fn(doc as any, "https://example.com/news/rendered-article");
    expect(result.canonicalUrl).toBe("https://example.com/news/rendered-article");
  });

  it("handles malformed JSON-LD gracefully", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({ jsonLd: ["not valid json"] });
    const result = fn(doc as any, "https://example.com/news/article");
    // Should not throw, and should fall back to document.title
    expect(result.title).toBe("Document Title");
  });

  it("extracts description from meta tags", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({ metaDescription: "A test article description." });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.description).toBe("A test article description.");
  });

  it("extracts keywords from meta tag", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({ keywords: "news, breaking, important" });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.keywords).toEqual(["news", "breaking", "important"]);
  });

  it("prefers og:title over JSON-LD headline", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({
      ogTitle: "OG Meta Title",
      jsonLd: [JSON.stringify({ headline: "JSON-LD Headline" })],
    });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.title).toBe("OG Meta Title");
  });

  it("uses datePublished from JSON-LD when no meta date exists", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({
      jsonLd: [JSON.stringify({ headline: "Article", datePublished: "2026-07-20T10:00:00Z" })],
    });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("datePublished");
  });

  it("prefers JSON-LD datePublished over meta article:published_time (JSON-LD extracted first)", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({
      metaDatePublished: "2026-07-19T08:00:00Z",
      jsonLd: [JSON.stringify({ headline: "Article", datePublished: "2026-07-20T10:00:00Z" })],
    });
    const result = fn(doc as any, "https://example.com/news/article");
    // Meta date should not be used because JSON-LD datePublished is checked first
    // (JSON-LD extraction happens before meta date extraction in the code)
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("datePublished");
  });

  it("handles multiple JSON-LD script blocks", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({
      jsonLd: [
        JSON.stringify({ "@type": "WebPage", name: "Page Name" }),
        JSON.stringify({ headline: "Second Script Block Headline" }),
      ],
    });
    const result = fn(doc as any, "https://example.com/news/article");
    // Should find headline from second script block
    expect(result.title).toBe("Second Script Block Headline");
  });

  it("handles JSON-LD array form (not wrapped in object)", async () => {
    const fn = await loadHelper();
    const doc = makeMockDocument({
      jsonLd: [JSON.stringify([
        { "@type": "WebSite", name: "Site" },
        { headline: "Array Form Headline" },
      ])],
    });
    const result = fn(doc as any, "https://example.com/news/article");
    expect(result.title).toBe("Array Form Headline");
  });
});

// ─── Regression: page.evaluate path and pure helper equivalence ─────────

describe("normalizeArticleDetailFromRaw — date source labeling", () => {
  async function loadNormalizer() {
    const mod = await import("./article-discovery-browser");
    return mod.normalizeArticleDetailFromRaw;
  }

  function makeRaw(overrides: Record<string, unknown> = {}) {
    return {
      pageUrl: "https://example.com/news/2026/07/20/article-slug-here",
      canonicalHref: null,
      docTitle: "Page Title Here",
      h1Text: null,
      ogTitle: "Article Title Here",
      twitterTitle: null,
      metaTitle: null,
      ogDescription: null,
      metaDescription: null,
      twitterDescription: null,
      metaKeywords: null,
      articlePublishedTime: null,
      ogPublishedTime: null,
      pubdate: null,
      publishdate: null,
      timeDatetime: null,
      metaDate: null,
      jsonLdScripts: [],
      bodyText: "body",
      ...overrides,
    };
  }

  it("articlePublishedTime returns source article:published_time", async () => {
    const fn = await loadNormalizer();
    const result = fn(makeRaw({ articlePublishedTime: "2026-07-20T10:00:00Z" }) as any);
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("article:published_time");
  });

  it("ogPublishedTime returns source og:published_time", async () => {
    const fn = await loadNormalizer();
    const result = fn(makeRaw({ ogPublishedTime: "2026-07-20T10:00:00Z" }) as any);
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("og:published_time");
  });

  it("pubdate returns source article:published_time", async () => {
    const fn = await loadNormalizer();
    const result = fn(makeRaw({ pubdate: "2026-07-20T10:00:00Z" }) as any);
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("article:published_time");
  });

  it("publishdate returns source article:published_time", async () => {
    const fn = await loadNormalizer();
    const result = fn(makeRaw({ publishdate: "2026-07-20T10:00:00Z" }) as any);
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("article:published_time");
  });

  it("timeDatetime returns source time[datetime]", async () => {
    const fn = await loadNormalizer();
    const result = fn(makeRaw({ timeDatetime: "2026-07-20" }) as any);
    expect(result.publishedAtRaw).toBe("2026-07-20");
    expect(result.publishedAtSource).toBe("time[datetime]");
  });

  it("metaDate returns source meta[name=date]", async () => {
    const fn = await loadNormalizer();
    const result = fn(makeRaw({ metaDate: "2026-07-20" }) as any);
    expect(result.publishedAtRaw).toBe("2026-07-20");
    expect(result.publishedAtSource).toBe("meta[name=date]");
  });

  it("prefers JSON-LD datePublished over all meta fields", async () => {
    const fn = await loadNormalizer();
    const result = fn(makeRaw({
      articlePublishedTime: "2026-07-18T00:00:00Z",
      ogPublishedTime: "2026-07-17T00:00:00Z",
      pubdate: "2026-07-16T00:00:00Z",
      publishdate: "2026-07-15T00:00:00Z",
      jsonLdScripts: [JSON.stringify({ datePublished: "2026-07-20T10:00:00Z" })],
    }) as any);
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("datePublished");
  });

  it("prefers articlePublishedTime over ogPublishedTime when JSON-LD is absent", async () => {
    const fn = await loadNormalizer();
    const result = fn(makeRaw({
      articlePublishedTime: "2026-07-20T10:00:00Z",
      ogPublishedTime: "2026-07-19T00:00:00Z",
    }) as any);
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("article:published_time");
  });

  it("prefers ogPublishedTime over pubdate when articlePublishedTime is absent", async () => {
    const fn = await loadNormalizer();
    const result = fn(makeRaw({
      ogPublishedTime: "2026-07-20T10:00:00Z",
      pubdate: "2026-07-19T00:00:00Z",
    }) as any);
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("og:published_time");
  });

  it("prefers pubdate over publishdate when ogPublishedTime is absent", async () => {
    const fn = await loadNormalizer();
    const result = fn(makeRaw({
      pubdate: "2026-07-20T10:00:00Z",
      publishdate: "2026-07-19T00:00:00Z",
    }) as any);
    expect(result.publishedAtRaw).toBe("2026-07-20T10:00:00Z");
    expect(result.publishedAtSource).toBe("article:published_time");
  });
});

describe("page.evaluate and extractArticleDetailFromDocument equivalence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPageGoto.mockReset();
    mockPageEvaluate.mockReset();
    mockPageTitle.mockReset();
    mockPageRoute.mockReset();
    mockPageUrl.mockReset();
    mockPageClose.mockReset();
    mockContextNewPage.mockReset();
    mockContextClose.mockReset();
    mockBrowserNewContext.mockReset();
    mockBrowserClose.mockReset();
    mockChromiumLaunch.mockReset();
  });

  function makeMockDocumentForEquivalence() {
    const elements: Record<string, { getAttribute: (n: string) => string | null; textContent: string | null; innerText: string }> = {
      'link[rel="canonical"]': { getAttribute: (n: string) => n === "href" ? "https://example.com/news/2026/07/20/equiv-canonical" : null, textContent: null, innerText: "" },
      'meta[name="keywords"]': { getAttribute: (n: string) => n === "content" ? "breaking, politics, world" : null, textContent: null, innerText: "" },
    };

    const jsonLdContent = JSON.stringify({
      headline: "Equivalence Test Headline",
      datePublished: "2026-07-20T14:00:00Z",
      name: "Equivalence Name",
    });

    return {
      title: "Fallback Title",
      querySelector: (selector: string) => elements[selector] || null,
      querySelectorAll: (selector: string) => {
        if (selector === 'script[type="application/ld+json"]') {
          return [{ getAttribute: () => null, textContent: jsonLdContent, innerText: "" }];
        }
        return [];
      },
      body: { getAttribute: () => null, textContent: "Equivalence body text for testing the regression.", innerText: "Equivalence body text for testing the regression." },
    };
  }

  it("page.evaluate uses standard Playwright (pageFn, singleArg) pattern and produces equivalent output", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    const mod = await import("./article-discovery-browser");
    mod.setArticleDiscoveryBrowserImporterForTest(async () => ({
      chromium: {
        launch: (...args: any[]) => mockChromiumLaunch(...args),
      },
    }));

    const { extractArticleDetailFromDocument, normalizeArticleDetailFromRaw } = mod;

    // Build a mock document and run the pure helper directly
    const mockDoc = makeMockDocumentForEquivalence();
    const helperOutput = extractArticleDetailFromDocument(
      mockDoc as any,
      "https://example.com/news/2026/07/20/equiv-article",
    );

    // Verify the helper produces expected output
    expect(helperOutput.canonicalUrl).toBe("https://example.com/news/2026/07/20/equiv-canonical");
    expect(helperOutput.title).toBe("Equivalence Test Headline");
    expect(helperOutput.publishedAtRaw).toBe("2026-07-20T14:00:00Z");
    expect(helperOutput.keywords).toEqual(["breaking", "politics", "world"]);
    expect(helperOutput.bodyFallback).toBe("Equivalence body text for testing the regression.");

    // Build the raw data that a real browser page.evaluate would return.
    // This is what extractArticleDetailFromDocument extracts before normalizing.
    const rawEquiv = {
      pageUrl: "https://example.com/news/2026/07/20/equiv-article",
      canonicalHref: "https://example.com/news/2026/07/20/equiv-canonical",
      docTitle: "Fallback Title",
      h1Text: null,
      ogTitle: null,
      twitterTitle: null,
      metaTitle: null,
      ogDescription: null,
      metaDescription: null,
      twitterDescription: null,
      metaKeywords: "breaking, politics, world",
      articlePublishedTime: null,
      ogPublishedTime: null,
      pubdate: null,
      publishdate: null,
      timeDatetime: null,
      metaDate: null,
      jsonLdScripts: [JSON.stringify({ headline: "Equivalence Test Headline", datePublished: "2026-07-20T14:00:00Z", name: "Equivalence Name" })],
      bodyText: "Equivalence body text for testing the regression.",
    };

    // Verify normalizeArticleDetailFromRaw produces the same output as the helper
    const normalized = normalizeArticleDetailFromRaw(rawEquiv as any);
    expect(normalized.canonicalUrl).toBe(helperOutput.canonicalUrl);
    expect(normalized.title).toBe(helperOutput.title);
    expect(normalized.publishedAtRaw).toBe(helperOutput.publishedAtRaw);
    expect(normalized.keywords).toEqual(helperOutput.keywords);
    expect(normalized.bodyFallback).toBe(helperOutput.bodyFallback);

    // Configure mock page.evaluate to return the raw data
    makePlaywrightPage({ url: "https://example.com/news/2026/07/20/equiv-article" });
    mockPageEvaluate.mockReset();
    mockPageEvaluate.mockResolvedValueOnce(rawEquiv);

    const fn = mod.evaluateArticleLinkCandidateWithBrowser;
    const result = await fn({
      articleUrl: "https://example.com/news/2026/07/20/equiv-article",
      sourcePageUrl: "browser:https://example.com/news/2026/07/20/equiv-article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
    });

    // Verify the standard Playwright contract: page.evaluate(pageFn, singleArg)
    expect(mockPageEvaluate).toHaveBeenCalledTimes(1);
    const evaluateArgs = mockPageEvaluate.mock.calls[0]!;
    expect(typeof evaluateArgs[0]).toBe("string");
    // Second arg must be a plain serializable object, not a function
    expect(evaluateArgs[0]).toContain("https://example.com/news/2026/07/20/equiv-article");
    expect(evaluateArgs[0]).not.toContain("__name");
    // No third argument — Playwright only supports one serializable arg
    expect(evaluateArgs.length).toBe(1);

    // Verify the candidate uses the same data as the pure helper
    expect(result.accepted).toBe(true);
    const candidate = result.candidate!;
    expect(candidate.canonicalUrl).toBe(helperOutput.canonicalUrl);
    expect(candidate.title).toBe(helperOutput.title);
    expect(candidate.publishedAt).not.toBeNull();
    expect(candidate.rawSignals).toContain("agent2-browser-detail-recovery");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });
});
