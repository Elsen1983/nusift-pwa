/**
 * Agent 2 discovery quality helpers.
 *
 * Three independent improvements that feed into the main article-discovery flow:
 * 1. Sitemap / news-sitemap / robots.txt discovery
 * 2. JSON-LD structured data extraction
 * 3. Candidate URL scoring and filtering
 */

import { safeFetch } from "../ssrf-guard";
import { normalizeFeedTextDetailed } from "./normalize-feed-text";
import { hashText, normalizeUrl, stripHtml } from "./text";

const USER_AGENT = "NuSift/1.0 Agent2-Discovery";

// ─── Constants ──────────────────────────────────────────────────────────────

export const DISCOVERY_FRESHNESS_MS = 14 * 24 * 60 * 60 * 1000;

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
  { pattern: /^\/players(?:\/|$)/i, reason: "player_directory" },
  { pattern: /^\/teams(?:\/|$)/i, reason: "team_directory" },
  { pattern: /^\/standings(?:\/|$)/i, reason: "standings_page" },
  { pattern: /^\/schedule(?:\/|$)/i, reason: "schedule_page" },
  { pattern: /^\/scores(?:\/|$)/i, reason: "scores_page" },
  { pattern: /^\/stats(?:\/|$)/i, reason: "stats_page" },
  { pattern: /^\/games(?:\/|$)/i, reason: "games_page" },
  { pattern: /^\/tickets(?:\/|$)/i, reason: "tickets_page" },
  { pattern: /^\/watch(?:\/|$)/i, reason: "watch_page" },
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

// ─── Candidate Outcome Types ──────────────────────────────────────────────

export type ArticleDiscoverySourceKind = "listing" | "sitemap" | "jsonld" | "browser";

export type ArticleDiscoveryOutcomeStatus =
  | "accepted"
  | "rejected_low_score"
  | "rejected_utility_path"
  | "rejected_cross_domain"
  | "rejected_stale"
  | "rejected_missing_title"
  | "rejected_duplicate"
  | "rejected_out_of_scope"
  | "fetch_failed"
  | "detail_validation_failed";

export type ArticleDiscoveryCandidateOutcome = {
  url: string;
  canonicalUrl?: string | null;
  sourceKind: ArticleDiscoverySourceKind;
  status: ArticleDiscoveryOutcomeStatus;
  score?: number;
  scoreReasons?: string[];
  title?: string | null;
  publishedAt?: string | null;
  reason?: string;
  // Stale audit fields (only present on rejected_stale outcomes)
  rawPublishedAt?: string | null;
  normalizedPublishedAt?: string | null;
  publishedAtSource?: PublishedAtSource;
  freshnessCutoffIso?: string;
  ageDays?: number | null;
  staleReason?: StaleAuditMeta["staleReason"];
};

export type ArticleDiscoveryOutcomeSummary = {
  totalEvaluated: number;
  accepted: number;
  rejected: number;
  byStatus: Record<string, number>;
  bySourceKind: Record<string, number>;
  topRejectionReasons: Array<{ reason: string; count: number }>;
};

const MAX_STORED_REJECTED_OUTCOMES = 100;

/**
 * Tracks outcomes for every URL evaluated during Agent 2 discovery.
 * Keeps accepted outcomes unbounded; caps rejected outcomes to limit payload size.
 */
export class ArticleDiscoveryOutcomeTracker {
  private accepted: ArticleDiscoveryCandidateOutcome[] = [];
  private rejected: ArticleDiscoveryCandidateOutcome[] = [];
  private byStatus: Record<string, number> = {};
  private bySourceKind: Record<string, number> = {};

  record(outcome: ArticleDiscoveryCandidateOutcome): void {
    if (outcome.status === "accepted") {
      this.accepted.push(outcome);
    } else if (this.rejected.length < MAX_STORED_REJECTED_OUTCOMES) {
      this.rejected.push(outcome);
    }
    this.byStatus[outcome.status] = (this.byStatus[outcome.status] || 0) + 1;
    this.bySourceKind[outcome.sourceKind] = (this.bySourceKind[outcome.sourceKind] || 0) + 1;
  }

  getSummary(): ArticleDiscoveryOutcomeSummary {
    const rejectionCounts: Record<string, number> = {};
    for (const outcome of this.rejected) {
      const reason = outcome.reason || outcome.status;
      rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
    }
    // Count statuses that were capped
    for (const [status, count] of Object.entries(this.byStatus)) {
      if (status !== "accepted") {
        const storedCount = this.rejected.filter((o) => o.status === status).length;
        if (count > storedCount) {
          const overflowReason = status.replace("rejected_", "");
          rejectionCounts[overflowReason] = (rejectionCounts[overflowReason] || 0) + (count - storedCount);
        }
      }
    }

    const topRejectionReasons = Object.entries(rejectionCounts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalEvaluated: Object.values(this.byStatus).reduce((a, b) => a + b, 0),
      accepted: this.accepted.length,
      rejected: Object.entries(this.byStatus)
        .filter(([s]) => s !== "accepted")
        .reduce((a, [, v]) => a + v, 0),
      byStatus: { ...this.byStatus },
      bySourceKind: { ...this.bySourceKind },
      topRejectionReasons,
    };
  }

