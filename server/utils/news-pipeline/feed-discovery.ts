import { safeFetch } from "../ssrf-guard";
import { buildFeedUrlCandidates } from "./import-rss";
import type { FeedDiscoveryResult, ScopeMatch, TaxonomyEvidence } from "./types";

type SupportedFeedType =
  | "application/rss+xml"
  | "application/atom+xml"
  | "application/feed+json"
  | "application/json";

type FeedCandidate = {
  feedUrl: string;
  discoveredVia: string;
  detection: "direct-feed" | "html-link" | "html-raw-url" | "http-link" | "robots-sitemap" | "cms-fingerprint" | "taxonomy-extraction" | "directory-traversal";
  contentType?: SupportedFeedType | null;
  score: number;
  scopeMatch: ScopeMatch;
};

type DiscoverySummaryCandidate = {
  feedUrl: string;
  detection: FeedCandidate["detection"];
  score: number;
  contentType?: SupportedFeedType | null;
  scopeMatch: ScopeMatch;
};

type RejectedCandidate = DiscoverySummaryCandidate & {
  reason: string;
};

type SitemapEntry = {
  loc: string;
  publishedAt: Date | null;
};

const FEED_CONTENT_TYPE_PATTERNS = [
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/json",
] as const;

const looksLikeFeed = (body: string) => {
  const sample = body.slice(0, 4000).toLowerCase();
  return (
    sample.includes("<rss") ||
    sample.includes("<feed") ||
    sample.includes("<rdf:rdf") ||
    sample.includes("<channel") ||
    sample.includes("<entry") ||
    sample.includes("<item")
  );
};

const looksLikeJsonFeed = (body: string) => {
  const sample = body.slice(0, 4000).trim();
  if (!sample.startsWith("{")) return false;

  try {
    const parsed = JSON.parse(sample);
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.version === "string" &&
      parsed.version.toLowerCase().includes("jsonfeed"),
    );
  } catch {
    return false;
  }
};

const normalizeSupportedContentType = (contentType: string | null): SupportedFeedType | null => {
  if (!contentType) return null;
  const normalized = contentType.toLowerCase();
  return FEED_CONTENT_TYPE_PATTERNS.find((pattern) => normalized.includes(pattern)) || null;
};

const isDefinitiveFeedContentType = (contentType: SupportedFeedType | null) =>
  contentType === "application/rss+xml" ||
  contentType === "application/atom+xml" ||
  contentType === "application/feed+json";

const resolveRelativeUrl = (rawUrl: string, pageUrl: string) => {
  try {
    return new URL(rawUrl, pageUrl).toString();
  } catch {
    return null;
  }
};

const resolveHtmlDeclaredFeeds = (body: string, pageUrl: string) => {
  const feeds: Array<{ feedUrl: string; contentType: SupportedFeedType | null }> = [];
  const seen = new Set<string>();
  const linkTags = body.match(/<link\b[^>]*>/gi) || [];

  for (const tag of linkTags) {
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase() || "";
    if (!rel.includes("alternate")) continue;

    const contentType = normalizeSupportedContentType(
      tag.match(/\btype=["']([^"']+)["']/i)?.[1] || null,
    );
    if (!contentType) continue;

    const resolved = resolveRelativeUrl(
      tag.match(/\bhref=["']([^"']+)["']/i)?.[1] || "",
      pageUrl,
    );
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    feeds.push({ feedUrl: resolved, contentType });
  }

  return feeds;
};

const extractFeedLikeUrlsFromHtml = (body: string, pageUrl: string) => {
  const results: string[] = [];
  const seen = new Set<string>();
  const urlMatches = body.match(/https?:\/\/[^"'\\<>\s]+|\/[^"'\\<>\s]+/gi) || [];

  for (const rawMatch of urlMatches) {
    const cleaned = rawMatch
      .replace(/&amp;/gi, "&")
      .replace(/[),.;]+$/g, "")
      .trim();
    const resolved = resolveRelativeUrl(cleaned, pageUrl);
    if (!resolved || seen.has(resolved) || !looksLikeFeedUrl(resolved)) continue;
    seen.add(resolved);
    results.push(resolved);
  }

  return results;
};

const parseLinkHeaderFeeds = (linkHeader: string | null, pageUrl: string) => {
  if (!linkHeader) return [] as Array<{ feedUrl: string; contentType: SupportedFeedType | null }>;

  const results: Array<{ feedUrl: string; contentType: SupportedFeedType | null }> = [];
  const seen = new Set<string>();
  const entries = linkHeader.split(/,(?=\s*<)/);

  for (const entry of entries) {
    const urlMatch = entry.match(/<([^>]+)>/);
    const relMatch = entry.match(/;\s*rel="?([^";,]+)"?/i);
    const typeMatch = entry.match(/;\s*type="?([^";,]+)"?/i);
    const relValue = relMatch?.[1]?.toLowerCase() || "";
    if (!urlMatch?.[1] || !relValue.includes("alternate")) continue;

    const contentType = normalizeSupportedContentType(typeMatch?.[1] || null);
    if (!contentType) continue;

    const resolved = resolveRelativeUrl(urlMatch[1], pageUrl);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    results.push({ feedUrl: resolved, contentType });
  }

  return results;
};

const detectCmsFingerprints = (
  body: string,
  pageUrl: string,
  headers: Headers,
) => {
  const fingerprints = new Set<string>();
  const sample = body.toLowerCase();
  const generator =
    body.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)?.[1]?.toLowerCase() ||
    "";
  const poweredBy = headers.get("x-powered-by")?.toLowerCase() || "";

  if (
    generator.includes("wordpress") ||
    poweredBy.includes("wordpress") ||
    sample.includes("/wp-content/") ||
    sample.includes("/wp-includes/")
  ) {
    fingerprints.add("wordpress");
  }

  if (
    generator.includes("ghost") ||
    poweredBy.includes("ghost") ||
    sample.includes("ghost-sdk") ||
    sample.includes("ghost.io")
  ) {
    fingerprints.add("ghost");
  }

  if (
    sample.includes("brightspot") ||
    generator.includes("brightspot") ||
    poweredBy.includes("brightspot")
  ) {
    fingerprints.add("brightspot");
  }

  if (
    generator.includes("drupal") ||
    poweredBy.includes("drupal") ||
    sample.includes("/sites/default/files/") ||
    sample.includes("drupal-settings-json")
  ) {
    fingerprints.add("drupal");
  }

  try {
    const parsed = new URL(pageUrl);
    if (parsed.pathname !== "/" && parsed.pathname !== "") {
      fingerprints.add("path-scoped");
    }
  } catch {}

  return [...fingerprints];
};

const buildCmsFingerprintCandidates = (
  pageUrl: string,
  fingerprints: string[],
) => {
  const candidates = new Set<string>();

  try {
    const parsed = new URL(pageUrl);
    const trimmedPath = parsed.pathname.replace(/\/+$/, "");
    const basePath = `${parsed.origin}${trimmedPath}`;
    const rootPath = parsed.origin;

    for (const fingerprint of fingerprints) {
      if (fingerprint === "wordpress") {
        candidates.add(`${basePath}/feed/`);
        candidates.add(`${basePath}/feed`);
        candidates.add(`${basePath}/rss/`);
        candidates.add(`${rootPath}/feed/`);
      }

      if (fingerprint === "ghost") {
        candidates.add(`${basePath}/rss/`);
        candidates.add(`${basePath}/rss`);
        candidates.add(`${rootPath}/rss/`);
      }

      if (fingerprint === "brightspot") {
        candidates.add(`${basePath}.rss`);
        candidates.add(`${basePath}/index.rss`);
      }

      if (fingerprint === "drupal") {
        candidates.add(`${basePath}/feed`);
        candidates.add(`${basePath}/rss.xml`);
        candidates.add(`${rootPath}/rss.xml`);
      }

      if (fingerprint === "path-scoped") {
        candidates.add(`${basePath}/rss.xml`);
        candidates.add(`${basePath}/index.xml`);
      }
    }
  } catch {}

  return [...candidates].filter(Boolean);
};

const parseRobotsSitemaps = (body: string, pageUrl: string) => {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap:\s*(.+)\s*$/i);
    if (!match?.[1]) continue;
    const resolved = resolveRelativeUrl(match[1].trim(), pageUrl);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    results.push(resolved);
  }

  return results;
};

