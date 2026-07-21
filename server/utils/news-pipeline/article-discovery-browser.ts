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
  evaluateArticleLinkCandidateFromExtractedMetadata,
} from "./article-discovery-helpers";
import type {
  EvaluateArticleLinkResult,
  ArticleDiscoveryCandidateOutcome,
  PublishedAtSource,
} from "./article-discovery-helpers";
import { normalizeUrl } from "./text";

// ─── Constants ──────────────────────────────────────────────────────────────

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BROWSER_SHORTLISTED_LINKS = 25;
const MAX_BROWSER_TOP_REJECTED_LINKS = 20;
const MAX_BROWSER_RAW_LINKS = 700;

// ─── Types ──────────────────────────────────────────────────────────────────

export type BrowserArticleLink = {
  url: string;
  text: string | null;
  sourcePageUrl: string;
  sourceKind: "browser";
  rawSignals: Record<string, unknown>;
};

/**
 * Compact audit entry for a raw browser link that was evaluated by
 * scoreAndFilterBrowserLinks. Explains why a link was rejected or accepted
 * for detail evaluation.
 */
export type BrowserLinkAuditEntry = {
  url: string;
  normalizedUrl: string | null;
  anchorText: string | null;
  score: number;
  rejected: boolean;
  reason: string | null;
  scoreReasons: string[];
  sameDomain: boolean;
  utilityPath: boolean;
  categoryScoped: boolean | null;
};

export type BrowserArticleLinkResult = {
  ok: boolean;
  reason?: string;
  renderedUrl?: string;
  links: BrowserArticleLink[];
  rawLinkCount: number;
  shortlistedLinkCount: number;
  topRejectedLinks: BrowserLinkAuditEntry[];
  shortlistedLinkSamples: BrowserLinkAuditEntry[];
  topRejectionReasons: Array<{ reason: string; count: number }>;
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
  dateText: string | null;
};

/**
 * Extract raw anchor URLs from the rendered DOM inside the browser context.
 * Runs via page.evaluate() so it has access to the live DOM.
 * Returns deduplicated, resolved anchor URLs. Only obviously non-link hrefs
 * (hash-only, javascript:, mailto:, tel:) are skipped. Domain, category,
 * and URL quality validation happen Node-side in scoreAndFilterBrowserLinks
 * so the full bounded raw sample can be audited.
 */
async function extractRawLinksFromBrowser(
  page: any,
  pageUrl: string,
): Promise<RawBrowserLink[]> {
  return page.evaluate(
    (args: { pageUrl: string; maxLinks: number }) => {
      const { pageUrl, maxLinks } = args;
      const results: Array<{ url: string; text: string | null; dateText: string | null }> = [];
      const seen = new Set<string>();

      const extractNearbyDateText = (anchor: Element): string | null => {
        const containers = [
          anchor.closest("article"),
          anchor.closest("li"),
          anchor.closest("[class*='story' i]"),
          anchor.closest("[class*='article' i]"),
          anchor.closest("[class*='news' i]"),
          anchor.parentElement,
          anchor.parentElement?.parentElement || null,
        ].filter(Boolean) as Element[];

        const patterns = [
          /\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/i,
          /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/i,
          /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/,
          /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/,
        ];

        for (const container of containers) {
          const text = (container.textContent || "").replace(/\s+/g, " ").trim().slice(0, 800);
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match?.[0]) return match[0];
          }
        }

        return null;
      };

      try {
        const anchors = Array.from(document.querySelectorAll("a[href]"));

        for (const anchor of anchors) {
          const href = (anchor as HTMLAnchorElement).getAttribute("href");
          // Only skip obviously non-link hrefs. Domain, category, and URL
          // validation are handled Node-side by scoreAndFilterBrowserLinks
          // so the full bounded raw sample can be audited.
          if (
            !href ||
            href.startsWith("#") ||
            href.startsWith("javascript:") ||
            href.startsWith("mailto:") ||
            href.startsWith("tel:")
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

          results.push({
            url: resolved,
            text: (anchor as HTMLAnchorElement).textContent?.trim().slice(0, 200) || null,
            dateText: extractNearbyDateText(anchor),
          });

          if (results.length >= maxLinks) break;
        }
      } catch {
        // DOM extraction failed
      }

      return results;
    },
    { pageUrl, maxLinks: MAX_BROWSER_RAW_LINKS },
  );
}