  getAccepted(): ArticleDiscoveryCandidateOutcome[] {
    return [...this.accepted];
  }

  getRejected(): ArticleDiscoveryCandidateOutcome[] {
    return [...this.rejected];
  }
}

// ─── Quality Classification & Escalation ──────────────────────────────────

export type ArticleDiscoveryQuality = "productive" | "weak" | "failed" | "blocked";

export type ArticleDiscoveryEscalationReason =
  | "no_candidates"
  | "low_acceptance_rate"
  | "mostly_fetch_failed"
  | "mostly_low_score"
  | "mostly_out_of_scope"
  | "dynamic_or_empty_html"
  | "blocked_or_forbidden"
  | "insufficient_static_signals";

export type ArticleDiscoveryQualityAssessment = {
  quality: ArticleDiscoveryQuality;
  shouldEscalateToHeadless: boolean;
  escalationReasons: ArticleDiscoveryEscalationReason[];
  confidence: "high" | "medium" | "low";
  explanation: string;
};

/**
 * Input for quality assessment. Derived from the outcome tracker summary,
 * discovery sources, and page-level signals collected during the run.
 */
export type ArticleDiscoveryQualityInput = {
  acceptedCount: number;
  totalEvaluated: number;
  pagesVisited: number;
  failed: number;
  byStatus: Record<string, number>;
};

/**
 * Thresholds for quality classification. Conservative and deterministic.
 */
const QUALITY_ACCEPTANCE_RATE_STRONG = 0.10;   // ≥10% acceptance → not weak
const QUALITY_ACCEPTANCE_RATE_WEAK = 0.06;      // <6% acceptance → weak with escalation
const QUALITY_MIN_EVALUATED_FOR_RATE = 5;       // need ≥5 evaluated to judge rate
const QUALITY_FETCH_FAILURE_DOMINANCE = 0.60;    // ≥60% fetch failures → blocked
const QUALITY_LOW_SCORE_DOMINANCE = 0.80;        // ≥80% low-score rejections → weak signals

/**
 * Pure helper: assess the quality of static article discovery for a single target.
 *
 * Uses outcome summary counts and source signals to classify the result as
 * productive / weak / failed / blocked. Returns an escalation marker when
 * the target should be re-tried with a browser/headless fallback later.
 *
 * Rules (deterministic, conservative):
 * - productive: accepted > 0 and acceptance rate is reasonable
 * - weak:       accepted > 0 but acceptance rate is very low
 * - failed:     accepted = 0 and URLs were evaluated
 * - blocked:    accepted = 0 and fetch failures dominate
 */
