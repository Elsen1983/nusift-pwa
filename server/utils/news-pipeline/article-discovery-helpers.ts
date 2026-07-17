/**
 * Agent 2 discovery quality helpers.
 *
 * Three independent improvements that feed into the main article-discovery flow:
 * 1. Sitemap / news-sitemap / robots.txt discovery
 * 2. JSON-LD structured data extraction
 * 3. Candidate URL scoring and filtering
 */

import { safeFetch } from "../ssrf-guard";

const USER_AGENT = "NuSift/1.0 Agent2-Discovery";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SITEMAP_URLS = 40;
const MAX_SITEMAP_INDEX_ENTRIES = 5;
/** Extra slots for robots.txt-discovered sitemaps beyond the built-in paths. */
const MAX_ROBOTS_SITEMAP_SLOTS = 3;
const MAX_JSONLD_CANDIDATES = 20;

/**
 * Utility path patterns shared across sitemap filtering, link extraction,
 * and candidate scoring. Single source of truth to prevent drift.
 */
export const BLOCKED_UTILITY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/?$/i, reason: "homepage" },
  { pattern: /^\/about/i, reason: "about_page" },
  { pattern: /^\/contact/i, reason: "contact_page" },
  { pattern: /^\/privacy/i, reason: "privacy_page" },
  { pattern: /^\/terms/i, reason: "terms_page" },
  { pattern: /^\/advertising/i, reason: "advertising_page" },
  { pattern: /^\/newsletter/i, reason: "newsletter_page" },
  { pattern: /^\/newsletters/i, reason: "newsletter_page" },
  { pattern: /^\/preferences/i, reason: "preferences_page" },
  { pattern: /^\/sitemap/i, reason: "sitemap_page" },
  { pattern: /^\/auth/i, reason: "auth_page" },
  { pattern: /^\/login/i, reason: "login_page" },
  { pattern: /^\/signup/i, reason: "signup_page" },
  { pattern: /^\/register/i, reason: "register_page" },
  { pattern: /^\/search/i, reason: "search_page" },
  { pattern: /^\/tag\//i, reason: "tag_page" },
  { pattern: /^\/topic/i, reason: "topic_page" },
  { pattern: /^\/topics/i, reason: "topic_page" },
  { pattern: /^\/category\/?$/i, reason: "category_index" },
  { pattern: /^\/author\/?$/i, reason: "author_index" },
  { pattern: /^\/wp-/i, reason: "wordpress_admin" },
  { pattern: /^\/feed\/?$/i, reason: "feed_url" },
  { pattern: /^\/rss\/?$/i, reason: "rss_url" },
];

const SITEMAP_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/news-sitemap.xml",
  "/post-sitemap.xml",
];

const JSONLD_ARTICLE_TYPES = new Set([
  "NewsArticle",
  "Article",
  "BlogPosting",
  "Report",
  "WebPage",
]);

// ─── Sitemap Discovery ─────────────────────────────────────────────────────

export type SitemapEntry = {
  url: string;
  lastmod?: string | null;
};

/**
 * Fetch a URL and return the text body, or null on any failure.
 * Respects same-domain policy relative to the target origin.
 */
const safeFetchText = async (url: string, targetOrigin: string): Promise<string | null> => {
  try {
    const urlObj = new URL(url);
    const targetObj = new URL(targetOrigin);
    if (urlObj.hostname.replace(/^www\./, "") !== targetObj.hostname.replace(/^www\./, "")) {
      return null;
    }
    const response = await safeFetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml, text/xml, text/plain" },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
};

/**
 * Extract <loc> URLs from sitemap XML using regex (no XML parser dependency).
 */
const extractSitemapLocs = (xml: string): string[] => {
  const urls: string[] = [];
  const regex = /<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const url = match[1]?.trim();
    if (url) urls.push(url);
  }
  return urls;
};

/**
 * Extract <lastmod> values paired with <loc> from sitemap XML.
 */