/**
 * Score and filter raw browser links in Node.js using the same scoring
 * logic as static Agent 2. Returns fully typed BrowserArticleLink[].
 */
type ScoreAndFilterResult = {
  /** Capped to MAX_BROWSER_SHORTLISTED_LINKS */
  links: BrowserArticleLink[];
  /** Total accepted before cap (may exceed links.length) */
  totalAcceptedBeforeCap: number;
  topRejectedLinks: BrowserLinkAuditEntry[];
  shortlistedLinkSamples: BrowserLinkAuditEntry[];
  topRejectionReasons: Array<{ reason: string; count: number }>;
};

function isCategoryDirectoryPath(url: string | null): boolean {
  if (!url) return false;
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "") || "/";
    return /^\/categor(?:y|ies)\/[^/]+$/i.test(path);
  } catch {
    return false;
  }
}

function isStrongListingContextArticle(
  raw: RawBrowserLink,
  pageUrl: string,
  categoryPathUrl: string | null,
): { accepted: boolean; score: number; reasons: string[] } {
  if (!isCategoryDirectoryPath(categoryPathUrl)) {
    return { accepted: false, score: 0, reasons: [] };
  }

  try {
    const path = new URL(raw.url).pathname.replace(/\/+$/, "") || "/";
    if (isCategoryDirectoryPath(raw.url) || path === "/" || path === new URL(pageUrl).pathname.replace(/\/+$/, "")) {
      return { accepted: false, score: 0, reasons: ["category_directory_or_listing_page"] };
    }
  } catch {
    return { accepted: false, score: 0, reasons: ["invalid_url"] };
  }

      const score = scoreCandidateUrl(raw.url, pageUrl, {
        title: raw.text,
        dateText: raw.dateText,
        categoryPathUrl: null,
      });

  const hasUsefulAnchor = Boolean(raw.text && raw.text.trim().length >= 12);
  const accepted = !score.rejected && score.score >= 50 && hasUsefulAnchor;
  return {
    accepted,
    score: score.score,
    reasons: accepted
      ? [...score.reasons, "listing_context_scope"]
      : [...score.reasons, hasUsefulAnchor ? "weak_listing_context" : "weak_anchor_text"],
  };
}

