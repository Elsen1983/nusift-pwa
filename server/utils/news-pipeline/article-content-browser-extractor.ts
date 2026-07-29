// ─────────────────────────────────────────────────────────────────────────────
// Agent 3 Phase 3 — Browser-based article content extractor fallback
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders article pages with Playwright when the static HTTP extractor fails
// (due to JS-rendering, anti-bot blocking, or unsupported static HTML structure).
// Extracts the fully rendered HTML and passes it through the shared scoring
// pipeline (`extractArticleContentFromHtml`) for identical quality gates.
//
// Design constraints:
//  - No publisher-specific selectors or special cases
//  - Reuses Agent 2 browser launch infrastructure (playwright-core + @sparticuz/chromium)
//  - Reuses the shared `extractArticleContentFromHtml` for scoring/quality gates
//  - Returns the same `ArticleContentExtractionResult` shape as the static extractor
//  - Bounded timeouts and resource blocking for Vercel/serverless safety
//  - Local and production code paths identical
// ─────────────────────────────────────────────────────────────────────────────

import {
  launchBrowser,
  BROWSER_USER_AGENT,
  isBrowserFallbackEnabled,
  setArticleDiscoveryBrowserImporterForTest,
} from "./article-discovery-browser";
import {
  extractArticleContentFromHtml,
  type ArticleContentExtractionResult,
} from "./article-content-extractor";

/**
 * Re-export for test injection. Allows tests to mock the browser launch
 * without touching Agent 2's internals directly.
 */
export { setArticleDiscoveryBrowserImporterForTest as setBrowserExtractorImporterForTest };

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BROWSER_TIMEOUT_MS = 25_000;
const MAX_BROWSER_TIMEOUT_MS = 45_000;
const MIN_BROWSER_TIMEOUT_MS = 5_000;
const POST_NAV_WAIT_MS = 1_500;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BrowserExtractionInput {
  articleUrl: string;
  existingTitle: string;
  existingBodyText?: string | null;
  timeoutMs?: number;
}

// ─── Browser Extraction ─────────────────────────────────────────────────────

/**
 * Extract article content using a headless browser.
 *
 * This is the Phase 3 fallback path for articles where static HTTP extraction
 * fails (HTTP 403, no article text, JS-rendered content, etc.).
 *
 * Flow:
 *  1. Launch browser using the same production-compatible runtime as Agent 2
 *  2. Navigate to the article URL with resource blocking
 *  3. Wait for DOM content to render
 *  4. Capture the fully rendered HTML via page.content()
 *  5. Pass HTML through the shared `extractArticleContentFromHtml` pipeline
 *  6. Return `ArticleContentExtractionResult` with method="browser-dom"
 *
 * If browser runtime is unavailable, returns a structured failure with
 * rejectedReason="browser_runtime_unavailable".
 */