const toDate = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseSitemapEntries = (body: string, baseUrl: string) => {
  const results: SitemapEntry[] = [];
  const seen = new Set<string>();

  const blocks = [
    ...body.matchAll(/<url\b[\s\S]*?<\/url>/gi),
    ...body.matchAll(/<sitemap\b[\s\S]*?<\/sitemap>/gi),
  ];

  for (const match of blocks) {
    const block = match[0] || "";
    const resolved = resolveRelativeUrl(
      block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i)?.[1]?.trim() || "",
      baseUrl,
    );
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    const publishedAt = toDate(
      block.match(/<news:publication_date[^>]*>([\s\S]*?)<\/news:publication_date>/i)?.[1]?.trim() ||
      block.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i)?.[1]?.trim() ||
      "",
    );
    results.push({ loc: resolved, publishedAt });
  }

  return results;
};

const looksLikeFeedUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();
    const normalized = `${pathname}${search}`;
    const blockedPathPatterns = [
      /\/feedback(?:\/|$)/,
      /\/contact(?:\/|$)/,
      /\/about(?:\/|$)/,
      /\/privacy(?:\/|$)/,
      /\/terms(?:\/|$)/,
    ];

    if (blockedPathPatterns.some((pattern) => pattern.test(pathname))) {
      return false;
    }

    const feedPathPatterns = [
      /\/rss(?:\/|$)/,
      /\/rss\.[a-z0-9]+$/,
      /\/feed(?:\/|$)/,
      /\/feeds(?:\/|$)/,
      /\/atom(?:\/|$)/,
      /\/atom\.[a-z0-9]+$/,
      /\/index\.rss$/,
      /\/index\.xml$/,
    ];
    const feedQueryPatterns = [
      /[?&]feed=(rss|atom|json)/,
      /[?&]format=(rss|atom|xml|json)/,
      /[?&]output=(rss|atom|xml|json)/,
      /[?&]service=rss(?:&|$)/,
    ];

    return (
      feedPathPatterns.some((pattern) => pattern.test(pathname)) ||
      feedQueryPatterns.some((pattern) => pattern.test(search)) ||
      normalized.includes("jsonfeed") ||
      normalized.includes("feed+json")
    );
  } catch {
    return false;
  }
};

const isRecentDate = (value: Date | null, now = new Date()) => {
  if (!value) return false;
  const diff = now.getTime() - value.getTime();
  return diff >= 0 && diff <= 14 * 24 * 60 * 60 * 1000;
};