const extractSitemapEntries = (xml: string): SitemapEntry[] => {
  const entries: SitemapEntry[] = [];
  // Match <url> blocks or bare <loc>/<lastmod> pairs
  const urlBlockRegex = /<url[^>]*>([\s\S]*?)<\/url>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = urlBlockRegex.exec(xml)) !== null) {
    const block = blockMatch[1] || "";
    const loc = block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i)?.[1]?.trim();
    if (!loc) continue;
    const lastmod = block.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i)?.[1]?.trim() || null;
    entries.push({ url: loc, lastmod });
  }

  // Fallback: if no <url> blocks found, try bare <loc> tags
  if (entries.length === 0) {
    const locs = extractSitemapLocs(xml);
    for (const loc of locs) {
      entries.push({ url: loc, lastmod: null });
    }
  }

  return entries;
};

/**
 * Check if a sitemap XML looks like a sitemap index (contains <sitemapindex>).
 */
const isSitemapIndex = (xml: string): boolean => /<sitemapindex[\s>]/i.test(xml);

/**
 * Parse robots.txt for Sitemap: directives.
 */
const extractRobotsSitemaps = (robotsTxt: string): string[] => {
  const sitemaps: string[] = [];
  for (const line of robotsTxt.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(/^sitemap:\s*(\S+)/i);
    if (match?.[1]) sitemaps.push(match[1]);
  }
  return sitemaps;
};

/**
 * Discover article-like URLs from sitemaps for a given target URL.
 *
 * Process:
 * 1. Try /sitemap.xml, /sitemap_index.xml, /news-sitemap.xml, /post-sitemap.xml
 * 2. Parse robots.txt for additional Sitemap: directives
 * 3. For sitemap indexes, follow up to MAX_SITEMAP_INDEX_ENTRIES child sitemaps
 * 4. Extract article-like URLs from all sitemaps
 * 5. Return bounded list of sitemap entries
 */
export async function discoverSitemapUrls(targetUrl: string): Promise<SitemapEntry[]> {
  const origin = new URL(targetUrl).origin;
  const allEntries: SitemapEntry[] = [];
  const seenUrls = new Set<string>();
  const visitedSitemaps = new Set<string>();

  // Collect sitemap URLs to try
  const sitemapCandidates: string[] = [];
  for (const path of SITEMAP_PATHS) {
    sitemapCandidates.push(`${origin}${path}`);
  }

  // Also try robots.txt for sitemap references
  const robotsTxt = await safeFetchText(`${origin}/robots.txt`, origin);
  if (robotsTxt) {
    for (const sitemapUrl of extractRobotsSitemaps(robotsTxt)) {
      if (!sitemapCandidates.includes(sitemapUrl)) {
        sitemapCandidates.push(sitemapUrl);
      }
    }
  }

  // Process sitemaps with index expansion
  const queue = [...sitemapCandidates];
  let processedCount = 0;

  while (queue.length > 0 &&    processedCount < MAX_SITEMAP_INDEX_ENTRIES + SITEMAP_PATHS.length + MAX_ROBOTS_SITEMAP_SLOTS) {
    const sitemapUrl = queue.shift()!;
    const normalized = sitemapUrl.toLowerCase();
    if (visitedSitemaps.has(normalized)) continue;
    visitedSitemaps.add(normalized);
    processedCount += 1;

    const xml = await safeFetchText(sitemapUrl, origin);
    if (!xml) continue;

    if (isSitemapIndex(xml)) {
      // Sitemap index → enqueue child sitemaps
      const childUrls = extractSitemapLocs(xml);
      for (const child of childUrls.slice(0, MAX_SITEMAP_INDEX_ENTRIES)) {
        if (!visitedSitemaps.has(child.toLowerCase())) {
          queue.push(child);
        }
      }
      continue;
    }

    // Regular sitemap → extract entries
    const entries = extractSitemapEntries(xml);
    for (const entry of entries) {
      if (seenUrls.has(entry.url)) continue;
      seenUrls.add(entry.url);
      allEntries.push(entry);
      if (allEntries.length >= MAX_SITEMAP_URLS) return allEntries;
    }
  }

  return allEntries;
}