export async function extractArticleContentWithBrowser(
  input: BrowserExtractionInput,
): Promise<ArticleContentExtractionResult> {
  const { articleUrl, existingTitle, existingBodyText } = input;

  if (!articleUrl || !articleUrl.trim()) {
    return {
      ok: false,
      method: "none",
      resolvedUrl: null,
      statusCode: null,
      rejectedReason: "missing_article_url",
      detail: "Article URL is empty or null.",
      confidence: 0,
      qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null,
        selectedContainerScore: null,
        selectedContainerParagraphCount: null,
        selectedContainerTextLength: null,
        candidateContainerCount: 0,
        bodyRejectedReason: null,
        scoreReasons: [],
        excerptLength: null,
        bodyEqualsExcerpt: false,
        bodySource: "none",
        linkTextRatio: null,
        boilerplatePenalty: null,
        topCandidates: [],
        usedExpansion: false,
        expansionType: null,
        leadLikePenaltyApplied: false,
        stopReason: null,
        boundaryMarkersSeen: 0,
        stoppedAtText: null,
        stoppedAtClassOrId: null,
        excludedBlockCount: 0,
      },
    };
  }

  // Feature gate: check if browser runtime is enabled
  if (!isBrowserFallbackEnabled()) {
    return browserUnavailableResult(articleUrl, "NUXT_ENABLE_AGENT2_BROWSER_FALLBACK is not set");
  }

  // Clamp timeout
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs || DEFAULT_BROWSER_TIMEOUT_MS, MIN_BROWSER_TIMEOUT_MS),
    MAX_BROWSER_TIMEOUT_MS,
  );

  // Launch browser
  const launchResult = await launchBrowser();
  const browser = launchResult.browser;

  if (!browser) {
    return browserUnavailableResult(
      articleUrl,
      launchResult.blockedReason || "Browser runtime unavailable",
    );
  }

  try {
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
    });
    const page = await context.newPage();

    // Block heavy resources to speed up rendering
    await page.route(
      "**/*.{png,jpg,jpeg,gif,svg,webp,mp4,mp3,woff,woff2,ttf,eot}",
      (route: any) => route.abort(),
    );

    // Navigate to the article URL
    const response = await page
      .goto(articleUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      })
      .catch((err: any) => {
        return null;
      });

    if (!response) {
      return {
        ok: false,
        method: "browser-dom",
        resolvedUrl: articleUrl,
        statusCode: null,
        rejectedReason: "fetch_failed",
        detail: "Browser navigation failed (timeout or network error).",
        confidence: 0,
        qualitySignals: ["browser_navigation_failed"],
        diagnostics: emptyDiagnostics("none"),
      };
    }

    const statusCode = response.status();
    const resolvedUrl = page.url() || articleUrl;

    // Handle HTTP errors
    if (statusCode >= 400) {
      const rejectedReason =
        statusCode === 403 || statusCode === 429 ? "http_error" : "fetch_failed";
      return {
        ok: false,
        method: "browser-dom",
        resolvedUrl,
        statusCode,
        rejectedReason,
        detail: `Browser received HTTP ${statusCode}`,
        confidence: 0,
        qualitySignals: [`browser_http_${statusCode}`],
        diagnostics: emptyDiagnostics("none"),
      };
    }

    // Wait for content to render (conservative wait for JS-heavy pages)
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(POST_NAV_WAIT_MS).catch(() => {});
    }

    // Capture the fully rendered HTML
    const html = await page.content();

    // Pass through shared extraction pipeline (browser closed in finally)
    return extractArticleContentFromHtml({
      html,
      resolvedUrl,
      statusCode,
      existingTitle,
      existingBodyText,
      method: "browser-dom",
    });
  } catch (error: any) {
    // Handle browser errors gracefully
    const message = error?.message || String(error);

    // Check for rate limiting signals
    if (message.includes("429") || message.includes("rate limit")) {
      return {
        ok: false,
        method: "browser-dom",
        resolvedUrl: articleUrl,
        statusCode: 429,
        rejectedReason: "http_error",
        detail: `Browser rate limited: ${message}`,
        confidence: 0,
        qualitySignals: ["browser_rate_limited"],
        diagnostics: emptyDiagnostics("none"),
      };
    }

    return {
      ok: false,
      method: "browser-dom",
      resolvedUrl: articleUrl,
      statusCode: null,
      rejectedReason: "fetch_failed",
      detail: `Browser extraction error: ${message}`,
      confidence: 0,
      qualitySignals: ["browser_error"],
      diagnostics: emptyDiagnostics("none"),
    };
  } finally {
    // Always close browser, even on error
    try {
      await browser.close();
    } catch {
      // Ignore close errors (already closed or never opened)
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function browserUnavailableResult(
  articleUrl: string,
  detail: string,
): ArticleContentExtractionResult {
  return {
    ok: false,
    method: "none",
    resolvedUrl: articleUrl,
    statusCode: null,
    rejectedReason: "fetch_failed",
    detail: `[browser_runtime_unavailable] ${detail}`,
    confidence: 0,
    qualitySignals: ["browser_runtime_unavailable"],
    diagnostics: emptyDiagnostics("none"),
  };
}

function emptyDiagnostics(
  bodySource: "dom" | "expanded-dom" | "existing-fallback" | "none",
) {
  return {
    selectedContainerSelector: null,
    selectedContainerScore: null,
    selectedContainerParagraphCount: null,
    selectedContainerTextLength: null,
    candidateContainerCount: 0,
    bodyRejectedReason: null,
    scoreReasons: [],
    excerptLength: null,
    bodyEqualsExcerpt: false,
    bodySource,
    linkTextRatio: null,
    boilerplatePenalty: null,
    topCandidates: [],
    usedExpansion: false,
    expansionType: null,
    leadLikePenaltyApplied: false,
    stopReason: null,
    boundaryMarkersSeen: 0,
    stoppedAtText: null,
    stoppedAtClassOrId: null,
    excludedBlockCount: 0,
  };
}

// ─── Browser Fallback Eligibility ───────────────────────────────────────────

/**
 * Signals that indicate a generic fetch failure might be recoverable via
 * browser rendering (anti-bot, timeout, connection reset, etc.).
 * Used to narrow fetch_failed eligibility so SSRF blocks, DNS failures,
 * and other non-browser-recoverable issues don't trigger expensive browser
 * fallback attempts.
 */
const BROWSER_USEFUL_FETCH_SIGNALS: ReadonlySet<string> = new Set([
  "browser_navigation_failed",
  "browser_http_403",
  "browser_http_429",
  "browser_rate_limited",
  "browser_error",
  "fetch_timeout",
  "connection_reset",
  "bot_blocked",
  "static_fetch_blocked",
]);

/**
 * Determine whether a static extraction failure should attempt browser fallback.
 * Accepts the full static extraction failure result to make a precise decision.
 *
 * Browser fallback is expensive (launches a full browser), so only retry for
 * failures that indicate the content might be recoverable with JS rendering:
 *  - HTTP 403 (anti-bot blocking)
 *  - HTTP 429 (rate limiting)
 *  - no_article_text (JS-rendered content not visible in static HTML)
 *  - empty_html (server returned empty/minimal HTML)
 *  - too_short (partial extraction, might get more with JS rendering)
 *
 * For fetch_failed: only eligible when qualitySignals or detail suggest
 * browser-useful problems (timeout, connection reset, bot blocking).
 * Generic SSRF blocks, DNS failures, and other non-browser-recoverable
 * issues should NOT trigger browser fallback.
 *
 * Do NOT browser-fallback for:
 *  - missing_article_url (fundamental data issue)
 *  - stale_or_invalid (content problem, not rendering)
 *  - paywall_or_blocked (paywall won't be bypassed by browser)
 *  - non_html_response (server issue, not rendering)
 *  - canonical_mismatch (content mismatch, not rendering)
 *  - parse_error (HTML structure issue — browser renders same HTML)
 */
export function isBrowserFallbackEligibleForFailure(result: {
  rejectedReason: string;
  statusCode: number | null;
  detail?: string | null;
  qualitySignals?: string[];
}): boolean {
  const { rejectedReason, statusCode, detail, qualitySignals } = result;
  const signals = qualitySignals ?? [];

  switch (rejectedReason) {
    case "http_error":
      // Only retry 403 (forbidden/anti-bot) and 429 (rate limited)
      return statusCode === 403 || statusCode === 429;
    case "no_article_text":
    case "empty_html":
    case "too_short":
      return true;
    case "fetch_failed": {
      // Narrow: only eligible when signals indicate browser-recoverable problems

      const hasUsefulSignal = signals.some((s) => BROWSER_USEFUL_FETCH_SIGNALS.has(s));
      if (hasUsefulSignal) return true;

      // Check detail for common browser-recoverable patterns
      const detailLower = (detail ?? "").toLowerCase();
      if (
        detailLower.includes("timeout") ||
        detailLower.includes("403") ||
        detailLower.includes("429") ||
        detailLower.includes("connection reset") ||
        detailLower.includes("econnreset") ||
        detailLower.includes("enotfound") ||
        detailLower.includes("navigation failed")
      ) {
        return true;
      }

      return false;
    }
    // parse_error: NOT eligible — browser renders the same HTML structure
    // canonical_mismatch: NOT eligible — content mismatch issue
    // paywall_or_blocked: NOT eligible — won't bypass paywalls
    // non_html_response: NOT eligible — server issue
    // stale_or_invalid: NOT eligible — content problem
    // missing_article_url: NOT eligible — fundamental data issue
    default:
      return false;
  }
}

/**
 * Backward-compatible wrapper that delegates to the full-result eligibility check.
 * Used by callers that only have rejectedReason and statusCode.
 * @deprecated Prefer isBrowserFallbackEligibleForFailure for more precise eligibility.
 */
export function isBrowserFallbackEligible(
  rejectedReason: string,
  statusCode: number | null,
): boolean {
  return isBrowserFallbackEligibleForFailure({ rejectedReason, statusCode });
}
