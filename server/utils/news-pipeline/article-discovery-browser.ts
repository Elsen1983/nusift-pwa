/**
 * Agent 2 browser-based article link resolver.
 *
 * Renders target pages with Playwright and extracts article-like links from
 * the rendered DOM. Used as a fallback when static (fetch-based) discovery
 * is insufficient for JS-heavy or dynamically rendered targets.
 *
 * ## Safety
 * - Only activated when NUXT_ENABLE_AGENT2_BROWSER_FALLBACK=true
 * - Each page load is bounded by a short timeout (max 15 seconds)
 * - Only the rendered target page is inspected (no deep crawling)
 * - Same-domain filtering and utility path exclusion apply
 * - Links are scored and validated before being returned
 * - Max 25 links per target
 *
 * ## Lazy import pattern
 * Browser dependencies are imported lazily, but production serverless
 * dependencies use explicit dynamic imports so Nitro/Vercel can include them
 * in the function bundle. If the import or launch fails, the resolver returns
 * `ok: false, reason: "browser_runtime_unavailable"`.
 */

import {
  scoreCandidateUrl,
  isBlockedDiscoveryPath,
} from "./article-discovery-helpers";

// ─── Constants ──────────────────────────────────────────────────────────────

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LINKS_PER_TARGET = 25;

// ─── Types ──────────────────────────────────────────────────────────────────

export type BrowserArticleLink = {
  url: string;
  text: string | null;
  sourcePageUrl: string;
  sourceKind: "browser";
  rawSignals: Record<string, unknown>;
};

export type BrowserArticleLinkResult = {
  ok: boolean;
  reason?: string;
  renderedUrl?: string;
  links: BrowserArticleLink[];
  diagnostics: {
    pageTitle: string | null;
    linkCount: number;
    articleLikeLinkCount: number;
    blockedReason?: string;
    browserRuntimeAvailable: boolean;
    elapsedMs: number;
  };
};

// ─── Feature Gate ───────────────────────────────────────────────────────────

/**
 * Check if the Agent 2 browser fallback is enabled via environment flag.
 */
export function isBrowserFallbackEnabled(): boolean {
  return (process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK || "").trim().toLowerCase() === "true";
}

// ─── Link Extraction from Rendered DOM ──────────────────────────────────────

/**
 * Raw link data extracted from the browser DOM via page.evaluate().
 * These are the same-domain, deduplicated anchor URLs and their text.
 * Scoring and filtering happen in Node.js after extraction.
 */
type RawBrowserLink = {
  url: string;
  text: string | null;
};

/**
 * Extract raw anchor URLs from the rendered DOM inside the browser context.
 * Runs via page.evaluate() so it has access to the live DOM.
 * Returns only same-domain, deduplicated, non-utility URLs.
 */
async function extractRawLinksFromBrowser(
  page: any,
  pageUrl: string,
  categoryPathUrl: string | null,
): Promise<RawBrowserLink[]> {
  return page.evaluate(
    (args: { pageUrl: string; categoryPathUrl: string | null; maxLinks: number }) => {
      const { pageUrl, categoryPathUrl, maxLinks } = args;
      const results: Array<{ url: string; text: string | null }> = [];
      const seen = new Set<string>();

      try {
        const pageHostname = new URL(pageUrl).hostname.replace(/^www\./, "");
        const anchors = Array.from(document.querySelectorAll("a[href]"));

        for (const anchor of anchors) {
          const href = (anchor as HTMLAnchorElement).getAttribute("href");
          if (
            !href ||
            href.startsWith("#") ||
            href.startsWith("javascript:") ||
            href.startsWith("mailto:")
          ) {
            continue;
          }

          let resolved: string;
          try {
            resolved = new URL(href, pageUrl).toString();
          } catch {
            continue;
          }

          const normalized = resolved.toLowerCase();
          if (seen.has(normalized)) continue;
          seen.add(normalized);

          let linkHostname: string;
          try {
            linkHostname = new URL(resolved).hostname.replace(/^www\./, "");
          } catch {
            continue;
          }
          if (linkHostname !== pageHostname) continue;

          // Category scope filter (in-browser)
          if (categoryPathUrl) {
            try {
              const articlePath = new URL(resolved).pathname.replace(/\/+$/, "") || "/";
              const categoryPath = new URL(categoryPathUrl).pathname.replace(/\/+$/, "") || "/";
              if (
                categoryPath !== "/" &&
                !(articlePath === categoryPath || articlePath.startsWith(`${categoryPath}/`))
              ) {
                continue;
              }
            } catch {
              continue;
            }
          }

          results.push({
            url: resolved,
            text: (anchor as HTMLAnchorElement).textContent?.trim().slice(0, 200) || null,
          });

          if (results.length >= maxLinks) break;
        }
      } catch {
        // DOM extraction failed
      }

      return results;
    },
    { pageUrl, categoryPathUrl, maxLinks: MAX_LINKS_PER_TARGET * 2 },
  );
}

