// ─────────────────────────────────────────────────────────────────────────────
// Agent 3 Phase 2 — Real HTTP article content extractor (hardened)
// ─────────────────────────────────────────────────────────────────────────────
//
// Fetches an article URL, parses the HTML with jsdom, and extracts structured
// content: title, excerpt, body text, image, author, published date, and
// paywall signals. Returns a typed discriminated union for safe consumption
// by the enrichment runtime.
//
// Hardened extraction:
//  - Multi-candidate container scoring (not first-match)
//  - Parent/sibling expansion for thin containers
//  - Stricter quality gates (paragraph count, length, link ratio, punctuation)
//  - Excerpt-vs-body guard: meta description never becomes bodyText
//  - Compact extraction diagnostics for audit trails
//
// Design constraints:
//  - No publisher-specific selectors or special cases
//  - Deterministic extraction from semantic HTML / meta / JSON-LD
//  - Reuses the project's established safeFetch for SSRF protection
//  - Uses jsdom (already a devDependency) for DOM parsing
//  - Local and production code paths identical
// ─────────────────────────────────────────────────────────────────────────────

import { governedSafeFetchAndParse, GovernedFetchDeferredError } from "./governed-fetch";
import { decodeResponseText } from "./response-text-decoder";
import { NUSIFT_CRAWLER_USER_AGENT } from "./publisher-user-agent";
import {
  classifyArticleAccess,
  extractJsonLdPaywallSignalsFromValue,
  matchAdBlockerWarningPatterns,
  matchArticleAccessCtaPatterns,
  matchChallengeTextPatterns,
  type ArticleAccessClassificationResult,
  type JsonLdPaywallSignal,
  type JsonLdPaywallSignalScan,
} from "./article-access-classification";
import {
  detectStrongInterstitialSignals,
  hasBlockingInterstitialSignalPair,
} from "./article-body-policy";
import type { StageBatchProbe } from "./stage-telemetry";
import { loadJsdom } from "./jsdom-runtime";
import {
  getHttpsArticleUrl,
  isExplicitHttpFallbackAllowed,
} from "./article-transport-policy";
import { collectMatchingObjects, getJsonLdTypes } from "./structured-data";

// ─── Constants ──────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2_000_000; // 2 MB cap on downloaded HTML
const MAX_BODY_TEXT_CHARS = 50_000; // cap stored body text
// A publisher-declared amphtml alternate is always in <head>; bounding the
// search keeps this a cheap regex scan even on a very large page.
const AMP_LINK_SEARCH_BOUND_CHARS = 100_000;
/** Content-quality failures an AMP alternate can plausibly fix. Never network/
 * access-level reasons — a static 403/429/paywall/interstitial must not
 * trigger further same-host fallback (Repair 14 requirement 4). */
const AMP_RETRY_ELIGIBLE_REASONS: ReadonlySet<string> = new Set([
  "no_article_text",
  "too_short",
  "parse_error",
]);

const USER_AGENT = NUSIFT_CRAWLER_USER_AGENT;

const HTML_CONTENT_TYPE_HINTS = ["text/html", "application/xhtml", "application/xml"];

/** Tags whose content should be stripped from article body extraction. */
const STRIP_TAGS = [
  "script",
  "style",
  "nav",
  "footer",
  "header",
  "aside",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "noscript",
  "iframe",
  "svg",
];

/**
 * Tags treated as chrome by the access-evidence analyzer. Deliberately does
 * NOT include button/input/form — interactive access CTAs are exactly the
 * candidates the analyzer must detect, never chrome.
 */
const ACCESS_CHROME_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "nav",
  "footer",
  "header",
  "aside",
  "select",
  "textarea",
  "noscript",
  "iframe",
  "svg",
]);

/** Class/id patterns that suggest a lead/summary container, not the full body. */
const LEAD_LIKE_PATTERNS: RegExp[] = [
  /lead/i, /summary/i, /excerpt/i, /standfirst/i, /intro/i,
  /teaser/i, /subtitle/i, /kicker/i, /dek/i, /subhead/i,
  /highlight/i, /key.?point/i, /tldr/i,
];

/**
 * Text patterns that signal the end of article content ("more by", "related", etc.).
 * Used for boundary detection during paragraph extraction.
 */
const END_BOUNDARY_TEXT_PATTERNS: RegExp[] = [
  /^more\s+(by|from|stories|news|on|about)/i,
  /^more\s*$/i,
  /^related\s*(articles?|stories|posts?|content|links?|news)?$/i,
  /^recommended\s*(articles?|stories|posts?|for\s*you)?$/i,
  /^most\s*(read|popular|viewed|shared|commented)/i,
  /^popular\s*(articles?|stories|posts?|now|today)?$/i,
  /^trending\s*(now|today|stories|articles?)?$/i,
  /^latest\s*(news|stories|articles?|updates?)?$/i,
  /^read\s*more$/i,
  /^also\s*read$/i,
  /^see\s*also$/i,
  /^around\s*the\s*web$/i,
  /^you\s*may\s*also\s*(like|enjoy)/i,
  /^from\s*(our|the)\s*(partners?|sponsors?|network)/i,
  /^sponsored\s*(content|stories|by)/i,
  /^top\s*(stories|articles?|news)/i,
  /^elsewhere\s*on\s*\w+/i,
];

/**
 * Class/id patterns that signal article boundary sections.
 * More specific than boilerplate — these are used for ordered extraction
 * to know where article body content definitively ends.
 */
const END_BOUNDARY_CLASS_ID_PATTERNS: RegExp[] = [
  /related/i, /recommended/i, /most.?read/i, /popular/i,
  /trending/i, /more.?stories/i, /more.?articles/i, /more.?from/i,
  /also.?read/i, /see.?also/i, /around.?the.?web/i,
  /newsletter/i, /signup/i, /subscribe/i, /follow.?us/i,
  /social.?share/i, /share.?buttons?/i, /share.?bar/i,
  /comments?/i, /comment.?section/i, /disqus/i,
  /author.?bio/i, /author.?profile/i, /about.?the.?author/i,
  /sidebar/i, /tag.?cloud/i, /topics?$/i,
];

/** Class/id patterns that suggest media/caption sections. */
const CAPTION_LIKE_PATTERNS: RegExp[] = [
  /figcaption/i, /gallery/i, /image.?caption/i, /video.?caption/i,
  /media.?caption/i, /photo.?credit/i,
];

/** CSS selectors for boilerplate/non-article sections to exclude from scoring. */
const BOILERPLATE_SELECTORS = [
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  ".related",
  ".related-posts",
  ".related-articles",
  ".more-stories",
  ".recommended",
  ".newsletter",
  ".signup",
  ".subscribe",
  ".social-share",
  ".share-buttons",
  ".comments",
  ".comment-section",
  ".tag-cloud",
  ".tags",
  ".author-bio",
  ".sidebar",
  ".ad",
  ".advertisement",
  ".sponsored",
];

// NOTE (Prompt 15A): the generic /paywall/i keyword signal list that previously
// lived here has been removed. Authoritative paywall/blocker classification now
// lives in ./article-access-classification.ts. Generic topic words (paywall,
// subscription, premium, ...) and technical access failures (CAPTCHA, robot
// challenge, JS interstitial, ad-blocker warning, access denied) can never
// classify an article as paywalled on their own.

/**
 * Generic text signals that a page is an interstitial, challenge, consent,
 * queue, processing, or otherwise non-final shell rather than an article.
 * Only meaningful when combined with an HTTP 202 status AND the absence of a
 * usable article body — a real article page may contain some of these phrases
 * (e.g. a cookie banner), but never without its body.
 */
const INTERSTITIAL_SIGNAL_PATTERNS: RegExp[] = [
  /checking\s+your\s+browser/i,
  /verify(ing)?\s+(you\s+are|that\s+you\s+are)\s+(human|not\s+a\s+robot)/i,
  /are\s+you\s+a\s+robot/i,
  /captcha/i,
  /attention\s+required/i,
  /please\s+wait\s+(while|for|a\s+moment)/i,
  /you\s+will\s+(be\s+)?redirected/i,
  /redirecting\s+(you|your\s+request)/i,
  /(request|page)\s+(is\s+)?(processing|in\s+queue)/i,
  /before\s+(accessing|proceeding|continuing)/i,
  /powered\s+by\s+(cloudflare|incapsula|imperva)/i,
  /accessing\s+(the\s+)?(site|website|page)/i,
  /your\s+request\s+is\s+very\s+important\s+to\s+us/i,
  /thank\s+you\s+for\s+your\s+patience/i,
  /one\s+moment\s*(please)?/i,
  /just\s+a\s+moment/i,
  /you\s+are\s+being\s+(served|redirected)/i,
  /page\s+is\s+loading/i,
  /loading\s*\.{3}/i,
  /we\s+value\s+your\s+privacy/i,
  /manage\s+(your\s+)?(consent|cookies)/i,
  /accept\s+(all\s+)?cookies/i,
];

/**
 * JSON-LD schema types whose `articleBody` may be trusted as a complete
 * article body. Explicit allow-list: generic traversal must never promote a
 * navigation/consent/metadata object's text to bodyText.
 */
const SUPPORTED_JSONLD_ARTICLE_TYPES: ReadonlySet<string> = new Set([
  "newsarticle",
  "article",
  "reportagenewsarticle",
  "analysisnewsarticle",
]);

// ─── Types ──────────────────────────────────────────────────────────────────

export type ArticleContentExtractionResult =
  | ArticleContentExtractionOk
  | ArticleContentExtractionFail;

export interface ArticleContentExtractionOk {
  ok: true;
  method: "http-dom" | "http-meta" | "browser-dom";
  resolvedUrl: string;
  statusCode: number;
  title: string | null;
  excerpt: string | null;
  bodyText: string | null;
  imageUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  isPaywall: boolean | null;
  confidence: number;
  qualitySignals: string[];
  diagnostics: ExtractionDiagnostics;
  /** URL actually used for the successful transport attempt. */
  transportUrl?: string;
  /** Original article URL before HTTPS-first transport normalization. */
  originalArticleUrl?: string;
  transportAttempts?: ArticleTransportAttempt[];
  /** Structured Agent 3 access classification; bounded and non-sensitive. */
  access?: ArticleAccessClassificationResult;
  rejectedReason?: never;
}

export interface ArticleContentExtractionFail {
  ok: false;
  method: "http-dom" | "http-meta" | "browser-dom" | "none";
  resolvedUrl: string | null;
  statusCode: number | null;
  rejectedReason:
    | "missing_article_url"
    | "fetch_failed"
    | "http_error"
    | "non_html_response"
    | "empty_html"
    | "no_article_text"
    | "too_short"
    | "paywall_or_blocked"
    | "stale_or_invalid"
    | "parse_error"
    | "interstitial_or_challenge";
  detail: string;
  confidence: number;
  qualitySignals: string[];
  diagnostics: ExtractionDiagnostics;
  /** URL actually used for the transport attempt, when known. */
  transportUrl?: string;
  /** Original article URL before HTTPS-first transport normalization. */
  originalArticleUrl?: string;
  transportAttempts?: ArticleTransportAttempt[];
  /** Structured Agent 3 access classification when page analysis reached it. */
  access?: ArticleAccessClassificationResult;
  retryAfterAt?: string | null;
}

export interface ExtractArticleContentInput {
  articleId: number;
  articleUrl: string;
  existingTitle: string;
  existingBodyText?: string | null;
  now?: Date;
  /** Observation-only operation probe; redirects count as one logical attempt. */
  telemetry?: StageBatchProbe;
  /** Optional Prompt 17C context; omitted legacy callers remain ungoverned. */
  governedFetchContext?: import("./governed-fetch").GovernedFetchContext;
  /**
   * Internal recursion guard for the Repair 14 AMP-alternate retry. Never set
   * by external callers — bounds the retry to at most one extra fetch per
   * article and prevents an AMP page's own amphtml link from looping.
   */
  isAmpRetry?: boolean;
}

/** Compact summary of a candidate container for diagnostics. */
export interface TopCandidateSummary {
  selector: string;
  score: number;
  paragraphCount: number;
  textLength: number;
  linkTextRatio: number;
  boilerplatePenalty: number;
  scoreReasons: string[];
  /** Ratio of extracted text length to raw container text length (0..1). */
  textYieldRatio: number;
}

/** Compact diagnostics for audit trails. Never contains raw HTML. */
export interface ExtractionDiagnostics {
  selectedContainerSelector: string | null;
  selectedContainerScore: number | null;
  selectedContainerParagraphCount: number | null;
  selectedContainerTextLength: number | null;
  candidateContainerCount: number;
  bodyRejectedReason: string | null;
  scoreReasons: string[];
  excerptLength: number | null;
  bodyEqualsExcerpt: boolean;
  bodySource: "dom" | "expanded-dom" | "readability" | "jsonld" | "existing-fallback" | "none";
  linkTextRatio: number | null;
  boilerplatePenalty: number | null;
  topCandidates: TopCandidateSummary[];
  usedExpansion: boolean;
  expansionType: "parent" | "siblings" | "parent+siblings" | null;
  leadLikePenaltyApplied: boolean;
  /** Why paragraph collection stopped (null = collected everything). */
  stopReason: string | null;
  /** Number of boundary markers (related/more-by/etc.) found in selected container. */
  boundaryMarkersSeen: number;
  /** Compact text snippet of the element that caused extraction to stop (max 120 chars). */
  stoppedAtText: string | null;
  /** Class/id string of the boundary element that caused extraction to stop (max 160 chars). */
  stoppedAtClassOrId: string | null;
  /** Number of blocks skipped due to boundary/boilerplate detection. */
  excludedBlockCount: number;
  /** Reasons why higher-scoring candidates were skipped (e.g. 'lead_dominated', 'truncated_extraction'). */
  skippedCandidateReasons: string[];
  /** Bounded trimmed HTML length (chars). Only set on failure diagnostics; never raw HTML. */
  htmlLength?: number | null;
  /** Bounded, URL-free browser navigation governance/accounting evidence. */
  browserNavigation?: import("./browser-navigation-governor").BrowserNavigationEvidence;
}

