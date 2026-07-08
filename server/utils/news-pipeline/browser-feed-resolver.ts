/**
 * Browser-based feed resolver for hard-case discovery queue items.
 *
 * Provides DOM-level feed candidate extraction that goes beyond regex-based
 * HTML parsing. Uses jsdom for static HTML DOM inspection (production-safe),
 * and optionally Playwright for true JS-rendered DOM (dev/local only).
 *
 * ## Resolution paths
 *
 * | Path        | JS execution | Environment   | Limitations                                          |
 * |-------------|-------------|---------------|------------------------------------------------------|
 * | jsdom       | No          | Production    | Parses static HTML only; cannot see SPA-injected DOM |
 * | Playwright  | Yes         | Dev/local     | Full JS rendering; requires browser binaries         |
 *
 * ## Production limitation
 *
 * The jsdom path inspects the raw HTML response — it does NOT execute JavaScript.
 * Sites that inject feed links purely via client-side JS (SPAs, React/Vue apps)
 * will NOT have those links discovered by the jsdom path. Only the Playwright
 * path can discover dynamically injected feed links, but it requires browser
 * binaries not available in serverless environments (e.g. Vercel).
 *
 * ## Architecture
 *
 * - Primary path: fetch HTML → jsdom DOM parsing → extract feed candidates
 * - Optional path: Playwright headless browser → render JS → extract from live DOM
 * - Fallback: existing fetch-based discovery (unchanged, via hard-case-consumer)
 *
 * Production-safe: jsdom requires no native binaries and runs on Vercel.
 * Playwright is opt-in and only attempted when PLAYWRIGHT_ENABLED=true.
 */
import { safeFetch } from "../ssrf-guard";

// ─── Constants ──────────────────────────────────────────────────────────────

const FEED_CONTENT_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/json",
] as const;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const COMMON_FEED_PATHS = [
  "/rss/",
  "/rss",
  "/feed/",
  "/feed",
  "/rss.xml",
  "/feed.xml",
  "/atom.xml",
  "/index.xml",
  "/index.rss",
] as const;

const BLOCKED_FEED_PATH_PATTERNS = [
  /\/feedback(?:\/|$)/i,
  /\/contact(?:\/|$)/i,
  /\/about(?:\/|$)/i,
  /\/privacy(?:\/|$)/i,
  /\/terms(?:\/|$)/i,
  /\/sitemap(?:\/|$)/i,
];

// ─── Types ──────────────────────────────────────────────────────────────────

export type BrowserFeedCandidate = {
  feedUrl: string;
  source: "dom-link" | "inline-script" | "json-ld" | "anchor-tag" | "embedded-markup" | "common-path-probe";
};

export type BrowserResolveResult = {
  candidates: BrowserFeedCandidate[];
  method: "jsdom" | "playwright" | "none";
  renderedDomAvailable: boolean;
  error?: string;
};

// ─── URL Helpers ────────────────────────────────────────────────────────────

function resolveRelativeUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function isBlockedFeedPath(urlString: string): boolean {
  try {
    const pathname = new URL(urlString).pathname;
    return BLOCKED_FEED_PATH_PATTERNS.some((p) => p.test(pathname));
  } catch {
    return true;
  }
}

function isLikelyFeedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();

    if (isBlockedFeedPath(url)) return false;

    const feedPathPatterns = [
      /\/rss(?:\/|$)/,
      /\/rss\.[a-z0-9]+$/,
      /\/feed(?:\/|$)/,
      /\/feeds(?:\/|$)/,
      /\/atom(?:\/|$)/,
      /\/atom\.[a-z0-9]+$/,
      /\/index\.rss$/,
      /\/index\.xml$/,
      /\.xml$/,
      /\.rss$/,
    ];

    const feedQueryPatterns = [
      /[?&]feed=(rss|atom|json)/,
      /[?&]format=(rss|atom|xml|json)/,
      /[?&]output=(rss|atom|xml|json)/,
      /[?&]service=rss(?:&|$)/,
    ];

    return (
      feedPathPatterns.some((p) => p.test(pathname)) ||
      feedQueryPatterns.some((p) => p.test(search)) ||
      pathname.includes("jsonfeed") ||
      pathname.includes("feed+json")
    );
  } catch {
    return false;
  }
}

function matchesFeedContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return FEED_CONTENT_TYPES.some((ct) => lower.includes(ct));
}

// ─── DOM Extraction (jsdom) ─────────────────────────────────────────────────

function extractFeedCandidatesFromDom(
  window: any,
  pageUrl: string,
): BrowserFeedCandidate[] {
  const candidates: BrowserFeedCandidate[] = [];
  const seen = new Set<string>();

  const addCandidate = (url: string, source: BrowserFeedCandidate["source"]) => {
    const resolved = resolveRelativeUrl(url, pageUrl);
    if (!resolved || seen.has(resolved) || isBlockedFeedPath(resolved)) return;
    seen.add(resolved);
    candidates.push({ feedUrl: resolved, source });
  };

  try {
    const document = window.document;

    // 1. link[rel="alternate"] with feed content types
    const linkElements = document.querySelectorAll('link[rel="alternate"]');
    for (const link of linkElements) {
      const type = link.getAttribute("type")?.toLowerCase() || "";
      const href = link.getAttribute("href");
      if (href && FEED_CONTENT_TYPES.some((ct) => type.includes(ct))) {
        addCandidate(href, "dom-link");
      }
    }

    // Also check link elements without rel="alternate" but with feed types
    const allLinkElements = document.querySelectorAll("link[href]");
    for (const link of allLinkElements) {
      const type = link.getAttribute("type")?.toLowerCase() || "";
      const href = link.getAttribute("href");
      const rel = link.getAttribute("rel")?.toLowerCase() || "";
      if (href && !rel.includes("alternate") && FEED_CONTENT_TYPES.some((ct) => type.includes(ct))) {
        addCandidate(href, "dom-link");
      }
    }

    // 2. Inline scripts containing feed-like URLs
    const scriptElements = document.querySelectorAll("script");
    const feedUrlPattern =
      /["']((?:https?:\/\/[^"'\s]+|\/[^"'\s]*)(?:\/rss|\/feed|\/atom|\.rss|\.xml|\.json(?:feed)?)(?:[^"'\s]*))["']/gi;

    for (const script of scriptElements) {
      const content = script.textContent || "";
      // Skip src-only script tags
      if (!content.trim()) continue;

      let match: RegExpExecArray | null;
      // Reset lastIndex for global regex
      feedUrlPattern.lastIndex = 0;
      while ((match = feedUrlPattern.exec(content)) !== null) {
        const candidate = match[1];
        if (candidate && isLikelyFeedUrl(candidate)) {
          addCandidate(candidate, "inline-script");
        }
      }
    }

    // 3. JSON-LD / structured data blocks
    const jsonLdElements = document.querySelectorAll(
      'script[type="application/ld+json"], script[type="application/json"]',
    );
    for (const el of jsonLdElements) {
      const content = el.textContent || "";
      extractFeedUrlsFromJson(content, pageUrl).forEach((url) =>
        addCandidate(url, "json-ld"),
      );
    }

    // 4. Anchor tags pointing to RSS/Atom pages
    const anchors = document.querySelectorAll("a[href]");
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href");
      const text = (anchor.textContent || "").toLowerCase();
      const title = (anchor.getAttribute("title") || "").toLowerCase();
      const ariaLabel = (anchor.getAttribute("aria-label") || "").toLowerCase();

      const isFeedLink =
        /rss|feed|atom|syndicat/i.test(text) ||
        /rss|feed|atom/i.test(title) ||
        /rss|feed|atom/i.test(ariaLabel) ||
        (href && isLikelyFeedUrl(href));

      if (href && isFeedLink && !/feedback|contact/i.test(href)) {
        addCandidate(href, "anchor-tag");
      }
    }

    // 5. Embedded RSS/Atom markup in page body
    const bodyHtml = document.body?.innerHTML || "";
    extractFeedUrlsFromRawMarkup(bodyHtml, pageUrl).forEach((url) =>
      addCandidate(url, "embedded-markup"),
    );
  } catch {
    // DOM parsing failed; return whatever candidates were collected
  }

  return candidates;
}