const computeSitemapRelevanceBonus = (
  sitemapUrl: string,
  entries: SitemapEntry[],
  targetPageUrl: string,
) => {
  const targetPath = normalizePath(targetPageUrl);
  if (targetPath === "/") {
    return sitemapUrl.toLowerCase().includes("news-sitemap") ? 8 : 0;
  }

  const scopeToken = targetPath.replace(/^\//, "");
  const matchingEntries = entries.filter((entry) => normalizePath(entry.loc).includes(scopeToken));
  const recentMatchingEntries = matchingEntries.filter((entry) => isRecentDate(entry.publishedAt));

  let bonus = 0;
  if (matchingEntries.length >= 3) bonus += 12;
  else if (matchingEntries.length > 0) bonus += 6;

  if (recentMatchingEntries.length >= 2) bonus += 10;
  else if (recentMatchingEntries.length > 0) bonus += 5;

  if (sitemapUrl.toLowerCase().includes("news-sitemap")) bonus += 6;
  return bonus;
};

const buildScopedCandidatesFromSitemapContext = (
  targetPageUrl: string,
  entries: SitemapEntry[],
) => {
  const candidates = new Set<string>();
  const targetPath = normalizePath(targetPageUrl);
  if (targetPath === "/") return [] as string[];

  const scopeToken = targetPath.replace(/^\//, "");
  const matchingEntries = entries.filter((entry) => normalizePath(entry.loc).includes(scopeToken));
  if (matchingEntries.length < 2) return [] as string[];

  try {
    const parsed = new URL(targetPageUrl);
    const base = `${parsed.origin}${targetPath === "/" ? "" : targetPath}`;
    candidates.add(`${base}/rss`);
    candidates.add(`${base}/rss/`);
    candidates.add(`${base}/feed`);
    candidates.add(`${base}/feed/`);
    candidates.add(`${base}/rss.xml`);
  } catch {}

  return [...candidates];
};

export const buildCandidatesFromSitemapUrl = (sitemapUrl: string) => {
  const candidates = new Set<string>();

  try {
    const parsed = new URL(sitemapUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const normalized = pathname.toLowerCase();

    const scopedSitemapMatch =
      normalized.match(/^(.*)\/(?:news-)?sitemap(?:[_-]index)?\.xml$/) ||
      normalized.match(/^(.*)\/sitemap\.xml$/);
    const scopedBasePath = scopedSitemapMatch?.[1] || "";

    if (!scopedBasePath || scopedBasePath === "/") {
      return [] as string[];
    }

    const base = `${parsed.origin}${scopedBasePath}`;
    candidates.add(`${base}/rss`);
    candidates.add(`${base}/rss/`);
    candidates.add(`${base}/rss.xml`);
    candidates.add(`${base}/feed`);
    candidates.add(`${base}/feed/`);
    candidates.add(`${base}/feed.xml`);
    candidates.add(`${base}/atom.xml`);
  } catch {}

  return [...candidates];
};

const collectSitemapFeedCandidates = async (
  input: { pageUrl: string; userAgent: string; acceptLanguage?: string; preferScopedDirectFeed?: boolean },
  seenAcceptedFeeds: Set<string>,
) => {
  const acceptedCandidates: FeedCandidate[] = [];
  const sitemapTargets = new Set<string>();

  try {
    const page = new URL(input.pageUrl);
    sitemapTargets.add(`${page.origin}/robots.txt`);
    sitemapTargets.add(`${page.origin}/sitemap.xml`);
    sitemapTargets.add(`${page.origin}/sitemap_index.xml`);
    sitemapTargets.add(`${page.origin}/news-sitemap.xml`);
  } catch {
    return acceptedCandidates;
  }

  const discoveredSitemapUrls = new Set<string>();

  for (const target of sitemapTargets) {
    try {
      const response = await safeFetch(target, {
        headers: {
          "User-Agent": input.userAgent,
          Accept: "text/plain, application/xml, text/xml, text/html, */*",
          ...(input.acceptLanguage ? { "Accept-Language": input.acceptLanguage } : {}),
        },
      });
      if (!response.ok) continue;
      const body = await response.text();

      if (target.endsWith("/robots.txt")) {
        for (const sitemapUrl of parseRobotsSitemaps(body, target)) {
          discoveredSitemapUrls.add(sitemapUrl);
        }
      } else {
        discoveredSitemapUrls.add(response.url);
      }
    } catch {}
  }

  const scopedPath = normalizePath(input.pageUrl);

  for (const sitemapUrl of discoveredSitemapUrls) {
    try {
      const response = await safeFetch(sitemapUrl, {
        headers: {
          "User-Agent": input.userAgent,
          Accept: "application/xml, text/xml, text/plain, */*",
          ...(input.acceptLanguage ? { "Accept-Language": input.acceptLanguage } : {}),
        },
      });
      if (!response.ok) continue;
      const body = await response.text();
      const entries = parseSitemapEntries(body, response.url);
      const relevanceBonus = computeSitemapRelevanceBonus(
        sitemapUrl,
        entries,
        input.pageUrl,
      );
      const candidateLocs = [
        ...entries.map((entry) => entry.loc),
        ...buildScopedCandidatesFromSitemapContext(input.pageUrl, entries),
        ...buildCandidatesFromSitemapUrl(sitemapUrl),
      ];

      for (const loc of candidateLocs) {
        if (!looksLikeFeedUrl(loc)) continue;
        if (seenAcceptedFeeds.has(loc)) continue;
        if (
          scopedPath !== "/" &&
          input.preferScopedDirectFeed &&
          !normalizePath(loc).includes(scopedPath.replace(/^\//, ""))
        ) {
          continue;
        }

        const candidateBase = {
          feedUrl: loc,
          discoveredVia: sitemapUrl,
          detection: "robots-sitemap" as const,
          contentType: null,
        };
        const { score: baseScore, scopeMatch } = computeCandidateScore(input, candidateBase);
        acceptedCandidates.push({
          ...candidateBase,
          score: baseScore + relevanceBonus,
          scopeMatch,
        });
        seenAcceptedFeeds.add(loc);
      }
    } catch {}
  }

  return acceptedCandidates;
};

export const buildScopedFeedCandidates = (pageUrl: string, existingFeedUrl?: string | null) => {
  const candidates = new Set(buildFeedUrlCandidates(existingFeedUrl || null, pageUrl));

  try {
    const parsed = new URL(pageUrl);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    const base = `${parsed.origin}${normalizedPath}`;
    const root = parsed.origin;
    const scopedPathWithTrailingSlash =
      normalizedPath && normalizedPath !== "/"
        ? `${normalizedPath}/`
        : "/";

    candidates.add(`${base}/rss/`);
    candidates.add(`${base}/rss`);
    candidates.add(`${base}/rss.xml`);
    candidates.add(`${base}/feed.xml`);
    candidates.add(`${base}/atom.xml`);
    candidates.add(`${base}/index.xml`);
    candidates.add(`${base}/index.rss`);
    candidates.add(`${base}/feed/`);
    candidates.add(`${base}/feed`);
    candidates.add(`${root}/rss.xml`);
    candidates.add(`${root}/feed.xml`);
    candidates.add(`${root}/atom.xml`);
    candidates.add(`${root}/index.xml`);
    candidates.add(`${root}/index.rss`);
    candidates.add(`${root}/feeds/rss/?index=${scopedPathWithTrailingSlash}`);
    candidates.add(`${root}/feeds/rss?index=${scopedPathWithTrailingSlash}`);
    candidates.add(pageUrl);
  } catch {
    candidates.add(pageUrl);
  }

  return [...candidates].filter(Boolean);
};

// ─── Feed Directory Traversal ───────────────────────────────────────────────

const DIRECTORY_LINK_TEXT_PATTERNS = [
  /\brss\b/i,
  /\bfeeds?\b/i,
  /\bxml\b/i,
  /\bsyndicat/i,
  /ball\s+feeds?/i,
  /news\s+feeds?/i,
  /rss\s+directory/i,
  /feed\s+directory/i,
  /rss\s+list/i,
];

const DIRECTORY_HREF_PATTERNS = [
  /\/rss[-_]?directory/i,
  /\/feed[-_]?directory/i,
  /\/rss[-_]?(?:index|list|page)/i,
  /\/feed[-_]?(?:index|list|page)/i,
  /\/show[-_]?rss/i,
  /\/all[-_]?feeds?/i,
  /\/feeds?[-_]?index/i,
];

/**
 * Scan the target page HTML for anchor links that look like they point
 * to a feed-directory / feed-index page (a page that lists available feeds).
 *
 * Returns the single best-scoring directory URL, or null.
 */
const findDirectoryUrl = (html: string, pageUrl: string): string | null => {
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let bestUrl: string | null = null;
  let bestScore = 0;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1] || "";
    const text = (match[2] || "").replace(/<[^>]+>/g, "").trim();

    // Skip anchors pointing to blocked / non-directory pages
    if (/\/feedback|\/contact|\/about|\/privacy|\/terms/i.test(href)) continue;

    // Skip anchors that look like article/blog links rather than directory pages
    if (/\/story|\/article|\/post|\/blog\b|\/\d{4}\/\d{2}\/|\/p\//i.test(href)) continue;

    // Skip generic navigation links unlikely to be directories
    if (/^\/?(?:home|index|sitemap)\/?$/i.test(href)) continue;

    let score = 0;
    let textMatched = false;

    // Score based on link text
    for (const pattern of DIRECTORY_LINK_TEXT_PATTERNS) {
      if (pattern.test(text)) { score += 3; textMatched = true; }
    }

    // Score based on href patterns (use max to avoid double-counting)
    let hrefMatched = false;
    let hrefScore = 0;
    for (const pattern of DIRECTORY_HREF_PATTERNS) {
      if (pattern.test(href)) { hrefScore = Math.max(hrefScore, 5); hrefMatched = true; }
    }
    score += hrefScore;

    // Bonus when BOTH text and href independently suggest a directory.
    // This reduces false positives from links like "RSS" that point to
    // a blog tag page or an unrelated content page.
    if (textMatched && hrefMatched) score += 4;

    // Boost if the href contains /rss or /feed but is NOT a direct feed URL
    const resolvedHref = resolveRelativeUrl(href, pageUrl);
    if (/(?:rss|feeds?)(?:\b|-|_)/i.test(href) && resolvedHref && !looksLikeFeedUrl(resolvedHref)) {
      score += 2;
    }

    // Penalize anchors whose resolved URL is already a direct feed URL
    // (these are the feed themselves, not a directory page)
    if (resolvedHref && looksLikeFeedUrl(resolvedHref)) {
      score -= 8;
    }

    if (score > bestScore && score >= 3) {
      bestScore = score;
      const resolved = resolveRelativeUrl(href, pageUrl);
      if (resolved) bestUrl = resolved;
    }
  }

  return bestUrl;
};

/**
 * Classify whether a fetched page is actually a feed directory/index.
 *
 * Uses a composite signal model: scores feed-like links, repeated feed labels,
 * list/table structure, and concentration of feed anchors. A page qualifies
 * when it accumulates enough combined evidence (composite score >= 25).
 */
const isFeedDirectoryPage = (html: string, pageUrl: string): boolean => {
  const feedLinks = new Set<string>();
  const feedAnchors: Array<{ href: string; text: string }> = [];
  let totalAnchors = 0;
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) !== null) {
    totalAnchors++;
    const href = match[1] || "";
    const text = (match[2] || "").replace(/<[^>]+>/g, "").toLowerCase().trim();
    const resolved = resolveRelativeUrl(href, pageUrl);

    const hasFeedHref = resolved ? looksLikeFeedUrl(resolved) : /\brss\b|\bfeed\b|\batom\b|\.xml\b/i.test(href);
    const hasFeedLabel = /\brss\b|\bfeed\b|\batom\b|\bxml\b/.test(text);

    if (hasFeedHref || hasFeedLabel) {
      feedLinks.add(resolved || href);
      feedAnchors.push({ href, text });
    }
  }

  // Composite signal scoring
  let signalScore = 0;

  // Signal 1: Feed-like links (most important)
  if (feedLinks.size >= 5) signalScore += 30;
  else if (feedLinks.size >= 3) signalScore += 15;
  else if (feedLinks.size >= 1) signalScore += 5;

  // Signal 2: Ratio of feed anchors to total anchors (concentration)
  if (totalAnchors > 0) {
    const feedRatio = feedAnchors.length / totalAnchors;
    if (feedRatio >= 0.5 && feedAnchors.length >= 3) signalScore += 20;
    else if (feedRatio >= 0.3 && feedAnchors.length >= 2) signalScore += 10;
  }

  // Signal 3: List/table structure around feed links
  const listPattern = /<(?:ul|ol|table|dl)\b[^>]*>[\s\S]*?<\/(?:ul|ol|table|dl)>/gi;
  const listBlocks = html.match(listPattern) || [];
  const feedLabelsInLists = listBlocks.filter((block) =>
    feedAnchors.some((a) => block.includes(a.href))
  ).length;
  if (feedLabelsInLists >= 2) signalScore += 15;
  else if (feedLabelsInLists >= 1) signalScore += 5;

  // Signal 4: Repeated feed keyword density in text content
  const textContent = html.replace(/<[^>]+>/g, " ").toLowerCase();
  const rssMentions = (textContent.match(/\brss\b/g) || []).length;
  const feedMentions = (textContent.match(/\bfeed\b/g) || []).length;
  if (rssMentions + feedMentions >= 10) signalScore += 10;
  else if (rssMentions + feedMentions >= 5) signalScore += 5;

  // Require a composite score of 25+ to qualify as a directory.
  // This means: either many feed links, or moderate feed links with
  // list structure and keyword density. Prevents pages that merely
  // mention RSS from qualifying.
  return signalScore >= 25;
};

/**
 * Extract labeled feed entries from a feed directory page.
 * Each entry has a display label and a feed URL.
 */
const parseDirectoryEntries = (
  html: string,
  pageUrl: string,
): Array<{ label: string; feedUrl: string }> => {
  const entries: Array<{ label: string; feedUrl: string }> = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1] || "";
    const rawText = (match[2] || "").replace(/<[^>]+>/g, "").trim();
    if (!rawText || rawText.length > 200) continue;

    const resolved = resolveRelativeUrl(href, pageUrl);
    if (!resolved || seen.has(resolved)) continue;

    // Accept entries where the href is feed-like OR the text contains feed keywords
    const isFeedHref = looksLikeFeedUrl(resolved);
    const hasFeedText = /\brss\b|\bfeed\b|\batom\b|\.xml/i.test(rawText);

    if (isFeedHref || hasFeedText) {
      seen.add(resolved);
      // Clean the label: remove "RSS", "Feed", "XML" suffix noise
      const label = rawText
        .replace(/\s*[-–—:]\s*(?:rss|feed|atom|xml)\s*$/i, "")
        .replace(/^\s*(?:rss|feed|atom|xml)\s*[-–—:]\s*/i, "")
        .trim();
      entries.push({ label: label || rawText, feedUrl: resolved });
    }
  }

  return entries;
};