/** Score for a single body candidate container. */
interface CandidateScore {
  element: Element;
  selector: string;
  paragraphs: string[];
  paragraphCount: number;
  totalTextLength: number;
  /** Raw container text length BEFORE stripping boilerplate. */
  rawTextLength: number;
  /** Container text length AFTER stripping boilerplate (before paragraph extraction). */
  cleanedTextLength: number;
  averageParagraphLength: number;
  linkTextRatio: number;
  headingCount: number;
  boilerplatePenalty: number;
  duplicateParagraphCount: number;
  score: number;
  scoreReasons: string[];
  leadLikePenaltyApplied: boolean;
  boundaryMarkerCount: number;
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

interface FetchResult {
  ok: boolean;
  html: string | null;
  statusCode: number;
  contentType: string | null;
  resolvedUrl: string;
  error?: string;
  retryAfterAt?: string | null;
  qualitySignals?: string[];
  transportUrl?: string;
  originalArticleUrl?: string;
  transportAttempts?: ArticleTransportAttempt[];
}

export interface ArticleTransportAttempt {
  protocol: "https" | "http";
  url: string;
  statusCode: number | null;
  outcome: "success" | "http_error" | "fetch_error" | "non_html" | "blocked";
}

function summarizeTransportAttempt(url: string, result: FetchResult): ArticleTransportAttempt {
  const protocol = url.startsWith("https:") ? "https" : "http";
  const outcome: ArticleTransportAttempt["outcome"] = result.ok
    ? "success"
    : result.error?.includes("not eligible")
      ? "blocked"
      : result.statusCode >= 400
        ? "http_error"
        : result.error?.includes("Non-HTML")
          ? "non_html"
          : "fetch_error";
  return { protocol, url, statusCode: result.statusCode || null, outcome };
}

async function fetchArticleHtmlOnce(
  url: string,
  telemetry?: StageBatchProbe,
  governedFetchContext?: import("./governed-fetch").GovernedFetchContext,
): Promise<FetchResult> {
  let fetched: {
    response: Response;
    rawHtml: string | null;
    bodyReadError: string | null;
  };

  try {
    fetched = await governedSafeFetchAndParse(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      telemetry,
    }, governedFetchContext ?? {
      agent: "agent3",
      stage: "article-extraction",
      purpose: "article_extraction",
    }, async (response) => {
      if (response.status < 200 || response.status >= 300) {
        return { response, rawHtml: null, bodyReadError: null };
      }
      try {
        const decoded = await decodeResponseText(response, {
          kind: "html",
          maxBytes: MAX_HTML_BYTES,
          overflow: "truncate",
        });
        return {
          response,
          rawHtml: decoded.text,
          bodyReadError: null,
        };
      } catch (error: unknown) {
        return {
          response,
          rawHtml: null,
          bodyReadError: `Body read failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  } catch (err: unknown) {
    // Governance deferral is a neutral retry boundary. Do not convert it into
    // fetch_failed: Agent 3 must not persist a publisher/network failure or
    // become eligible for browser fallback because the governor deferred work.
    if (err instanceof GovernedFetchDeferredError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      html: null,
      statusCode: 0,
      contentType: null,
      resolvedUrl: url,

      error: `Fetch failed: ${message}`,
    };
  }

  const { response, rawHtml, bodyReadError } = fetched;
  const contentType = response.headers.get("content-type");
  const resolvedUrl = response.url || url;
  const statusCode = response.status;

  if (statusCode < 200 || statusCode >= 300) {
    return {
      ok: false,
      html: null,
      statusCode,
      contentType,
      resolvedUrl,

      error: `HTTP ${statusCode}`,
      retryAfterAt: parseRetryAfter(response.headers.get("retry-after")),
    };
  }

  const isHtmlLike =
    (contentType && HTML_CONTENT_TYPE_HINTS.some((hint) => contentType.toLowerCase().includes(hint))) ||
    false;

  if (bodyReadError) {
    return {
      ok: false,
      html: null,
      statusCode,
      contentType,
      resolvedUrl,

      error: bodyReadError,
    };
  }

  // Accept HTML even if content-type is missing/wrong, as long as it looks like HTML
  if (rawHtml === null || (!isHtmlLike && !looksLikeHtml(rawHtml))) {
    return {
      ok: false,
      html: null,
      statusCode,
      contentType,
      resolvedUrl,

      error: `Non-HTML content-type: ${contentType}`,
    };
  }

  return {
    ok: true,
    html: rawHtml,
    statusCode,
    contentType,
    resolvedUrl,

  };
}

/**
 * Use HTTPS first for an HTTP article URL. Each attempt calls the governed
 * transport independently; the optional HTTP retry is host-allowlisted and
 * never carries credentials or cookies.
 */
async function fetchArticleHtml(
  url: string,
  telemetry?: StageBatchProbe,
  governedFetchContext?: import("./governed-fetch").GovernedFetchContext,
): Promise<FetchResult & { transportUrl?: string; originalArticleUrl?: string }> {
  const httpsUrl = getHttpsArticleUrl(url);
  if (!httpsUrl) {
    // An HTTP URL that cannot be safely promoted must not silently become a
    // direct HTTP request, even when a hostname allowlist is configured.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:") {
        return {
          ok: false,
          html: null,
          statusCode: 0,
          contentType: null,
          resolvedUrl: url,
          transportUrl: url,
          originalArticleUrl: url,
          error: "HTTP URL is not eligible for HTTPS-first transport",
          transportAttempts: [{ protocol: "http", url, statusCode: null, outcome: "blocked" }],
        };
      }
    } catch {
      // Preserve the normal governed failure path for malformed URLs.
    }
    const result = await fetchArticleHtmlOnce(url, telemetry, governedFetchContext);
    return { ...result, transportUrl: url, originalArticleUrl: url, transportAttempts: [summarizeTransportAttempt(url, result)] };
  }

  const httpsResult = await fetchArticleHtmlOnce(httpsUrl, telemetry, governedFetchContext);
  if (httpsResult.ok || !isExplicitHttpFallbackAllowed(url)) {
    return {
      ...httpsResult,
      transportUrl: httpsUrl,
      originalArticleUrl: url,
      transportAttempts: [summarizeTransportAttempt(httpsUrl, httpsResult)],
      qualitySignals: [...(httpsResult.qualitySignals || []), "https_first"],
    };
  }

  const httpResult = await fetchArticleHtmlOnce(url, telemetry, governedFetchContext);
  return {
    ...httpResult,
    transportUrl: url,
    originalArticleUrl: url,
    transportAttempts: [summarizeTransportAttempt(httpsUrl, httpsResult), summarizeTransportAttempt(url, httpResult)],
    qualitySignals: [
      ...(httpResult.qualitySignals || []),
      "https_first_failed",
      "http_fallback_used",
    ],
  };
}

function looksLikeHtml(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<") &&
    (trimmed.includes("<html") || trimmed.includes("<body") || trimmed.includes("<head") || trimmed.includes("<!DOCTYPE"))
  );
}

// ─── Meta / JSON-LD Extraction ──────────────────────────────────────────────

function getMetaContent(doc: Document, ...selectors: string[]): string | null {
  for (const selector of selectors) {
    try {
      const el = doc.querySelector(selector);
      if (el) {
        const content = el.getAttribute("content") || el.getAttribute("value") || el.textContent || "";
        const trimmed = content.trim();
        if (trimmed) return trimmed;
      }
    } catch {
      // Invalid selector; skip
    }
  }
  return null;
}

function extractCanonicalUrl(doc: Document, resolvedUrl: string): string {
  const canonical =
    getMetaContent(doc, 'link[rel="canonical"]') ||
    getMetaContent(doc, 'meta[property="og:url"]', 'meta[name="og:url"]');
  if (canonical) {
    try {
      return new URL(canonical, resolvedUrl).toString();
    } catch {
      return resolvedUrl;
    }
  }
  return resolvedUrl;
}

function extractTitle(doc: Document, existingTitle: string): { title: string | null; source: string } {
  const ogTitle = getMetaContent(doc, 'meta[property="og:title"]', 'meta[name="og:title"]');
  if (ogTitle) return { title: ogTitle, source: "meta" };

  const twitterTitle = getMetaContent(doc, 'meta[name="twitter:title"]', 'meta[property="twitter:title"]');
  if (twitterTitle) return { title: twitterTitle, source: "meta" };

  // JSON-LD headline
  const jsonLdTitle = extractJsonLdField(doc, "headline");
  if (jsonLdTitle) return { title: jsonLdTitle, source: "meta" };

  // h1
  try {
    const h1 = doc.querySelector("h1");
    if (h1?.textContent?.trim()) return { title: h1.textContent.trim(), source: "dom" };
  } catch { /* skip */ }

  // document.title
  if (doc.title?.trim()) return { title: doc.title.trim(), source: "dom" };

  // Existing article title
  if (existingTitle?.trim()) return { title: existingTitle.trim(), source: "unchanged" };

  return { title: null, source: "none" };
}

function extractExcerpt(doc: Document): string | null {
  return (
    getMetaContent(doc, 'meta[name="description"]') ||
    getMetaContent(doc, 'meta[property="og:description"]', 'meta[name="og:description"]') ||
    getMetaContent(doc, 'meta[name="twitter:description"]', 'meta[property="twitter:description"]') ||
    null
  );
}

function extractImageUrl(doc: Document): string | null {
  return (
    getMetaContent(doc, 'meta[property="og:image"]', 'meta[name="og:image"]') ||
    getMetaContent(doc, 'meta[name="twitter:image"]', 'meta[property="twitter:image"]') ||
    null
  );
}

function extractAuthor(doc: Document): string | null {
  const metaAuthor =
    getMetaContent(doc, 'meta[name="author"]') ||
    getMetaContent(doc, 'meta[property="article:author"]', 'meta[name="article:author"]');
  if (metaAuthor) return metaAuthor;

  const jsonLdAuthor = extractJsonLdField(doc, "author");
  if (jsonLdAuthor) return jsonLdAuthor;

  return null;
}

function extractPublishedAt(doc: Document): string | null {
  // JSON-LD datePublished/dateModified
  const jsonLdDate = extractJsonLdField(doc, "datePublished") || extractJsonLdField(doc, "dateModified");
  if (jsonLdDate) return normalizeDateString(jsonLdDate);

  // article:published_time
  const metaDate =
    getMetaContent(doc, 'meta[property="article:published_time"]', 'meta[name="article:published_time"]') ||
    getMetaContent(doc, 'meta[property="og:updated_time"]') ||
    getMetaContent(doc, 'meta[property="article:modified_time"]');
  if (metaDate) return normalizeDateString(metaDate);

  // time[datetime]
  try {
    const timeEl = doc.querySelector("time[datetime]");
    if (timeEl?.getAttribute("datetime")) {
      return normalizeDateString(timeEl.getAttribute("datetime")!);
    }
  } catch { /* skip */ }

  return null;
}

function normalizeDateString(raw: string): string | null {
  try {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

// ─── JSON-LD Helpers ────────────────────────────────────────────────────────

function extractJsonLdField(doc: Document, field: string): string | null {
  try {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      const text = script.textContent?.trim();
      if (!text) continue;

      const parsed = JSON.parse(text);
      const value = walkJsonForField(parsed, field);
      if (typeof value === "string" && value.trim()) return value.trim();

      // Handle @graph arrays
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const v = walkJsonForField(item, field);
          if (typeof v === "string" && v.trim()) return v.trim();
        }
      }
    }
  } catch {
    // Malformed JSON-LD; skip
  }
  return null;
}

/**
 * Decode common HTML entities and numeric character references safely.
 * Used for JSON-LD `articleBody` values that may contain escaped markup.
 */
function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&apos;": "'",
    "&nbsp;": " ",
    "&hellip;": "…",
    "&mdash;": "—",
    "&ndash;": "–",
    "&rsquo;": "'",
    "&lsquo;": "'",
    "&ldquo;": "\"",
    "&rdquo;": "\"",
  };
  const codePoint = (n: number): string =>
    Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  return text
    .replace(/&#(\d+);/g, (_, raw) => codePoint(Number(raw)))
    .replace(/&#x([0-9a-f]+);/gi, (_, raw) => codePoint(parseInt(raw, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|rsquo|lsquo|ldquo|rdquo);/gi, (match, name: string) => {
      return named[`&${name.toLowerCase()};`] ?? match;
    });
}

/**
 * Normalize a JSON-LD `articleBody` value: decode entities, strip tags,
 * collapse whitespace, remove boilerplate lines, and cap to the storage bound.
 * Returns null when nothing meaningful remains.
 */
function normalizeJsonLdBodyText(raw: string): string | null {
  const decoded = decodeHtmlEntities(raw);
  const withoutTags = decoded.replace(/<[^>]*>/g, " ");
  const normalized = normalizeExtractedText(withoutTags);
  if (!normalized) return null;
  return capBodyText(normalized);
}

/**
 * Whether a JSON-LD object declares a supported article schema type.
 * `@type` may be a string or an array of strings.
 */
function isJsonLdArticleObject(record: Record<string, unknown>): boolean {
  return getJsonLdTypes(record["@type"]).some((t) => SUPPORTED_JSONLD_ARTICLE_TYPES.has(t.toLowerCase()));
}

/**
 * Collect all JSON-LD objects (recursively, including @graph and arrays,
 * bounded by the shared structured-data authority's depth/count/array-length
 * limits) that declare a supported article schema type.
 */
function collectJsonLdArticleObjects(value: unknown): Array<Record<string, unknown>> {
  return collectMatchingObjects(value, isJsonLdArticleObject);
}

/**
 * Extract a complete `articleBody` from supported Article/NewsArticle JSON-LD
 * objects. Returns the longest normalized candidate that survives the same
 * bounded-length normalization used for DOM text. Never reads `description`,
 * `excerpt`, or navigation/consent objects — only the explicit `articleBody`
 * field of a supported article schema. Returns null when unavailable.
 */
function extractJsonLdArticleBody(doc: Document): string | null {
  try {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    let best: string | null = null;
    for (const script of scripts) {
      const text = script.textContent?.trim();
      if (!text) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // malformed JSON-LD → skip, never treat as article body
      }
      for (const obj of collectJsonLdArticleObjects(parsed)) {
        const raw = obj.articleBody;
        if (typeof raw !== "string" || raw.trim().length === 0) continue;
        const normalized = normalizeJsonLdBodyText(raw);
        if (!normalized) continue;
        if (!best || normalized.length > best.length) best = normalized;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Generic interstitial/challenge heuristic. Only called for HTTP 202 responses
 * that already failed to produce a usable article body, so a normal article
 * page (even one with a consent banner) cannot be misclassified here.
 */
function isLikelyInterstitialPage(rawPageText: string, doc: Document): boolean {
  const title = doc.title?.trim() || "";
  const haystack = title ? `${title}\n${rawPageText}` : rawPageText;
  return INTERSTITIAL_SIGNAL_PATTERNS.some((pattern) => pattern.test(haystack));
}

function walkJsonForField(obj: unknown, field: string): unknown {
  if (!obj || typeof obj !== "object") return null;

  const record = obj as Record<string, unknown>;

  // Direct field match
  if (field in record) {
    const val = record[field];
    // Handle author.name pattern
    if (field === "author" && typeof val === "object" && val !== null) {
      const authorObj = val as Record<string, unknown>;
      if (typeof authorObj.name === "string") return authorObj.name;
      // Handle array of authors
      if (Array.isArray(val) && val.length > 0) {
        const first = val[0];
        if (typeof first === "string") return first;
        if (typeof first === "object" && first !== null && typeof (first as Record<string, unknown>).name === "string") {
          return (first as Record<string, unknown>).name;
        }
      }
    }
    if (typeof val === "string") return val;
  }

  // Recurse into nested objects
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const found = walkJsonForField(value, field);
      if (found !== null && found !== undefined) return found;
    }
  }

  return null;
}

// ─── Body Text Extraction — Multi-Candidate Scoring ─────────────────────────

/**
 * Strip non-content elements from a container by removing tags whose
 * nodeName matches entries in STRIP_TAGS and boilerplate sections.
 * Works in-place on a cloned element.
 */
function stripNonContentElements(container: Element): void {
  for (const tag of STRIP_TAGS) {
    try {
      const elements = container.querySelectorAll(tag);
      for (let i = elements.length - 1; i >= 0; i--) {
        elements[i]?.remove();
      }
    } catch {
      // Invalid tag name; skip
    }
  }
  // Remove boilerplate sections
  for (const sel of BOILERPLATE_SELECTORS) {
    try {
      const elements = container.querySelectorAll(sel);
      for (let i = elements.length - 1; i >= 0; i--) {
        elements[i]?.remove();
      }
    } catch {
      // Invalid selector; skip
    }
  }
}

function measureContainerText(element: Element): {
  rawTextLength: number;
  cleanedTextLength: number;
} {
  const rawTextLength = (element.textContent || "").trim().length;
  const clone = element.cloneNode(true) as Element;
  stripNonContentElements(clone);
  return {
    rawTextLength,
    cleanedTextLength: (clone.textContent || "").trim().length,
  };
}

/**
 * Compute the ratio of link text to total text in a container.
 * High link-text ratio suggests navigation/related sections.
 */
function computeLinkTextRatio(container: Element): number {
  try {
    const links = container.querySelectorAll("a");
    let linkTextLength = 0;
    for (const link of links) {
      linkTextLength += (link.textContent || "").trim().length;
    }
    const totalText = (container.textContent || "").trim().length;
    if (totalText === 0) return 0;
    return linkTextLength / totalText;
  } catch {
    return 0;
  }
}

/**
 * Count headings (h1-h6) in a container.
 */
function countHeadings(container: Element): number {
  try {
    return container.querySelectorAll("h1, h2, h3, h4, h5, h6").length;
  } catch {
    return 0;
  }
}

/**
 * Compute a boilerplate penalty based on boilerplate-like content density.
 */
function computeBoilerplatePenalty(paragraphs: string[]): number {
  let penalty = 0;
  const boilerplatePatterns = [
    /^(share|tweet|pin|email|print|subscribe|sign up|follow us)/i,
    /^(related articles?|more (from|stories|news)|you may also like)/i,
    /^(advertisement|sponsored|promoted)/i,
    /^(©|copyright|all rights reserved)/i,
    /^(click here|read more|continue reading|load more)/i,
    /^(loading|please wait)/i,
    /^(cookie|privacy policy|terms of (use|service))/i,
  ];

  for (const para of paragraphs) {
    if (boilerplatePatterns.some((p) => p.test(para.trim()))) {
      penalty += 0.1;
    }
  }
  return Math.min(penalty, 1);
}

/**
 * Check if an element's class/id matches lead-like patterns.
 */
function isLeadLikeContainer(element: Element): boolean {
  try {
    const cls = element.getAttribute("class") || "";
    const id = element.getAttribute("id") || "";
    const combined = `${cls} ${id}`;
    return LEAD_LIKE_PATTERNS.some((p) => p.test(combined));
  } catch {
    return false;
  }
}

/**
 * Detect if an element marks the end of article content.
 * Checks text patterns, class/id patterns, and structural indicators.
 * Designed to be conservative: won't flag normal article section headings
 * that happen to contain words like "related" in a longer sentence.
 */
function isArticleEndBoundaryElement(el: Element): boolean {
  try {
    const tag = el.tagName.toLowerCase();
    const cls = el.getAttribute("class") || "";
    const id = el.getAttribute("id") || "";
    const combined = `${cls} ${id}`;

    // 1. Class/id patterns are the strongest signal
    if (END_BOUNDARY_CLASS_ID_PATTERNS.some((p) => p.test(combined))) return true;

    // 2. role="complementary" (sidebar), role="navigation" (nav)
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "complementary" || role === "navigation") return true;

    // 3. <aside> elements are always boundary
    if (tag === "aside") return true;

    // 4. Headings (h2-h6) with boundary text patterns
    if (tag.length === 2 && tag[0] === "h" && tag >= "h2" && tag <= "h6") {
      const text = (el.textContent || "").trim();
      if (text.length > 0 && text.length < 80 &&
          END_BOUNDARY_TEXT_PATTERNS.some((p) => p.test(text))) {
        return true;
      }
    }

    // 5. Very short text with boundary keywords (but not inside normal content)
    if (tag !== "p" && tag !== "div" && tag !== "section" && tag !== "article") {
      const text = (el.textContent || "").trim();
      if (text.length > 0 && text.length < 60 &&
          END_BOUNDARY_TEXT_PATTERNS.some((p) => p.test(text))) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if an element or any of its ancestors is a boundary section.
 * Stops at body to avoid unnecessary traversal.
 */
function isInsideBoundarySection(el: Element): boolean {
  try {
    let current: Element | null = el;
    while (current && current.tagName.toLowerCase() !== "body") {
      if (isArticleEndBoundaryElement(current)) return true;
      current = current.parentElement;
    }
  } catch { /* skip */ }
  return false;
}

/**
 * Check if an element is boilerplate (nav/share/author/etc.) that should be
 * skipped during ordered collection (not a hard stop, just skip this element).
 */
function isSkippableNonContentElement(el: Element): boolean {
  try {
    const tag = el.tagName.toLowerCase();
    if (STRIP_TAGS.includes(tag)) return true;

    const cls = el.getAttribute("class") || "";
    const id = el.getAttribute("id") || "";
    const combined = `${cls} ${id}`;
    const skipPatterns = [
      /byline/i, /author.?info/i, /publish.?date/i, /article.?date/i,
      /share/i, /social.?bar/i, /bookmark/i,
      /image.?caption/i, /photo.?credit/i, /figcaption/i,
      /newsletter/i, /signup/i,
    ];
    if (skipPatterns.some((p) => p.test(combined))) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if an element's class/id matches caption/media patterns.
 */
function isCaptionLikeContainer(element: Element): boolean {
  try {
    const cls = element.getAttribute("class") || "";
    const id = element.getAttribute("id") || "";
    const tag = element.tagName.toLowerCase();
    const combined = `${tag} ${cls} ${id}`;
    return CAPTION_LIKE_PATTERNS.some((p) => p.test(combined));
  } catch {
    return false;
  }
}

/**
 * Compute word-overlap ratio between two strings (0..1).
 */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size < 3 || wordsB.size < 3) return 0;
  let overlap = 0;
  for (const w of wordsB) {
    if (wordsA.has(w)) overlap++;
  }
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/**
 * Check if paragraphs are mostly bullet/list items that are very short.
 */
function isBulletOnlySummary(paragraphs: string[], element: Element): boolean {
  if (paragraphs.length < 2) return false;
  try {
    const lis = element.querySelectorAll("li");
    const ps = element.querySelectorAll("p");
    // Mostly list items, few paragraphs
    if (lis.length > 3 && lis.length > ps.length * 2) {
      const avgLiLen = Array.from(lis).reduce((sum, li) => sum + (li.textContent || "").trim().length, 0) / lis.length;
      if (avgLiLen < 100) return true;
    }
  } catch { /* skip */ }
  return false;
}

/**
 * Count how many child/descendant elements look like article end boundaries.
 * Used to penalize broad parent containers that include post-article sections.
 */
function countBoundaryMarkersInElement(el: Element): number {
  let count = 0;
  try {
    const children = el.querySelectorAll("h2, h3, h4, h5, h6, div, section, aside");
    for (const child of children) {
      if (isArticleEndBoundaryElement(child)) count++;
    }
  } catch { /* skip */ }
  return count;
}

/**
 * Score a candidate body container.
 * Returns a CandidateScore with detailed metrics.
 *
 * Enhanced scoring:
 *  - Strongly rewards paragraphCount >= 4 and totalTextLength >= 1200
 *  - Penalizes lead/summary-only containers by class/id
 *  - Penalizes bullet-only summaries
 *  - Penalizes media/caption sections
 *  - Penalizes containers similar to excerpt/meta description
 *  - Rewards average paragraph length between 80 and 800
 */
function scoreCandidate(
  element: Element,
  selector: string,
  doc: Document,
  excerpt?: string | null,
): CandidateScore | null {
  // Clone to avoid mutating original
  const clone = element.cloneNode(true) as Element;
  const { rawTextLength, cleanedTextLength } = measureContainerText(element);
  stripNonContentElements(clone);

  const paragraphs = extractMeaningfulParagraphs(clone);
  if (paragraphs.length === 0) return null;

  const paragraphCount = paragraphs.length;
  const totalTextLength = paragraphs.reduce((sum, p) => sum + p.length, 0);
  const averageParagraphLength = totalTextLength / paragraphCount;
  const linkTextRatio = computeLinkTextRatio(clone);
  const headingCount = countHeadings(clone);
  const boilerplatePenalty = computeBoilerplatePenalty(paragraphs);

  // Count duplicate paragraphs
  const seen = new Set<string>();
  let duplicateParagraphCount = 0;
  for (const para of paragraphs) {
    const normalized = para.trim().toLowerCase();
    if (seen.has(normalized)) {
      duplicateParagraphCount++;
    } else {
      seen.add(normalized);
    }
  }

  // Detect lead-like and caption-like containers
  const isLeadLike = isLeadLikeContainer(element);
  const isCaptionLike = isCaptionLikeContainer(element);
  const isBulletOnly = isBulletOnlySummary(paragraphs, element);

  // Compute excerpt similarity
  const excerptSimilarity = excerpt ? wordOverlap(paragraphs.join(" "), excerpt) : 0;

  // Compute composite score
  let score = 0;
  const scoreReasons: string[] = [];
  let leadLikePenaltyApplied = false;

  // Paragraph count: strong signal — reward more aggressively for rich bodies
  if (paragraphCount >= 8) { score += 35; scoreReasons.push("many_paragraphs"); }
  else if (paragraphCount >= 5) { score += 28; scoreReasons.push("good_paragraphs"); }
  else if (paragraphCount >= 4) { score += 22; scoreReasons.push("adequate_paragraphs"); }
  else if (paragraphCount >= 3) { score += 15; scoreReasons.push("some_paragraphs"); }
  else if (paragraphCount >= 2) { score += 8; scoreReasons.push("few_paragraphs"); }
  else { score += 2; scoreReasons.push("single_paragraph"); }

  // Total text length: prefer rich content
  if (totalTextLength >= 3000) { score += 30; scoreReasons.push("long_text"); }
  else if (totalTextLength >= 1500) { score += 24; scoreReasons.push("medium_text"); }
  else if (totalTextLength >= 1200) { score += 18; scoreReasons.push("adequate_text"); }
  else if (totalTextLength >= 800) { score += 12; scoreReasons.push("short_text"); }
  else if (totalTextLength >= 400) { score += 5; scoreReasons.push("very_short_text"); }

  // Average paragraph length: prefer 80-800 char paragraphs
  if (averageParagraphLength >= 80 && averageParagraphLength <= 800) {
    score += 10;
    scoreReasons.push("good_avg_para_length");
  } else if (averageParagraphLength > 800) {
    score += 5;
    scoreReasons.push("long_avg_para");
  }

  // Semantic container bonus
  const semanticSelectors = ["article", "main article", '[itemprop="articleBody"]', '[property="articleBody"]'];
  if (semanticSelectors.some((s) => selector.includes(s.replace(/[[\]"]/g, "")))) {
    score += 15;
    scoreReasons.push("semantic_container");
  }

  // Penalize lead/summary-like containers strongly
  if (isLeadLike) {
    score -= 20;
    scoreReasons.push("lead_like_container");
    leadLikePenaltyApplied = true;
  }

  // Penalize caption/media sections
  if (isCaptionLike) {
    score -= 15;
    scoreReasons.push("caption_like_container");
  }

  // Penalize bullet-only summaries
  if (isBulletOnly) {
    score -= 15;
    scoreReasons.push("bullet_only_summary");
  }

  // Penalize containers similar to excerpt (likely summary, not full body)
  if (excerptSimilarity > 0.8 && totalTextLength < 2000) {
    score -= 20;
    scoreReasons.push("high_excerpt_similarity");
  } else if (excerptSimilarity > 0.6 && totalTextLength < 1500) {
    score -= 10;
    scoreReasons.push("moderate_excerpt_similarity");
  }

  // Penalize high link text ratio (navigation, related posts)
  if (linkTextRatio > 0.5) { score -= 20; scoreReasons.push("high_link_ratio"); }
  else if (linkTextRatio > 0.3) { score -= 10; scoreReasons.push("moderate_link_ratio"); }

  // Penalize boilerplate content
  if (boilerplatePenalty > 0.3) { score -= 15; scoreReasons.push("high_boilerplate"); }
  else if (boilerplatePenalty > 0.1) { score -= 5; scoreReasons.push("some_boilerplate"); }

  // Penalize duplicate paragraphs
  if (duplicateParagraphCount > 2) { score -= 10; scoreReasons.push("many_duplicates"); }
  else if (duplicateParagraphCount > 0) { score -= 3; scoreReasons.push("some_duplicates"); }

  // Penalize too many headings relative to paragraphs (likely a section listing)
  if (headingCount > 0 && paragraphCount > 0 && headingCount / paragraphCount > 0.5) {
    score -= 8;
    scoreReasons.push("high_heading_ratio");
  }

  // Penalize containers that contain boundary markers (related/more-by/etc.)
  // This penalizes broad parent containers that include post-article content.
  const boundaryMarkerCount = countBoundaryMarkersInElement(element);
  if (boundaryMarkerCount >= 3) { score -= 15; scoreReasons.push("many_boundary_markers"); }
  else if (boundaryMarkerCount >= 1) { score -= 8; scoreReasons.push("some_boundary_markers"); }

  // Penalize low text yield: extracted text is much less than raw container text.
  // This catches containers where boundary/boilerplate detection stopped too early
  // or where only a lead portion was captured from a larger container.
  const textYieldRatio = rawTextLength > 0 ? totalTextLength / rawTextLength : 1;
  if (rawTextLength > 1000 && textYieldRatio < 0.3) {
    score -= 25;
    scoreReasons.push("low_text_yield");
  } else if (rawTextLength > 800 && textYieldRatio < 0.4) {
    score -= 15;
    scoreReasons.push("moderate_low_text_yield");
  }

  // Penalize lead-dominant patterns: first paragraph is much shorter than average,
  // suggesting the container opens with a credit/byline/teaser that could dominate.
  if (paragraphCount >= 2) {
    const firstParaLen = paragraphs[0]!.length;
    const avgLen = averageParagraphLength;
    if (firstParaLen < avgLen * 0.3 && firstParaLen < 200 && totalTextLength < 2000) {
      score -= 12;
      scoreReasons.push("lead_dominant_opening");
    }
  }

  return {
    element,
    selector,
    paragraphs,
    paragraphCount,
    totalTextLength,
    rawTextLength,
    cleanedTextLength,
    averageParagraphLength,
    linkTextRatio,
    headingCount,
    boilerplatePenalty,
    duplicateParagraphCount,
    score: Math.max(0, score),
    scoreReasons,
    leadLikePenaltyApplied,
    boundaryMarkerCount,
  };
}

/**
 * Collect and score all body container candidates from the document.
 * Returns candidates sorted by score descending.
 * Passes excerpt for similarity-aware scoring.
 */
function collectAndScoreCandidates(doc: Document, excerpt?: string | null): CandidateScore[] {
  // Priority semantic selectors
  const semanticSelectors = [
    "article",
    "main article",
    '[itemprop="articleBody"]',
    '[property="articleBody"]',
    ".article-body",
    ".article__body",
    ".article-content",
    ".article__content",
    ".entry-content",
    ".post-content",
    ".post__content",
    ".content",
    "main",
  ];

  const candidates: CandidateScore[] = [];
  const seenElements = new Set<Element>();

  // Score semantic containers first
  for (const selector of semanticSelectors) {
    try {
      const elements = doc.querySelectorAll(selector);
      for (const el of elements) {
        if (seenElements.has(el)) continue;
        seenElements.add(el);
        const scored = scoreCandidate(el, selector, doc, excerpt);
        if (scored && scored.paragraphCount > 0) {
          candidates.push(scored);
        }
      }
    } catch {
      // Invalid selector; skip
    }
  }

  // Also score div/section containers that might contain articles
  try {
    const genericContainers = doc.querySelectorAll("div, section");
    for (const el of genericContainers) {
      if (seenElements.has(el)) continue;
      // Only consider containers with reasonable text content
      const textLen = (el.textContent || "").trim().length;
      if (textLen < 200) continue;
      seenElements.add(el);
      const scored = scoreCandidate(el, "div/section", doc, excerpt);
      if (scored && scored.paragraphCount >= 2) {
        candidates.push(scored);
      }
    }
  } catch { /* skip */ }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
/** Non-article sibling tags to skip during expansion. */
const NON_ARTICLE_SIBLING_TAGS = new Set(["nav", "footer", "header", "aside", "form", "script", "style", "noscript"]);

/**
 * Try parent/sibling expansion for a thin candidate.
 * If the best candidate has only 1-2 paragraphs or less than the usable
 * threshold, try:
 * 1. Parent expansion (go up 2 levels)
 * 2. Sibling paragraph collection (before and after)
 * 3. Stop before related/footer/sidebar/comment blocks
 * Re-score the expanded version and return if it improves.
 *
 * Returns a tuple of [candidate, expansionType].
 */
function tryExpandCandidate(
  best: CandidateScore,
  doc: Document,
  excerpt?: string | null,
): [CandidateScore, "parent" | "siblings" | "parent+siblings" | null] {
  if (best.paragraphCount >= 4 && best.totalTextLength >= 1200) {
    return [best, null]; // Already good enough — don't expand
  }

  let expanded = best;
  let usedParent = false;
  let usedSiblings = false;

  // Try parent expansion (up to 2 levels)
  let parent = best.element.parentElement;
  for (let depth = 0; depth < 2 && parent; depth++) {
    const tag = parent.tagName.toLowerCase();
    if (tag === "body" || tag === "html") break;

    // Stop if parent is a boilerplate section
    const parentCls = (parent.getAttribute("class") || "").toLowerCase();
    const parentId = (parent.getAttribute("id") || "").toLowerCase();
    if (/related|footer|sidebar|comment|newsletter|signup|share/.test(`${parentCls} ${parentId}`)) break;

    const parentScored = scoreCandidate(parent, `${best.selector}+parent`, doc, excerpt);
    if (parentScored && parentScored.score > expanded.score && parentScored.paragraphCount > expanded.paragraphCount) {
      expanded = parentScored;
      usedParent = true;
    }
    parent = parent.parentElement;
  }

  // Try sibling expansion: collect article-like paragraphs from siblings
  // before AND after the selected container. Stop at boilerplate boundaries.
  if (expanded.paragraphCount < 4 || expanded.totalTextLength < 1200) {
    const siblings: string[] = [...expanded.paragraphs];
    const seen = new Set(siblings.map((s) => s.trim().toLowerCase()));
    const includedSiblingElements = new Set<Element>();

    const containerParent = expanded.element.parentElement;
    if (containerParent) {
      const children = Array.from(containerParent.children);
      const elementIndex = children.indexOf(expanded.element);

      // Collect siblings AFTER the selected container first (body typically follows lead)
      for (let i = elementIndex + 1; i < children.length; i++) {
        const sibling = children[i];
        if (!sibling) continue;

        const siblingTag = sibling.tagName.toLowerCase();
        if (NON_ARTICLE_SIBLING_TAGS.has(siblingTag)) break; // stop at boilerplate

        // Stop at boundary markers (related/more-by/most-read/etc.)
        if (isArticleEndBoundaryElement(sibling)) break;

        // Check class/id for boilerplate patterns — stop if we hit related/footer/etc.
        const sibCls = (sibling.getAttribute("class") || "").toLowerCase();
        const sibId = (sibling.getAttribute("id") || "").toLowerCase();
        if (/related|footer|sidebar|comment|newsletter|signup|share|tag-cloud/.test(`${sibCls} ${sibId}`)) break;

        const siblingClone = sibling.cloneNode(true) as Element;
        stripNonContentElements(siblingClone);

        const siblingParagraphs = extractMeaningfulParagraphs(siblingClone);
        let addedParagraph = false;
        for (const para of siblingParagraphs) {
          const normalized = para.trim().toLowerCase();
          if (!seen.has(normalized)) {
            seen.add(normalized);
            siblings.push(para);
            addedParagraph = true;
          }
        }
        if (addedParagraph) includedSiblingElements.add(sibling);
      }

      // Also collect siblings BEFORE the container (some layouts have content above)
      for (let i = elementIndex - 1; i >= 0; i--) {
        const sibling = children[i];
        if (!sibling) continue;

        const siblingTag = sibling.tagName.toLowerCase();
        if (NON_ARTICLE_SIBLING_TAGS.has(siblingTag)) break;

        // Stop at boundary markers
        if (isArticleEndBoundaryElement(sibling)) break;

        const sibCls = (sibling.getAttribute("class") || "").toLowerCase();
        const sibId = (sibling.getAttribute("id") || "").toLowerCase();
        if (/related|footer|sidebar|comment|newsletter|signup|share|tag-cloud/.test(`${sibCls} ${sibId}`)) break;

        // Skip if it's clearly a lead-like container that is similar to excerpt
        if (isLeadLikeContainer(sibling)) continue;

        const siblingClone = sibling.cloneNode(true) as Element;
        stripNonContentElements(siblingClone);

        const siblingParagraphs = extractMeaningfulParagraphs(siblingClone);
        let addedParagraph = false;
        for (const para of siblingParagraphs) {
          const normalized = para.trim().toLowerCase();
          if (!seen.has(normalized)) {
            seen.add(normalized);
            siblings.push(para);
            addedParagraph = true;
          }
        }
        if (addedParagraph) includedSiblingElements.add(sibling);
      }
    }

    if (siblings.length > expanded.paragraphCount) {
      const totalLen = siblings.reduce((sum, p) => sum + p.length, 0);
      let siblingRawTextLength = 0;
      let siblingCleanedTextLength = 0;
      for (const sibling of includedSiblingElements) {
        const measured = measureContainerText(sibling);
        siblingRawTextLength += measured.rawTextLength;
        siblingCleanedTextLength += measured.cleanedTextLength;
      }
      const expandedCandidate: CandidateScore = {
        ...expanded,
        paragraphs: siblings,
        paragraphCount: siblings.length,
        totalTextLength: totalLen,
        rawTextLength: expanded.rawTextLength + siblingRawTextLength,
        cleanedTextLength: expanded.cleanedTextLength + siblingCleanedTextLength,
        averageParagraphLength: totalLen / siblings.length,
        score: expanded.score + (siblings.length - expanded.paragraphCount) * 5,
        scoreReasons: [...expanded.scoreReasons, "sibling_expansion"],
        leadLikePenaltyApplied: expanded.leadLikePenaltyApplied,
        // Preserve boundary marker count from pre-expansion candidate.
        // Recalculating on containerParent would overcount since expansion
        // may have narrowed the effective content scope.
        boundaryMarkerCount: expanded.boundaryMarkerCount,
      };

      // Only accept if it meaningfully improves
      if (expandedCandidate.paragraphCount > expanded.paragraphCount &&
          expandedCandidate.totalTextLength > expanded.totalTextLength * 1.2) {
        expanded = expandedCandidate;
        usedSiblings = true;
      }
    }
  }

  const expansionType = usedParent && usedSiblings ? "parent+siblings"
    : usedParent ? "parent"
    : usedSiblings ? "siblings"
    : null;

  return [expanded, expansionType];
}

/**
 * Main body extraction: collect candidates, score, expand, select best.
 * Passes excerpt for similarity-aware scoring.
 */
interface BodyExtractionResult {
  text: string;
  method: "dom";
  selector: string;
  score: CandidateScore;
  bodySource: "dom" | "expanded-dom" | "readability";
  candidateContainerCount: number;
  topCandidates: TopCandidateSummary[];
  usedExpansion: boolean;
  expansionType: "parent" | "siblings" | "parent+siblings" | null;
  /** Why extraction stopped (null = collected all available content). */
  stopReason: string | null;
  /** Compact text of the boundary element that caused stop. */
  stoppedAtText: string | null;
  /** Class/id of the boundary element. */
  stoppedAtClassOrId: string | null;
  /** Number of blocks excluded by boundary/boilerplate detection. */
  excludedBlockCount: number;
  /** Reasons why higher-scoring candidates were skipped (e.g. 'lead_dominated', 'truncated_extraction'). */
  skippedCandidateReasons: string[];
}

/** Result returned when all candidates fail sanity checks. */
interface BodyExtractionDiagnosticsOnly {
  __diagnosticsOnly: true;
  topCandidates: TopCandidateSummary[];
  skippedCandidateReasons: string[];
  candidateContainerCount: number;
}

function extractBodyText(doc: Document, excerpt?: string | null): BodyExtractionResult | BodyExtractionDiagnosticsOnly | null {
  const candidates = collectAndScoreCandidates(doc, excerpt);

  if (candidates.length === 0) return null;

  // Build top candidate summaries for diagnostics (max 5)
  const topCandidates: TopCandidateSummary[] = candidates.slice(0, 5).map((c) => ({
    selector: c.selector,
    score: c.score,
    paragraphCount: c.paragraphCount,
    textLength: c.totalTextLength,
    linkTextRatio: Math.round(c.linkTextRatio * 100) / 100,
    boilerplatePenalty: Math.round(c.boilerplatePenalty * 100) / 100,
    scoreReasons: c.scoreReasons,
    textYieldRatio: c.rawTextLength > 0
      ? Math.round((c.totalTextLength / c.rawTextLength) * 100) / 100
      : 1,
  }));

  // ── Retry loop: try up to 3 top candidates ──
  // If the best candidate fails post-selection sanity checks (lead-dominated,
  // truncated extraction), try the next-best candidate before giving up.
  const MAX_RETRIES = Math.min(candidates.length, 3);
  const skippedCandidateReasons: string[] = [];

  for (let i = 0; i < MAX_RETRIES; i++) {
    let best = candidates[i]!;

    // Try expansion for thin candidates
    const [expandedBest, expansionType] = tryExpandCandidate(best, doc, excerpt);
    best = expandedBest;
    const usedExpansion = expansionType !== null;

    // Build final text from the selected paragraphs
    const text = best.paragraphs.join("\n\n");

    if (!isUsableBody(text, best)) {
      skippedCandidateReasons.push(`candidate_${i}:not_usable`);
      continue;
    }

    // ── Post-selection sanity checks ──
    // Only apply to non-first candidates when the first passed isUsableBody,
    // or to the first candidate to catch obvious failures early.
    const paragraphs = best.paragraphs;
    const rawLen = best.rawTextLength;

    // Check 1: Lead-dominated body (only 1-2 short paragraphs from a much larger container)
    if (isLeadDominatedBody(paragraphs, best.totalTextLength, rawLen)) {
      skippedCandidateReasons.push(`candidate_${i}:lead_dominated`);
      continue;
    }

    // Check 2: Truncated extraction (extracted text is a small fraction of container)
    if (isTruncatedExtraction(best.totalTextLength, rawLen, best.cleanedTextLength, best.paragraphCount)) {
      skippedCandidateReasons.push(`candidate_${i}:truncated_extraction`);
      continue;
    }

    // ── Candidate passed all checks — build result ──

    // Compute boundary diagnostics from the selected container
    const boundaryCount = best.boundaryMarkerCount;
    let stopReason: string | null = null;
    let stoppedAtText: string | null = null;
    let stoppedAtClassOrId: string | null = null;
    let excludedBlockCount = 0;

    if (boundaryCount > 0) {
      stopReason = `boundary_markers_in_container:${boundaryCount}`;
      try {
        const children = best.element.querySelectorAll("h2, h3, h4, h5, h6, div, section, aside");
        for (const child of children) {
          if (isArticleEndBoundaryElement(child)) {
            const childText = (child.textContent || "").trim();
            stoppedAtText = childText.length > 120 ? childText.slice(0, 120) : childText || null;
            const cls = child.getAttribute("class") || "";
            const id = child.getAttribute("id") || "";
            const combined = `${cls} ${id}`.trim();
            stoppedAtClassOrId = combined.length > 160 ? combined.slice(0, 160) : combined || null;
            break;
          }
        }
      } catch { /* non-fatal */ }
    }

    // Count excluded blocks for audit
    try {
      const allBlocks = best.element.querySelectorAll("h2, h3, h4, h5, h6, div, section, aside, p, li, blockquote");
      for (const block of allBlocks) {
        if (isSkippableNonContentElement(block) || isInsideBoundarySection(block)) {
          excludedBlockCount++;
        }
      }
    } catch { /* non-fatal */ }

    return {
      text: capBodyText(text),
      method: "dom",
      selector: best.selector,
      score: best,
      bodySource: usedExpansion ? "expanded-dom" : "dom",
      candidateContainerCount: candidates.length,
      topCandidates,
      usedExpansion,
      expansionType,
      stopReason,
      stoppedAtText,
      stoppedAtClassOrId,
      excludedBlockCount,
      skippedCandidateReasons,
    };
  }

  // All candidates failed sanity checks — return null but preserve diagnostics
  // so the caller can report skipped candidate reasons.
  return {
    __diagnosticsOnly: true as const,
    topCandidates,
    skippedCandidateReasons,
    candidateContainerCount: candidates.length,
  };
}

// ─── Text Normalization Helpers ─────────────────────────────────────────────

/**
 * Extract meaningful paragraphs from a DOM element.
 *
 * Boundary-aware extraction:
 *  - Walks children in document order to detect article end boundaries
 *  - Stops collection at boundary markers ("More by", "Related articles", etc.)
 *  - Skips boilerplate/byline/share/caption nodes
 *  - Preserves paragraph order from the original document
 *
 * This prevents contamination from related/recommended/most-read sections
 * that appear after the article body in the DOM.
 */
async function extractReadabilityBodyText(
  html: string,
  resolvedUrl: string,
  excerpt?: string | null,
): Promise<BodyExtractionResult | null> {
  let domWindow: { close(): void } | null = null;
  try {
    const [{ JSDOM }, { Readability }] = await Promise.all([
      loadJsdom(),
      import("@mozilla/readability"),
    ]);
    const dom = new JSDOM(html, {
      url: resolvedUrl,
      contentType: "text/html",
      pretendToBeVisual: false,
    });
    domWindow = dom.window;

    const article = new Readability(dom.window.document).parse();
    if (!article) return null;

    const contentDom = new JSDOM(article.content || "", {
      url: resolvedUrl,
      contentType: "text/html",
      pretendToBeVisual: false,
    });
    try {
      const blockParagraphs = Array.from(contentDom.window.document.querySelectorAll("p, li, blockquote"))
        .map((node) => collapseWhitespace(node.textContent || ""))
        .filter(isMeaningfulParagraph);
      const fallbackParagraphs = collapseWhitespace(article.textContent || "")
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
        .map((part) => part.trim())
        .filter(isMeaningfulParagraph);
      const seenParagraphs = new Set<string>();
      const paragraphs = (blockParagraphs.length > 0 ? blockParagraphs : fallbackParagraphs).filter((paragraph) => {
        const key = paragraph.toLowerCase().slice(0, 160);
        if (seenParagraphs.has(key)) return false;
        seenParagraphs.add(key);
        return true;
      });
      const text = paragraphs.join("\n\n");
      const totalTextLength = text.length;

      if (!text || bodyEqualsExcerpt(text, excerpt ?? null)) return null;

      const score: CandidateScore = {
        element: contentDom.window.document.body,
        selector: "readability",
        paragraphs,
        paragraphCount: paragraphs.length,
        totalTextLength,
        rawTextLength: totalTextLength,
        cleanedTextLength: totalTextLength,
        linkTextRatio: 0,
        headingCount: 0,
        boilerplatePenalty: 0,
        duplicateParagraphCount: 0,
        averageParagraphLength: paragraphs.length > 0 ? totalTextLength / paragraphs.length : 0,
        score: Math.min(100, 40 + paragraphs.length * 8 + Math.floor(totalTextLength / 250)),
        scoreReasons: ["readability_candidate"],
        leadLikePenaltyApplied: false,
        boundaryMarkerCount: 0,
      };

      if (!isUsableBody(text, score)) return null;

      return {
        text: capBodyText(text),
        method: "dom",
        selector: "readability",
        score,
        bodySource: "readability",
        candidateContainerCount: 1,
        topCandidates: [{
          selector: "readability",
          score: score.score,
          paragraphCount: score.paragraphCount,
          textLength: score.totalTextLength,
          linkTextRatio: 0,
          boilerplatePenalty: 0,
          scoreReasons: score.scoreReasons,
          textYieldRatio: 1,
        }],
        usedExpansion: false,
        expansionType: null,
        stopReason: null,
        stoppedAtText: null,
        stoppedAtClassOrId: null,
        excludedBlockCount: 0,
        skippedCandidateReasons: [],
      };
    } finally {
      try { contentDom.window.close(); } catch { /* cleanup is non-fatal */ }
    }
  } catch {
    return null;
  } finally {
    try { domWindow?.close(); } catch { /* cleanup is non-fatal */ }
  }
}

function shouldPreferReadabilityBody(
  current: BodyExtractionResult | null,
  readability: BodyExtractionResult | null,
): readability is BodyExtractionResult {
  if (!readability) return false;
  if (!current) return true;

  const currentParagraphs = current.score.paragraphCount;
  const readabilityParagraphs = readability.score.paragraphCount;
  const currentLength = current.text.length;
  const readabilityLength = readability.text.length;

  if (currentLength < 500 && readabilityLength >= 800) return true;
  if (readabilityParagraphs >= currentParagraphs + 3 && readabilityLength >= currentLength * 1.15) return true;
  if (readabilityLength >= currentLength * 1.5 && readabilityParagraphs >= currentParagraphs) return true;

  return false;
}

/**
 * One pure quality decision for trusted JSON-LD `articleBody` vs. the
 * current DOM/readability body. Mirrors `shouldPreferReadabilityBody`'s
 * "weak current + demonstrably more complete challenger" shape. JSON-LD text
 * has no `CandidateScore` (no DOM container), so its paragraph count is
 * derived the same way `isUsableBody` derives it (blank-line splitting).
 * A missing/empty current body is always replaced by a usable JSON-LD
 * candidate; a usable-but-weak current body is only replaced when the
 * JSON-LD candidate is demonstrably longer/more complete; a strong current
 * body is never regressed.
 */
function shouldPreferJsonLdBody(
  currentText: string | null,
  currentParagraphCount: number,
  jsonLdText: string,
): boolean {
  const currentLength = currentText?.length ?? 0;
  if (!currentText || currentLength === 0) return true;

  const jsonLdLength = jsonLdText.length;
  const jsonLdParagraphs = jsonLdText.split(/\n{2,}/).filter((p) => p.trim().length > 0).length;

  if (currentLength < 500 && jsonLdLength >= 800) return true;
  if (jsonLdParagraphs >= currentParagraphCount + 3 && jsonLdLength >= currentLength * 1.15) return true;
  if (jsonLdLength >= currentLength * 1.5 && jsonLdParagraphs >= currentParagraphCount) return true;

  return false;
}

export function extractMeaningfulParagraphs(container: Element): string[] {
  const paragraphs: string[] = [];
  const seen = new Set<string>();
  let stopReason: string | null = null;
  const blockSelectors = "p, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, dd, dt";

  // ── Pass 1: Walk direct children in document order ──
  // This catches boundaries between siblings (e.g. article body div followed
  // by a "More by Author" div inside the same parent).
  try {
    const children = Array.from(container.children);
    let hitBoundary = false;
    for (const child of children) {
      if (hitBoundary) break;

      const childTag = child.tagName.toLowerCase();
      if (STRIP_TAGS.includes(childTag)) continue;

      if (isArticleEndBoundaryElement(child)) {
        hitBoundary = true;
        stopReason = `boundary:${childTag}.${(child.getAttribute("class") || "").slice(0, 30)}`;
        break;
      }
      if (isSkippableNonContentElement(child)) continue;

      const blocks = child.querySelectorAll(blockSelectors);
      for (const block of blocks) {
        if (isInsideBoundarySection(block)) {
          hitBoundary = true;
          stopReason = `nested_boundary`;
          break;
        }
        const text = normalizeExtractedText(block.textContent || "");
        if (text && isMeaningfulParagraph(text) && !seen.has(text)) {
          seen.add(text);
          paragraphs.push(text);
        }
      }
    }
  } catch { /* fall through to pass 2 */ }

  // ── Pass 2: Fallback with querySelectorAll + boundary filtering ──
  // Handles cases where paragraphs are nested inside a single container
  // (common: <article><p>...</p><p>...</p><div class=related>...</div></article>)
  if (paragraphs.length < 3) {
    try {
      const blocks = container.querySelectorAll(blockSelectors);
      for (const block of blocks) {
        // Skip if inside a boilerplate section already stripped
        const parent = block.closest(BOILERPLATE_SELECTORS.join(", ") || ".__none__");
        if (parent) continue;

        // Stop at boundary sections
        if (isInsideBoundarySection(block)) {
          if (!stopReason) stopReason = "nested_boundary_querySelectorAll";
          break; // document-order: stop, don't just skip
        }

        const text = normalizeExtractedText(block.textContent || "");
        if (text && isMeaningfulParagraph(text) && !seen.has(text)) {
          seen.add(text);
          paragraphs.push(text);
        }
      }
    } catch { /* skip */ }
  }

  // ── Pass 3: Div-based paragraph fallback ──
  // Sites using divs instead of p tags for article paragraphs.
  if (paragraphs.length < 3) {
    try {
      const directDivs = container.querySelectorAll(":scope > div, :scope > section");
      for (const div of directDivs) {
        if (isArticleEndBoundaryElement(div)) break;
        if (isSkippableNonContentElement(div)) continue;

        const innerPs = div.querySelectorAll("p");
        if (innerPs.length >= 2) continue; // already captured via p selector

        const text = normalizeExtractedText(div.textContent || "");
        if (text && isMeaningfulParagraph(text) && !seen.has(text)) {
          const words = text.split(/\s+/);
          if (words.length >= 6 && /[,.;:!?]/.test(text)) {
            seen.add(text);
            paragraphs.push(text);
          }
        }
      }
    } catch { /* skip */ }
  }

  // ── Pass 4: Full text chunking (last resort) ──
  if (paragraphs.length === 0) {
    try {
      const allText = normalizeExtractedText(container.textContent || "");
      const split = allText.split(/\n{2,}|\r\n{2,}/).map((s) => s.trim()).filter(Boolean);
      for (const para of split) {
        if (isMeaningfulParagraph(para) && !seen.has(para)) {
          seen.add(para);
          paragraphs.push(para);
        }
      }
    } catch { /* skip */ }
  }

  return paragraphs;
}

/**
 * Normalize extracted text: collapse whitespace, remove boilerplate lines.
 */
export function normalizeExtractedText(text: string): string {
  return collapseWhitespace(removeBoilerplateLines(text));
}

/**
 * Collapse repeated whitespace while preserving paragraph boundaries.
 */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * Remove lines that look like boilerplate (share buttons, copyright notices, etc.)
 */
function removeBoilerplateLines(text: string): string {
  const boilerplatePatterns = [
    /^(share|tweet|pin|email|print|subscribe|sign up|follow us)/i,
    /^(related articles?|more (from|stories|news)|you may also like)/i,
    /^(advertisement|sponsored|promoted)/i,
    /^(©|copyright|all rights reserved)/i,
    /^(click here|read more|continue reading|load more)/i,
    /^(loading|please wait)/i,
    /^(cookie|privacy policy|terms of (use|service))/i,
  ];

  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !boilerplatePatterns.some((pattern) => pattern.test(trimmed));
    })
    .join("\n");
}

/**
 * Check if a paragraph is meaningful (not just navigation or very short text).
 */
function isMeaningfulParagraph(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;

  // Unicode letters and numbers are meaningful regardless of writing system.
  const alphaNumericLength = trimmed.replace(/[^\p{L}\p{N}]/gu, "").length;
  const alphaRatio = alphaNumericLength / trimmed.length;
  if (alphaRatio < 0.4) return false;

  // CJK and Thai text commonly has no spaces, so a word-count gate would
  // discard valid paragraphs. The length and density gates above are enough.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(trimmed)) {
    return alphaNumericLength >= 12;
  }

  // Space-delimited scripts still reject single-word and short fragments.
  const words = trimmed.split(/\s+/);
  if (words.length < 4) return false;

  return true;
}

/**
 * Check if extracted body text meets minimum quality thresholds.
 * Stricter than the previous version.
 */
function isUsableBody(text: string, score?: CandidateScore): boolean {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const totalChars = text.length;

  // Gate 1: 3+ paragraphs AND >= 500 chars
  if (paragraphs.length >= 3 && totalChars >= 500) return true;

  // Gate 2: 2+ paragraphs AND >= 800 chars
  if (paragraphs.length >= 2 && totalChars >= 800) return true;

  // Gate 3: 1 paragraph >= 1200 chars with low boilerplate/link ratio
  if (paragraphs.length >= 1 && totalChars >= 1200) {
    if (score) {
      if (score.linkTextRatio < 0.2 && score.boilerplatePenalty < 0.2) return true;
    } else {
      return true; // No score info available, accept long single paragraph
    }
  }

  return false;
}

/**
 * Post-selection sanity check: detect lead/credit-dominated bodies.
 *
 * A body is lead-dominated when:
 * - it has only 1-2 very short paragraphs (each under 150 chars)
 * - AND the container has substantially more text available (rawTextLength > body * 3)
 *
 * This catches cases where the extractor captured only the credit/byline/teaser
 * portion of a container that also holds real article paragraphs.
 *
 * Legitimate short articles pass this check because their containers don't have
 * much more hidden text — the raw container text is proportional to the extracted body.
 */
function isLeadDominatedBody(
  paragraphs: string[],
  totalTextLength: number,
  rawContainerTextLength: number,
): boolean {
  // Need very few, very short paragraphs to be lead-dominated
  if (paragraphs.length > 2) return false;

  const allShort = paragraphs.every((p) => p.length < 150);
  if (!allShort) return false;

  // Container has much more text than what was extracted — there's hidden content
  if (rawContainerTextLength > totalTextLength * 3 && rawContainerTextLength > 600) {
    return true;
  }

  return false;
}

/**
 * Post-selection sanity check: detect truncated extractions.
 *
 * An extraction is truncated when the extracted text is much shorter than
 * the raw container text, suggesting that boundary detection or paragraph
 * collection stopped too early inside a container that holds more content.
 *
 * Threshold: extracted text < 40% of raw container text, when raw > 1500 chars.
 * This is intentionally conservative to avoid rejecting containers that simply
 * have a lot of stripped boilerplate/nav/footer content.
 */
function isTruncatedExtraction(
  totalTextLength: number,
  rawContainerTextLength: number,
  cleanedContainerTextLength: number,
  paragraphCount: number,
): boolean {
  // Use cleanedTextLength (after boilerplate stripping) as the primary
  // denominator. This avoids false positives when a large wrapper contains
  // nav/header/footer/sidebar/ads that inflate rawTextLength.
  // Fall back to rawTextLength only when cleaned is unavailable.
  const availableText = cleanedContainerTextLength > 0
    ? cleanedContainerTextLength
    : rawContainerTextLength;

  if (availableText < 800) return false;
  if (totalTextLength < 1) return true;

  const yieldRatio = totalTextLength / availableText;

  // Flag as truncated when yield is low AND paragraphs are few.
  // A container with 5+ paragraphs that has low yield probably had
  // a lot of boilerplate stripped — that's fine, not truncated.
  if (yieldRatio < 0.30 && paragraphCount < 4) return true;

  // Very low yield regardless of paragraph count — only when the
  // cleaned container is substantially larger than extracted content.
  if (yieldRatio < 0.15 && availableText > 2000) return true;

  return false;
}

/**
 * Cap body text to MAX_BODY_TEXT_CHARS.
 */
function capBodyText(text: string): string {
  if (text.length <= MAX_BODY_TEXT_CHARS) return text;
  // Cut at the last paragraph boundary before the cap
  const capped = text.slice(0, MAX_BODY_TEXT_CHARS);
  const lastParagraph = capped.lastIndexOf("\n\n");
  if (lastParagraph > MAX_BODY_TEXT_CHARS * 0.5) {
    return capped.slice(0, lastParagraph);
  }
  return capped;
}

/**
 * Extract raw text from the page body for paywall detection.
 * This is separate from extractBodyText because it does not apply the minimum
 * length threshold — even very short pages may contain paywall signals.
 */
function extractRawPageText(doc: Document): string {
  try {
    const body = doc.querySelector("body");
    if (!body) return "";
    // Strip non-content elements to get cleaner text
    const clone = body.cloneNode(true) as Element;
    stripNonContentElements(clone);
    return collapseWhitespace(clone.textContent || "");
  } catch {
    return "";
  }
}

// ─── Excerpt-vs-Body Guard ──────────────────────────────────────────────────

/**
 * Check if extracted bodyText is essentially equal to the excerpt/meta description.
 * If the body is just the excerpt repeated, it's not real article content.
 */
function bodyEqualsExcerpt(bodyText: string | null, excerpt: string | null): boolean {
  if (!bodyText || !excerpt) return false;

  const normalizedBody = bodyText.trim().toLowerCase();
  const normalizedExcerpt = excerpt.trim().toLowerCase();

  // Exact match
  if (normalizedBody === normalizedExcerpt) return true;

  // Body is a subset of excerpt or vice versa
  if (normalizedBody.length > 20 && normalizedExcerpt.length > 20) {
    // Check if body starts with excerpt (excerpt + extra)
    if (normalizedBody.startsWith(normalizedExcerpt) && normalizedBody.length < normalizedExcerpt.length * 1.5) {
      return true;
    }
    // Check if excerpt starts with body (body is truncated excerpt)
    if (normalizedExcerpt.startsWith(normalizedBody) && normalizedBody.length > normalizedExcerpt.length * 0.7) {
      return true;
    }
  }

  // High word overlap — only meaningful when body and excerpt are similar
  // in size. A real article body naturally contains all excerpt words, so
  // skip this check when body is significantly longer than excerpt.
  if (normalizedBody.length > normalizedExcerpt.length * 2) return false;

  const bodyWords = new Set(normalizedBody.split(/\s+/));
  const excerptWords = new Set(normalizedExcerpt.split(/\s+/));
  if (bodyWords.size < 5 || excerptWords.size < 5) return false;

  let overlap = 0;
  for (const word of excerptWords) {
    if (bodyWords.has(word)) overlap++;
  }
  const overlapRatio = overlap / Math.min(bodyWords.size, excerptWords.size);
  return overlapRatio > 0.85;
}

/**
 * Count sentence-ending punctuation marks in text.
 */
function countSentenceEnders(text: string): number {
  const matches = text.match(/(?:[.!?]+(?=\s|$)|[。！？؟…]+)/gu);
  return matches ? matches.length : 0;
}

// ─── Article Access Classification (Prompt 15A) ─────────────────────────────
//
// Replaces the keyword-driven paywall detection. The DOM-side analysis here
// only COLLECTS article-scoped evidence (gate/overlay, CTA texts, scoped
// JSON-LD); the decision is made by the centralized classifier in
// ./article-access-classification.ts.

/**
 * Normalize a class/id value into bounded semantic tokens.
 *
 * Handles whitespace, hyphens, underscores, dots, camelCase boundaries,
 * common BEM separators (`__` / `--`), and numeric suffixes (`menu2` →
 * `menu`, `ad-container-1` → `ad` `container`). Matching is done against
 * COMPLETE tokens only — an arbitrary substring like `nav` inside
 * `navy-report` or `image` inside `imagery-analysis` never matches.
 */
export function tokenizeClassId(value: string): Set<string> {
  const tokens = new Set<string>();
  // camelCase boundaries: moreStories -> "more Stories", mediaModal -> "media Modal".
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    // Numeric suffixes: "menu2" -> "menu"; "list-2024" drops the "2024" part.
    const token = raw.replace(/\d+$/, "");
    if (!token || /^\d+$/.test(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/**
 * Chrome tokens that exclude an element from access-evidence collection when
 * they appear as COMPLETE normalized tokens. Intentionally does NOT include
 * ambiguous tokens (`form`, `modal`, `story`, `media`, ...) that also appear
 * in genuine article/gate identifiers — those are handled via explicit token
 * groups below.
 */
const ACCESS_CHROME_TOKEN_SINGLES: ReadonlySet<string> = new Set([
  // navigation / layout
  "nav", "navbar", "navigation", "menu", "menubar", "header", "footer", "sidebar", "aside",
  // newsletter chrome (auth actions are context-sensitive below)
  "newsletter",
  // related / recommended
  "related", "recommended", "recommendation", "recommendations",
  // advertisements / sponsored
  "ad", "ads", "advert", "adverts", "advertisement", "advertising", "advertorial",
  "sponsored", "promoted", "promo",
  // gallery / lightbox / media modal containers
  "gallery", "lightbox", "carousel",
  // cookie / consent
  "cookie", "consent", "gdpr", "ccpa", "privacy",
  // site chrome
  "search", "breadcrumb", "pagination", "image", "img", "video",
]);

/**
 * Explicit chrome token combinations. Every position must contain at least one
 * of its tokens. These encode exclusions whose bare tokens would be ambiguous
 * in a genuine article context (e.g. "modal" is a gate signal on its own, but
 * a media/image/video modal is page chrome).
 */
const AUTH_CHROME_TOKEN_SINGLES: ReadonlySet<string> = new Set([
  "account", "auth", "authn", "login", "logout", "logon", "signin", "signout",
  "signup", "register", "registration",
]);

const ACCESS_CHROME_TOKEN_GROUPS: ReadonlyArray<ReadonlyArray<ReadonlySet<string>>> = [
  [new Set(["more"]), new Set(["stories", "news"])],
  [new Set(["also"]), new Set(["read"])],
  [new Set(["you"]), new Set(["may"]), new Set(["also"])],
  [new Set(["media", "image", "video"]), new Set(["modal"])],
  // Auth/account tokens are context-sensitive and handled by
  // hasAuthChromeTokenEvidence + isInExcludedChrome, not as unconditional
  // page-chrome combinations.
  [new Set(["cookie"]), new Set(["banner", "notice", "wall", "bar"])],
  [new Set(["consent"]), new Set(["banner", "notice"])],
  // Generic article cards that represent ANOTHER article (prompt: "article-card
  // when it represents another article"). Real <article> cards are rejected
  // structurally; this closes the gap for div/section cards with a CTA.
  [new Set(["article"]), new Set(["card"])],
];

/** Gate/overlay tokens that mark an article-scoped access wall. */
const ACCESS_GATE_TOKEN_SINGLES: ReadonlySet<string> = new Set([
  "paywall", "overlay", "modal", "regwall", "gate", "metered", "unlock",
]);

/**
 * Explicit gate token combinations (e.g. "subscription-wall", "member-gate",
 * "premium-wall") — `wall`/`gate` alone would be too ambiguous.
 */
const ACCESS_GATE_TOKEN_GROUPS: ReadonlyArray<ReadonlyArray<ReadonlySet<string>>> = [
  [new Set(["subscription"]), new Set(["wall", "gate"])],
  [new Set(["member"]), new Set(["gate", "wall"])],
  [new Set(["premium"]), new Set(["wall", "gate"])],
];

function hasTokenEvidence(
  value: string,
  singles: ReadonlySet<string>,
  groups: ReadonlyArray<ReadonlyArray<ReadonlySet<string>>>,
): boolean {
  const tokens = tokenizeClassId(value);
  if (tokens.size === 0) return false;
  for (const token of tokens) {
    if (singles.has(token)) return true;
  }
  for (const group of groups) {
    let matched = true;
    for (const position of group) {
      let any = false;
      for (const token of position) {
        if (tokens.has(token)) {
          any = true;
          break;
        }
      }
      if (!any) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** Token-level chrome evidence (exported for regression tests). */
export function hasAccessChromeTokenEvidence(value: string): boolean {
  // This exported token predicate describes unconditional page chrome only.
  // Auth/account tokens are deliberately context-sensitive and are handled by
  // isInExcludedChrome after article-gate validation.
  return hasPageChromeTokenEvidence(value);
}

function hasPageChromeTokenEvidence(value: string): boolean {
  return hasTokenEvidence(value, ACCESS_CHROME_TOKEN_SINGLES, ACCESS_CHROME_TOKEN_GROUPS);
}

function hasAuthChromeTokenEvidence(value: string): boolean {
  return hasTokenEvidence(value, AUTH_CHROME_TOKEN_SINGLES, []);
}

/** Token-level gate/overlay evidence (exported for regression tests). */
export function hasAccessGateTokenEvidence(value: string): boolean {
  return hasTokenEvidence(value, ACCESS_GATE_TOKEN_SINGLES, ACCESS_GATE_TOKEN_GROUPS);
}

const ACCESS_INTERACTIVE_SELECTOR = 'button, a[href], [role="button"], input[type="submit"]';
const ACCESS_CTA_EVIDENCE_MAX = 6;
const ACCESS_CTA_TEXT_MAX = 160;

/** Whether an element looks like page chrome (nav/menu/footer/...) — excluded from evidence. */
function isAccessChromeElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (ACCESS_CHROME_TAGS.has(tag)) return true;
  const cls = el.getAttribute("class") || "";
  const id = el.getAttribute("id") || "";
  // Auth/account tokens are intentionally not checked here. They are page
  // chrome unless the caller proves that the element is inside a validated
  // article-scoped gate; see isInExcludedChrome below.
  return hasPageChromeTokenEvidence(`${cls} ${id}`);
}

/** Whether an element's class/id marks an article-scoped gate or overlay. */
function isGateOverlayElement(el: Element): boolean {
  if (isAccessChromeElement(el)) return false;
  const cls = el.getAttribute("class") || "";
  const id = el.getAttribute("id") || "";
  const identity = `${cls} ${id}`;
  // A bare `modal`/`overlay` token on an account/login panel is page chrome,
  // not an article gate. Auth-bearing elements need an independent strong gate
  // identity such as subscription-wall, paywall, gate, or metered.
  if (hasAuthChromeTokenEvidence(identity) && !hasStrongArticleGateTokenEvidence(identity)) {
    return false;
  }
  // The chrome filter already excludes nav/menu/newsletter/etc., so a token
  // match here is strong article-scoped gate/overlay evidence.
  return hasAccessGateTokenEvidence(identity);
}

function hasStrongArticleGateTokenEvidence(value: string): boolean {
  const tokens = tokenizeClassId(value);
  if (tokens.has("paywall") || tokens.has("regwall") || tokens.has("gate") ||
      tokens.has("metered") || tokens.has("unlock")) {
    return true;
  }
  return (
    (tokens.has("subscription") || tokens.has("member") || tokens.has("premium")) &&
    (tokens.has("wall") || tokens.has("gate"))
  );
}

function normalizeCtaText(raw: string): string {
  return collapseWhitespace(raw || "").trim().slice(0, ACCESS_CTA_TEXT_MAX);
}

/**
 * Resolve the deterministic current-article root for access evidence.
 *
 * Rules (Prompt 15A-1):
 *  - The root is the nearest <article> ancestor of the selected container, or
 *    the selected container itself. A full <main> or generic <section> subtree
 *    is NEVER promoted to article scope merely because the selected element is
 *    inside it.
 *  - No document-wide scan of every <article> element: other article cards are
 *    unrelated and cannot contribute evidence to the selected article.  *  - When the selected element belongs to a separate Readability document, the
  *    corresponding root is resolved in the original document using extraction
  *    evidence (body-text overlap against article/main containers). If no safe
  *    match exists, access evidence is empty: the Readability body is preserved,
  *    but no original-document gate or CTA evidence is imported.

 */
interface ArticleAccessRoot {
  root: Element | null;
  /** Ancestors of the root up to body — chrome wrappers reject evidence. */
  rootAncestors: Element[];
  /** True when the root lives in the original document (full checks apply). */
  originalDocument: boolean;
}

function collectAncestorsToBody(el: Element): Element[] {
  const ancestors: Element[] = [];
  let current = el.parentElement;
  while (current && current.tagName.toLowerCase() !== "body") {
    ancestors.push(current);
    current = current.parentElement;
  }
  return ancestors;
}

// ─── Readability root resolution (Prompt 15A-2) ─────────────────────────────
//
// Access-evidence root attribution FAILS CLOSED: a false root can turn an
// unrelated Subscribe/Sign-in CTA into blocking paywall evidence for the
// extracted article, so root resolution only succeeds when the original
// document contains an unambiguous, substantial match for the Readability
// body. When in doubt we keep the Readability extraction and import NO
// gate/CTA evidence from the original document.

/** Content-word filter so repetitive boilerplate cannot dominate similarity. */
const ROOT_MATCH_STOPWORDS: ReadonlySet<string> = new Set([
  "with", "from", "that", "this", "have", "will", "would", "your", "about", "which",
  "where", "when", "what", "more", "most", "some", "than", "then", "into", "over",
  "also", "only", "just", "very", "such", "each", "other", "their", "there", "these",
  "those", "while", "still", "even", "both", "after", "before", "they", "them", "were",
  "been", "being", "could", "should", "might", "must", "shall", "because", "between",
  "during", "under", "without", "through", "against", "within", "around", "among",
  "across", "toward", "along", "upon", "said", "says", "told", "made", "make", "used",
  "using", "according", "first", "last", "next", "every", "many", "much", "same", "new",
]);

const MIN_CANDIDATE_TEXT_LENGTH = 300;
const MIN_SHARED_UNIQUE_WORDS = 12;
const MIN_SAMPLE_COVERAGE = 0.6;
const MIN_CANDIDATE_COVERAGE = 0.6;
const MIN_LENGTH_RATIO = 0.5;
const MAX_LENGTH_RATIO = 3;
const MIN_LEXICAL_DIVERSITY = 0.15;
const COVERAGE_AMBIGUITY_TOLERANCE = 0.05;
const RATIO_AMBIGUITY_TOLERANCE = 0.15;

/** Unique content words of a text (stopwords and short words excluded). */
function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length <= 3) continue;
    if (ROOT_MATCH_STOPWORDS.has(w)) continue;
    words.add(w);
  }
  return words;
}

function countWords(text: string): number {
  return text.toLowerCase().split(/\s+/).filter(Boolean).length;
}

interface RootResolutionMetrics {
  el: Element;
  sampleCoverage: number;
  candidateCoverage: number;
  lengthRatio: number;
  isArticle: boolean;
  headingAgreement: boolean;
}

/** Normalized heading/title agreement — an optional bounded tie-break signal. */
function headingAgrees(el: Element, sampleWords: Set<string>): boolean {
  try {
    const heading = el.querySelector("h1, h2, h3");
    if (!heading) return false;
    const headingWords = contentWords((heading.textContent || "").slice(0, 200));
    let shared = 0;
    for (const w of headingWords) {
      if (sampleWords.has(w)) shared++;
    }
    return shared >= 3;
  } catch {
    return false;
  }
}

/**
 * Select a root with one global, ordered ambiguity policy. Each tier keeps all
 * candidates effectively tied with the best value in that tier; only after a
 * tier is exhausted may the next criterion decide. This avoids non-transitive
 * pairwise tolerance comparisons allowing DOM order to resolve a three-way tie.
 */
function selectRootResolutionCandidate(candidates: RootResolutionMetrics[]): RootResolutionMetrics | null {
  if (candidates.length === 0) return null;

  const maxCoverage = Math.max(...candidates.map((candidate) => candidate.sampleCoverage));
  let remaining = candidates.filter((candidate) =>
    maxCoverage - candidate.sampleCoverage < COVERAGE_AMBIGUITY_TOLERANCE,
  );

  const minRatioCloseness = Math.min(
    ...remaining.map((candidate) => Math.abs(candidate.lengthRatio - 1)),
  );
  remaining = remaining.filter((candidate) =>
    Math.abs(Math.abs(candidate.lengthRatio - 1) - minRatioCloseness) < RATIO_AMBIGUITY_TOLERANCE,
  );

  const hasArticle = remaining.some((candidate) => candidate.isArticle);
  const hasGeneric = remaining.some((candidate) => !candidate.isArticle);
  if (hasArticle && hasGeneric) {
    remaining = remaining.filter((candidate) => candidate.isArticle);
  }

  const hasHeadingMatch = remaining.some((candidate) => candidate.headingAgreement);
  const hasHeadingMiss = remaining.some((candidate) => !candidate.headingAgreement);
  if (hasHeadingMatch && hasHeadingMiss) {
    remaining = remaining.filter((candidate) => candidate.headingAgreement);
  }

  return remaining.length === 1 ? remaining[0]! : null;
}

/**
 * Resolve a Readability extraction to its corresponding original-document
 * root using extraction evidence (body-text overlap). The readability sample
 * text is passed in explicitly because the Readability element's own document
 * is closed before analysis runs, so its textContent is no longer readable.
 * Returns null when no safe match exists; the caller then falls back
 * conservatively (keeping the Readability body but importing NO original-doc
 * gate/CTA evidence).
 *
 * Safety (bidirectional, not subset-only):
 *  - sampleCoverage: the candidate must contain a substantial proportion of
 *    the Readability sample's unique content words;
 *  - candidateCoverage: the candidate's words must mostly come from the sample;
 *  - minimum absolute shared unique word count;
 *  - the candidate/sample text-length ratio must not be extremely small (a
 *    short teaser can never match a much longer Readability article);
 *  - lexical diversity guards against repetitive/template text dominating;
 *  - stopwords never contribute to any score.
 *
 * Deterministic selection uses global tolerance tiers: best sample coverage,
 * then safest length ratio (closest to 1), then semantic <article> over generic
 * <main>, then normalized heading/title agreement. DOM order is never decisive;
 * if more than one candidate remains after every tier, resolution fails closed.
 */
export function resolveCorrespondingRootByText(doc: Document, sampleText: string): Element | null {
  const sample = sampleText.trim();
  if (sample.length < 300) return null;
  const sampleWords = contentWords(sample);
  if (sampleWords.size < 20) return null;

  const metricize = (candidate: Element): RootResolutionMetrics | null => {
    const candText = (candidate.textContent || "").trim();
    if (candText.length < MIN_CANDIDATE_TEXT_LENGTH) return null;
    const candWords = contentWords(candText);
    if (candWords.size < MIN_SHARED_UNIQUE_WORDS) return null;
    // Repetitive boilerplate guard: unique content words must form a
    // meaningful fraction of all words in the candidate.
    const lexicalDiversity = candWords.size / Math.max(1, countWords(candText));
    if (lexicalDiversity < MIN_LEXICAL_DIVERSITY) return null;

    let shared = 0;
    for (const w of candWords) {
      if (sampleWords.has(w)) shared++;
    }
    if (shared < MIN_SHARED_UNIQUE_WORDS) return null;

    const sampleCoverage = shared / sampleWords.size;
    const candidateCoverage = shared / candWords.size;
    if (sampleCoverage < MIN_SAMPLE_COVERAGE) return null;
    if (candidateCoverage < MIN_CANDIDATE_COVERAGE) return null;

    const lengthRatio = candText.length / sample.length;
    if (lengthRatio < MIN_LENGTH_RATIO || lengthRatio > MAX_LENGTH_RATIO) return null;

    return {
      el: candidate,
      sampleCoverage,
      candidateCoverage,
      lengthRatio,
      isArticle: candidate.tagName.toLowerCase() === "article",
      headingAgreement: headingAgrees(candidate, sampleWords),
    };
  };

  try {
    const articles = Array.from(doc.querySelectorAll("article"))
      .map(metricize)
      .filter((m): m is RootResolutionMetrics => m !== null);

    // A generic <main> may compete only when it contains no article-like
    // subtree. A failed nested teaser must never be bypassed by promoting its
    // parent main and importing the teaser's access CTA. Safe article and
    // article-free main roots can therefore be compared using the explicit
    // semantic <article> tie-breaker rather than DOM order.
    const mains = Array.from(doc.querySelectorAll("main"))
      .filter((main) => main.querySelectorAll("article").length === 0)
      .map(metricize)
      .filter((m): m is RootResolutionMetrics => m !== null);

    const candidates = [...articles, ...mains];
    if (candidates.length === 0) return null;

    // Apply one global, tolerance-aware policy: coverage, ratio closeness,
    // semantic <article>, then heading agreement. DOM order is never a
    // decisive criterion, including when three or more candidates overlap.
    const selected = selectRootResolutionCandidate(candidates);
    return selected?.el ?? null;
  } catch {
    return null;
  }
}

function resolveArticleAccessRoot(
  doc: Document,
  selectedElement: Element | null,
  sampleText: string | null,
): ArticleAccessRoot {
  if (!selectedElement) {
    // When a Readability body exists, resolve it against the original
    // document first. A single original <article> may be a teaser, so it is
    // not safe to treat it as the current article without text validation.
    if (sampleText?.trim()) {
      const resolved = resolveCorrespondingRootByText(doc, sampleText);
      if (resolved) {
        return { root: resolved, rootAncestors: collectAncestorsToBody(resolved), originalDocument: true };
      }
      return { root: null, rootAncestors: [], originalDocument: false };
    }

    // No usable body container was selected and no body sample exists — this
    // is the missing/truncated-body case where a single article is the only
    // conservative DOM anchor available. Multiple articles remain ambiguous.
    try {
      const articles = doc.querySelectorAll("article");
      if (articles.length === 1) {
        const single = articles[0]!;
        return { root: single, rootAncestors: collectAncestorsToBody(single), originalDocument: true };
      }
    } catch { /* non-fatal */ }
    return { root: null, rootAncestors: [], originalDocument: false };
  }

  const sameDocument = selectedElement.ownerDocument === doc;
  if (sameDocument) {
    // Walk up to the nearest <article> ancestor (the canonical "this article"
    // container). Do NOT promote <main>/<section>.
    let root: Element = selectedElement;
    let el: Element | null = selectedElement.parentElement;
    for (let depth = 0; el && depth < 4 && el.tagName.toLowerCase() !== "body"; depth++) {
      if (el.tagName.toLowerCase() === "article") {
        root = el;
        break;
      }
      el = el.parentElement;
    }
    return { root, rootAncestors: collectAncestorsToBody(root), originalDocument: true };
  }

  // Readability cross-document element → resolve a safe original-doc root by
  // body-text overlap using the extracted body text (the element's own
  // document is closed at this point). If no safe original root exists, return
  // an empty scope: preserve the Readability body, but import no original-doc
  // gate or CTA evidence at all.
  const resolved = resolveCorrespondingRootByText(doc, sampleText ?? "");
  if (resolved) {
    return { root: resolved, rootAncestors: collectAncestorsToBody(resolved), originalDocument: true };
  }
  return { root: null, rootAncestors: [], originalDocument: false };
}

interface ArticleScopedAccessEvidence {
  gateOrOverlayDetected: boolean;
  ctaTexts: string[];
}

/**
 * Whether an element (or any ancestor up to and including the current-article
 * root, plus the root's own ancestors) represents excluded chrome. The
 * exclusion never depends solely on the candidate element's own class name.
 */
function isInExcludedChrome(
  el: Element,
  root: Element,
  rootAncestors: Element[],
  validatedGates: Element[] = [],
): boolean {
  const isInsideValidatedGate = (candidate: Element): boolean =>
    validatedGates.some((gate) => gate === candidate || gate.contains(candidate));
  let current: Element | null = el;
  let depth = 0;
  while (current && depth < 16) {
    if (isAccessChromeElement(current)) return true;
    if (hasAuthChromeTokenEvidence(`${current.getAttribute("class") || ""} ${current.getAttribute("id") || ""}`) &&
        !isInsideValidatedGate(current)) {
      return true;
    }
    if (current === root) break;
    current = current.parentElement;
    depth++;
  }
  for (const ancestor of rootAncestors) {
    if (isAccessChromeElement(ancestor)) return true;
    if (hasAuthChromeTokenEvidence(`${ancestor.getAttribute("class") || ""} ${ancestor.getAttribute("id") || ""}`) &&
        !isInsideValidatedGate(ancestor)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect article-scoped gate/overlay and access CTA evidence.
 *
 * Scope (Prompt 15A-1):
 *  - Evidence comes ONLY from the validated current-article root subtree or
 *    from validated adjacent gate/overlay siblings. No document-wide <article>
 *    scan and no generic <main>/<section> promotion; other article cards,
 *    recommendation content, advertisements, and account/navigation UI are
 *    excluded via the ancestor-aware chrome check.
 *  - An immediate sibling qualifies ONLY when it has an explicit
 *    gate/overlay/access-wall identity (never mere adjacency).
 *  - An interactive CTA counts only inside the article root or inside a
 *    validated gate/overlay. Plain text blocks count only when no usable body
 *    was extracted, so a quoted access phrase inside full article prose stays
 *    non-decisive.
 */
function detectArticleScopedAccessEvidence(
  doc: Document,
  selectedElement: Element | null,
  usableBodyExtracted: boolean,
  bodyText: string | null,
): ArticleScopedAccessEvidence {
  const { root, rootAncestors, originalDocument } = resolveArticleAccessRoot(doc, selectedElement, bodyText);
  const ctaTexts: string[] = [];
  const gateContainers: Element[] = [];
  let gateOrOverlayDetected = false;
  const seenCta = new Set<string>();

  if (!root) return { gateOrOverlayDetected: false, ctaTexts: [] };

  const isArticleRoot = root.tagName.toLowerCase() === "article";
  // Any descendant <article> is a separate article-like subtree unless it is
  // the validated root itself. This remains structural for generic roots such
  // as <main>; class names are not required for exclusion.
  const inOtherArticleCard = (el: Element): boolean => {
    if (!root.contains(el)) return false;
    const nearestArticle = el.closest("article");
    return nearestArticle !== null && (!isArticleRoot || nearestArticle !== root);
  };

  // Pass 0: validated adjacent gate/overlay siblings (original document only).
  if (originalDocument && root.parentElement) {
    const children = Array.from(root.parentElement.children);
    const idx = children.indexOf(root);
    for (const sib of [children[idx - 1], children[idx + 1]]) {
      if (!sib) continue;
      // An <article> sibling is another article card — never the current
      // article's gate, even with a gate-like class (Prompt 15A-1).
      if (sib.tagName.toLowerCase() === "article") continue;
      // Mere adjacency is never enough — explicit gate/overlay identity required.
      if (!isGateOverlayElement(sib)) continue;
      if (isInExcludedChrome(sib, root, rootAncestors, [sib])) continue;
      gateOrOverlayDetected = true;
      gateContainers.push(sib);
    }
    // A gate that directly WRAPS the root is part of the same article.
    if (isGateOverlayElement(root.parentElement) &&
        !isInExcludedChrome(root.parentElement, root, rootAncestors, [root.parentElement])) {
      gateOrOverlayDetected = true;
      gateContainers.push(root.parentElement);
    }
  }

  // Pass 1: gate/overlay containers inside the root subtree (ancestor-aware).
  if (isGateOverlayElement(root)) {
    gateOrOverlayDetected = true;
    gateContainers.push(root);
  }
  try {
    for (const child of root.querySelectorAll("div, section, aside, [class], [id]")) {
      if (inOtherArticleCard(child)) continue;
      if (!isGateOverlayElement(child)) continue;
      // Evaluate gate identity before auth-token filtering: a genuine
      // subscription-wall registration container is not page auth chrome.
      if (isInExcludedChrome(child, root, rootAncestors, [child])) continue;
      gateOrOverlayDetected = true;
      gateContainers.push(child);
    }
  } catch { /* non-fatal */ }

  const isInsideValidatedGate = (el: Element): boolean =>
    gateContainers.some((gate) => gate === el || gate.contains(el));

  const considerCta = (el: Element, interactive: boolean): void => {
    if (inOtherArticleCard(el)) return;
    if (isInExcludedChrome(el, root, rootAncestors, gateContainers)) return;
    const text = normalizeCtaText(el.textContent || "");
    if (!text) return;
    if (matchArticleAccessCtaPatterns(text).length === 0) return;
    const inGate = isInsideValidatedGate(el);
    // Plain in-body text with a usable body is never decisive (quoted phrases).
    if (!interactive && !inGate && usableBodyExtracted) return;
    const key = text.toLowerCase();
    if (!seenCta.has(key) && ctaTexts.length < ACCESS_CTA_EVIDENCE_MAX) {
      seenCta.add(key);
      ctaTexts.push(text);
    }
  };

  const scanSubtree = (container: Element): void => {
    // Interactive CTAs (buttons/links) inside the root or a validated gate.
    try {
      for (const el of container.querySelectorAll(ACCESS_INTERACTIVE_SELECTOR)) {
        if (inOtherArticleCard(el)) continue;
        if (isInExcludedChrome(el, root, rootAncestors, gateContainers)) continue;
        considerCta(el, true);
      }
    } catch { /* non-fatal */ }
    // Short plain-text blocks count only when no usable body was extracted.
    if (!usableBodyExtracted) {
      try {
        for (const el of container.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6, span")) {
          if (inOtherArticleCard(el)) continue;
          if ((el.textContent || "").length > 240) continue;
          considerCta(el, false);
        }
      } catch { /* non-fatal */ }
    }
  };

  scanSubtree(root);
  for (const gate of gateContainers) {
    if (gate !== root) scanSubtree(gate);
  }

  return { gateOrOverlayDetected, ctaTexts };
}

/**
 * Parse JSON-LD safely and collect paywall signals from supported article
 * nodes ONLY, scoped to the current canonical URL. Conflicting article nodes
 * are dropped; unstated (identity-less) nodes are honored only when they are
 * the page's single unambiguous article node.
 */
function extractScopedJsonLdPaywallSignals(doc: Document, canonicalUrl: string): JsonLdPaywallSignal[] {
  try {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    let merged: JsonLdPaywallSignalScan = { signals: [], articleNodeCount: 0, conflictingNodeCount: 0 };
    for (const script of scripts) {
      const text = script.textContent?.trim();
      if (!text) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // malformed JSON-LD → never classify from it
      }
      const scan = extractJsonLdPaywallSignalsFromValue(parsed, canonicalUrl);
      merged = {
        signals: [...merged.signals, ...scan.signals],
        articleNodeCount: merged.articleNodeCount + scan.articleNodeCount,
        conflictingNodeCount: merged.conflictingNodeCount + scan.conflictingNodeCount,
      };
    }
    const hasMatched = merged.signals.some((s) => s.nodeIdentityState === "matched");
    return merged.signals.filter(
      (s) =>
        s.nodeIdentityState === "matched" ||
        // A single unambiguous identity-less article node is clearly related.
        // Conflicting article nodes always disqualify identity-less signals.
        (s.nodeIdentityState === "unstated" &&
          !hasMatched &&
          merged.articleNodeCount <= 1 &&
          merged.conflictingNodeCount === 0),
    ).slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Run the centralized article-access classifier with DOM-collected evidence.
 * Returns the structured result; classification drives isPaywall and the
 * paywall_or_blocked rejection decision.
 */
function analyzeArticleAccess(input: {
  doc: Document;
  canonicalUrl: string;
  statusCode: number;
  bodyText: string | null;
  usableBodyExtracted: boolean;
  bodyTruncationDetected: boolean;
  rawPageText: string;
  selectedElement: Element | null;
}): ArticleAccessClassificationResult {
  const scopedEvidence = detectArticleScopedAccessEvidence(input.doc, input.selectedElement, input.usableBodyExtracted, input.bodyText);
  const jsonLdSignals = extractScopedJsonLdPaywallSignals(input.doc, input.canonicalUrl);
  return classifyArticleAccess({
    statusCode: input.statusCode,
    bodyText: input.bodyText,
    usableBodyExtracted: input.usableBodyExtracted,
    bodyTruncationDetected: input.bodyTruncationDetected,
    rawPageText: input.rawPageText,
    articleScopedGateOrOverlayDetected: scopedEvidence.gateOrOverlayDetected,
    articleScopedCtaTexts: scopedEvidence.ctaTexts,
    jsonLdPaywallSignals: jsonLdSignals,
    challengeTextSignals: matchChallengeTextPatterns(input.rawPageText),
    adBlockerWarningDetected: matchAdBlockerWarningPatterns(input.rawPageText).length > 0,
  });
}

// ─── Quality Scoring ────────────────────────────────────────────────────────

function computeConfidence(
  extraction: { method: string; selector: string },
  bodyTextLength: number,
  hasTitle: boolean,
  hasExcerpt: boolean,
  hasAuthor: boolean,
  hasDate: boolean,
  isPaywall: boolean | null,
): number {
  let score = 0;

  // Base score for having body text
  if (bodyTextLength >= 2000) score += 0.4;
  else if (bodyTextLength >= 1000) score += 0.3;
  else if (bodyTextLength >= 500) score += 0.2;

  // Semantic container bonus
  if (["article", "main article", '[itemprop="articleBody"]'].includes(extraction.selector)) {
    score += 0.15;
  } else if (extraction.selector !== "body-fallback") {
    score += 0.05;
  }

  // Metadata bonuses
  if (hasTitle) score += 0.1;
  if (hasExcerpt) score += 0.05;
  if (hasAuthor) score += 0.05;
  if (hasDate) score += 0.05;

  // Body length bonus
  if (bodyTextLength >= 3000) score += 0.1;
  else if (bodyTextLength >= 1500) score += 0.05;

  // Penalty for paywall
  if (isPaywall) score -= 0.15;

  return Math.min(1, Math.max(0, score));
}

// ─── Empty diagnostics helper ───────────────────────────────────────────────

function emptyDiagnostics(bodySource: ExtractionDiagnostics["bodySource"] = "none"): ExtractionDiagnostics {
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
    skippedCandidateReasons: [],
  };
}

// ─── Main Extraction Function ───────────────────────────────────────────────

/**
 * Input for the shared HTML extraction pipeline.
 */
export interface ExtractArticleContentFromHtmlInput {
  /** Raw HTML string to parse. */
  html: string;
  /** Resolved URL (after redirects) for canonical URL resolution. */
  resolvedUrl: string;
  /** HTTP status code of the fetch. */
  statusCode: number;
  /** Existing article title for fallback. */
  existingTitle: string;
  /** Existing body text for fallback. */
  existingBodyText?: string | null;
  /** Extraction method label to set on the result. */
  method: "http-dom" | "http-meta" | "browser-dom";
}

/**
 * Shared HTML extraction pipeline: parse HTML with jsdom, extract structured
 * content using multi-candidate scoring, quality gates, and paywall detection.
 *
 * This is the single source of truth for DOM-based article content extraction.
 * Both the static HTTP extractor and the browser fallback call this function
 * with their respective HTML sources, ensuring identical scoring and quality
 * gates regardless of how the HTML was obtained.
 *
 * Returns a typed discriminated union for safe consumption by the enrichment
 * runtime.
 */
export async function extractArticleContentFromHtml(
  input: ExtractArticleContentFromHtmlInput,
): Promise<ArticleContentExtractionResult> {
  const { html, resolvedUrl, statusCode, existingTitle, existingBodyText, method } = input;

  // Step 1: Check for empty HTML
  const htmlLength = html.trim().length;
  if (htmlLength < 100) {
    // HTTP 202 with empty/very short HTML and no usable article evidence is an
    // interstitial/challenge shell (browser-recoverable, bounded-retryable) —
    // never a terminal empty_html failure. HTTP 204/200 short bodies keep the
    // existing empty_html classification; 403/429/5xx never reach this point.
    // Note: this check runs before paywall detection, but an empty/short shell
    // carries no DOM for paywall evidence, so a genuine 202 paywall page (a
    // full-length document) still routes through paywall detection below.
    if (statusCode === 202) {
      return fail(
        method,
        resolvedUrl,
        statusCode,
        "interstitial_or_challenge",
        `HTTP 202 response has no usable article HTML (${htmlLength} chars) — empty or short interstitial/challenge shell.`,
        ["http_202_interstitial", "empty_or_short_interstitial_html", `htmlLength:${htmlLength}`],
        { htmlLength, bodyRejectedReason: "empty_or_short_interstitial_html", bodySource: "none" },
      );
    }
    return fail(
      method,
      resolvedUrl,
      statusCode,
      "empty_html",
      `HTML too short (${htmlLength} chars)`,
      [],
      { htmlLength },
    );
  }

  // Step 2: Parse HTML with jsdom
  let doc: Document;
  let domWindow: { close(): void } | null = null;
  try {
    const { JSDOM } = await loadJsdom();
    const dom = new JSDOM(html, {
      url: resolvedUrl,
      contentType: "text/html",
      pretendToBeVisual: false,
    });
    doc = dom.window.document;
    domWindow = dom.window;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      method,
      resolvedUrl,
      statusCode,
      "parse_error",
      `DOM parse failed: ${message}`,
    );
  }

  try {
    // Step 3: Extract structured content
    const canonicalUrl = extractCanonicalUrl(doc, resolvedUrl);
    const { title } = extractTitle(doc, existingTitle);
    const excerpt = extractExcerpt(doc);
    const imageUrl = extractImageUrl(doc);
    const author = extractAuthor(doc);
    const publishedAt = extractPublishedAt(doc);

    // Step 4: Extract body text with multi-candidate scoring
    // Pass excerpt so scoring can penalize containers that are just the summary
    let bodyResult = extractBodyText(doc, excerpt);
    const readabilityResult = await extractReadabilityBodyText(html, resolvedUrl, excerpt);

    // Capture DOM diagnostics BEFORE readability can override them.
    // This handles two cases:
    //   1. extractBodyText returns BodyExtractionDiagnosticsOnly (all candidates
    //      failed sanity checks) — preserves full candidate evaluation diagnostics.
    //   2. extractBodyText returns BodyExtractionResult with skip reasons, but
    //      readability is later preferred — DOM skip reasons would otherwise be lost.
    const domDiagnosticsOnly = bodyResult && "__diagnosticsOnly" in bodyResult
      ? bodyResult as BodyExtractionDiagnosticsOnly
      : null;
    const domFullResult = domDiagnosticsOnly ? null : bodyResult as BodyExtractionResult | null;

    // Capture DOM diagnostics before readability comparison
    const domSkipReasons = domDiagnosticsOnly?.skippedCandidateReasons
      ?? domFullResult?.skippedCandidateReasons
      ?? [];
    const domTopCandidates = domDiagnosticsOnly?.topCandidates
      ?? domFullResult?.topCandidates
      ?? [];
    const domCandidateCount = domDiagnosticsOnly?.candidateContainerCount
      ?? domFullResult?.candidateContainerCount
      ?? 0;

    if (shouldPreferReadabilityBody(domFullResult, readabilityResult)) {
      bodyResult = readabilityResult;
    } else if (domDiagnosticsOnly) {
      bodyResult = null;
    }

    const effectiveResult = bodyResult && "__diagnosticsOnly" in bodyResult
      ? null
      : bodyResult as BodyExtractionResult | null;

    let bodyText = effectiveResult?.text || null;
    let bodySource: ExtractionDiagnostics["bodySource"] = effectiveResult?.bodySource || "none";

    // JSON-LD articleBody extraction: a complete, trustworthy structured-data
    // body is accepted when the DOM produced nothing usable (unconditional
    // replace, as before), or when it is demonstrably more complete than a
    // usable-but-weak DOM/readability body (shouldPreferJsonLdBody). It is
    // never preferred over a strong DOM/readability body. The candidate must
    // pass the same quality gate as DOM-derived text (isUsableBody) and is
    // bounded by the same storage cap.
    let jsonLdBodyText: string | null = null;
    {
      const jsonLdCandidate = extractJsonLdArticleBody(doc);
      if (jsonLdCandidate && isUsableBody(jsonLdCandidate)) {
        const currentUsable = Boolean(bodyText) && isUsableBody(bodyText as string, effectiveResult?.score);
        const shouldReplace = !currentUsable ||
          shouldPreferJsonLdBody(bodyText, effectiveResult?.score?.paragraphCount ?? 0, jsonLdCandidate);
        if (shouldReplace) {
          jsonLdBodyText = jsonLdCandidate;
          bodyText = jsonLdCandidate;
          bodySource = "jsonld";
        }
      }
    }

    // Merge diagnostics: always prefer captured DOM diagnostics (which include
    // candidate skip reasons from the full evaluation) over effectiveResult
    // (which may be readability with empty diagnostics).
    const mergedTopCandidates = domTopCandidates.length
      ? domTopCandidates
      : effectiveResult?.topCandidates ?? [];
    const mergedSkippedReasons = domSkipReasons.length
      ? domSkipReasons
      : effectiveResult?.skippedCandidateReasons ?? [];
    const mergedCandidateCount = domCandidateCount
      || effectiveResult?.candidateContainerCount || 0;

    // Build diagnostics
    const diagnostics: ExtractionDiagnostics = {
      selectedContainerSelector: effectiveResult?.score.selector || null,
      selectedContainerScore: effectiveResult?.score.score ?? null,
      selectedContainerParagraphCount: effectiveResult?.score.paragraphCount ?? null,
      selectedContainerTextLength: effectiveResult?.score.totalTextLength ?? null,
      candidateContainerCount: mergedCandidateCount,
      bodyRejectedReason: null,
      scoreReasons: effectiveResult?.score.scoreReasons || [],
      excerptLength: excerpt?.length ?? null,
      bodyEqualsExcerpt: false,
      bodySource,
      linkTextRatio: effectiveResult?.score.linkTextRatio ?? null,
      boilerplatePenalty: effectiveResult?.score.boilerplatePenalty ?? null,
      topCandidates: mergedTopCandidates,
      usedExpansion: effectiveResult?.usedExpansion || false,
      expansionType: effectiveResult?.expansionType || null,
      leadLikePenaltyApplied: effectiveResult?.score.leadLikePenaltyApplied || false,
      stopReason: effectiveResult?.stopReason ?? null,
      boundaryMarkersSeen: effectiveResult?.score.boundaryMarkerCount ?? 0,
      stoppedAtText: effectiveResult?.stoppedAtText ?? null,
      stoppedAtClassOrId: effectiveResult?.stoppedAtClassOrId ?? null,
      excludedBlockCount: effectiveResult?.excludedBlockCount ?? 0,
      skippedCandidateReasons: mergedSkippedReasons,
    };

    // Also extract raw text from the page for access classification.
    // This runs even when bodyText is below the minimum threshold, so short
    // paywall/challenge pages are still classified correctly.
    const rawPageText = extractRawPageText(doc);

    // Step 6: Excerpt-vs-body guard (runs BEFORE quality gate so we catch
    // excerpt-as-body even when the excerpt is too short to pass quality checks)
    // NEVER use excerpt as bodyText. If body equals excerpt, reject.
    if (bodyText && excerpt && bodyEqualsExcerpt(bodyText, excerpt)) {
      diagnostics.bodyEqualsExcerpt = true;
      diagnostics.bodyRejectedReason = "body_equals_excerpt";

      try { domWindow?.close(); } catch { /* cleanup is non-fatal */ }

      return fail(
        method,
        resolvedUrl,
        statusCode,
        "no_article_text",
        "Extracted body text is essentially equal to the meta description/excerpt.",
        [`bodyEqualsExcerpt:true`, `excerptLength:${excerpt?.length ?? 0}`],
        diagnostics,
      );
    }

    // Step 7: If no usable body from DOM, try existing body as fallback
    // BUT only if existing body is NOT equal to excerpt
    if (!bodyText && existingBodyText && existingBodyText.length >= 500) {
      if (!bodyEqualsExcerpt(existingBodyText, excerpt)) {
        bodyText = existingBodyText;
        diagnostics.bodySource = "existing-fallback";
      }
    }

    // Step 7.5: Article access classification (Prompt 15A). Runs after the
    // existing-body fallback so the classifier sees the final body text.
    // Evidence is DOM-collected and article-scoped (gate/overlay, CTA texts,
    // scoped JSON-LD); generic topic words and technical access failures are
    // never decisive on their own.
    const usableBodyExtracted = diagnostics.bodySource !== "existing-fallback" &&
      Boolean(bodyText) && isUsableBody(bodyText ?? "", effectiveResult?.score);
    const bodyTruncationDetected = Boolean(
      diagnostics.stopReason ||
      diagnostics.stoppedAtClassOrId ||
      diagnostics.stoppedAtText ||
      (bodyText && bodyText.length >= MAX_BODY_TEXT_CHARS),
    );
    const access = analyzeArticleAccess({
      doc,
      canonicalUrl,
      statusCode,
      bodyText,
      usableBodyExtracted,
      bodyTruncationDetected,
      rawPageText,
      selectedElement: effectiveResult?.score.element ?? null,
    });
    const accessEvidenceCodes = access.evidence.map((e) => `access_evidence:${e.code}`);

    // Step 8: A decisive PAYWALL_BLOCKED classification (article-scoped CTA with
    // missing/truncated body) rejects. LOW-confidence gate-only evidence falls
    // through to the regular body-quality gates so JS-rendered pages stay
    // browser-recoverable.
    if (access.classification === "PAYWALL_BLOCKED" && access.confidence !== "LOW") {
      diagnostics.bodyRejectedReason = "paywall_short_body";
      try { domWindow?.close(); } catch { /* non-fatal */ }
      return fail(
        method,
        resolvedUrl,
        statusCode,
        "paywall_or_blocked",
        "Article-scoped access gate detected with missing or truncated body text.",
        [`access_classification:PAYWALL_BLOCKED`, `access_confidence:${access.confidence}`, ...accessEvidenceCodes],
        diagnostics,
        undefined,
        access,
      );
    }

    // Step 8.5: Some publishers return a blocker document with HTTP 200. Only
    // classify it when both strong blocker groups occur in the selected body,
    // or when the current response had no body and an existing-body fallback
    // would otherwise hide the blocker. Raw-page signals alone are not enough:
    // genuine article pages commonly include equivalent noscript warnings.
    const rawStrongInterstitialSignals = detectStrongInterstitialSignals(rawPageText);
    const bodyStrongInterstitialSignals = detectStrongInterstitialSignals(bodyText ?? "");
    const currentBodyMissing = diagnostics.bodySource === "existing-fallback" || !bodyText;
    const strongHttp200Interstitial =
      statusCode === 200 &&
      !jsonLdBodyText &&
      hasBlockingInterstitialSignalPair(rawStrongInterstitialSignals) &&
      (currentBodyMissing || hasBlockingInterstitialSignalPair(bodyStrongInterstitialSignals));

    if (strongHttp200Interstitial) {
      diagnostics.bodyRejectedReason = "interstitial_or_challenge";
      try { domWindow?.close(); } catch { /* cleanup is non-fatal */ }
      return fail(
        method,
        resolvedUrl,
        statusCode,
        "interstitial_or_challenge",
        "HTTP 200 response contains a JavaScript/cookie blocker instead of article content.",
        ["http_200_interstitial", ...rawStrongInterstitialSignals],
        { ...diagnostics, htmlLength: html.trim().length },
      );
    }

    // Step 8.6: HTTP 202 interstitial/challenge classification.
    // A 2xx response that carries NO usable article body, NO trustworthy
    // structured-data body, and no acceptable existing body is an
    // interstitial/challenge/consent/queue/non-final shell and must not become
    // a terminal LOW_CONTENT_QUALITY failure — it stays browser-recoverable and
    // bounded-retryable. Known interstitial text patterns only strengthen the
    // evidence; they are never mandatory (an unknown provider shell with no
    // article body is still classified). Paywall detection above takes
    // precedence, and a valid 202 body (DOM, readability, or JSON-LD)
    // short-circuits this check entirely.
    const usableArticleBody = Boolean(bodyText) && (
      ((bodyText ?? "").length >= 50 && isUsableBody(bodyText ?? "", effectiveResult?.score)) ||
      (diagnostics.bodySource === "existing-fallback" && (bodyText ?? "").length >= 500)
    );
    if (statusCode === 202 && !jsonLdBodyText && !usableArticleBody) {
      diagnostics.bodyRejectedReason = "interstitial_or_challenge";
      const interstitialSignals = isLikelyInterstitialPage(rawPageText, doc)
        ? ["http_202_interstitial", "interstitial_text_pattern"]
        : ["http_202_interstitial"];
      try { domWindow?.close(); } catch { /* cleanup is non-fatal */ }
      return fail(
        method,
        resolvedUrl,
        statusCode,
        "interstitial_or_challenge",
        "HTTP 202 response without a usable article body — page is an interstitial/challenge/non-final response.",
        [...accessEvidenceCodes, ...interstitialSignals],
        { ...diagnostics, htmlLength: html.trim().length },
      );
    }

    // Step 9: If no usable body text at all
    if (!bodyText || bodyText.length < 50) {
      diagnostics.bodyRejectedReason = "no_body_found";
      try { domWindow?.close(); } catch { /* non-fatal */ }
      return fail(
        method,
        resolvedUrl,
        statusCode,
        "no_article_text",
        "No meaningful body text could be extracted from the page.",
        accessEvidenceCodes,
        diagnostics,
      );
    }

    // Step 10: Check minimum quality threshold
    if (!isUsableBody(bodyText, effectiveResult?.score)) {
      diagnostics.bodyRejectedReason = "below_quality_threshold";

      // Additional checks for rejection reason
      const sentenceEnders = countSentenceEnders(bodyText);
      if (sentenceEnders < 2 && bodyText.length < 3000) {
        diagnostics.bodyRejectedReason = "insufficient_sentences";
      }

      // High link ratio check
      if (effectiveResult?.score && effectiveResult.score.linkTextRatio > 0.5) {
        diagnostics.bodyRejectedReason = "high_link_ratio";
      }

      try { domWindow?.close(); } catch { /* non-fatal */ }
      return fail(
        method,
        resolvedUrl,
        statusCode,
        "too_short",
        `Extracted body text too short or low quality (${bodyText.length} chars).`,
        [`bodyRejected:${diagnostics.bodyRejectedReason}`, ...accessEvidenceCodes],
        diagnostics,
      );
    }

    // Close the jsdom window to free memory after all DOM operations are done
    try { domWindow?.close(); } catch { /* cleanup is non-fatal */ }

    // Step 11: Compute confidence
    const confidence = computeConfidence(
      { method: effectiveResult?.method || "meta", selector: effectiveResult?.score.selector || "none" },
      bodyText.length,
      !!title,
      !!excerpt,
      !!author,
      !!publishedAt,
      access.isPaywall,
    );

    const qualitySignals: string[] = [];
    if (bodyResult) {
      qualitySignals.push(`selector:${effectiveResult!.score.selector}`);
      qualitySignals.push(`method:${effectiveResult!.method}`);
      qualitySignals.push(`score:${effectiveResult!.score.score}`);
      qualitySignals.push(`paragraphs:${effectiveResult!.score.paragraphCount}`);
      qualitySignals.push(`linkRatio:${effectiveResult!.score.linkTextRatio.toFixed(2)}`);
    }
    if (access.classification !== "UNKNOWN") {
      qualitySignals.push(`access_classification:${access.classification}`);
      qualitySignals.push(`access_confidence:${access.confidence}`);
      qualitySignals.push(`access_detector:${access.detectorVersion}`);
      qualitySignals.push(...accessEvidenceCodes);
    }
    if (jsonLdBodyText) {
      qualitySignals.push(`bodySource:jsonld`);
      qualitySignals.push(`jsonLdBodyLength:${jsonLdBodyText.length}`);
    }
    if (bodyText.length > 0) qualitySignals.push(`bodyLength:${bodyText.length}`);

    const resultMethod = bodyResult ? method : "http-meta";

    return {
      ok: true,
      method: resultMethod,
      resolvedUrl,
      statusCode,
      title,
      excerpt,
      bodyText,
      imageUrl,
      author,
      publishedAt,
      isPaywall: access.isPaywall,
      access,
      confidence,
      qualitySignals,
      diagnostics,
    };
  } catch (err: unknown) {
    // Ensure jsdom window is always closed, even on unexpected errors
    try { domWindow?.close(); } catch { /* cleanup is non-fatal */ }
    throw err;
  }
}

const AMP_LINK_RE =
  /<link\b[^>]*\brel=["']amphtml["'][^>]*\bhref=["']([^"']+)["'][^>]*>|<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']amphtml["'][^>]*>/i;

/**
 * Find a publisher-declared `<link rel="amphtml">` alternate in already-
 * fetched HTML (no network request). Only a validated absolute http(s) URL,
 * distinct from the page itself, is returned — never a guessed AMP URL
 * pattern.
 */
function findValidatedAmpAlternate(html: string, pageUrl: string): string | null {
  const match = AMP_LINK_RE.exec(html.slice(0, AMP_LINK_SEARCH_BOUND_CHARS));
  const raw = match?.[1] || match?.[2];
  if (!raw) return null;
  try {
    const resolved = new URL(raw, pageUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    const normalized = resolved.toString();
    if (normalized === pageUrl) return null;
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Extract article content from a URL using HTTP fetch + jsdom DOM parsing.
 *
 * Hardened extraction with multi-candidate scoring, parent/sibling expansion,
 * stricter quality gates, and excerpt-vs-body guard.
 *
 * Returns a typed discriminated union for safe consumption by the
 * enrichment runtime.
 */
export async function extractArticleContentFromUrl(
  input: ExtractArticleContentInput,
): Promise<ArticleContentExtractionResult> {
  const { articleUrl, existingTitle, existingBodyText } = input;

  if (!articleUrl || !articleUrl.trim()) {
    return fail("none", null, null, "missing_article_url", "Article URL is empty or null.");
  }

  // Validate URL format
  try {
    new URL(articleUrl);
  } catch {
    return fail("none", null, null, "missing_article_url", `Invalid URL format: ${articleUrl}`);
  }

  // Step 1: Fetch HTML
  const fetchResult = await fetchArticleHtml(articleUrl, input.telemetry, input.governedFetchContext);

  if (!fetchResult.ok || !fetchResult.html) {
    // HTTP 202 with an empty body is an interstitial/challenge shell (bounded
    // evidence, browser-recoverable) — not a plain fetch/empty failure. HTTP
    // 204/other empty responses keep their existing classification below.
    if (fetchResult.statusCode === 202 && !fetchResult.html) {
      return {
        ...fail(
        "none",
        fetchResult.resolvedUrl,
        202,
        "interstitial_or_challenge",
        "HTTP 202 response returned an empty body — interstitial/challenge shell.",
        ["http_202_interstitial", "empty_or_short_interstitial_html", "htmlLength:0"],
        { htmlLength: 0, bodyRejectedReason: "empty_or_short_interstitial_html", bodySource: "none" },
        ),
        transportUrl: fetchResult.transportUrl,
        originalArticleUrl: fetchResult.originalArticleUrl,
        transportAttempts: fetchResult.transportAttempts,
      };
    }
    const reason = categorizeFetchError(fetchResult);
    return {
      ...fail(
      "none",
      fetchResult.resolvedUrl,
      fetchResult.statusCode || null,
      reason,
      fetchResult.error || "Fetch failed",
      [],
      undefined,
      fetchResult.retryAfterAt,
      ),
      transportUrl: fetchResult.transportUrl,
      originalArticleUrl: fetchResult.originalArticleUrl,
      transportAttempts: fetchResult.transportAttempts,
    };
  }

  // DOM parsing, Readability, candidate scoring, and quality evaluation are
  // processing/extraction time, separate from the HTTP request above.
  const html = fetchResult.html;
  if (!html) {
    return {
      ...fail("none", fetchResult.resolvedUrl, fetchResult.statusCode || null, "empty_html", "Fetched HTML was empty."),
      transportUrl: fetchResult.transportUrl,
      originalArticleUrl: fetchResult.originalArticleUrl,
      transportAttempts: fetchResult.transportAttempts,
    };
  }
  const extract = () => extractArticleContentFromHtml({
    html,
    resolvedUrl: fetchResult.resolvedUrl,
    statusCode: fetchResult.statusCode,
    existingTitle,
    existingBodyText,
    method: "http-dom",
  });
  const result = input.telemetry ? await input.telemetry.timed("extraction", extract) : await extract();

  // Repair 14: a publisher-declared AMP alternate can rescue a genuine
  // content-quality failure (thin/missing body) using the HTML we already
  // fetched — no extra request unless a validated amphtml link is found.
  // Never attempted for network/access-level failures, and never more than
  // once per article (isAmpRetry guard).
  if (!result.ok && !input.isAmpRetry && AMP_RETRY_ELIGIBLE_REASONS.has(result.rejectedReason)) {
    const ampUrl = findValidatedAmpAlternate(html, fetchResult.resolvedUrl || articleUrl);
    if (ampUrl) {
      const ampResult = await extractArticleContentFromUrl({ ...input, articleUrl: ampUrl, isAmpRetry: true });
      if (ampResult.ok) {
        return { ...ampResult, qualitySignals: [...ampResult.qualitySignals, "amp_alternate_used"] };
      }
    }
  }

  const resultWithTransport = {
    ...result,
    qualitySignals: [...result.qualitySignals, ...(fetchResult.qualitySignals || [])],
    transportUrl: fetchResult.transportUrl,
    originalArticleUrl: fetchResult.originalArticleUrl,
    transportAttempts: fetchResult.transportAttempts,
  };
  return resultWithTransport;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseRetryAfter(raw: string | null): string | null {
  if (!raw) return null;
  const seconds = Number(raw.trim());
  const timestamp = Number.isFinite(seconds)
    ? Date.now() + Math.max(0, seconds) * 1000
    : Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function categorizeFetchError(result: FetchResult): ArticleContentExtractionFail["rejectedReason"] {
  if (result.error?.includes("SSRF")) return "fetch_failed";
  if (result.error?.includes("timeout") || result.error?.includes("Timeout") || result.error?.includes("abort")) return "fetch_failed";
  if (result.error?.includes("Non-HTML")) return "non_html_response";
  if (result.statusCode >= 400 && result.statusCode < 500) return "http_error";
  if (result.statusCode >= 500) return "fetch_failed";
  return "fetch_failed";
}

function fail(
  method: ArticleContentExtractionFail["method"],
  resolvedUrl: string | null,
  statusCode: number | null,
  rejectedReason: ArticleContentExtractionFail["rejectedReason"],
  detail: string,
  qualitySignals: string[] = [],
  diagnostics?: Partial<ExtractionDiagnostics>,
  retryAfterAt?: string | null,
  access?: ArticleAccessClassificationResult,
): ArticleContentExtractionFail {
  return {
    ok: false,
    method,
    resolvedUrl,
    statusCode,
    rejectedReason,
    detail,
    confidence: 0,
    qualitySignals,
    diagnostics: { ...emptyDiagnostics(), ...diagnostics },
    access,
    retryAfterAt: retryAfterAt ?? null,
  };
}
