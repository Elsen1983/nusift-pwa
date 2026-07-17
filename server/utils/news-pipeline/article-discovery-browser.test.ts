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
    expect(result.diagnostics.browserRuntimeAvailable).toBe(false);
    expect(result.diagnostics.blockedReason).toContain("NUXT_ENABLE_AGENT2_BROWSER_FALLBACK");
    expect(mockChromiumLaunch).not.toHaveBeenCalled();

    if (original !== undefined) {
      process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original;
    }
  });

  it("returns runtime unavailable when Playwright cannot be imported", async () => {
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

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
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
});