function scoreAndFilterBrowserLinks(
  rawLinks: RawBrowserLink[],
  pageUrl: string,
  categoryPathUrl: string | null,
): ScoreAndFilterResult {
  // Collect ALL accepted candidates — we iterate the full raw sample so that
  // rejectedLinks and rejectionReasonCounts cover every link, not just the
  // ones seen before the shortlist cap is hit.
  const allAccepted: BrowserArticleLink[] = [];
  const allAcceptedEntries: BrowserLinkAuditEntry[] = [];
  const rejectedLinks: BrowserLinkAuditEntry[] = [];
  const rejectionReasonCounts: Record<string, number> = {};

  const pageHostname = (() => {
    try { return new URL(pageUrl).hostname.replace(/^www\./, ""); } catch { return ""; }
  })();

  for (const raw of rawLinks) {
    let normalizedUrl: string | null = null;
    try { normalizedUrl = normalizeUrl(raw.url); } catch { normalizedUrl = null; }

    // ── Domain validation (moved from browser-context extraction) ──
    let sameDomain = false;
    try { sameDomain = new URL(raw.url).hostname.replace(/^www\./, "") === pageHostname; } catch { /* invalid URL below */ }

    // ── Invalid URL detection ──────────────────────────────────────
    if (!normalizedUrl) {
      const entry: BrowserLinkAuditEntry = {
        url: raw.url,
        normalizedUrl: null,
        anchorText: raw.text?.slice(0, 100) || null,
        score: 0,
        rejected: true,
        reason: "invalid_url",
        scoreReasons: ["invalid_url"],
        sameDomain: false,
        utilityPath: false,
        categoryScoped: null,
      };
      rejectedLinks.push(entry);
      rejectionReasonCounts["invalid_url"] = (rejectionReasonCounts["invalid_url"] || 0) + 1;
      continue;
    }

    const isUtilityPath = isBlockedDiscoveryPath(raw.url);

    // ── Category scope validation (moved from browser-context extraction) ──
    let categoryScoped: boolean | null = null;
    if (categoryPathUrl) {
      try {
        const articlePath = new URL(raw.url).pathname.replace(/\/+$/, "") || "/";
        const categoryPath = new URL(categoryPathUrl).pathname.replace(/\/+$/, "") || "/";
        categoryScoped = categoryPath === "/" || articlePath === categoryPath || articlePath.startsWith(`${categoryPath}/`);
      } catch { categoryScoped = false; }
    }

    const makeAuditEntry = (rejected: boolean, reason: string | null, scoreResult: { score: number; reasons: string[] }): BrowserLinkAuditEntry => ({
      url: raw.url,
      normalizedUrl,
      anchorText: raw.text?.slice(0, 100) || null,
      score: scoreResult.score,
      rejected,
      reason,
      scoreReasons: scoreResult.reasons,
      sameDomain,
      utilityPath: isUtilityPath,
      categoryScoped,
    });

    // Reject cross-domain links
    if (!sameDomain) {
      const entry = makeAuditEntry(true, "different_domain", { score: 0, reasons: ["different_domain"] });
      rejectedLinks.push(entry);
      rejectionReasonCounts["different_domain"] = (rejectionReasonCounts["different_domain"] || 0) + 1;
      continue;
    }

    // Reject utility path links
    if (isUtilityPath) {
      const entry = makeAuditEntry(true, "utility_path", { score: 0, reasons: ["utility_path"] });
      rejectedLinks.push(entry);
      rejectionReasonCounts["utility_path"] = (rejectionReasonCounts["utility_path"] || 0) + 1;
      continue;
    }

    if (normalizedUrl === normalizeUrl(pageUrl)) {
      const entry = makeAuditEntry(true, "listing_page", { score: 0, reasons: ["listing_page"] });
      rejectedLinks.push(entry);
      rejectionReasonCounts["listing_page"] = (rejectionReasonCounts["listing_page"] || 0) + 1;
      continue;
    }

    // Reject out-of-category-scope links unless the target is a category
    // directory page whose article URLs intentionally live outside that
    // directory. This is common on sites such as /category/arizona-news where
    // the listing page is category-scoped but article detail URLs are global.
    if (categoryScoped === false) {
      const listingContext = isStrongListingContextArticle(raw, pageUrl, categoryPathUrl);
      if (!listingContext.accepted) {
        const entry = makeAuditEntry(true, "out_of_category_scope", {
          score: listingContext.score,
          reasons: listingContext.reasons.length > 0 ? listingContext.reasons : ["out_of_category_scope"],
        });
        rejectedLinks.push(entry);
        rejectionReasonCounts["out_of_category_scope"] = (rejectionReasonCounts["out_of_category_scope"] || 0) + 1;
        continue;
      }

      const entry = makeAuditEntry(false, null, {
        score: listingContext.score,
        reasons: listingContext.reasons,
      });
      allAcceptedEntries.push(entry);

      allAccepted.push({
        url: raw.url,
        text: raw.text,
        sourcePageUrl: `browser:${pageUrl}`,
        sourceKind: "browser",
        rawSignals: {
          anchorText: raw.text?.slice(0, 100) || null,
          listingDateText: raw.dateText,
          score: listingContext.score,
          scoreReasons: listingContext.reasons,
        },
      });
      continue;
    }

    // Score the candidate URL
    const score = scoreCandidateUrl(raw.url, pageUrl, {
      title: raw.text,
      dateText: raw.dateText,
      categoryPathUrl,
    });

    if (score.rejected) {
      const rejectionReason = score.rejectionReason || "low_score";
      const entry = makeAuditEntry(true, rejectionReason, { score: score.score, reasons: score.reasons });
      rejectedLinks.push(entry);
      rejectionReasonCounts[rejectionReason] = (rejectionReasonCounts[rejectionReason] || 0) + 1;
      continue;
    }

    // Accepted for shortlist — collect ALL accepted candidates; the links
    // array is capped later so audit covers the full raw sample.
    const entry = makeAuditEntry(false, null, { score: score.score, reasons: score.reasons });
    allAcceptedEntries.push(entry);

    allAccepted.push({
      url: raw.url,
      text: raw.text,
      sourcePageUrl: `browser:${pageUrl}`,
      sourceKind: "browser",
      rawSignals: {
        anchorText: raw.text?.slice(0, 100) || null,
        listingDateText: raw.dateText,
        score: score.score,
        scoreReasons: score.reasons,
      },
    });
  }

  // ── Cap the returned links array ────────────────────────────────
  // Sort accepted by score desc, then cap to MAX_BROWSER_SHORTLISTED_LINKS.
  allAccepted.sort((a, b) => {
    const sa = (a.rawSignals as Record<string, unknown>).score as number || 0;
    const sb = (b.rawSignals as Record<string, unknown>).score as number || 0;
    return sb - sa;
  });
  allAcceptedEntries.sort((a, b) => b.score - a.score);
  const links = allAccepted.slice(0, MAX_BROWSER_SHORTLISTED_LINKS);

  // ── Build shortlisted samples (capped at 25) ───────────────────
  const shortlistedSamples: BrowserLinkAuditEntry[] = allAcceptedEntries
    .slice(0, MAX_BROWSER_SHORTLISTED_LINKS);

  // ── Build top rejected links (capped at 20, sorted by score desc)
  rejectedLinks.sort((a, b) => b.score - a.score);
  const topRejectedLinks = rejectedLinks.slice(0, MAX_BROWSER_TOP_REJECTED_LINKS);

  // ── Build top rejection reasons (from the full audited sample) ──
  const topRejectionReasons = Object.entries(rejectionReasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    links,
    totalAcceptedBeforeCap: allAccepted.length,
    topRejectedLinks,
    shortlistedLinkSamples: shortlistedSamples,
    topRejectionReasons,
  };
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
      rawLinkCount: 0,
      shortlistedLinkCount: 0,
      topRejectedLinks: [],
      shortlistedLinkSamples: [],
      topRejectionReasons: [],
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
      rawLinkCount: 0,
      shortlistedLinkCount: 0,
      topRejectedLinks: [],
      shortlistedLinkSamples: [],
      topRejectionReasons: [],
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
        rawLinkCount: 0,
        shortlistedLinkCount: 0,
        topRejectedLinks: [],
        shortlistedLinkSamples: [],
        topRejectionReasons: [],
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
        rawLinkCount: 0,
        shortlistedLinkCount: 0,
        topRejectedLinks: [],
        shortlistedLinkSamples: [],
        topRejectionReasons: [],
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
    ).catch(() => [] as RawBrowserLink[]);
    const filterResult = scoreAndFilterBrowserLinks(rawLinks, renderedUrl || input.targetUrl, categoryPathUrl);

    await browser.close();

    return {
      ok: true,
      renderedUrl,
      links: filterResult.links,
      rawLinkCount: rawLinks.length,
      shortlistedLinkCount: filterResult.totalAcceptedBeforeCap,
      topRejectedLinks: filterResult.topRejectedLinks,
      shortlistedLinkSamples: filterResult.shortlistedLinkSamples,
      topRejectionReasons: filterResult.topRejectionReasons,
      diagnostics: {
        pageTitle,
        linkCount: allAnchors,
        articleLikeLinkCount: filterResult.links.length,
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
      rawLinkCount: 0,
      shortlistedLinkCount: 0,
      topRejectedLinks: [],
      shortlistedLinkSamples: [],
      topRejectionReasons: [],
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

// ─── Browser-based article detail recovery ────────────────────────────────

export type BrowserArticleDetailExtraction = {
  title: string;
  description: string;
  publishedAtRaw: string | null;
  publishedAtSource: PublishedAtSource;
  keywords: string[];
  bodyFallback: string;
  canonicalUrl: string | null;
};

const DETAIL_PAGE_TIMEOUT_MS = 15_000;
const MAX_DETAIL_PAGE_TIMEOUT_MS = 15_000;

// ─── Raw DOM data extraction + Node-side normalization ─────────────────────

/**
 * Plain serializable data extracted from the browser DOM.
 * All fields are primitives — no DOM objects, no functions, no closures.
 * This is what page.evaluate() returns to Node.
 */
export type RawArticleDetailData = {
  pageUrl: string;
  canonicalHref: string | null;
  docTitle: string;
  h1Text: string | null;
  ogTitle: string | null;
  twitterTitle: string | null;
  metaTitle: string | null;
  ogDescription: string | null;
  metaDescription: string | null;
  twitterDescription: string | null;
  metaKeywords: string | null;
  articlePublishedTime: string | null;
  ogPublishedTime: string | null;
  pubdate: string | null;
  publishdate: string | null;
  timeDatetime: string | null;
  metaDate: string | null;
  jsonLdScripts: string[];
  bodyText: string;
};

/**
 * Node-side single source of truth: normalize raw DOM data into article
 * metadata. Handles JSON-LD parsing (including @graph and array forms),
 * title priority, date priority, keywords splitting, and body truncation.
 *
 * This function never touches the DOM — it works only with primitive values.
 */
export function normalizeArticleDetailFromRaw(
  raw: RawArticleDetailData,
): BrowserArticleDetailExtraction {
  const canonicalUrl = raw.canonicalHref || raw.pageUrl;

  // ── JSON-LD extraction (collect all objects including @graph) ────
  let jsonLdHeadline: string | null = null;
  let jsonLdName: string | null = null;
  let publishedAtRaw: string | null = null;
  let publishedAtSource: string = "unknown";

  for (const jsonText of raw.jsonLdScripts) {
    try {
      const data = JSON.parse(jsonText || "{}");
      const queue: any[] = Array.isArray(data) ? [...data] : [data];
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        // Flatten @graph arrays
        if (Array.isArray(item["@graph"])) {
          queue.push(...item["@graph"]);
          continue;
        }
        if (!publishedAtRaw && item.datePublished) {
          publishedAtRaw = String(item.datePublished);
          publishedAtSource = "datePublished";
        }
        if (!jsonLdHeadline && typeof item.headline === "string" && item.headline.trim()) {
          jsonLdHeadline = item.headline.trim();
        }
        if (!jsonLdName && typeof item.name === "string" && item.name.trim()) {
          jsonLdName = item.name.trim();
        }
      }
    } catch {
      // malformed JSON-LD — ignore
    }
  }

  // ── Title priority chain ───────────────────────────────────────
  // og:title > twitter:title > meta title > JSON-LD headline >
  // JSON-LD name > document.title > h1
  const metaTitle = raw.ogTitle || raw.twitterTitle || raw.metaTitle || null;
  const title =
    metaTitle ||
    jsonLdHeadline ||
    jsonLdName ||
    raw.docTitle ||
    raw.h1Text ||
    "";

  const description =
    raw.ogDescription || raw.metaDescription || raw.twitterDescription || "";

  // ── Date priority ──────────────────────────────────────────────
  // Each field is checked individually so publishedAtSource precisely
  // matches the selected source.
  if (!publishedAtRaw) {
    if (raw.articlePublishedTime) {
      publishedAtRaw = raw.articlePublishedTime;
      publishedAtSource = "article:published_time";
    } else if (raw.ogPublishedTime) {
      publishedAtRaw = raw.ogPublishedTime;
      publishedAtSource = "og:published_time";
    } else if (raw.pubdate) {
      publishedAtRaw = raw.pubdate;
      publishedAtSource = "article:published_time";
    } else if (raw.publishdate) {
      publishedAtRaw = raw.publishdate;
      publishedAtSource = "article:published_time";
    }
  }

  if (!publishedAtRaw && raw.timeDatetime) {
    publishedAtRaw = raw.timeDatetime;
    publishedAtSource = "time[datetime]";
  }

  if (!publishedAtRaw && raw.metaDate) {
    publishedAtRaw = raw.metaDate;
    publishedAtSource = "meta[name=date]";
  }

  const keywords = raw.metaKeywords
    ? raw.metaKeywords.split(",").map((k) => k.trim()).filter(Boolean)
    : [];

  const bodyFallback = raw.bodyText
    ? raw.bodyText.trim().replace(/\s+/g, " ").slice(0, 600)
    : "";

  return {
    canonicalUrl,
    title,
    description,
    publishedAtRaw,
    publishedAtSource: publishedAtSource as PublishedAtSource,
    keywords,
    bodyFallback,
  };
}

/**
 * Minimal document-like adapter for extracting article metadata.
 * Allows the extraction logic to be unit-tested without a real browser.
 */
export type DocumentLike = {
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
  title: string;
  body: ElementLike;
};

type ElementLike = {
  getAttribute(name: string): string | null;
  textContent: string | null;
  innerText?: string;
};

/**
 * Testable mirror: extract raw data from a document-like object, then
 * delegate to normalizeArticleDetailFromRaw().
 *
 * NOTE: This function must stay in sync with the inline page.evaluate()
 * extraction in evaluateArticleLinkCandidateWithBrowser(). Both produce
 * the same RawArticleDetailData shape.
 */
export function extractArticleDetailFromDocument(
  doc: DocumentLike,
  pageUrl: string,
): BrowserArticleDetailExtraction {
  const getMetaContent = (selector: string): string | null => {
    const el = doc.querySelector(selector);
    return el?.getAttribute("content")?.trim() || null;
  };

  const canonicalLink = doc.querySelector('link[rel="canonical"]');

  const jsonLdScripts: string[] = [];
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const text = scripts[i]!.textContent || "";
    if (text.trim()) jsonLdScripts.push(text);
  }

  const articleEl =
    doc.querySelector("article") ||
    doc.querySelector("main") ||
    doc.body;

  const raw: RawArticleDetailData = {
    pageUrl,
    canonicalHref: canonicalLink?.getAttribute("href") || null,
    docTitle: doc.title || "",
    h1Text: doc.querySelector("h1")?.innerText?.trim() || null,
    ogTitle: getMetaContent('meta[property="og:title"]'),
    twitterTitle: getMetaContent('meta[name="twitter:title"]'),
    metaTitle: getMetaContent('meta[name="title"]'),
    ogDescription: getMetaContent('meta[property="og:description"]'),
    metaDescription: getMetaContent('meta[name="description"]'),
    twitterDescription: getMetaContent('meta[name="twitter:description"]'),
    metaKeywords: getMetaContent('meta[name="keywords"]'),
    articlePublishedTime:
      getMetaContent('meta[property="article:published_time"]') ||
      getMetaContent('meta[name="article:published_time"]') ||
      null,
    ogPublishedTime:
      getMetaContent('meta[property="og:published_time"]') ||
      getMetaContent('meta[name="og:published_time"]') ||
      null,
    pubdate: getMetaContent('meta[name="pubdate"]'),
    publishdate: getMetaContent('meta[name="publishdate"]'),
    timeDatetime: doc.querySelector("time[datetime]")?.getAttribute("datetime") || null,
    metaDate: getMetaContent('meta[name="date"]'),
    jsonLdScripts,
    bodyText: articleEl ? (articleEl.innerText || "") : "",
  };

  return normalizeArticleDetailFromRaw(raw);
}