/**
 * Filter sitemap entries to only article-like URLs.
 * Uses the same domain + path heuristics as the listing page link filter.
 */
export function filterSitemapArticleUrls(
  entries: SitemapEntry[],
  targetUrl: string,
  categoryPathUrl?: string | null,
): SitemapEntry[] {
  const targetHostname = new URL(targetUrl).hostname.replace(/^www\./, "");
  const categoryPath = categoryPathUrl
    ? new URL(categoryPathUrl).pathname.replace(/\/+$/, "") || "/"
    : null;

  return entries.filter((entry) => {
    try {
      const url = new URL(entry.url);
      if (url.hostname.replace(/^www\./, "") !== targetHostname) return false;
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/") return false;

      // Block utility paths
      if (BLOCKED_UTILITY_PATTERNS.some(({ pattern }) => pattern.test(path))) return false;

      // Category scope filter: when a category path is provided, only keep
      // entries that live under that path. Avoids unnecessary detail fetches
      // for articles in unrelated sections.
      if (categoryPath && categoryPath !== "/") {
        if (!(path === categoryPath || path.startsWith(`${categoryPath}/`))) {
          return false;
        }
      }

      // Must look like an article path
      const segments = path.split("/").filter(Boolean);
      if (segments.length >= 2) return true;
      if (segments.length === 1) {
        const last = segments[0] || "";
        if (last.length >= 18) return true;
        if ((last.match(/-/g) || []).length >= 2) return true;
        if (/\d{4,}/.test(last)) return true;
      }
      return false;
    } catch {
      return false;
    }
  });
}

// ─── JSON-LD Structured Data Extraction ────────────────────────────────────

export type JsonLdArticle = {
  url: string;
  headline?: string;
  datePublished?: string;
  description?: string;
  author?: string;
  type: string;
};

/**
 * Parse JSON-LD blocks from HTML and extract article-type entities.
 *
 * Handles:
 * - Single objects and @graph arrays
 * - NewsArticle, Article, BlogPosting, Report, WebPage types
 * - Extracts url, headline, datePublished, description, author
 */
export function extractJsonLdArticles(html: string, pageUrl: string): JsonLdArticle[] {
  const articles: JsonLdArticle[] = [];
  const seenUrls = new Set<string>();

  // Match all <script type="application/ld+json"> blocks
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;

  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const jsonText = scriptMatch[1]?.trim();
    if (!jsonText) continue;

    try {
      const parsed = JSON.parse(jsonText);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      // Also handle @graph arrays
      for (const item of items) {
        if (item?.["@graph"] && Array.isArray(item["@graph"])) {
          items.push(...item["@graph"]);
        }
      }

      for (const item of items) {
        if (!item || typeof item !== "object") continue;

        const itemType = typeof item["@type"] === "string"
          ? item["@type"]
          : Array.isArray(item["@type"]) ? item["@type"][0] : "";

        // Normalize type (strip namespace prefix like "schema:NewsArticle")
        const normalizedType = itemType.replace(/^[^:]*:/, "");
        if (!JSONLD_ARTICLE_TYPES.has(normalizedType)) continue;

        const rawUrl = item.url || item["@id"] || "";
        let resolvedUrl: string;
        try {
          resolvedUrl = new URL(rawUrl, pageUrl).toString();
        } catch {
          continue;
        }

        if (seenUrls.has(resolvedUrl)) continue;
        seenUrls.add(resolvedUrl);

        articles.push({
          url: resolvedUrl,
          headline: typeof item.headline === "string" ? item.headline : undefined,
          datePublished: typeof item.datePublished === "string" ? item.datePublished : undefined,
          description: typeof item.description === "string" ? item.description : undefined,
          author: typeof item.author === "string"
            ? item.author
            : item.author?.name || undefined,
          type: normalizedType,
        });

        if (articles.length >= MAX_JSONLD_CANDIDATES) return articles;
      }
    } catch {
      // Malformed JSON-LD — skip silently
      continue;
    }
  }

  return articles;
}