export function assessArticleDiscoveryQuality(
  input: ArticleDiscoveryQualityInput,
): ArticleDiscoveryQualityAssessment {
  const { acceptedCount, totalEvaluated, pagesVisited, byStatus } = input;

  const fetchFailed = byStatus["fetch_failed"] || 0;
  const lowScore = byStatus["rejected_low_score"] || 0;
  const outOfScope = byStatus["rejected_out_of_scope"] || 0;
  const stale = byStatus["rejected_stale"] || 0;
  const missingTitle = byStatus["rejected_missing_title"] || 0;

  const reasons: ArticleDiscoveryEscalationReason[] = [];
  let quality: ArticleDiscoveryQuality;
  let shouldEscalateToHeadless: boolean;
  let confidence: "high" | "medium" | "low";

  // ── No URLs evaluated at all ──
  if (totalEvaluated === 0 && pagesVisited === 0) {
    return {
      quality: "failed",
      shouldEscalateToHeadless: true,
      escalationReasons: ["dynamic_or_empty_html"],
      confidence: "medium",
      explanation: "No listing pages were successfully fetched. The target may be JS-rendered or blocking requests.",
    };
  }

  // ── No URLs evaluated but pages were visited (listing pages had no links) ──
  if (totalEvaluated === 0 && pagesVisited > 0) {
    return {
      quality: "failed",
      shouldEscalateToHeadless: true,
      escalationReasons: ["dynamic_or_empty_html"],
      confidence: "high",
      explanation: `${pagesVisited} listing page(s) were fetched but yielded no article-like URLs. The page content may be dynamically rendered.`,
    };
  }

  // ── No accepted candidates ──
  if (acceptedCount === 0 && totalEvaluated > 0) {
    const fetchRate = fetchFailed / totalEvaluated;

    // Blocked: fetch failures dominate — the site blocks automated requests
    if (fetchRate >= QUALITY_FETCH_FAILURE_DOMINANCE) {
      return {
        quality: "blocked",
        shouldEscalateToHeadless: true,
        escalationReasons: ["blocked_or_forbidden", "mostly_fetch_failed"],
        confidence: "high",
        explanation: `${fetchFailed}/${totalEvaluated} article fetches failed. The site may block automated requests or require authentication.`,
      };
    }

    // Failed: URLs evaluated, none accepted, fetch failures do not dominate
    const lowScoreRate = totalEvaluated > 0 ? lowScore / totalEvaluated : 0;
    const scopeRate = totalEvaluated > 0 ? outOfScope / totalEvaluated : 0;

    if (lowScoreRate >= QUALITY_LOW_SCORE_DOMINANCE) {
      reasons.push("mostly_low_score", "insufficient_static_signals");
    } else if (scopeRate >= 0.5) {
      reasons.push("mostly_out_of_scope");
    } else if (fetchFailed > 0) {
      reasons.push("mostly_fetch_failed");
    }
    reasons.push("no_candidates");

    return {
      quality: "failed",
      shouldEscalateToHeadless: true,
      escalationReasons: reasons.length > 0 ? reasons : ["no_candidates"],
      confidence: fetchFailed > 0 ? "medium" : "high",
      explanation: `${totalEvaluated} URL(s) were evaluated but none produced valid article candidates. ` +
        (fetchFailed > 0 ? `${fetchFailed} fetch(es) failed. ` : "") +
        (lowScore > 0 ? `${lowScore} had low content scores. ` : "") +
        (stale > 0 ? `${stale} were stale. ` : "") +
        (missingTitle > 0 ? `${missingTitle} lacked titles. ` : "") +
        `Static discovery is insufficient for this target.`,
    };
  }

  // ── Accepted > 0 but fetch failures dominate: weak + escalation ──
  if (acceptedCount > 0 && totalEvaluated > 0) {
    const fetchRate = fetchFailed / totalEvaluated;
    if (fetchRate >= QUALITY_FETCH_FAILURE_DOMINANCE) {
      return {
        quality: "weak",
        shouldEscalateToHeadless: true,
        escalationReasons: ["mostly_fetch_failed", "insufficient_static_signals"],
        confidence: "medium",
        explanation: `Static discovery found ${acceptedCount} article(s) but ${fetchFailed}/${totalEvaluated} fetches failed. Coverage may be incomplete because the site blocks some automated requests.`,
      };
    }
  }

  // ── Accepted > 0: judge acceptance rate ──
  const acceptanceRate = totalEvaluated >= QUALITY_MIN_EVALUATED_FOR_RATE
    ? acceptedCount / totalEvaluated
    : 1; // not enough data to judge → assume OK

  if (acceptanceRate >= QUALITY_ACCEPTANCE_RATE_STRONG) {
    quality = "productive";
    shouldEscalateToHeadless = false;
    confidence = acceptedCount >= 3 ? "high" : "medium";
  } else if (acceptanceRate >= QUALITY_ACCEPTANCE_RATE_WEAK) {
    quality = "weak";
    shouldEscalateToHeadless = false;
    confidence = "medium";
    reasons.push("low_acceptance_rate");
  } else {
    quality = "weak";
    shouldEscalateToHeadless = true;
    confidence = "medium";
    reasons.push("low_acceptance_rate");
    if (fetchFailed > totalEvaluated * 0.3) reasons.push("mostly_fetch_failed");
    if (lowScore > totalEvaluated * 0.5) reasons.push("mostly_low_score");
  }

  const explanation = quality === "productive"
    ? `Discovered ${acceptedCount} article(s) from ${totalEvaluated} evaluated URL(s) (${(acceptanceRate * 100).toFixed(0)}% acceptance rate). Static discovery is effective.`
    : `Discovered ${acceptedCount} article(s) from ${totalEvaluated} evaluated URL(s) (${(acceptanceRate * 100).toFixed(0)}% acceptance rate). Static coverage may be incomplete.`;

  return {
    quality,
    shouldEscalateToHeadless,
    escalationReasons: quality === "productive" ? [] : (reasons.length > 0 ? reasons : ["low_acceptance_rate"]),
    confidence,
    explanation,
  };
}

// ─── Extraction Helpers ──────────────────────────────────────────────────────

type ListingMetadata = {
  title: string;
  description: string;
  publishedAt: Date | null;
  keywords: string[];
};

export const isWithinFreshnessWindow = (publishedAt: Date | null, now = new Date()) => {
  if (!publishedAt) return false;
  const diff = now.getTime() - publishedAt.getTime();
  return diff >= 0 && diff <= DISCOVERY_FRESHNESS_MS;
};

export const normalizePublishedAt = (value: Date | null) =>
  value && !Number.isNaN(value.getTime()) ? value : null;

/**
 * Attempt to normalize a raw date string into a parseable Date.
 * Handles common edge cases:
 * - Leading/trailing whitespace
 * - ISO strings without timezone suffix (treated as UTC by appending Z)
 * - Date-only ISO strings (YYYY-MM-DD) are left as-is (JS parses them)
 * Returns null when the string cannot be parsed into a valid Date.
 */