/**
 * Render an article detail page in a headless browser and evaluate it using
 * the same candidate-building logic as static Agent 2.
 *
 * This is a recovery path: static `evaluateArticleLinkCandidate()` has already
 * failed (usually HTTP 403), so we render the page and extract metadata from
 * the live DOM. No raw HTML, screenshots, or DOM dumps are persisted.
 */
export async function evaluateArticleLinkCandidateWithBrowser(input: {
  articleUrl: string;
  sourcePageUrl: string;
  targetUrl: string;
  sourceId: string;
  categoryId?: string | null;
  timeoutMs?: number;
  listingDateFallbackRaw?: string | null;
}): Promise<EvaluateArticleLinkResult> {
  const startedAt = Date.now();
  const { articleUrl, sourcePageUrl, targetUrl, sourceId, categoryId } = input;
  const timeoutMs = Math.min(input.timeoutMs || DETAIL_PAGE_TIMEOUT_MS, MAX_DETAIL_PAGE_TIMEOUT_MS);

  const reject = (
    status: ArticleDiscoveryCandidateOutcome["status"],
    reason: string,
  ): EvaluateArticleLinkResult => ({
    accepted: false,
    candidate: null,
    outcome: {
      url: articleUrl,
      sourceKind: "browser",
      status,
      reason,
      canonicalUrl: normalizeUrl(articleUrl),
    } as ArticleDiscoveryCandidateOutcome,
  });

  if (!isBrowserFallbackEnabled()) {
    return reject("fetch_failed", "browser fallback disabled");
  }

  const launchResult = await launchBrowser();
  const browser = launchResult.browser;
  if (!browser) {
    return reject("detail_validation_failed", launchResult.blockedReason || "browser runtime unavailable");
  }

  try {
    const context = await browser.newContext({ userAgent: BROWSER_USER_AGENT });
    const page = await context.newPage();

    // Block heavy resources just like the listing browser path.
    await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,mp4,mp3,woff,woff2,ttf}", (route: any) =>
      route.abort(),
    );

    const response = await page
      .goto(articleUrl, { waitUntil: "networkidle", timeout: timeoutMs })
      .catch((err: any) => {
        return null;
      });

    if (!response) {
      return reject("fetch_failed", "navigation failed");
    }

    if (!response.ok()) {
      return reject("fetch_failed", `HTTP ${response.status()}`);
    }

    const renderedUrl = page.url();

    // Extract raw primitive data from the live DOM. The page.evaluate()
    // callback uses only document and args — no module-scope closures.
    // The raw data is then normalized on the Node side by
    // normalizeArticleDetailFromRaw(), which is the single source of truth
    // for JSON-LD parsing, title priority, and date priority.
    //
    // NOTE: Keep this extraction in sync with extractArticleDetailFromDocument()
    // below — both must produce the same RawArticleDetailData shape.
    const raw = (await page.evaluate((args: { pageUrl: string }) => {
      const { pageUrl } = args;

      const getMetaContent = (selector: string): string | null => {
        const el = document.querySelector(selector);
        return el?.getAttribute("content")?.trim() || null;
      };

      const getTextContent = (selector: string): string | null => {
        const el = document.querySelector(selector);
        return el?.textContent?.trim() || null;
      };

      const canonicalLink = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;

      const jsonLdScripts: string[] = [];
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (let i = 0; i < scripts.length; i++) {
        const text = scripts[i]!.textContent || "";
        if (text.trim()) jsonLdScripts.push(text);
      }

      const articleEl =
        document.querySelector("article") ||
        document.querySelector("main") ||
        document.body;

      return {
        pageUrl,
        canonicalHref: canonicalLink?.getAttribute("href") || null,
        docTitle: document.title || "",
        h1Text: (document.querySelector("h1") as HTMLElement | null)?.innerText?.trim() || null,
        ogTitle: getMetaContent('meta[property="og:title"]'),
        twitterTitle: getMetaContent('meta[name="twitter:title"]'),
        metaTitle: getMetaContent('meta[name="title"]'),
        ogDescription: getMetaContent('meta[property="og:description"]'),
        metaDescription: getMetaContent('meta[name="description"]'),
        twitterDescription: getMetaContent('meta[name="twitter:description"]'),
        metaKeywords: getMetaContent('meta[name="keywords"]'),
        articlePublishedTime:
          getMetaContent('meta[property="article:published_time"]') ||
          getMetaContent('meta[name="article:published_time"]') ||
          null,
        ogPublishedTime:
          getMetaContent('meta[property="og:published_time"]') ||
          getMetaContent('meta[name="og:published_time"]') ||
          null,
        pubdate: getMetaContent('meta[name="pubdate"]'),
        publishdate: getMetaContent('meta[name="publishdate"]'),
        timeDatetime: (document.querySelector("time[datetime]") as HTMLTimeElement | null)?.getAttribute("datetime") || null,
        metaDate: getMetaContent('meta[name="date"]'),
        jsonLdScripts,
        bodyText: articleEl
          ? (articleEl as HTMLElement).innerText || ""
          : "",
      };
    }, { pageUrl: renderedUrl || articleUrl })) as RawArticleDetailData;

    const extracted = normalizeArticleDetailFromRaw(raw);
    const publishedAtRaw = extracted.publishedAtRaw || input.listingDateFallbackRaw || null;
    const publishedAtSource = extracted.publishedAtRaw
      ? extracted.publishedAtSource
      : input.listingDateFallbackRaw
        ? "listing_context"
        : extracted.publishedAtSource;

    const evaluation = await evaluateArticleLinkCandidateFromExtractedMetadata({
      articleUrl,
      sourcePageUrl,
      targetUrl,
      sourceId,
      categoryId,
      title: extracted.title,
      description: extracted.description,
      keywords: extracted.keywords,
      publishedAtRaw,
      publishedAtSource: (publishedAtSource as PublishedAtSource) || "unknown",
      bodyFallback: extracted.bodyFallback,
      extraRawSignals: ["agent2-browser-detail-recovery"],
      canonicalUrlOverride: extracted.canonicalUrl,
    });

    return evaluation;
  } catch (error: any) {
    return reject("detail_validation_failed", error?.message || String(error));
  } finally {
    try {
      await browser.close();
    } catch {
      // ignore close errors
    }
  }
}