function extractFeedUrlsFromJson(
  jsonText: string,
  pageUrl: string,
): string[] {
  const results: string[] = [];
  const feedKeywords = /feed|rss|atom|syndicat|jsonfeed/i;

  try {
    const parsed = JSON.parse(jsonText);
    walkJsonObject(parsed, (key, value) => {
      if (
        typeof key === "string" &&
        feedKeywords.test(key) &&
        typeof value === "string" &&
        value.startsWith("http")
      ) {
        results.push(value);
      }
      if (
        typeof value === "string" &&
        feedKeywords.test(value) &&
        (value.includes("://") || value.startsWith("/"))
      ) {
        const resolved = resolveRelativeUrl(value, pageUrl);
        if (resolved) results.push(resolved);
      }
    });
  } catch {
    // Malformed JSON; skip
  }

  return results;
}

function walkJsonObject(
  obj: unknown,
  callback: (key: string, value: unknown) => void,
): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) walkJsonObject(item, callback);
    return;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    callback(key, value);
    if (value && typeof value === "object") {
      walkJsonObject(value, callback);
    }
  }
}

function extractFeedUrlsFromRawMarkup(
  html: string,
  pageUrl: string,
): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  // Look for inline RSS/Atom XML blocks
  const feedTagPattern =
    /<(?:rss|feed|rdf:rdf)\b[^>]*>[\s\S]*?<\/(?:rss|feed|rdf:rdf)>/gi;
  const matches = html.match(feedTagPattern) || [];

  for (const block of matches) {
    const linkMatches =
      block.match(/<(?:link|atom:link)\b[^>]+href=["']([^"']+)["']/gi) || [];
    for (const tag of linkMatches) {
      const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
      if (href) {
        const resolved = resolveRelativeUrl(href, pageUrl);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          results.push(resolved);
        }
      }
    }
  }

  // Also look for RSS-like URLs in data attributes
  const dataAttrPattern =
    /data-(?:feed|rss|atom|url|href|src)=["']([^"']*(?:rss|feed|atom)[^"']*)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = dataAttrPattern.exec(html)) !== null) {
    const url = match[1];
    if (url && isLikelyFeedUrl(url)) {
      const resolved = resolveRelativeUrl(url, pageUrl);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        results.push(resolved);
      }
    }
  }

  return results;
}

// ─── jsdom Resolver ─────────────────────────────────────────────────────────

