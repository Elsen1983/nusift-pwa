/**
 * Agent 1 / Agent 2 shared URL acceptance policy.
 *
 * Scores candidate article URLs by combining negative signals
 * (utility pages, listing/topic pages, media clips, account pages)
 * with positive signals (date paths, long slugs, numeric IDs,
 * article suffixes).
 *
 * Core principle: reject obvious non-article URLs early, but
 * do not reject valid article URLs. Conservative — only rejects
 * when negative confidence is high and positive article evidence
 * is weak.
 *
 * No publisher-specific hardcoding. All rules are generic.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ArticleUrlRejectReason =
  | "invalid_url"
  | "listing_or_topic_path"
  | "search_or_query_page"
  | "account_or_private_path"
  | "checkout_or_referral_path"
  | "feed_or_archive_path"
  | "author_or_profile_path"
  | "media_clip_path"
  | "video_only_path"
  | "utility_path"
  | "low_article_url_confidence";

export type ArticleUrlPolicyResult = {
  accepted: boolean;
  reason: ArticleUrlRejectReason | null;
  normalizedUrl: string | null;
  signals: string[];
};

// ─── URL Normalization ──────────────────────────────────────────────────────

/**
 * Parse and normalize a URL for policy evaluation.
 * Returns null if the URL is invalid.
 *
 * Exported for diagnostic/test use. Production callers should prefer
 * `classifyArticleUrl()` or `isLikelyArticleUrl()` which call this internally.
 */
