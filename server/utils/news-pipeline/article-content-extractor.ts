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

import { safeFetch } from "../ssrf-guard";
import type { StageBatchProbe } from "./stage-telemetry";
import { loadJsdom } from "./jsdom-runtime";

// ─── Constants ──────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2_000_000; // 2 MB cap on downloaded HTML
const MAX_BODY_TEXT_CHARS = 50_000; // cap stored body text

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

/** Paywall / blocker signal phrases (case-insensitive, generic). */
const PAYWALL_SIGNALS: Array<{ pattern: RegExp; strength: "strong" | "weak" }> = [
  { pattern: /subscribe\s+to\s+(continue|read|unlock|access)/i, strength: "strong" },
  { pattern: /sign\s+in\s+to\s+(continue|read|access)/i, strength: "strong" },
  { pattern: /log\s*in\s+to\s+(continue|read|access)/i, strength: "strong" },
  { pattern: /become\s+a\s+(subscriber|member)\s+to/i, strength: "strong" },
  { pattern: /premium\s+(article|content|subscriber)/i, strength: "strong" },
  { pattern: /this\s+(article|content|story)\s+is\s+(for|available\s+to)\s+(subscribers|members)/i, strength: "strong" },
  { pattern: /paywall/i, strength: "strong" },
  { pattern: /access\s+denied/i, strength: "strong" },
  { pattern: /enable\s+javascript\s+to\s+(continue|read|view)/i, strength: "weak" },
  { pattern: /are\s+you\s+a\s+robot/i, strength: "strong" },
  { pattern: /captcha/i, strength: "weak" },
  { pattern: /blocked\s+by\s+security/i, strength: "strong" },
  { pattern: /please\s+disable\s+your\s+ad\s*blocker/i, strength: "weak" },
];

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
    | "parse_error";
  detail: string;
  confidence: number;
  qualitySignals: string[];
  diagnostics: ExtractionDiagnostics;
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
  bodySource: "dom" | "expanded-dom" | "readability" | "existing-fallback" | "none";
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
}

function buildHttpsUpgradeUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password) return null;
    // Do not reinterpret an explicitly configured non-standard service port.
    if (parsed.port && parsed.port !== "80") return null;
    parsed.protocol = "https:";
    if (parsed.port === "80") parsed.port = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchArticleHtml(url: string, telemetry?: StageBatchProbe): Promise<FetchResult> {
  let response: Response;

  try {
    response = await safeFetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      telemetry,
    });
  } catch (err: unknown) {
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

  const contentType = response.headers.get("content-type");
  const resolvedUrl = response.url || url;
  const statusCode = response.status;

  if (statusCode < 200 || statusCode >= 300) {
    const httpsUpgradeUrl = (statusCode === 401 || statusCode === 403)
      ? buildHttpsUpgradeUrl(url)
      : null;
    if (httpsUpgradeUrl) {
      const upgraded = await fetchArticleHtml(httpsUpgradeUrl, telemetry);
      const upgradeSignal = upgraded.ok
        ? "http_to_https_upgrade_succeeded"
        : "http_to_https_upgrade_failed";
      return {
        ...upgraded,
        error: upgraded.ok
          ? upgraded.error
          : `HTTP ${statusCode}; HTTPS upgrade failed: ${upgraded.error || `HTTP ${upgraded.statusCode}`}`,
        qualitySignals: [...(upgraded.qualitySignals || []), upgradeSignal],
      };
    }
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

  let rawHtml: string;
  try {
    const buffer = await response.arrayBuffer();
    const truncated = buffer.byteLength > MAX_HTML_BYTES
      ? buffer.slice(0, MAX_HTML_BYTES)
      : buffer;
    rawHtml = new TextDecoder("utf-8", { fatal: false }).decode(truncated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      html: null,
      statusCode,
      contentType,
      resolvedUrl,

      error: `Body read failed: ${message}`,
    };
  }

  // Accept HTML even if content-type is missing/wrong, as long as it looks like HTML
  if (!isHtmlLike && !looksLikeHtml(rawHtml)) {
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

  // Skip lines that are mostly punctuation or special chars
  const alphaRatio = (trimmed.replace(/[^a-zA-Z0-9]/g, "").length) / trimmed.length;
  if (alphaRatio < 0.4) return false;

  // Skip single-word or very short fragments
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
  const matches = text.match(/[.!?]+(?=\s|$)/g);
  return matches ? matches.length : 0;
}

// ─── Paywall Detection ──────────────────────────────────────────────────────

interface PaywallDetection {
  isPaywall: boolean | null;
  signals: string[];
}

function detectPaywallSignals(bodyText: string, doc: Document): PaywallDetection {
  const signals: string[] = [];
  let strongCount = 0;
  let weakCount = 0;

  // Check body text against paywall patterns
  for (const { pattern, strength } of PAYWALL_SIGNALS) {
    if (pattern.test(bodyText)) {
      signals.push(`paywall_signal:${pattern.source.slice(0, 40)}`);
      if (strength === "strong") strongCount++;
      else weakCount++;
    }
  }

  // Also check meta tags for paywall hints
  try {
    const isAccessibleForFree = getMetaContent(doc, 'meta[name="isAccessibleForFree"]');
    if (isAccessibleForFree && isAccessibleForFree.toLowerCase() === "false") {
      signals.push("paywall_meta:isAccessibleForFree=false");
      strongCount++;
    }
  } catch { /* skip */ }

  // Check for metered/soft paywall indicators in JSON-LD
  try {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      const text = script.textContent || "";
      if (/"isAccessibleForFree"\s*:\s*false/i.test(text)) {
        signals.push("paywall_jsonld:isAccessibleForFree=false");
        strongCount++;
      }
      if (/"hasPart"[^{]*"@type"\s*:\s*"PaywalledContent"/i.test(text)) {
        signals.push("paywall_jsonld:PaywalledContent");
        strongCount++;
      }
    }
  } catch { /* skip */ }

  if (strongCount >= 1) return { isPaywall: true, signals };
  if (weakCount >= 2) return { isPaywall: true, signals };
  return { isPaywall: null, signals };
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
  if (html.trim().length < 100) {
    return fail(
      method,
      resolvedUrl,
      statusCode,
      "empty_html",
      `HTML too short (${html.trim().length} chars)`,
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
    const bodySource = effectiveResult?.bodySource || "none";

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

    // Also extract raw text from the page for paywall detection.
    // This runs even when bodyText is below the minimum threshold, so short
    // paywall pages are still detected.
    const rawPageText = extractRawPageText(doc);

    // Step 5: Paywall detection (runs on whatever text is available, even below
    // minimum threshold, so short paywall pages are detected correctly)
    const paywall = detectPaywallSignals(rawPageText || bodyText || excerpt || "", doc);

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

    // Step 8: If strong paywall signals AND very short or no body, reject
    if (paywall.isPaywall && (!bodyText || bodyText.length < 200)) {
      diagnostics.bodyRejectedReason = "paywall_short_body";
      try { domWindow?.close(); } catch { /* non-fatal */ }
      return fail(
        method,
        resolvedUrl,
        statusCode,
        "paywall_or_blocked",
        "Strong paywall signals detected and body text is very short.",
        paywall.signals,
        diagnostics,
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
        paywall.signals,
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
        [`bodyRejected:${diagnostics.bodyRejectedReason}`],
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
      paywall.isPaywall,
    );

    const qualitySignals: string[] = [];
    if (bodyResult) {
      qualitySignals.push(`selector:${effectiveResult!.score.selector}`);
      qualitySignals.push(`method:${effectiveResult!.method}`);
      qualitySignals.push(`score:${effectiveResult!.score.score}`);
      qualitySignals.push(`paragraphs:${effectiveResult!.score.paragraphCount}`);
      qualitySignals.push(`linkRatio:${effectiveResult!.score.linkTextRatio.toFixed(2)}`);
    }
    if (paywall.isPaywall) {
      qualitySignals.push(...paywall.signals);
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
      isPaywall: paywall.isPaywall,
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
  const fetchResult = await fetchArticleHtml(articleUrl, input.telemetry);

  if (!fetchResult.ok || !fetchResult.html) {
    const reason = categorizeFetchError(fetchResult);
    return fail(
      "none",
      fetchResult.resolvedUrl,
      fetchResult.statusCode || null,
      reason,
      fetchResult.error || "Fetch failed",
      [],
      undefined,
      fetchResult.retryAfterAt,
    );
  }

  // DOM parsing, Readability, candidate scoring, and quality evaluation are
  // processing/extraction time, separate from the HTTP request above.
  const html = fetchResult.html;
  if (!html) {
    return fail("none", fetchResult.resolvedUrl, fetchResult.statusCode || null, "empty_html", "Fetched HTML was empty.");
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
  if (!fetchResult.qualitySignals?.length) return result;
  return {
    ...result,
    qualitySignals: [...result.qualitySignals, ...fetchResult.qualitySignals],
  };
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
    retryAfterAt: retryAfterAt ?? null,
  };
}