/**
 * Score and filter raw browser links in Node.js using the same scoring
 * logic as static Agent 2. Returns fully typed BrowserArticleLink[].
 */
function scoreAndFilterBrowserLinks(
  rawLinks: RawBrowserLink[],
  pageUrl: string,
  categoryPathUrl: string | null,
): BrowserArticleLink[] {
  const results: BrowserArticleLink[] = [];

  for (const raw of rawLinks) {
    // Utility path filter (Node.js side)
    if (isBlockedDiscoveryPath(raw.url)) continue;

    // Article-like path check via scoring
    const score = scoreCandidateUrl(raw.url, pageUrl, {
      title: raw.text,
      dateText: null,
      categoryPathUrl,
    });

    if (score.rejected) continue;

    results.push({
      url: raw.url,
      text: raw.text,
      sourcePageUrl: `browser:${pageUrl}`,
      sourceKind: "browser",
      rawSignals: {
        anchorText: raw.text?.slice(0, 100) || null,
        score: score.score,
        scoreReasons: score.reasons,
      },
    });

    if (results.length >= MAX_LINKS_PER_TARGET) break;
  }

  return results;
}

// ─── Playwright Loader (lazy) ───────────────────────────────────────────────

type OptionalDependencyImporter = (specifier: string) => Promise<any>;

const hiddenDynamicImporter = new Function(
  "specifier",
  "return import(specifier)",
) as OptionalDependencyImporter;

async function defaultOptionalDependencyImporter(specifier: string): Promise<any> {
  if (specifier === "playwright-core") {
    return await import("playwright-core");
  }
  if (specifier === "@sparticuz/chromium") {
    return await import("@sparticuz/chromium");
  }

  return await hiddenDynamicImporter(specifier);
}

let importOptionalDependency = defaultOptionalDependencyImporter;