/**
 * Extract scope tokens from the target URL for label matching.
 * E.g. "/category/arizona-news" => ["arizona-news", "arizona", "news"]
 */
const extractTargetTokens = (targetUrl: string): string[] => {
  const tokens: string[] = [];
  try {
    const pathname = new URL(targetUrl).pathname;
    const segments = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    if (segments.length === 0) return tokens;

    // Full last segment as a token
    const lastSegment = segments[segments.length - 1]!;
    const normalizedSlug = lastSegment
      .toLowerCase()
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    tokens.push(normalizedSlug);
    tokens.push(lastSegment.toLowerCase());

    // Individual word tokens from the last segment
    const words = normalizedSlug.split(" ").filter((w) => w.length >= 2);
    tokens.push(...words);

    // Also include second-to-last segment if available
    if (segments.length >= 2) {
      const parent = segments[segments.length - 2]!;
      tokens.push(parent.toLowerCase());
    }
  } catch {}
  return [...new Set(tokens)];
};

/**
 * Normalize a label for comparison: lowercase, strip feed-format noise words,
 * clean punctuation, collapse whitespace.
 *
 * Only removes words that are purely feed-format markers (rss, feed, feeds,
 * atom, xml). Preserves meaningful content words like "news", "sport", etc.
 * so that label matching retains real distinctions.
 */
const NOISE_WORDS = /\b(?:rss|feeds?|atom|xml)\b/gi;