export async function resolveWithJsdom(input: {
  pageUrl: string;
  userAgent?: string;
}): Promise<BrowserFeedCandidate[]> {
  const userAgent = input.userAgent || BROWSER_USER_AGENT;

  let html: string;
  try {
    const response = await safeFetch(input.pageUrl, {
      headers: {
        "User-Agent": userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) return [];
    html = await response.text();
  } catch {
    return [];
  }

  try {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM(html, {
      url: input.pageUrl,
      contentType: "text/html",
      pretendToBeVisual: false,
    });

    const candidates = extractFeedCandidatesFromDom(dom.window, input.pageUrl);

    // Add candidates from common feed path probing
    const pathCandidates = await probeCommonFeedPaths(input.pageUrl, userAgent);

    dom.window.close();

    return [...candidates, ...pathCandidates];
  } catch {
    return [];
  }
}

async function probeCommonFeedPaths(
  pageUrl: string,
  userAgent: string,
): Promise<BrowserFeedCandidate[]> {
  const candidates: BrowserFeedCandidate[] = [];

  let origin: string;
  let basePath: string;
  try {
    const parsed = new URL(pageUrl);
    origin = parsed.origin;
    basePath = parsed.pathname.replace(/\/+$/, "") || "";
  } catch {
    return candidates;
  }

  // Only probe paths that are relevant to the target page
  const pathsToProbe = COMMON_FEED_PATHS.filter((path) => {
    // For root pages, probe root-level paths
    if (!basePath || basePath === "/") return !path.includes("/news") && !path.includes("/all");
    // For section pages, probe both root and section-scoped paths
    return true;
  });

  const probePromises = pathsToProbe.map(async (feedPath) => {
    const probeUrl = basePath ? `${origin}${basePath}${feedPath}` : `${origin}${feedPath}`;
    try {
      const response = await safeFetch(probeUrl, {
        method: "HEAD",
        headers: {
          "User-Agent": userAgent,
          Accept: "application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml",
        },
      });

      if (!response.ok) return null;

      const contentType = response.headers.get("content-type");
      if (matchesFeedContentType(contentType)) {
        const resolvedUrl = response.url || probeUrl;
        return { feedUrl: resolvedUrl, source: "common-path-probe" as const };
      }
      return null;
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(probePromises);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      candidates.push(result.value);
    }
  }

  return candidates;
}

// ─── Playwright Resolver (dev/local only) ───────────────────────────────────

/**
 * Attempt to resolve feeds using Playwright for full JS rendering.
 * Returns null if Playwright is not available or execution fails.
 *
 * This path is designed for dev/local environments where Playwright
 * can be installed with browser binaries. In production (e.g., Vercel),
 * the jsdom path is used instead.
 */
export async function resolveWithPlaywright(input: {
  pageUrl: string;
  timeoutMs?: number;
}): Promise<BrowserFeedCandidate[] | null> {
  if (process.env.PLAYWRIGHT_ENABLED !== "true") {
    return null;
  }

  try {
    const playwright = await import("playwright" as string);
    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        userAgent: BROWSER_USER_AGENT,
      });
      const page = await context.newPage();

      const collectedFeedUrls = new Map<string, BrowserFeedCandidate["source"]>();

      // Listen for responses with feed content types
      page.on("response", (response: any) => {
        const headers = response.headers() as Record<string, string> | undefined;
        const contentType = headers?.["content-type"] || "";
        const url = response.url();
        if (matchesFeedContentType(contentType) && isLikelyFeedUrl(url)) {
          collectedFeedUrls.set(url, "common-path-probe");
        }
      });

      await page.goto(input.pageUrl, {
        waitUntil: "networkidle",
        timeout: input.timeoutMs || 30000,
      });

      // Extract from rendered DOM
      const domCandidates = await page.evaluate((pageUrl: string) => {
        const candidates: Array<{ feedUrl: string; source: string }> = [];
        const seen = new Set<string>();

        const addCandidate = (url: string, source: string) => {
          try {
            const resolved = new URL(url, pageUrl).toString();
            if (!seen.has(resolved)) {
              seen.add(resolved);
              candidates.push({ feedUrl: resolved, source });
            }
          } catch { /* ignore */ }
        };

        // link[rel="alternate"] with feed types
        document.querySelectorAll('link[rel="alternate"]').forEach((link) => {
          const type = (link as HTMLLinkElement).type?.toLowerCase() || "";
          const href = (link as HTMLLinkElement).href;
          if (href && /rss|atom|feed\+json|json/i.test(type)) {
            addCandidate(href, "dom-link");
          }
        });

        // Scripts containing feed URLs
        const feedUrlRe = /["']((?:https?:\/\/[^"'\s]+|\/[^"'\s]*)(?:\/rss|\/feed|\/atom|\.rss|\.xml|\.json(?:feed)?)[^"'\s]*)["']/gi;
        document.querySelectorAll("script").forEach((script) => {
          const content = script.textContent || "";
          if (!content.trim()) return;
          let m: RegExpExecArray | null;
          feedUrlRe.lastIndex = 0;
          while ((m = feedUrlRe.exec(content)) !== null) {
            if (m[1]) addCandidate(m[1], "inline-script");
          }
        });

        // Anchor tags with feed-like text
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = (a as HTMLAnchorElement).href;
          const text = (a.textContent || "").toLowerCase();
          const title = ((a as HTMLAnchorElement).title || "").toLowerCase();
          if (/rss|feed|atom/.test(text) || /rss|feed|atom/.test(title)) {
            if (!/feedback|contact/i.test(href)) {
              addCandidate(href, "anchor-tag");
            }
          }
        });

        return candidates;
      }, input.pageUrl);

      for (const c of domCandidates) {
        collectedFeedUrls.set(c.feedUrl, c.source as BrowserFeedCandidate["source"]);
      }

      return [...collectedFeedUrls.entries()].map(([feedUrl, source]) => ({
        feedUrl,
        source,
      }));
    } finally {
      await browser.close();
    }
  } catch {
    // Playwright not available or execution failed
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Main entry point for browser-based feed resolution.
 *
 * Tries jsdom-based DOM parsing first (production-safe).
 * Optionally attempts Playwright if PLAYWRIGHT_ENABLED=true (dev/local).
 *
 * Returns deduplicated feed candidates with source metadata.
 */
export async function resolveFeedsWithBrowser(input: {
  pageUrl: string;
  userAgent?: string;
  enablePlaywright?: boolean;
}): Promise<BrowserResolveResult> {
  const allCandidates = new Map<string, BrowserFeedCandidate["source"]>();
  let method: BrowserResolveResult["method"] = "none";
  let renderedDomAvailable = false;
  let lastError: string | undefined;

  // Step 1: jsdom-based resolution (always attempted)
  try {
    const jsdomCandidates = await resolveWithJsdom({
      pageUrl: input.pageUrl,
      userAgent: input.userAgent,
    });

    if (jsdomCandidates.length > 0) {
      method = "jsdom";
      renderedDomAvailable = true;
      for (const candidate of jsdomCandidates) {
        if (!allCandidates.has(candidate.feedUrl)) {
          allCandidates.set(candidate.feedUrl, candidate.source);
        }
      }
    }
  } catch (error: any) {
    lastError = `jsdom resolver failed: ${error?.message || String(error)}`;
  }

  // Step 2: Playwright-based resolution (optional, dev/local only)
  if (
    input.enablePlaywright !== false &&
    process.env.PLAYWRIGHT_ENABLED === "true"
  ) {
    try {
      const playwrightCandidates = await resolveWithPlaywright({
        pageUrl: input.pageUrl,
      });

      if (playwrightCandidates && playwrightCandidates.length > 0) {
        method = "playwright";
        renderedDomAvailable = true;
        for (const candidate of playwrightCandidates) {
          if (!allCandidates.has(candidate.feedUrl)) {
            allCandidates.set(candidate.feedUrl, candidate.source);
          }
        }
      }
    } catch (error: any) {
      lastError = `Playwright resolver failed: ${error?.message || String(error)}`;
    }
  }

  const candidates = [...allCandidates.entries()].map(
    ([feedUrl, source]) => ({ feedUrl, source }),
  );

  return {
    candidates,
    method,
    renderedDomAvailable,
    error: candidates.length === 0 ? lastError : undefined,
  };
}

/**
 * Check if browser-based resolution should be attempted for a given URL.
 * Returns false if the URL is clearly a direct feed (no browser needed)
 * or if the URL is invalid.
 */
export function shouldAttemptBrowserResolution(pageUrl: string): boolean {
  try {
    const parsed = new URL(pageUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    // Don't browser-resolve direct feed URLs
    if (isLikelyFeedUrl(pageUrl)) return false;
    return true;
  } catch {
    return false;
  }
}