export function setArticleDiscoveryBrowserImporterForTest(
  importer: OptionalDependencyImporter | null,
) {
  importOptionalDependency = importer ?? defaultOptionalDependencyImporter;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function launchBrowser(): Promise<{ browser: any | null; blockedReason?: string }> {
  const errors: string[] = [];

  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    try {
      const [playwrightCoreModule, chromiumModule] = await Promise.all([
        importOptionalDependency("playwright-core"),
        importOptionalDependency("@sparticuz/chromium"),
      ]);
      const playwrightCore = playwrightCoreModule.default ?? playwrightCoreModule;
      const serverlessChromium = chromiumModule.default ?? chromiumModule;
      const executablePath = await serverlessChromium.executablePath();

      return {
        browser: await playwrightCore.chromium.launch({
          args: serverlessChromium.args,
          defaultViewport: serverlessChromium.defaultViewport,
          executablePath,
          headless: serverlessChromium.headless ?? true,
        }),
      };
    } catch (error) {
      errors.push(`serverless chromium: ${getErrorMessage(error)}`);
      // Fall through to the regular Playwright runtime. This keeps local/dev installs working
      // and preserves the existing runtime-unavailable result when no browser can launch.
    }
  }

  try {
    const playwright = await importOptionalDependency("playwright");
    return {
      browser: await playwright.chromium.launch({ headless: true }),
    };
  } catch (error) {
    errors.push(`playwright: ${getErrorMessage(error)}`);
    return {
      browser: null,
      blockedReason: errors.length > 0
        ? `Browser launch failed (${errors.join("; ")})`
        : "Playwright is not installed or could not be launched",
    };
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Discover article links from a rendered page using Playwright.
 *
 * @param input.targetUrl - The page to render
 * @param input.sourceId - Source ID for provenance
 * @param input.categoryId - Category ID (if category target)
 * @param input.targetType - "source" or "category"
 * @param input.timeoutMs - Page load timeout (default 15s, max 15s)
 * @param input.categoryPathUrl - Category path URL for scope filtering
 */
export async function discoverArticleLinksWithBrowser(input: {
  targetUrl: string;
  sourceId: string;
  categoryId?: string | null;
  targetType: "source" | "category";
  timeoutMs?: number;
  categoryPathUrl?: string | null;
}): Promise<BrowserArticleLinkResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(input.timeoutMs || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const categoryPathUrl = input.categoryPathUrl || null;

  // Feature gate
  if (!isBrowserFallbackEnabled()) {
    return {
      ok: false,
      reason: "browser_fallback_disabled",
      links: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: "NUXT_ENABLE_AGENT2_BROWSER_FALLBACK is not set",
        browserRuntimeAvailable: false,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  // Launch browser
  const launchResult = await launchBrowser();
  const browser = launchResult.browser;
  if (!browser) {
    return {
      ok: false,
      reason: "browser_runtime_unavailable",
      links: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: launchResult.blockedReason || "Playwright is not installed or could not be launched",
        browserRuntimeAvailable: false,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  try {
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
    });
    const page = await context.newPage();

    let blockedReason: string | undefined;
    let renderedUrl: string | undefined;

    // Block heavy resources to speed up rendering
    await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,mp4,mp3,woff,woff2,ttf}", (route: any) =>
      route.abort(),
    );

    const response = await page
      .goto(input.targetUrl, {
        waitUntil: "networkidle",
        timeout: timeoutMs,
      })
      .catch((err: any) => {
        blockedReason = `Navigation failed: ${err?.message || String(err)}`;
        return null;
    });

    if (!response) {
      await browser.close();
      return {
        ok: false,
        reason: "navigation_failed",
        links: [],
        diagnostics: {
          pageTitle: null,
          linkCount: 0,
          articleLikeLinkCount: 0,
          blockedReason,
          browserRuntimeAvailable: true,
          elapsedMs: Date.now() - startedAt,
        },
      };
    }

    if (!response.ok()) {
      blockedReason = `HTTP ${response.status()}`;
      await browser.close();
      return {
        ok: false,
        reason: "http_error",
        links: [],
        diagnostics: {
          pageTitle: null,
          linkCount: 0,
          articleLikeLinkCount: 0,
          blockedReason,
          browserRuntimeAvailable: true,
          elapsedMs: Date.now() - startedAt,
        },
      };
    }

    renderedUrl = page.url();

    // Extract article links from rendered DOM via page.evaluate()
    // (runs inside the browser context where document is available)
    const pageTitle = await page.title().catch(() => null);
    const allAnchors = await page.evaluate(() => document.querySelectorAll("a[href]").length);
    const rawLinks = await extractRawLinksFromBrowser(
      page,
      renderedUrl || input.targetUrl,
      categoryPathUrl,
    ).catch(() => [] as RawBrowserLink[]);
    const links = scoreAndFilterBrowserLinks(rawLinks, renderedUrl || input.targetUrl, categoryPathUrl);

    await browser.close();

    return {
      ok: true,
      renderedUrl,
      links,
      diagnostics: {
        pageTitle,
        linkCount: allAnchors,
        articleLikeLinkCount: links.length,
        browserRuntimeAvailable: true,
        elapsedMs: Date.now() - startedAt,
      },
    };
  } catch (error: any) {
    try {
      await browser.close();
    } catch {
      // ignore close errors
    }
    return {
      ok: false,
      reason: "browser_error",
      links: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: error?.message || String(error),
        browserRuntimeAvailable: true,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }
}