// ─── Candidate URL Scoring ─────────────────────────────────────────────────

export type CandidateScore = {
  score: number;
  reasons: string[];
  rejected: boolean;
  rejectionReason?: string;
};

const REJECTION_THRESHOLD = 30;

/**
 * Score a candidate URL for likelihood of being an article.
 *
 * Scoring factors (0-100 scale, threshold at 30):
 * - same_domain: +20 (must be same domain)
 * - article_path_pattern: +25 (multi-segment path, date patterns, slug-like)
 * - category_path_match: +15 (path overlaps with target category path)
 * - title_signal: +15 (nearby title text in DOM context)
 * - date_signal: +10 (nearby date/time text or URL date pattern)
 * - not_utility_page: +15 (not blocked utility paths)
 * - penalized: -50 for blocked utility paths
 */
export function scoreCandidateUrl(
  url: string,
  targetUrl: string,
  context?: {
    title?: string | null;
    dateText?: string | null;
    categoryPathUrl?: string | null;
  },
): CandidateScore {
  const reasons: string[] = [];
  let score = 0;

  try {
    const urlObj = new URL(url);
    const targetObj = new URL(targetUrl);
    const hostname = urlObj.hostname.replace(/^www\./, "");
    const targetHostname = targetObj.hostname.replace(/^www\./, "");

    // Same domain check (hard requirement)
    if (hostname !== targetHostname) {
      return { score: 0, reasons: ["different_domain"], rejected: true, rejectionReason: "different_domain" };
    }
    score += 20;
    reasons.push("same_domain");

    const path = urlObj.pathname.replace(/\/+$/, "") || "/";

    // Blocked utility pages
    for (const { pattern, reason } of BLOCKED_UTILITY_PATTERNS) {
      if (pattern.test(path)) {
        return { score: 0, reasons: [reason], rejected: true, rejectionReason: reason };
      }
    }
    score += 15;
    reasons.push("not_utility");

    // Article path pattern scoring
    const segments = path.split("/").filter(Boolean);
    let pathScore = 0;

    if (segments.length >= 2) {
      pathScore += 10;
      reasons.push("multi_segment_path");
    }

    // Date pattern in URL (e.g., /2026/07/16/slug or /20260716/slug)
    if (/\/\d{4}\/\d{2}\/\d{2}\//.test(path) || /\/\d{8,}/.test(path)) {
      pathScore += 10;
      reasons.push("date_in_url");
    }

    // Slug-like pattern (words separated by hyphens, reasonable length)
    const lastSegment = segments[segments.length - 1] || "";
    if (lastSegment.length >= 12 && (lastSegment.match(/-/g) || []).length >= 2) {
      pathScore += 5;
      reasons.push("slug_pattern");
    }

    score += Math.min(pathScore, 25);
    reasons.push(`path_score:${Math.min(pathScore, 25)}`);

    // Category path match
    if (context?.categoryPathUrl) {
      try {
        const categoryPath = new URL(context.categoryPathUrl).pathname.replace(/\/+$/, "") || "/";
        if (categoryPath !== "/" && (path === categoryPath || path.startsWith(`${categoryPath}/`))) {
          score += 15;
          reasons.push("category_match");
        }
      } catch {
        // ignore
      }
    }

    // Title signal
    if (context?.title && context.title.length >= 12) {
      score += 15;
      reasons.push("has_title");
    }

    // Date signal
    if (context?.dateText) {
      score += 10;
      reasons.push("has_date");
    }

    const rejected = score < REJECTION_THRESHOLD;
    return {
      score,
      reasons,
      rejected,
      rejectionReason: rejected ? "low_score" : undefined,
    };
  } catch {
    return { score: 0, reasons: ["invalid_url"], rejected: true, rejectionReason: "invalid_url" };
  }
}