export function normalizeRawDateString(raw: string): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // If it looks like an ISO datetime without timezone suffix, prefer UTC
  // interpretation by appending Z. JS treats bare ISO datetimes as local
  // time, which varies by server timezone and would produce inconsistent
  // freshness checks. CMS platforms commonly emit these without TZ.
  // Matches: 2026-07-18T14:00:00, 2026-07-18T14:00:00.000, etc.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed) && !/[Zz+\-]\d{2}:?\d{2}$/.test(trimmed)) {
    const withZ = new Date(trimmed + "Z");
    if (!Number.isNaN(withZ.getTime())) return withZ;
  }

  // Fallback: try as-is (handles strings with explicit timezone, date-only
  // ISO strings, RFC 2822 dates, etc.)
  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) return direct;

  return null;
}

// ─── Date Extraction Provenance ──────────────────────────────────────────────

export type PublishedAtSource =
  | "article:published_time"
  | "og:published_time"
  | "article:modified_time"
  | "og:updated_time"
  | "datePublished"
  | "listing_context"
  | "time[datetime]"
  | "meta[name=date]"
  | "meta[itemprop=datePublished]"
  | "url_date"
  | "unknown";

export type DateExtractionResult = {
  rawDate: string | null;
  source: PublishedAtSource;
};

export type StaleAuditMeta = {
  rawPublishedAt: string | null;
  normalizedPublishedAt: string | null;
  publishedAtSource: PublishedAtSource;
  freshnessCutoffIso: string;
  ageDays: number | null;
  staleReason:
    | "published_at_before_cutoff"
    | "missing_published_at"
    | "invalid_published_at"
    | "future_published_at"
    | "unknown";
};

const LISTING_CONTEXT_FUTURE_TOLERANCE_MS = 36 * 60 * 60 * 1000;

function isWithinListingContextFutureTolerance(
  extraction: DateExtractionResult,
  normalizedDate: Date | null,
  now = new Date(),
): boolean {
  if (extraction.source !== "listing_context" || !normalizedDate) return false;
  const futureMs = normalizedDate.getTime() - now.getTime();
  return futureMs > 0 && futureMs <= LISTING_CONTEXT_FUTURE_TOLERANCE_MS;
}

/**
 * Extract the publication date from HTML with provenance tracking.
 * Checks standard meta tags in priority order, then falls back to URL date.
 *
 * Priority order ensures publish dates win over modified/update timestamps:
 *   1. article:published_time (property or name)
 *   2. og:published_time (property or name)
 *   3. pubdate / publishdate (legacy meta)
 *   4. JSON-LD datePublished
 *   5. meta itemprop=datePublished
 *   6. <time datetime>
 *   7. meta name=date
 *   8. URL date pattern
 *   9. article:modified_time (fallback — only when no publish date exists)
 *  10. og:updated_time (fallback — only when no publish date exists)
 *
 * Returns the raw date string and which source it came from.
 */