export function normalizeArticleUrlForPolicy(url: string): URL | null {
  try {
    const parsed = new URL(url);
    // Reject non-http(s) schemes
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    // Require a hostname
    if (!parsed.hostname || parsed.hostname.length < 3) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Negative Signal Patterns ───────────────────────────────────────────────

type NegativePattern = {
  pattern: RegExp;
  reason: ArticleUrlRejectReason;
  weight: number;
  label: string;
};

/**
 * Negative signal patterns. Each entry has:
 * - pattern: regex matched against the lowercase pathname
 * - reason: the rejection reason if this is the dominant signal
 * - weight: negative score contribution (always negative)
 * - label: signal label for diagnostics
 *
 * Patterns are ordered by specificity — more specific patterns
 * should come first so label assignment is deterministic.
 */
const NEGATIVE_PATTERNS: NegativePattern[] = [
  // ── Media clips / audio / podcast ────────────────────────────────
  // Radio/audio clip pages are almost never articles.
  { pattern: /\/radio\/clips?\//i, reason: "media_clip_path", weight: -80, label: "radio_clips" },
  { pattern: /\/podcasts?\//i, reason: "media_clip_path", weight: -60, label: "podcast" },
  { pattern: /\/audio\//i, reason: "media_clip_path", weight: -60, label: "audio" },
  { pattern: /\/listen(?:\/|$)/i, reason: "media_clip_path", weight: -60, label: "listen" },
  { pattern: /\/player\//i, reason: "media_clip_path", weight: -50, label: "player" },
  { pattern: /(?:^|\/)clips?(?:\/|$)/i, reason: "media_clip_path", weight: -70, label: "clips" },
  { pattern: /\/gallery\//i, reason: "media_clip_path", weight: -40, label: "gallery" },
  { pattern: /\/embed\//i, reason: "media_clip_path", weight: -70, label: "embed" },
  { pattern: /(?:^|\/)video(?:\/|$)/i, reason: "video_only_path", weight: -60, label: "video" },
  { pattern: /(?:^|\/)video-/i, reason: "video_only_path", weight: -50, label: "video_prefix" },
  { pattern: /\.(?:mp3|mp4|wav|m3u8|ogg|webm)(?:$|\?)/i, reason: "media_clip_path", weight: -100, label: "media_file" },

  // ── Topic / tag / category listing pages ─────────────────────────
  // These are aggregation pages, not individual articles.
  // Patterns use `(?:^|\/)topics?` so they match at any position in the path
  // (e.g. /hindi/topics/xyz, /news/tag/politics).
  { pattern: /(?:^|\/)topics?(?:\/|$)/i, reason: "listing_or_topic_path", weight: -80, label: "topic" },
  { pattern: /(?:^|\/)tags?(?:\/|$)/i, reason: "listing_or_topic_path", weight: -80, label: "tag" },
  { pattern: /(?:^|\/)categor(?:y|ies)(?:\/|$)/i, reason: "listing_or_topic_path", weight: -80, label: "category" },
  { pattern: /(?:^|\/)sections?(?:\/|$)/i, reason: "listing_or_topic_path", weight: -60, label: "section" },
  { pattern: /(?:^|\/)hub(?:\/|$)/i, reason: "listing_or_topic_path", weight: -60, label: "hub" },
  { pattern: /^\/latest(?:\/|$)/i, reason: "listing_or_topic_path", weight: -70, label: "latest" },
  { pattern: /^\/most[-_]?read(?:\/|$)/i, reason: "listing_or_topic_path", weight: -80, label: "most_read" },
  { pattern: /^\/popular(?:\/|$)/i, reason: "listing_or_topic_path", weight: -60, label: "popular" },
  { pattern: /^\/trending(?:\/|$)/i, reason: "listing_or_topic_path", weight: -70, label: "trending" },
  { pattern: /^\/liveblog(?:\/|$)/i, reason: "listing_or_topic_path", weight: -60, label: "liveblog" },
  { pattern: /^\/live(?:\/|$)/i, reason: "listing_or_topic_path", weight: -40, label: "live" },
  { pattern: /^\/archive(?:s)?(?:\/|$)/i, reason: "feed_or_archive_path", weight: -80, label: "archive" },
  { pattern: /^\/sitemap/i, reason: "feed_or_archive_path", weight: -100, label: "sitemap" },
  { pattern: /^\/index\./i, reason: "listing_or_topic_path", weight: -80, label: "index_page" },

  // ── Account / private / utility pages ────────────────────────────
  { pattern: /^\/login(?:\/|$)/i, reason: "account_or_private_path", weight: -100, label: "login" },
  { pattern: /^\/sign[-_]?in(?:\/|$)/i, reason: "account_or_private_path", weight: -100, label: "signin" },
  { pattern: /^\/register(?:\/|$)/i, reason: "account_or_private_path", weight: -100, label: "register" },
  { pattern: /^\/account(?:\/|$)/i, reason: "account_or_private_path", weight: -90, label: "account" },
  { pattern: /^\/profile(?:\/|$)/i, reason: "account_or_private_path", weight: -70, label: "profile" },
  { pattern: /^\/user(?:s)?(?:\/|$)/i, reason: "account_or_private_path", weight: -70, label: "user" },
  { pattern: /^\/my(?:\/|$)/i, reason: "account_or_private_path", weight: -80, label: "my" },
  { pattern: /^\/settings(?:\/|$)/i, reason: "account_or_private_path", weight: -90, label: "settings" },
  { pattern: /^\/dashboard(?:\/|$)/i, reason: "account_or_private_path", weight: -80, label: "dashboard" },
  { pattern: /^\/manage(?:\/|$)/i, reason: "account_or_private_path", weight: -80, label: "manage" },

  // ── Checkout / referral / commerce ───────────────────────────────
  { pattern: /^\/checkout(?:\/|$)/i, reason: "checkout_or_referral_path", weight: -100, label: "checkout" },
  { pattern: /^\/referral(?:\/|$)/i, reason: "checkout_or_referral_path", weight: -100, label: "referral" },
  { pattern: /^\/subscribe(?:\/|$)/i, reason: "checkout_or_referral_path", weight: -80, label: "subscribe" },
  { pattern: /^\/subscription(?:\/|$)/i, reason: "checkout_or_referral_path", weight: -80, label: "subscription" },
  { pattern: /^\/cart(?:\/|$)/i, reason: "checkout_or_referral_path", weight: -100, label: "cart" },
  { pattern: /^\/shop(?:\/|$)/i, reason: "checkout_or_referral_path", weight: -80, label: "shop" },
  { pattern: /^\/pricing(?:\/|$)/i, reason: "checkout_or_referral_path", weight: -80, label: "pricing" },
  { pattern: /^\/store(?:\/|$)/i, reason: "checkout_or_referral_path", weight: -70, label: "store" },

  // ── Feed / RSS / Atom ────────────────────────────────────────────
  { pattern: /^\/feed(?:\/|$)/i, reason: "feed_or_archive_path", weight: -100, label: "feed" },
  { pattern: /^\/rss(?:\/|$)/i, reason: "feed_or_archive_path", weight: -100, label: "rss" },
  { pattern: /^\/atom(?:\/|$)/i, reason: "feed_or_archive_path", weight: -100, label: "atom" },

  // ── Search / query pages ─────────────────────────────────────────
  { pattern: /^\/search(?:\/|$)/i, reason: "search_or_query_page", weight: -100, label: "search_path" },
  { pattern: /^\/find(?:\/|$)/i, reason: "search_or_query_page", weight: -80, label: "find" },

  // ── Author / profile pages ───────────────────────────────────────
  { pattern: /^\/author(?:s)?(?:\/|$)/i, reason: "author_or_profile_path", weight: -80, label: "author" },
  { pattern: /^\/columnist(?:s)?(?:\/|$)/i, reason: "author_or_profile_path", weight: -70, label: "columnist" },
  { pattern: /^\/contributor(?:s)?(?:\/|$)/i, reason: "author_or_profile_path", weight: -70, label: "contributor" },

  // ── Newsletter / contact / about / privacy / terms ───────────────
  { pattern: /^\/newsletter/i, reason: "utility_path", weight: -90, label: "newsletter" },
  { pattern: /^\/preferences(?:\/|$)/i, reason: "utility_path", weight: -90, label: "preferences" },
  { pattern: /^\/about(?:\/|$)/i, reason: "utility_path", weight: -90, label: "about" },
  { pattern: /^\/contact(?:\/|$)/i, reason: "utility_path", weight: -90, label: "contact" },
  { pattern: /^\/privacy(?:\/|$)/i, reason: "utility_path", weight: -100, label: "privacy" },
  { pattern: /^\/terms(?:\/|$)/i, reason: "utility_path", weight: -100, label: "terms" },
  { pattern: /^\/advertising(?:\/|$)/i, reason: "utility_path", weight: -90, label: "advertising" },
  { pattern: /^\/careers?(?:\/|$)/i, reason: "utility_path", weight: -90, label: "careers" },
  { pattern: /^\/help(?:\/|$)/i, reason: "utility_path", weight: -80, label: "help" },
  { pattern: /^\/support(?:\/|$)/i, reason: "utility_path", weight: -80, label: "support" },
  { pattern: /^\/advertise(?:\/|$)/i, reason: "utility_path", weight: -90, label: "advertise" },
  { pattern: /^\/feedback(?:\/|$)/i, reason: "utility_path", weight: -90, label: "feedback" },
  { pattern: /^\/auth(?:\/|$)/i, reason: "utility_path", weight: -100, label: "auth" },
  { pattern: /^\/wp-/i, reason: "utility_path", weight: -100, label: "wordpress_admin" },

  // ── Discover / browse / listing UI pages ─────────────────────────
  { pattern: /^\/discover(?:\/|$)/i, reason: "listing_or_topic_path", weight: -70, label: "discover" },
  { pattern: /^\/browse(?:\/|$)/i, reason: "listing_or_topic_path", weight: -60, label: "browse" },
  { pattern: /^\/explore(?:\/|$)/i, reason: "listing_or_topic_path", weight: -60, label: "explore" },
];

// ─── Positive Signal Patterns ───────────────────────────────────────────────

type PositiveSignal = {
  test: (pathname: string, segments: string[]) => boolean;
  weight: number;
  label: string;
};

const POSITIVE_SIGNALS: PositiveSignal[] = [
  // Date path: /YYYY/MM/DD/ or /YYYY/MM/ or /YYYY/
  {
    test: (path) => /\/\d{4}\/\d{2}\/\d{2}\//.test(path) || /\/\d{4}\/\d{2}(?:\/|$)/.test(path),
    weight: 60,
    label: "date_path",
  },
  // Long slug with 5+ meaningful hyphen-separated tokens in the last segment
  {
    test: (_path, segments) => {
      const last = segments[segments.length - 1] || "";
      // Strip extension
      const slug = last.replace(/\.[a-z]+$/i, "");
      return (slug.match(/-/g) || []).length >= 4;
    },
    weight: 50,
    label: "long_slug",
  },
  // Numeric article ID in path (5+ digits, common in CMS URLs)
  {
    test: (path) => /\/\d{5,}(?:\/|$|[.?])/.test(path),
    weight: 40,
    label: "numeric_id",
  },
  // Article suffix patterns (.html, .htm, .cms)
  {
    test: (path) => /\.(?:html?|cms)(?:\?|$)/i.test(path),
    weight: 40,
    label: "article_suffix",
  },
  // Path includes "article", "articles", "news", "story", "stories" as a segment
  // followed by a non-trivial slug or ID
  {
    test: (_path, segments) => {
      const articleSegments = ["article", "articles", "news", "story", "stories", "post", "posts", "blog"];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!.toLowerCase().replace(/\.[a-z]+$/i, "");
        if (articleSegments.includes(seg)) {
          // Check if there's a next segment that looks like a slug or ID
          const next = segments[i + 1] || "";
          if (next.length >= 8 || /\d{4,}/.test(next) || (next.match(/-/g) || []).length >= 1) {
            return true;
          }
        }
      }
      return false;
    },
    weight: 50,
    label: "article_segment",
  },
  // Multi-segment path with 3+ segments (e.g., /news/world/example-slug)
  {
    test: (_path, segments) => segments.length >= 3,
    weight: 20,
    label: "deep_path",
  },
];

// ─── Strong Positive Overrides ──────────────────────────────────────────────

/**
 * Some positive signals are so strong they should override soft negatives.
 * When a URL has a strong positive AND a negative that could be a false
 * positive (e.g., /video/2026/01/01/slug — video section with date article),
 * the strong positive prevents rejection.
 */
const STRONG_POSITIVE_WEIGHT_THRESHOLD = 80;

// ─── Core Classification ────────────────────────────────────────────────────

/**
 * Classify a URL as likely-article or not.
 *
 * Uses a scoring approach:
 * - Negative signals subtract from the score
 * - Positive signals add to the score
 * - Reject only when negative score dominates and positive evidence is weak
 *
 * Conservative: when in doubt, accept.
 */
export function classifyArticleUrl(url: string): ArticleUrlPolicyResult {
  const signals: string[] = [];
  const parsed = normalizeArticleUrlForPolicy(url);

  if (!parsed) {
    return { accepted: false, reason: "invalid_url", normalizedUrl: null, signals: ["invalid_url"] };
  }

  const pathname = parsed.pathname;
  const path = pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean);
  const normalizedUrl = parsed.toString();

  // Empty path (homepage) — not an article
  if (path === "/" || path === "") {
    return { accepted: false, reason: "utility_path", normalizedUrl, signals: ["homepage"] };
  }

  // Check for search query parameters
  const search = parsed.search.toLowerCase();
  if (/[?&](?:q|query|search|s|keyword)=/i.test(search) && !/[?&](?:id|article|post)=/i.test(search)) {
    signals.push("search_query_param");
    // Only reject if path also looks non-article
    const hasStrongPositive = POSITIVE_SIGNALS.some((s) => {
      if (s.weight >= STRONG_POSITIVE_WEIGHT_THRESHOLD) return s.test(path, segments);
      return false;
    });
    if (!hasStrongPositive) {
      return { accepted: false, reason: "search_or_query_page", normalizedUrl, signals };
    }
  }

  // Check for feed/rss/atom query parameters
  if (/[?&](?:feed|rss|atom)=(?:rss|atom|json|true|1)/i.test(search)) {
    return { accepted: false, reason: "feed_or_archive_path", normalizedUrl, signals: ["feed_query_param"] };
  }

  // ── Score negative signals ───────────────────────────────────────
  let score = 0;
  let dominantNegativeReason: ArticleUrlRejectReason | null = null;
  let dominantNegativeWeight = 0;
  let hasStrongNegative = false;

  for (const { pattern, reason, weight, label } of NEGATIVE_PATTERNS) {
    if (pattern.test(path)) {
      score += weight;
      signals.push(`neg:${label}`);
      if (weight < dominantNegativeWeight) {
        dominantNegativeReason = reason;
        dominantNegativeWeight = weight;
      }
      if (weight <= -80) {
        hasStrongNegative = true;
      }
    }
  }

  // ── Score positive signals ───────────────────────────────────────
  let maxPositiveWeight = 0;
  let totalPositiveWeight = 0;

  for (const { test, weight, label } of POSITIVE_SIGNALS) {
    if (test(path, segments)) {
      score += weight;
      totalPositiveWeight += weight;
      if (weight > maxPositiveWeight) maxPositiveWeight = weight;
      signals.push(`pos:${label}`);
    }
  }

  // ── Decide ───────────────────────────────────────────────────────

  // No negative signals: accept
  if (dominantNegativeReason === null) {
    return { accepted: true, reason: null, normalizedUrl, signals };
  }

  // When strong negative signals matched (media clips, topics, checkout, etc.),
  // discount generic positive signals that could be false positives.
  // e.g., /radio/clips/22633747 has a numeric ID but it's a clip ID, not an
  // article ID. Only keep strong positive signals that are truly article-like.
  if (hasStrongNegative) {
    // Recount positives excluding generic signals (deep_path, numeric_id)
    // that are easily confused with non-article URL structures.
    let articlePositiveWeight = 0;
    for (const { test, weight, label } of POSITIVE_SIGNALS) {
      if (label === "deep_path" || label === "numeric_id") continue;
      if (test(path, segments)) {
        articlePositiveWeight += weight;
      }
    }
    // Only override if article-specific positives are very strong
    // (date path + slug + article segment = clearly an article)
    if (articlePositiveWeight >= 100) {
      return { accepted: true, reason: null, normalizedUrl, signals: [...signals, "override:very_strong_positive"] };
    }
    return {
      accepted: false,
      reason: dominantNegativeReason,
      normalizedUrl,
      signals: [...signals, "strong_negative_dominates"],
    };
  }

  // Soft negative: accept if positive signals outweigh
  if (totalPositiveWeight >= STRONG_POSITIVE_WEIGHT_THRESHOLD) {
    return { accepted: true, reason: null, normalizedUrl, signals: [...signals, "override:strong_positive"] };
  }

  // Rejection: negative score dominates
  if (score < 0) {
    return {
      accepted: false,
      reason: dominantNegativeReason,
      normalizedUrl,
      signals,
    };
  }

  // Default: accept (conservative)
  return { accepted: true, reason: null, normalizedUrl, signals };
}

/**
 * Simple boolean convenience function.
 * Returns true if the URL is likely an article URL.
 */
export function isLikelyArticleUrl(url: string): boolean {
  return classifyArticleUrl(url).accepted;
}