const normalizeLabel = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(NOISE_WORDS, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Match the original target against directory entries.
 * Returns the best-matched entry or null.
 *
 * Matching is label-based (not URL-based) because directory feed URLs
 * may be opaque and not contain the target slug.
 */
/**
 * Generic/broad label words that should not be trusted as strong match evidence
 * on their own. A match based solely on these words risks false positives.
 */
const GENERIC_LABEL_TOKENS = new Set([
  "news", "feeds", "feed", "rss", "atom", "xml", "all", "latest",
  "top", "trending", "popular", "featured", "headlines", "breaking",]);

const matchTargetToDirectoryEntries = (
  entries: Array<{ label: string; feedUrl: string }>,
  targetUrl: string,
): { feedUrl: string; label: string } | null => {
  const targetTokens = extractTargetTokens(targetUrl);
  if (targetTokens.length === 0) return null;

  let bestMatch: { feedUrl: string; label: string } | null = null;
  let bestScore = 0;

  for (const entry of entries) {
    const entryLabel = normalizeLabel(entry.label);
    if (!entryLabel) continue;

    // Split entry label into tokens for granular matching
    const entryTokens = entryLabel.split(" ").filter((t) => t.length >= 2);

    let score = 0;

    // Tier 1 — Exact label-to-slug match (strongest signal)
    if (entryLabel === targetTokens[0]) {
      score += 50;
    }

    // Tier 1b — Exact raw last segment match
    if (entryLabel === targetTokens[1]) {
      score += 45;
    }

    // Tier 2 — Label contains the full normalized slug
    if (targetTokens[0] && targetTokens[0].length >= 3 && entryLabel.includes(targetTokens[0])) {
      score += 30;
    }

    // Tier 3 — Full slug contains the label (short label match)
    if (entryLabel.length >= 3 && targetTokens[0] && targetTokens[0].includes(entryLabel)) {
      score += 20;
    }

    // Tier 4 — Meaningful token overlap
    // Count how many target tokens appear in the entry label.
    // Only count tokens that are NOT generic/broad words, to avoid
    // false positives from overlapping on "news", "all", etc.
    let meaningfulOverlap = 0;
    let genericOverlap = 0;
    for (const token of targetTokens) {
      if (token.length < 2) continue;
      // Use word-boundary-aware check to avoid substring false positives
      const tokenInEntry = entryTokens.some((et) => et === token || et.includes(token) || token.includes(et));
      if (tokenInEntry) {
        if (GENERIC_LABEL_TOKENS.has(token)) {
          genericOverlap++;
        } else {
          meaningfulOverlap++;
        }
      }
    }
    if (meaningfulOverlap > 0) {
      score += meaningfulOverlap * 10;
    }
    // Generic tokens contribute less
    if (genericOverlap > 0) {
      score += genericOverlap * 3;
    }

    // Feed URL path bonus (for non-opaque URLs)
    try {
      const feedPath = new URL(entry.feedUrl).pathname.toLowerCase();
      for (const token of targetTokens) {
        if (token.length >= 3 && !GENERIC_LABEL_TOKENS.has(token) && feedPath.includes(token)) {
          score += 5;
        }
      }
    } catch {}

    // Generic label penalty: if the entry label is entirely composed of
    // generic words after normalization, require stronger evidence.
    const nonGenericEntryTokens = entryTokens.filter((t) => !GENERIC_LABEL_TOKENS.has(t));
    if (nonGenericEntryTokens.length === 0 && entryTokens.length > 0) {
      // Label is purely generic (e.g., "News RSS", "All Feeds") — penalize
      score = Math.floor(score * 0.5);
    }

    // Minimum score threshold: generic labels need more evidence
    const minScore = nonGenericEntryTokens.length === 0 ? 20 : 8;

    if (score > bestScore && score >= minScore) {
      bestScore = score;
      bestMatch = { feedUrl: entry.feedUrl, label: entry.label };
    }
  }

  return bestMatch;
};

// ─── Scope Classification ────────────────────────────────────────────────────

const emptyTaxonomyEvidence = (): TaxonomyEvidence => ({
  sectionIds: [],
  tagIds: [],
  categorySlugs: [],
  collectionIds: [],
  routeNames: [],
  canonicalSectionHandles: [],
  feedParams: [],
  matchedFeedUrls: [],
});

/**
 * Accumulate taxonomy evidence from a source into a target accumulator in-place.
 * Deduplicates each array after merging.
 */
const accumulateTaxonomyEvidence = (
  target: TaxonomyEvidence,
  source: TaxonomyEvidence,
): void => {
  target.sectionIds.push(...source.sectionIds);
  target.tagIds.push(...source.tagIds);
  target.categorySlugs.push(...source.categorySlugs);
  target.collectionIds.push(...source.collectionIds);
  target.routeNames.push(...source.routeNames);
  target.canonicalSectionHandles.push(...source.canonicalSectionHandles);
  target.feedParams.push(...source.feedParams);
  target.matchedFeedUrls.push(...source.matchedFeedUrls);

  // Deduplicate all arrays in-place
  target.sectionIds = [...new Set(target.sectionIds)];
  target.tagIds = [...new Set(target.tagIds)];
  target.categorySlugs = [...new Set(target.categorySlugs)];
  target.collectionIds = [...new Set(target.collectionIds)];
  target.routeNames = [...new Set(target.routeNames)];
  target.canonicalSectionHandles = [...new Set(target.canonicalSectionHandles)];
  target.feedParams = [...new Set(target.feedParams)];
  target.matchedFeedUrls = [...new Set(target.matchedFeedUrls)];
};

/**
 * Extract taxonomy/section evidence from inline JSON blocks, script text,
 * and feed URLs with taxonomy query parameters.
 *
 * This is purely regex-based (no DOM required) to complement the DOM-level
 * extraction in browser-feed-resolver.ts.
 *
 * Extracts:
 * - Section/category/tag IDs from inline JSON (e.g., Next.js __NEXT_DATA__,
 *   WordPress config, Ghost config, Drupal settings)
 * - Feed URLs with taxonomy parameters (e.g., ?cat=5, ?tag=nba)
 * - Route names and canonical section handles from page content
 */
export const extractTaxonomyEvidence = (
  html: string,
  pageUrl: string,
): TaxonomyEvidence => {
  const evidence = emptyTaxonomyEvidence();

  try {
    const parsed = new URL(pageUrl);
    const pathSlug = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (pathSlug) {
      const segments = pathSlug.split("/").filter(Boolean);
      if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1];
        if (lastSegment && lastSegment.length >= 2 && lastSegment.length <= 80) {
          evidence.canonicalSectionHandles.push(lastSegment);
        }
      }
    }
  } catch {}

  // 1. Extract section/category/tag IDs from inline JSON blocks
  const jsonBlockPattern =
    /<(?:script)[^>]*type=["']application\/?(?:ld\+)?json[^>]*>[\s\S]*?<\/script>/gi;
  const scriptBlocks = html.match(jsonBlockPattern) || [];

  for (const block of scriptBlocks) {
    const jsonContent = block.replace(/<[^>]+>/g, "").trim();
    if (!jsonContent) continue;

    try {
      const parsed = JSON.parse(jsonContent);
      extractTaxonomyFromJson(parsed, evidence);
    } catch {}
  }

  // 2. Extract taxonomy IDs from script text (WordPress, Ghost, Drupal patterns)
  const scriptTextPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptTextPattern.exec(html)) !== null) {
    const content = scriptMatch[1] || "";

    // WordPress: wp-json category/tag IDs
    const wpCategoryIds = content.match(/['"](?:cat|category_id|term_id)["']\s*[:=]\s*['"]?(\d+)['"]?/gi);
    if (wpCategoryIds) {
      for (const m of wpCategoryIds) {
        const id = m.match(/\d+/)?.[0];
        if (id) evidence.sectionIds.push(id);
      }
    }

    // WordPress: category/tag slugs in localized data
    const wpSlugs = content.match(/['"](?:category_slug|tag_slug|term_slug)["']\s*[:=]\s*['"]([a-z0-9_-]+)['"]?/gi);
    if (wpSlugs) {
      for (const m of wpSlugs) {
        const slug = m.match(/['"]([a-z0-9_-]+)['"]?$/i)?.[1];
        if (slug) evidence.categorySlugs.push(slug);
      }
    }

    // Ghost: section/tag slugs from JSON config blocks
    const ghostSlugs = content.match(/['"]slug['"]\s*:\s*['"]([a-z0-9_-]+)['"]?/gi);
    if (ghostSlugs) {
      for (const m of ghostSlugs) {
        const slug = m.match(/['"]([a-z0-9_-]+)['"]?$/i)?.[1];
        if (slug) evidence.categorySlugs.push(slug);
      }
    }

    // Drupal: taxonomy term IDs
    const drupalTermIds = content.match(/['"]tid['"]\s*:\s*['"]?(\d+)['"]?/gi);
    if (drupalTermIds) {
      for (const m of drupalTermIds) {
        const id = m.match(/\d+/)?.[0];
        if (id) evidence.tagIds.push(id);
      }
    }

    // Generic: route names / section IDs from common frameworks
    const routeNames = content.match(/['"](?:route|section|department|category)["']\s*[:=]\s*['"]([a-z0-9_/-]+)['"]?/gi);
    if (routeNames) {
      for (const m of routeNames) {
        const name = m.match(/['"]([a-z0-9_/-]+)['"]?$/i)?.[1];
        if (name && name.length >= 2) evidence.routeNames.push(name);
      }
    }
  }

  // 3. Extract feed URLs with taxonomy query parameters from the HTML.
  // Matches URLs like /feed?cat=5, /rss.xml?tag=nba, https://example.com/feed?cat=5
  // The regex structure: optional scheme+host, slash, path segments, feed keyword,
  // optional extension, then query string.
  const feedUrlWithParamsPattern =
    /((?:https?:\/\/[^"'\s<>]+)?\/[^"'\s<>]*?(?:rss|feed|atom)(?:\.[a-z]+)?[^"'\s<>]*\?[^"'\s<>]+)/gi;
  let feedUrlMatch: RegExpExecArray | null;
  while ((feedUrlMatch = feedUrlWithParamsPattern.exec(html)) !== null) {
    const url = feedUrlMatch[1];
    if (!url) continue;

    const paramPatterns = [/[?&]cat(?:egory)?=([^&"'\s]+)/gi, /[?&]tag=([^&"'\s]+)/gi, /[?&]term=([^&"'\s]+)/gi, /[?&]section=([^&"'\s]+)/gi];
    for (const pattern of paramPatterns) {
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = pattern.exec(url)) !== null) {
        const value = paramMatch[1];
        if (value) evidence.feedParams.push(value);
      }
    }
    evidence.matchedFeedUrls.push(url);
  }

  // 4. Extract collection IDs from meta tags
  const collectionMeta = html.match(/<meta[^>]+name=["'](?:collection|section|category)[_-]?id["'][^>]+content=["']([^"']+)["']/gi);
  if (collectionMeta) {
    for (const m of collectionMeta) {
      const id = m.match(/content=["']([^"']+)["']/i)?.[1];
      if (id) evidence.collectionIds.push(id);
    }
  }

  return evidence;
};

/**
 * Walk a parsed JSON object and extract taxonomy-related values.
 * Populates the evidence object in-place.
 */
function extractTaxonomyFromJson(obj: unknown, evidence: TaxonomyEvidence): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) extractTaxonomyFromJson(item, evidence);
    return;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();

    // Extract section/category/tag IDs
    if (typeof value === "string" || typeof value === "number") {
      const strValue = String(value);
      if (/(?:section|category|department)Id$/i.test(lowerKey) && strValue) {
        evidence.sectionIds.push(strValue);
      }
      if (/(?:tag|term)Id$/i.test(lowerKey) && strValue) {
        evidence.tagIds.push(strValue);
      }
      if (lowerKey === "slug" && typeof value === "string" && value.length >= 2 && value.length <= 80) {
        evidence.categorySlugs.push(value);
      }
      if (lowerKey === "handle" && typeof value === "string" && value.length >= 2 && value.length <= 80) {
        evidence.canonicalSectionHandles.push(value);
      }

    }

    if (value && typeof value === "object") {
      extractTaxonomyFromJson(value, evidence);
    }
  }
}

/**
 * Build feed candidates from site-specific heuristics and taxonomy evidence.
 * Only produces candidates for scoped targets — never for root/source targets.
 *
 * Heuristics are domain-scoped and produce candidates that still flow through
 * normal verification and scoring.
 *
 * Supported CMS patterns:
 * - WordPress: query parameter feeds (?cat=<id>, ?tag=<slug>)
 * - Ghost: section/tag RSS paths (/section/<slug>/rss/)
 * - Drupal: taxonomy term feed paths (/taxonomy/term/<id>/feed)
 * - Generic: section feed paths from extracted slugs/handles
 */
export const buildTaxonomyHeuristicCandidates = (
  pageUrl: string,
  evidence: TaxonomyEvidence,
  fingerprints: string[],
): string[] => {
  const candidates: string[] = [];

  try {
    const parsed = new URL(pageUrl);
    const origin = parsed.origin;
    const scopePath = parsed.pathname.replace(/\/+$/, "");
    const isWordPress = fingerprints.includes("wordpress");
    const isGhost = fingerprints.includes("ghost");
    const isDrupal = fingerprints.includes("drupal");

    // WordPress: category query parameter feeds
    if (isWordPress) {
      for (const id of evidence.sectionIds) {
        candidates.push(`${origin}/?feed=rss2&cat=${id}`);
        candidates.push(`${origin}/?cat=${id}&feed=rss2`);
      }
      for (const slug of evidence.categorySlugs) {
        candidates.push(`${origin}/category/${slug}/feed/`);
        candidates.push(`${origin}/tag/${slug}/feed/`);
      }
    }

    // Ghost: section/tag RSS paths
    if (isGhost) {
      for (const slug of evidence.categorySlugs) {
        candidates.push(`${origin}/${slug}/rss/`);
        candidates.push(`${origin}${scopePath}/${slug}/rss/`);
      }
    }

    // Drupal: taxonomy term feed paths
    if (isDrupal) {
      for (const id of evidence.tagIds) {
        candidates.push(`${origin}/taxonomy/term/${id}/feed`);
      }
      for (const id of evidence.sectionIds) {
        candidates.push(`${origin}/taxonomy/term/${id}/feed`);
      }
    }

    // Generic: section feeds from extracted slugs/handles
    if (!isWordPress && !isGhost && !isDrupal) {
      for (const slug of evidence.canonicalSectionHandles) {
        candidates.push(`${origin}/${slug}/rss`);
        candidates.push(`${origin}/${slug}/feed`);
        candidates.push(`${origin}/${slug}/rss.xml`);
      }
      for (const slug of evidence.categorySlugs) {
        candidates.push(`${origin}/${slug}/rss`);
        candidates.push(`${origin}/${slug}/feed`);
      }
    }

    // Feed URLs with taxonomy parameters found in the page
    for (const url of evidence.matchedFeedUrls) {
      const resolved = resolveRelativeUrl(url, pageUrl);
      if (resolved) candidates.push(resolved);
    }
  } catch {}

  // Filter out blocked paths before returning
  const blockedPattern = /\/(?:feedback|contact|about|privacy|terms)(?:\/|$)/i;
  return [...new Set(candidates)]
    .filter((url) => {
      if (!url) return false;
      try {
        return !blockedPattern.test(new URL(url).pathname);
      } catch {
        return false;
      }
    });
};

/**
 * Classify how well a candidate URL matches the target URL's scope.
 *
 * - exact: paths match or candidate is a direct scoped feed for the target
 * - probable: candidate is under the target scope, shares path segments,
 *   or has taxonomy query parameters that match extracted evidence
 * - generic: candidate is a root-level feed (/, /rss, /feed)
 * - unrelated: candidate belongs to a different scope entirely
 */
const classifyScopeMatch = (
  targetUrl: string,
  candidateUrl: string,
  taxonomyEvidence?: TaxonomyEvidence,
): ScopeMatch => {
  const targetPath = normalizePath(targetUrl);
  const candidatePath = normalizePath(candidateUrl);

  // Root target → all valid candidates are generic
  if (targetPath === "/") {
    // Exception: if the candidate has taxonomy query parameters matching evidence,
    // it's a scoped feed even though the path is root (e.g., /?feed=rss2&cat=5)
    if (taxonomyEvidence && hasTaxonomyQueryParams(candidateUrl, taxonomyEvidence)) {
      return "probable";
    }
    return candidatePath === "/" ? "generic" : "unrelated";
  }

  // Exact path match
  if (candidatePath === targetPath || candidatePath.startsWith(`${targetPath}/`)) {
    return "exact";
  }

  // Candidate contains target scope as path segment
  const scopeSegments = targetPath.split("/").filter(Boolean);
  const candidateSegments = candidatePath.split("/").filter(Boolean);
  if (scopeSegments.some((seg) => candidateSegments.includes(seg))) {
    return "probable";
  }

  if (hasIndexScopedQueryParam(candidateUrl, targetUrl)) {
    return "probable";
  }

  // Candidate has taxonomy query parameters matching extracted evidence
  if (taxonomyEvidence && hasTaxonomyQueryParams(candidateUrl, taxonomyEvidence)) {
    return "probable";
  }

  // Generic root-level feed paths (including common feed file extensions)
  if (
    candidatePath === "/rss" ||
    candidatePath === "/feed" ||
    candidatePath === "/" ||
    /^\/(?:rss|feed|atom)\.[a-z]+$/.test(candidatePath) ||
    /^\/(?:rss|feed|atom)(?:\/.*)?$/.test(candidatePath)
  ) {
    return "generic";
  }

  return "unrelated";
};

const hasIndexScopedQueryParam = (candidateUrl: string, targetUrl: string) => {
  try {
    const targetPath = normalizePath(targetUrl);
    if (targetPath === "/") return false;

    const candidate = new URL(candidateUrl);
    const rawIndex = candidate.searchParams.get("index");
    if (!rawIndex) return false;

    const normalizedIndex = rawIndex.replace(/\/+$/, "").toLowerCase() || "/";
    return normalizedIndex === targetPath || normalizedIndex.startsWith(`${targetPath}/`);
  } catch {
    return false;
  }
};

/**
 * Check if a candidate URL has taxonomy query parameters that match
 * extracted taxonomy evidence. Used to identify scoped feeds served
 * via query parameters (e.g., /?feed=rss2&cat=5).
 */
const hasTaxonomyQueryParams = (
  candidateUrl: string,
  evidence: TaxonomyEvidence,
): boolean => {
  try {
    const search = new URL(candidateUrl).search.toLowerCase();
    if (!search) return false;

    const paramPatterns = [/[?&]cat(?:egory)?=([^&]+)/gi, /[?&]tag=([^&]+)/gi, /[?&]term=([^&]+)/gi, /[?&]section=([^&]+)/gi];
    for (const pattern of paramPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(search)) !== null) {
        const value = decodeURIComponent(match[1] || "").toLowerCase();
        if (
          evidence.sectionIds.some((id) => id.toLowerCase() === value) ||
          evidence.tagIds.some((id) => id.toLowerCase() === value) ||
          evidence.categorySlugs.some((slug) => slug.toLowerCase() === value) ||
          evidence.feedParams.some((param) => param.toLowerCase() === value)
        ) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
};

/**
 * Compute the scope-aware score with taxonomy evidence and generic penalties.
 *
 * When preferScopedDirectFeed is true (category targets):
 * - Scoped candidates get a taxonomy bonus if they match extracted evidence
 * - Generic/root feeds receive a strong penalty to prevent them from winning
 *   over weaker but legitimately scoped candidates
 *
 * When preferScopedDirectFeed is false (source targets):
 * - Taxonomy evidence still provides a small bonus
 * - No generic penalty applied (root feeds are preferred)
 */
const computeScopeAwareScore = (
  baseScore: number,
  targetUrl: string,
  candidateUrl: string,
  preferScopedDirectFeed: boolean | undefined,
  taxonomyEvidence: TaxonomyEvidence,
  scopeMatch: ScopeMatch,
): number => {
  let score = baseScore;

  // Generic penalty: when preferScopedDirectFeed is true (category targets),
  // penalize root-level feeds so scoped candidates can win even with lower base scores.
  if (preferScopedDirectFeed && scopeMatch === "generic") {
    score -= 30;
  }

  // Taxonomy evidence bonus: boost candidates that align with extracted evidence.
  // Uses path-segment-aware matching to avoid false positives from substring matches
  // (e.g., scope token "art" should not match path "/smart/rss").
  if (taxonomyEvidence.sectionIds.length > 0 || taxonomyEvidence.categorySlugs.length > 0 || taxonomyEvidence.tagIds.length > 0) {
    try {
      const candidateSegments = normalizePath(candidateUrl).split("/").filter(Boolean);
      const scopeSegments = normalizePath(targetUrl).split("/").filter(Boolean);

      const hasMatchingSlug = taxonomyEvidence.categorySlugs.some(
        (slug) => candidateSegments.includes(slug),
      );
      const hasMatchingHandle = taxonomyEvidence.canonicalSectionHandles.some(
        (handle) => candidateSegments.includes(handle),
      );

      if (hasMatchingSlug || hasMatchingHandle) {
        score += 20;
      } else if (scopeSegments.length > 0 && scopeSegments.every((seg) => candidateSegments.includes(seg))) {
        score += 12;
      }
    } catch {}
  }

  return score;
};

const normalizePath = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").toLowerCase() || "/";
  } catch {
    return "/";
  }
};

const computeScopeScore = (targetUrl: string, candidateUrl: string, preferScopedDirectFeed?: boolean) => {
  const targetPath = normalizePath(targetUrl);
  const candidatePath = normalizePath(candidateUrl);

  if (targetPath === "/") {
    return candidatePath === "/" ? 20 : 0;
  }

  if (candidatePath === targetPath) return 50;
  if (candidatePath.startsWith(`${targetPath}/`)) return 45;
  if (candidatePath.includes(targetPath.replace(/^\//, ""))) return 25;
  if (preferScopedDirectFeed && (candidatePath === "/rss" || candidatePath === "/feed")) return -10;
  return 0;
};

const computeCandidateScore = (
  input: { pageUrl: string; preferScopedDirectFeed?: boolean },
  candidate: Omit<FeedCandidate, "score" | "scopeMatch">,
  taxonomyEvidence: TaxonomyEvidence = emptyTaxonomyEvidence(),
) => {
  let score = 0;

  // Base detection method score
  if (candidate.detection === "direct-feed") score += 30;
  if (candidate.detection === "http-link") score += 35;
  if (candidate.detection === "html-link") score += 25;
  if (candidate.detection === "html-raw-url") score += 20;
  if (candidate.detection === "robots-sitemap") score += 18;
  if (candidate.detection === "cms-fingerprint") score += 22;
  if (candidate.detection === "taxonomy-extraction") score += 28;
  if (candidate.detection === "directory-traversal") score += 15;

  // Content type score
  if (candidate.contentType === "application/rss+xml") score += 10;
  if (candidate.contentType === "application/atom+xml") score += 10;
  if (candidate.contentType === "application/feed+json") score += 12;
  if (candidate.contentType === "application/json") score += 6;

  // Base scope score from path affinity
  score += computeScopeScore(input.pageUrl, candidate.feedUrl, input.preferScopedDirectFeed);

  // Scope classification (uses taxonomy evidence to detect query-param scoped feeds)
  const scopeMatch = classifyScopeMatch(input.pageUrl, candidate.feedUrl, taxonomyEvidence);

  // Apply taxonomy evidence bonus and generic penalty
  score = computeScopeAwareScore(
    score,
    input.pageUrl,
    candidate.feedUrl,
    input.preferScopedDirectFeed,
    taxonomyEvidence,
    scopeMatch,
  );

  return { score, scopeMatch };
};

const toScopeConfidence = (score: number) => {
  if (score >= 80) return "high" as const;
  if (score >= 45) return "medium" as const;
  return "low" as const;
};

const summarizeTopCandidates = (candidates: FeedCandidate[], limit = 5): DiscoverySummaryCandidate[] =>
  [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((candidate) => ({
      feedUrl: candidate.feedUrl,
      detection: candidate.detection,
      score: candidate.score,
      contentType: candidate.contentType,
      scopeMatch: candidate.scopeMatch,
    }));

const summarizeRejectedCandidate = (
  candidate: FeedCandidate,
  reason: string,
): RejectedCandidate => ({
  feedUrl: candidate.feedUrl,
  detection: candidate.detection,
  score: candidate.score,
  contentType: candidate.contentType,
  scopeMatch: candidate.scopeMatch,
  reason,
});

export const verifyFeedCandidate = async (
  candidateUrl: string,
  input: {
    userAgent: string;
    acceptLanguage?: string;
  },
) => {
  const response = await safeFetch(candidateUrl, {
    allowCrossDomainRedirects: true,
    headers: {
      "User-Agent": input.userAgent,
      Accept: "application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, text/html,application/xhtml+xml",
      ...(input.acceptLanguage ? { "Accept-Language": input.acceptLanguage } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${candidateUrl}`);
  }

  const body = await response.text();
  const contentType = normalizeSupportedContentType(response.headers.get("content-type"));
  const valid =
    looksLikeFeed(body) ||
    looksLikeJsonFeed(body) ||
    isDefinitiveFeedContentType(contentType);

  if (!valid) {
    throw new Error(`Candidate ${candidateUrl} did not validate as a feed`);
  }

  return {
    feedUrl: response.url,
    contentType,
  };
};

export async function discoverFeedForUrl(input: {
  pageUrl: string;
  existingFeedUrl?: string | null;
  userAgent: string;
  acceptLanguage?: string;
  preferScopedDirectFeed?: boolean;
}): Promise<FeedDiscoveryResult> {
  let lastError = "No feed candidates succeeded.";
  const candidateUrls = buildScopedFeedCandidates(input.pageUrl, input.existingFeedUrl || null);
  const acceptedCandidates: FeedCandidate[] = [];
  const seenAcceptedFeeds = new Set<string>();
  const rejectedCandidates: RejectedCandidate[] = [];
  const taxonomyEvidence = emptyTaxonomyEvidence();
  let mainPageFingerprints: string[] = [];
  let mainPageHtml = "";

  const resolveBestVerifiedCandidate = async () => {
    acceptedCandidates.sort((a, b) => b.score - a.score);
    for (const candidate of acceptedCandidates) {
      try {
        const verified = await verifyFeedCandidate(candidate.feedUrl, input);
        return {
          feedUrl: verified.feedUrl,
          discoveredVia: candidate.discoveredVia,
          detection: candidate.detection,
          contentType: verified.contentType,
          score: candidate.score,
          scopeConfidence: toScopeConfidence(candidate.score),
          scopeMatch: candidate.scopeMatch,
          taxonomyEvidence,
          topCandidates: summarizeTopCandidates(acceptedCandidates),
          rejectedCandidates,
        };
      } catch (error: any) {
        const reason = error?.message || String(error);
        lastError = reason;
        rejectedCandidates.push(summarizeRejectedCandidate(candidate, reason));
      }
    }

    // All candidates failed verification — clear the list so downstream
    // fallback steps (taxonomy heuristics, directory traversal) can see
    // that no usable candidates remain.
    acceptedCandidates.length = 0;
    return null;
  };

  // ── Step 1: Probe page header and extract initial metadata ─────────────
  try {
    const headResponse = await safeFetch(input.pageUrl, {
      method: "HEAD",
      headers: {
        "User-Agent": input.userAgent,
        Accept: "application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, text/html,application/xhtml+xml",
        ...(input.acceptLanguage ? { "Accept-Language": input.acceptLanguage } : {}),
      },
    });

    if (headResponse.ok) {
      const contentType = normalizeSupportedContentType(headResponse.headers.get("content-type"));
      if (isDefinitiveFeedContentType(contentType) && !seenAcceptedFeeds.has(headResponse.url)) {
        const candidateBase = {
          feedUrl: headResponse.url,
          discoveredVia: input.pageUrl,
          detection: "direct-feed" as const,
          contentType,
        };
        const { score, scopeMatch } = computeCandidateScore(input, candidateBase, taxonomyEvidence);
        acceptedCandidates.push({ ...candidateBase, score, scopeMatch });
        seenAcceptedFeeds.add(headResponse.url);
      }

      for (const headerFeed of parseLinkHeaderFeeds(headResponse.headers.get("link"), headResponse.url || input.pageUrl)) {
        if (seenAcceptedFeeds.has(headerFeed.feedUrl)) continue;
        const candidateBase = {
          feedUrl: headerFeed.feedUrl,
          discoveredVia: input.pageUrl,
          detection: "http-link" as const,
          contentType: headerFeed.contentType,
        };
        const { score, scopeMatch } = computeCandidateScore(input, candidateBase, taxonomyEvidence);
        acceptedCandidates.push({ ...candidateBase, score, scopeMatch });
        seenAcceptedFeeds.add(headerFeed.feedUrl);
      }
    }
  } catch (error: any) {
    lastError = `${error?.message || String(error)} via HEAD ${input.pageUrl}`;
  }

  if (acceptedCandidates.length > 0 && !input.preferScopedDirectFeed) {
    const winner = await resolveBestVerifiedCandidate();
    if (winner) {
      return winner;
    }
  }

  // ── Step 2: Probe candidate URLs, extract taxonomy evidence, apply heuristics
  for (const candidateUrl of candidateUrls) {
    try {
      const response = await safeFetch(candidateUrl, {
        allowCrossDomainRedirects: true,
        headers: {
          "User-Agent": input.userAgent,
          Accept: "application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, text/html,application/xhtml+xml",
          ...(input.acceptLanguage ? { "Accept-Language": input.acceptLanguage } : {}),
        },
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status} from ${candidateUrl}`;
        continue;
      }

      const body = await response.text();
      const resolvedUrl = response.url || input.pageUrl;
      const detectedContentType = normalizeSupportedContentType(response.headers.get("content-type"));

      // Extract taxonomy evidence from the main page URL only (not every candidate).
      // This avoids redundant regex passes on 15+ candidate URLs and prevents
      // noise from unrelated pages polluting the evidence accumulator.
      // isDefinitiveFeedContentType covers rss/atom/feed+json — anything else
      // (text/html, null, etc.) is safe to treat as a page worth extracting from.
      const isMainPage = resolvedUrl === input.pageUrl || candidateUrl === input.pageUrl;
      if (isMainPage && !isDefinitiveFeedContentType(detectedContentType)) {
        mainPageHtml = body;
        const pageEvidence = extractTaxonomyEvidence(body, resolvedUrl);
        accumulateTaxonomyEvidence(taxonomyEvidence, pageEvidence);
      }

      // Detect CMS fingerprints (used for both regular and taxonomy heuristics)
      const fingerprints = detectCmsFingerprints(body, resolvedUrl, response.headers);
      mainPageFingerprints = fingerprints;

      // ── Regular candidate extraction ────────────────────────────────
      if (
        looksLikeFeed(body) ||
        looksLikeJsonFeed(body) ||
        isDefinitiveFeedContentType(detectedContentType)
      ) {
        if (!seenAcceptedFeeds.has(response.url)) {
          const candidateBase = {
            feedUrl: response.url,
            discoveredVia: candidateUrl,
            detection: "direct-feed" as const,
            contentType: detectedContentType,
          };
          const { score, scopeMatch } = computeCandidateScore(input, candidateBase, taxonomyEvidence);
          acceptedCandidates.push({ ...candidateBase, score, scopeMatch });
          seenAcceptedFeeds.add(response.url);
        }
      }

      for (const declaredFeed of resolveHtmlDeclaredFeeds(body, resolvedUrl)) {
        if (seenAcceptedFeeds.has(declaredFeed.feedUrl)) continue;
        const candidateBase = {
          feedUrl: declaredFeed.feedUrl,
          discoveredVia: candidateUrl,
          detection: "html-link" as const,
          contentType: declaredFeed.contentType,
        };
        const { score, scopeMatch } = computeCandidateScore(input, candidateBase, taxonomyEvidence);
        acceptedCandidates.push({ ...candidateBase, score, scopeMatch });
        seenAcceptedFeeds.add(declaredFeed.feedUrl);
      }

      for (const headerFeed of parseLinkHeaderFeeds(response.headers.get("link"), resolvedUrl)) {
        if (seenAcceptedFeeds.has(headerFeed.feedUrl)) continue;
        const candidateBase = {
          feedUrl: headerFeed.feedUrl,
          discoveredVia: candidateUrl,
          detection: "http-link" as const,
          contentType: headerFeed.contentType,
        };
        const { score, scopeMatch } = computeCandidateScore(input, candidateBase, taxonomyEvidence);
        acceptedCandidates.push({ ...candidateBase, score, scopeMatch });
        seenAcceptedFeeds.add(headerFeed.feedUrl);
      }

      for (const extractedFeedUrl of extractFeedLikeUrlsFromHtml(body, resolvedUrl)) {
        if (seenAcceptedFeeds.has(extractedFeedUrl)) continue;
        const candidateBase = {
          feedUrl: extractedFeedUrl,
          discoveredVia: candidateUrl,
          detection: "html-raw-url" as const,
          contentType: null,
        };
        const { score, scopeMatch } = computeCandidateScore(input, candidateBase, taxonomyEvidence);
        acceptedCandidates.push({ ...candidateBase, score, scopeMatch });
        seenAcceptedFeeds.add(extractedFeedUrl);
      }

      for (const fingerprintCandidate of buildCmsFingerprintCandidates(resolvedUrl, fingerprints)) {
        if (seenAcceptedFeeds.has(fingerprintCandidate)) continue;
        const candidateBase = {
          feedUrl: fingerprintCandidate,
          discoveredVia: `${candidateUrl}#${fingerprints.join(",")}`,
          detection: "cms-fingerprint" as const,
          contentType: null,
        };
        const { score, scopeMatch } = computeCandidateScore(input, candidateBase, taxonomyEvidence);
        acceptedCandidates.push({ ...candidateBase, score, scopeMatch });
        seenAcceptedFeeds.add(fingerprintCandidate);
      }

      // ── Taxonomy heuristic candidates (scoped targets only) ─────────
      if (input.preferScopedDirectFeed) {
        const heuristicUrls = buildTaxonomyHeuristicCandidates(
          resolvedUrl,
          taxonomyEvidence,
          fingerprints,
        );
        for (const heuristicUrl of heuristicUrls) {
          if (seenAcceptedFeeds.has(heuristicUrl)) continue;
          const candidateBase = {
            feedUrl: heuristicUrl,
            discoveredVia: `${candidateUrl}#taxonomy-heuristic`,
            detection: "taxonomy-extraction" as const,
            contentType: null,
          };
          const { score, scopeMatch } = computeCandidateScore(input, candidateBase, taxonomyEvidence);
          acceptedCandidates.push({ ...candidateBase, score, scopeMatch });
          seenAcceptedFeeds.add(heuristicUrl);
        }
      }

      if (acceptedCandidates.length > 0) {
        lastError = `Collected ${acceptedCandidates.length} feed candidate(s) while probing ${candidateUrl}`;
        if (!input.preferScopedDirectFeed) {
          continue;
        }
      }

      lastError = `No feed markers in ${candidateUrl}`;
    } catch (error: any) {
      lastError = `${error?.message || String(error)} via ${candidateUrl}`;
    }
  }

  if (acceptedCandidates.length > 0) {
    const winner = await resolveBestVerifiedCandidate();
    if (winner) {
      return winner;
    }
  }

  // ── Step 3: Sitemap-based discovery ──────────────────────────────────
  const sitemapCandidates = await collectSitemapFeedCandidates(input, seenAcceptedFeeds);
  if (sitemapCandidates.length > 0) {
    acceptedCandidates.push(...sitemapCandidates);
    const winner = await resolveBestVerifiedCandidate();
    if (winner) {
      return winner;
    }
  }

  // ── Step 4: Final taxonomy heuristics (last resort for scoped targets) ──
  if (input.preferScopedDirectFeed && acceptedCandidates.length === 0) {
    const lastResortUrls = buildTaxonomyHeuristicCandidates(
      input.pageUrl,
      taxonomyEvidence,
      mainPageFingerprints,
    );
    for (const url of lastResortUrls) {
      if (seenAcceptedFeeds.has(url)) continue;
      const candidateBase = {
        feedUrl: url,
        discoveredVia: `${input.pageUrl}#taxonomy-heuristic`,
        detection: "taxonomy-extraction" as const,
        contentType: null,
      };
      const { score, scopeMatch } = computeCandidateScore(input, candidateBase, taxonomyEvidence);
      acceptedCandidates.push({ ...candidateBase, score, scopeMatch });
      seenAcceptedFeeds.add(url);
    }
    if (acceptedCandidates.length > 0) {
      const winner = await resolveBestVerifiedCandidate();
      if (winner) {
        return winner;
      }
    }
  }

  // ── Step 5: Feed directory traversal (last resort) ──────────────────────
  // When all prior discovery paths produced no verified feed, check whether
  // the target page links to a feed-directory page. If so, fetch that single
  // directory page, classify it, match the target against directory entries,
  // and verify the matched feed candidate through the normal path.
  if (acceptedCandidates.length === 0 && mainPageHtml) {
    const directoryUrl = findDirectoryUrl(mainPageHtml, input.pageUrl);
    if (directoryUrl && !seenAcceptedFeeds.has(directoryUrl)) {
      try {
        const dirResponse = await safeFetch(directoryUrl, {
          headers: {
            "User-Agent": input.userAgent,
            Accept: "text/html, application/xml, text/xml, */*",
            ...(input.acceptLanguage ? { "Accept-Language": input.acceptLanguage } : {}),
          },
        });

        if (dirResponse.ok) {
          const dirHtml = await dirResponse.text();

          if (isFeedDirectoryPage(dirHtml, directoryUrl)) {
            const entries = parseDirectoryEntries(dirHtml, directoryUrl);
            const matched = matchTargetToDirectoryEntries(entries, input.pageUrl);

            if (matched && !seenAcceptedFeeds.has(matched.feedUrl)) {
              // Record directory traversal evidence
              taxonomyEvidence.directoryTraversal = {
                traversedUrl: directoryUrl,
                matchedLabel: matched.label,
                candidateCount: entries.length,
              };

              const candidateBase = {
                feedUrl: matched.feedUrl,
                discoveredVia: directoryUrl,
                detection: "directory-traversal" as const,
                contentType: null,
              };
              const { score, scopeMatch } = computeCandidateScore(input, candidateBase, taxonomyEvidence);
              acceptedCandidates.push({ ...candidateBase, score, scopeMatch });
              seenAcceptedFeeds.add(matched.feedUrl);

              const winner = await resolveBestVerifiedCandidate();
              if (winner) {
                return winner;
              }
            }
          }
        }
      } catch (error: any) {
        lastError = `Directory traversal failed: ${error?.message || String(error)} via ${directoryUrl}`;
      }
    }
  }

  return {
    feedUrl: null,
    discoveredVia: null,
    detection: "none" as const,
    score: 0,
    scopeConfidence: "low" as const,
    scopeMatch: "unrelated" as const,
    taxonomyEvidence,
    topCandidates: summarizeTopCandidates(acceptedCandidates),
    rejectedCandidates,
    lastError,
  };
}