export function extractDateFromHtml(html: string, pageUrl?: string): DateExtractionResult {
  // ── Publish-side sources (highest priority) ──────────────────────────

  // Priority 1: article:published_time (property or name)
  const articlePublished =
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (articlePublished) return { rawDate: articlePublished, source: "article:published_time" };

  // Priority 2: og:published_time (property or name)
  const ogPublished =
    html.match(/<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']og:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (ogPublished) return { rawDate: ogPublished, source: "og:published_time" };

  // Priority 3: pubdate / publishdate (legacy meta names)
  const pubdate =
    html.match(/<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']publishdate["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (pubdate) return { rawDate: pubdate, source: "article:published_time" };

  // Priority 4: JSON-LD datePublished
  const jsonLdDate = html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1];
  if (jsonLdDate) return { rawDate: jsonLdDate, source: "datePublished" };

  // Priority 5: meta itemprop=datePublished
  const itempropDate = html.match(/<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (itempropDate) return { rawDate: itempropDate, source: "meta[itemprop=datePublished]" };

  // Priority 6: <time datetime>
  const timeDatetime = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  if (timeDatetime) return { rawDate: timeDatetime, source: "time[datetime]" };

  // Priority 7: meta name=date
  const metaDate = html.match(/<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (metaDate) return { rawDate: metaDate, source: "meta[name=date]" };

  // Priority 8: URL date pattern
  if (pageUrl) {
    const urlDate = extractDateFromUrl(pageUrl);
    if (urlDate) return { rawDate: urlDate, source: "url_date" };
  }

  // ── Modified/update fallbacks (lowest priority) ──────────────────────
  // Only used when no publish date was found above.
  // These represent page modification times, not article publish dates,
  // and can be misleadingly old (e.g. layout changes).

  // Priority 9: article:modified_time
  const articleModified =
    html.match(/<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']article:modified_time["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (articleModified) return { rawDate: articleModified, source: "article:modified_time" };

  // Priority 10: og:updated_time
  const ogUpdated =
    html.match(/<meta[^>]+property=["']og:updated_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']og:updated_time["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (ogUpdated) return { rawDate: ogUpdated, source: "og:updated_time" };

  return { rawDate: null, source: "unknown" };
}

/**
 * Extract a date string from common URL path patterns.
 * Returns the first matched pattern or null.
 */
export function extractDateFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const buildValidDate = (year: string, month: string, day: string) => {
      const y = Number(year);
      const m = Number(month);
      const d = Number(day);
      if (y < 1900 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return null;
      return `${year}-${month}-${day}`;
    };

    // YYYY/MM/DD pattern
    const ymd = pathname.match(/\/(\d{4})\/(\d{2})\/(\d{2})\b/);
    if (ymd) return buildValidDate(ymd[1]!, ymd[2]!, ymd[3]!);
    // YYYYMMDD as its own path segment or slug prefix. Reject arbitrary
    // numeric article IDs such as /news/279204889/... .
    const compact = pathname.match(/\/((?:19|20)\d{2})(\d{2})(\d{2})(?:\b|[-_/])/);
    if (compact) return buildValidDate(compact[1]!, compact[2]!, compact[3]!);
    // YYYY/MM pattern
    const ym = pathname.match(/\/(\d{4})\/(\d{2})\b/);
    if (ym) return buildValidDate(ym[1]!, ym[2]!, "01");
    return null;
  } catch {
    return null;
  }
}

/**
 * Build stale audit metadata for a rejected_stale outcome.
 */
export function buildStaleAuditMeta(
  extraction: DateExtractionResult,
  normalizedDate: Date | null,
  freshnessMs: number,
  now = new Date(),
): StaleAuditMeta {
  const cutoff = new Date(now.getTime() - freshnessMs);

  if (!extraction.rawDate) {
    return {
      rawPublishedAt: null,
      normalizedPublishedAt: null,
      publishedAtSource: extraction.source,
      freshnessCutoffIso: cutoff.toISOString(),
      ageDays: null,
      staleReason: "missing_published_at",
    };
  }

  if (!normalizedDate) {
    return {
      rawPublishedAt: extraction.rawDate,
      normalizedPublishedAt: null,
      publishedAtSource: extraction.source,
      freshnessCutoffIso: cutoff.toISOString(),
      ageDays: null,
      staleReason: "invalid_published_at",
    };
  }

  const ageMs = now.getTime() - normalizedDate.getTime();
  const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));

  if (ageMs < 0) {
    return {
      rawPublishedAt: extraction.rawDate,
      normalizedPublishedAt: normalizedDate.toISOString(),
      publishedAtSource: extraction.source,
      freshnessCutoffIso: cutoff.toISOString(),
      ageDays,
      staleReason: "future_published_at",
    };
  }

  if (normalizedDate < cutoff) {
    return {
      rawPublishedAt: extraction.rawDate,
      normalizedPublishedAt: normalizedDate.toISOString(),
      publishedAtSource: extraction.source,
      freshnessCutoffIso: cutoff.toISOString(),
      ageDays,
      staleReason: "published_at_before_cutoff",
    };
  }

  return {
    rawPublishedAt: extraction.rawDate,
    normalizedPublishedAt: normalizedDate.toISOString(),
    publishedAtSource: extraction.source,
    freshnessCutoffIso: cutoff.toISOString(),
    ageDays,
    staleReason: "unknown",
  };
}

/**
 * Build a compact stale sample suffix for Agent 2 log messages.
 * Returns up to 3 stale samples with truncated date and URL.
 * Empty string when no stale rejections are present.
 */
export function buildStaleSampleLog(
  rejectedOutcomes: ArticleDiscoveryCandidateOutcome[],
  maxSamples = 3,
): string {
  const staleEntries = rejectedOutcomes
    .filter((o) => o.status === "rejected_stale")
    .slice(0, maxSamples);

  if (staleEntries.length === 0) return "";

  const samples = staleEntries.map((entry) => {
    const reason = entry.staleReason || "unknown";
    const date = entry.normalizedPublishedAt
      ? entry.normalizedPublishedAt.slice(0, 10)
      : entry.rawPublishedAt
        ? `raw:${entry.rawPublishedAt.slice(0, 20)}`
        : "missing-date";
    const source = entry.publishedAtSource || "";
    const shortUrl = truncateUrl(entry.url, 50);
    return source
      ? `${reason}|${date}|${source}:${shortUrl}`
      : `${reason}|${date}:${shortUrl}`;
  });

  return ` staleSample=[${samples.join(", ")}]`;
}

/**
 * Truncate a URL for compact display, preserving the domain and trimming
 * the path safely in the middle if too long.
 */
function truncateUrl(url: string, maxLen: number): string {
  if (url.length <= maxLen) return url;
  try {
    const u = new URL(url);
    const domain = u.hostname.replace(/^www\./, "");
    const path = u.pathname;
    const budget = maxLen - domain.length - 4;
    if (path.length <= budget) return `${domain}${path}`;
    const halfBudget = Math.floor(budget / 2) - 1;
    return `${domain}${path.slice(0, halfBudget)}...${path.slice(-halfBudget)}`;
  } catch {
    return url.length > maxLen ? `${url.slice(0, maxLen - 3)}...` : url;
  }
}

export const isBlockedDiscoveryPath = (href: string) => {
  try {
    const pathname = new URL(href).pathname.replace(/\/+$/, "") || "/";
    return BLOCKED_UTILITY_PATTERNS.some(({ pattern }) => pattern.test(pathname));
  } catch {
    return true;
  }
};

export const extractPageMetadata = (html: string): ListingMetadata => {
  const title =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    "";
  const description =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    "";
  const publishedAtRaw =
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']publishdate["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] ||
    "";
  const keywords =
    html.match(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']+)["']/i)?.[1]
      ?.split(",")
      .map((value) => normalizeFeedTextDetailed(value).value)
      .filter(Boolean) || [];

  return {
    title: stripHtml(title),
    description: stripHtml(description),
    publishedAt: publishedAtRaw ? new Date(publishedAtRaw) : null,
    keywords,
  };
};

// ─── Shared Article Link Evaluation ────────────────────────────────────────

type EvaluatedCandidate = {
  sourceId: string;
  categoryId?: string;
  sourceUrl: string;
  canonicalUrl: string;
  rssGuid: null;
  rawTitle: string;
  title: string;
  publishedAt: Date | null;
  rawBodyText: string;
  bodyText: string | null;
  contentHash: string;
  isPaywall: boolean;
  rawTags: string[];
  rawSignals: string[];
  reasoning: string;
  normalizationFlags: string[];
  provenance: {
    origin: "web_discovery";
    feedUrl: null;
    feedFormat: string;
    discoveredFromCategoryFeed: boolean;
    sourcePageUrl: string;
    fetchedAt: string;
  };
};

export type EvaluateArticleLinkResult =
  | { accepted: true; candidate: EvaluatedCandidate; outcome: ArticleDiscoveryCandidateOutcome }
  | { accepted: false; candidate: null; outcome: ArticleDiscoveryCandidateOutcome };

/**
 * Shared helper: fetch an article page, evaluate it against the target, and
 * return a candidate + outcome. Used by both static Agent 2 discovery and
 * the browser fallback queue consumer.
 *
 * This function does NOT update skip summary or rejected items — the caller
 * is responsible for those bookkeeping concerns.
 */
type EvaluateArticleLinkCandidateFromMetadataInput = {
  articleUrl: string;
  sourcePageUrl: string;
  targetUrl: string;
  sourceId: string;
  categoryId?: string | null;
  title: string;
  description: string;
  keywords: string[];
  publishedAtRaw: string | null;
  publishedAtSource: PublishedAtSource;
  bodyFallback: string;
  html?: string | null;
  freshnessMs?: number;
  extraRawSignals?: string[];
  /**
   * Browser fallback-only escape hatch for rendered listing pages that expose
   * strong article links and titles but no usable publish date metadata.
   * Static/RSS discovery must keep strict date freshness behavior.
   */
  allowWeakPublishedAt?: boolean;
  /**
   * Optional canonical URL override extracted from the rendered page
   * (e.g. <link rel="canonical"> or JSON-LD). When provided and valid,
   * this is used instead of normalizeUrl(articleUrl) for candidate identity
   * and dedupe. Invalid or cross-domain overrides safely fall back to
   * the article URL.
   */
  canonicalUrlOverride?: string | null;
};

const resolveSourceKindFromSourcePageUrl = (spu: string): ArticleDiscoverySourceKind => {
  if (spu.startsWith("sitemap:")) return "sitemap";
  if (spu.startsWith("jsonld:")) return "jsonld";
  if (spu.startsWith("browser:")) return "browser";
  return "listing";
};

/**
 * Shared builder for Agent 2 article candidates. Validates and scores a URL
 * using already-extracted page metadata. Used by the static fetch path and by
 * the browser-based detail recovery path so both produce the same candidate
 * shape and outcome semantics.
 */
export async function evaluateArticleLinkCandidateFromExtractedMetadata(
  input: EvaluateArticleLinkCandidateFromMetadataInput,
): Promise<EvaluateArticleLinkResult> {
  const {
    articleUrl,
    sourcePageUrl,
    targetUrl,
    sourceId,
    title,
    description,
    keywords,
    publishedAtRaw,
    publishedAtSource,
    bodyFallback,
    html,
    freshnessMs: customFreshnessMs,
    extraRawSignals = [],
    allowWeakPublishedAt = false,
  } = input;
  const categoryId = input.categoryId || undefined;

  const makeOutcome = (
    url: string,
    spu: string,
    status: ArticleDiscoveryCandidateOutcome["status"],
    overrides?: Partial<ArticleDiscoveryCandidateOutcome>,
  ): ArticleDiscoveryCandidateOutcome => ({
    url,
    sourceKind: resolveSourceKindFromSourcePageUrl(spu),
    status,
    ...overrides,
  });

  const tryNormalize = (raw: string): string | null => {
    try {
      const normalized = normalizeUrl(raw);
      return normalized || null;
    } catch {
      return null;
    }
  };

  const canonicalUrl =
    tryNormalize(input.canonicalUrlOverride || "") ||
    normalizeUrl(articleUrl);

  // Block utility paths on BOTH the article URL and the canonical URL so that
  // a canonical override cannot bypass utility-path rejection.
  if (!canonicalUrl || isBlockedDiscoveryPath(canonicalUrl) || isBlockedDiscoveryPath(articleUrl)) {
    return {
      accepted: false,
      candidate: null,
      outcome: makeOutcome(articleUrl, sourcePageUrl, "rejected_utility_path", { canonicalUrl, title }),
    };
  }

  const canonicalHostname = new URL(canonicalUrl).hostname.replace(/^www\./, "");
  const targetHostname = new URL(targetUrl).hostname.replace(/^www\./, "");
  if (canonicalHostname !== targetHostname) {
    return {
      accepted: false,
      candidate: null,
      outcome: makeOutcome(articleUrl, sourcePageUrl, "rejected_cross_domain", {
        canonicalUrl,
        title,
        reason: "cross-domain redirect",
      }),
    };
  }

  // Category scope check is preserved only for sitemap/jsonld sources, matching
  // the behaviour of the original static path.
  if (categoryId && (sourcePageUrl.startsWith("sitemap:") || sourcePageUrl.startsWith("jsonld:"))) {
    const categoryPath = targetUrl.replace(/\/+$/, "").replace(/^https?:\/\/[^/]+/, "") || "/";
    const articlePath = canonicalUrl.replace(/\/+$/, "").replace(/^https?:\/\/[^/]+/, "") || "/";
    if (categoryPath !== "/" && !(articlePath === categoryPath || articlePath.startsWith(`${categoryPath}/`))) {
      return {
        accepted: false,
        candidate: null,
        outcome: makeOutcome(articleUrl, sourcePageUrl, "rejected_out_of_scope", {
          canonicalUrl,
          title,
          reason: "outside category path",
        }),
      };
    }
  }

  const score = scoreCandidateUrl(canonicalUrl, targetUrl, {
    title,
    dateText: publishedAtRaw,
    categoryPathUrl: categoryId ? targetUrl : null,
  });
  if (score.rejected) {
    return {
      accepted: false,
      candidate: null,
      outcome: makeOutcome(articleUrl, sourcePageUrl, "rejected_low_score", {
        canonicalUrl,
        title,
        score: score.score,
        scoreReasons: score.reasons,
        reason: score.rejectionReason,
      }),
    };
  }

  const previewTitle = title || canonicalUrl;
  if (!previewTitle || previewTitle.length < 12) {
    return {
      accepted: false,
      candidate: null,
      outcome: makeOutcome(articleUrl, sourcePageUrl, "rejected_missing_title", {
        canonicalUrl,
        title: previewTitle,
        reason: "title too short or missing",
      }),
    };
  }

  const freshnessMs = customFreshnessMs ?? DISCOVERY_FRESHNESS_MS;

  // Build date extraction result, falling back to a URL-derived date when no
  // explicit date metadata was supplied.
  let dateExtraction: DateExtractionResult = { rawDate: publishedAtRaw, source: publishedAtSource };
  if (!dateExtraction.rawDate) {
    const urlDate = extractDateFromUrl(articleUrl);
    if (urlDate) {
      dateExtraction = { rawDate: urlDate, source: "url_date" };
    }
  }

  const normalizedPublishedAt = normalizeRawDateString(dateExtraction.rawDate || "");
  const acceptedWithListingFutureTolerance = isWithinListingContextFutureTolerance(
    dateExtraction,
    normalizedPublishedAt,
  );
  const acceptedWithWeakPublishedAt = Boolean(
    allowWeakPublishedAt &&
    !dateExtraction.rawDate &&
    score.score >= 60,
  );
  const effectivePublishedAt = normalizedPublishedAt ?? (acceptedWithWeakPublishedAt ? new Date() : null);

  if (
    !acceptedWithWeakPublishedAt &&
    !isWithinFreshnessWindow(normalizedPublishedAt, new Date()) &&
    !acceptedWithListingFutureTolerance
  ) {
    const staleAudit = buildStaleAuditMeta(dateExtraction, normalizedPublishedAt, freshnessMs);
    return {
      accepted: false,
      candidate: null,
      outcome: makeOutcome(articleUrl, sourcePageUrl, "rejected_stale", {
        canonicalUrl,
        title: previewTitle,
        publishedAt: normalizedPublishedAt?.toISOString() ?? null,
        reason:
          staleAudit.staleReason === "missing_published_at"
            ? "missing publishedAt"
            : staleAudit.staleReason === "invalid_published_at"
              ? "invalid publishedAt"
              : staleAudit.staleReason === "future_published_at"
                ? "future publishedAt"
                : "outside freshness window",
        rawPublishedAt: staleAudit.rawPublishedAt,
        normalizedPublishedAt: staleAudit.normalizedPublishedAt,
        publishedAtSource: staleAudit.publishedAtSource,
        freshnessCutoffIso: staleAudit.freshnessCutoffIso,
        ageDays: staleAudit.ageDays,
        staleReason: staleAudit.staleReason,
      }),
    };
  }

  const rawTitle = title || canonicalUrl;
  const rawBodyText = description || bodyFallback || "";
  const normalizedTitle = normalizeFeedTextDetailed(rawTitle);
  const normalizedBody = normalizeFeedTextDetailed(rawBodyText);
  const finalTitle = normalizedTitle.value || canonicalUrl;
  const bodyText = normalizedBody.value;
  const contentHash = await hashText([finalTitle, canonicalUrl, bodyText].filter(Boolean).join("|"));
  const isPaywall = /paywall|subscribe|premium/i.test(html || `${title} ${description}`);
  const rawTags = [...new Set(keywords.filter(Boolean))];

  const candidate: EvaluatedCandidate = {
    sourceId,
    categoryId,
    sourceUrl: targetUrl,
    canonicalUrl,
    rssGuid: null,
    rawTitle,
    title: finalTitle,
    publishedAt: effectivePublishedAt,
    rawBodyText,
    bodyText: bodyText || null,
    contentHash,
    isPaywall,
    rawTags,
    rawSignals: [
      "agent2-web-discovery",
      ...extraRawSignals,
      ...(acceptedWithListingFutureTolerance ? ["accepted_with_listing_future_tolerance"] : []),
      ...(acceptedWithWeakPublishedAt ? ["accepted_with_browser_weak_published_at"] : []),
      sourcePageUrl,
      `score:${score.score}`,
      ...(keywords.length > 0 ? [`keywords:${keywords.slice(0, 5).join(",")}`] : []),
    ],
    reasoning: `Agent 2 web discovery from ${sourcePageUrl} (score=${score.score}, reasons=${score.reasons.join(",")})`,
    normalizationFlags: [
      ...new Set([
        ...(normalizedTitle.changed ? normalizedTitle.flags : []),
        ...(normalizedBody.changed ? normalizedBody.flags : []),
      ]),
    ],
    provenance: {
      origin: "web_discovery",
      feedUrl: null,
      feedFormat: "unknown",
      discoveredFromCategoryFeed: Boolean(categoryId),
      sourcePageUrl,
      fetchedAt: new Date().toISOString(),
    },
  };

  return {
    accepted: true,
    candidate,
    outcome: makeOutcome(articleUrl, sourcePageUrl, "accepted", {
      canonicalUrl,
      title: finalTitle,
      publishedAt: effectivePublishedAt?.toISOString(),
      score: score.score,
      scoreReasons: [
        ...score.reasons,
        ...(acceptedWithListingFutureTolerance ? ["accepted_with_listing_future_tolerance"] : []),
      ],
      reason: acceptedWithListingFutureTolerance ? "accepted with listing-context future-date tolerance" : undefined,
    }),
  };
}

export async function evaluateArticleLinkCandidate(input: {
  articleUrl: string;
  sourcePageUrl: string;
  targetUrl: string;
  sourceId: string;
  categoryId?: string | null;
  freshnessMs?: number;
  listingDateFallbackRaw?: string | null;
}): Promise<EvaluateArticleLinkResult> {
  const { articleUrl, sourcePageUrl, targetUrl, sourceId } = input;

  const response = await safeFetch(articleUrl, {
    headers: {
      "User-Agent": "NuSift/1.0 Agent2-Discovery",
      Accept: "text/html,application/xhtml+xml",
    },
  }).catch(() => null);

  if (!response || !response.ok) {
    return {
      accepted: false,
      candidate: null,
      outcome: {
        url: articleUrl,
        sourceKind: resolveSourceKindFromSourcePageUrl(sourcePageUrl),
        status: "fetch_failed",
        reason: `HTTP ${response?.status || "no_response"}`,
      } as ArticleDiscoveryCandidateOutcome,
    };
  }

  const html = await response.text();
  const meta = extractPageMetadata(html);
  let dateExtraction = extractDateFromHtml(html, articleUrl);
  if (
    input.listingDateFallbackRaw &&
    (!dateExtraction.rawDate || !normalizeRawDateString(dateExtraction.rawDate))
  ) {
    dateExtraction = {
      rawDate: input.listingDateFallbackRaw,
      source: "listing_context",
    };
  }

  return evaluateArticleLinkCandidateFromExtractedMetadata({
    articleUrl,
    sourcePageUrl,
    targetUrl,
    sourceId,
    categoryId: input.categoryId,
    title: meta.title,
    description: meta.description,
    keywords: meta.keywords,
    publishedAtRaw: dateExtraction.rawDate,
    publishedAtSource: dateExtraction.source,
    bodyFallback: stripHtml(html).slice(0, 600),
    html,
    freshnessMs: input.freshnessMs,
  });
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
