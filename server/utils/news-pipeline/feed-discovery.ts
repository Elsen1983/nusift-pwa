import { safeFetch } from "../ssrf-guard";
import { buildFeedUrlCandidates } from "./import-rss";

type SupportedFeedType =
  | "application/rss+xml"
  | "application/atom+xml"
  | "application/feed+json"
  | "application/json";

type FeedCandidate = {
  feedUrl: string;
  discoveredVia: string;
  detection: "direct-feed" | "html-link" | "html-raw-url" | "http-link" | "robots-sitemap" | "cms-fingerprint";
  contentType?: SupportedFeedType | null;
  score: number;
};

type DiscoverySummaryCandidate = {
  feedUrl: string;
  detection: FeedCandidate["detection"];
  score: number;
  contentType?: SupportedFeedType | null;
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

        const candidate = {
          feedUrl: loc,
          discoveredVia: sitemapUrl,
          detection: "robots-sitemap" as const,
          contentType: null,
        };
        acceptedCandidates.push({
          ...candidate,
          score: computeCandidateScore(input, candidate) + relevanceBonus,
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
    candidates.add(pageUrl);
  } catch {
    candidates.add(pageUrl);
  }

  return [...candidates].filter(Boolean);
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
  candidate: Omit<FeedCandidate, "score">,
) => {
  let score = 0;

  if (candidate.detection === "direct-feed") score += 30;
  if (candidate.detection === "http-link") score += 35;
  if (candidate.detection === "html-link") score += 25;
  if (candidate.detection === "html-raw-url") score += 20;
  if (candidate.detection === "robots-sitemap") score += 18;
  if (candidate.detection === "cms-fingerprint") score += 22;

  if (candidate.contentType === "application/rss+xml") score += 10;
  if (candidate.contentType === "application/atom+xml") score += 10;
  if (candidate.contentType === "application/feed+json") score += 12;
  if (candidate.contentType === "application/json") score += 6;

  score += computeScopeScore(input.pageUrl, candidate.feedUrl, input.preferScopedDirectFeed);
  return score;
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
    }));

const summarizeRejectedCandidate = (
  candidate: FeedCandidate,
  reason: string,
): RejectedCandidate => ({
  feedUrl: candidate.feedUrl,
  detection: candidate.detection,
  score: candidate.score,
  contentType: candidate.contentType,
  reason,
});

const verifyFeedCandidate = async (
  candidateUrl: string,
  input: {
    userAgent: string;
    acceptLanguage?: string;
  },
) => {
  const response = await safeFetch(candidateUrl, {
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
}): Promise<{
  feedUrl: string | null;
  discoveredVia: string | null;
  detection:
    | "direct-feed"
    | "html-link"
    | "html-raw-url"
    | "http-link"
    | "robots-sitemap"
    | "cms-fingerprint"
    | "none";
  contentType?: SupportedFeedType | null;
  score: number;
  scopeConfidence: "high" | "medium" | "low";
  topCandidates: DiscoverySummaryCandidate[];
  rejectedCandidates: RejectedCandidate[];
  lastError?: string;
}> {
  let lastError = "No feed candidates succeeded.";
  const candidateUrls = buildScopedFeedCandidates(input.pageUrl, input.existingFeedUrl || null);
  const acceptedCandidates: FeedCandidate[] = [];
  const seenAcceptedFeeds = new Set<string>();
  const rejectedCandidates: RejectedCandidate[] = [];
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
          topCandidates: summarizeTopCandidates(acceptedCandidates),
          rejectedCandidates,
        };
      } catch (error: any) {
        const reason = error?.message || String(error);
        lastError = reason;
        rejectedCandidates.push(summarizeRejectedCandidate(candidate, reason));
      }
    }

    return null;
  };

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
        const candidate = {
          feedUrl: headResponse.url,
          discoveredVia: input.pageUrl,
          detection: "direct-feed" as const,
          contentType,
        };
        acceptedCandidates.push({
          ...candidate,
          score: computeCandidateScore(input, candidate),
        });
        seenAcceptedFeeds.add(headResponse.url);
      }

      for (const headerFeed of parseLinkHeaderFeeds(headResponse.headers.get("link"), headResponse.url || input.pageUrl)) {
        if (seenAcceptedFeeds.has(headerFeed.feedUrl)) continue;
        const candidate = {
          feedUrl: headerFeed.feedUrl,
          discoveredVia: input.pageUrl,
          detection: "http-link" as const,
          contentType: headerFeed.contentType,
        };
        acceptedCandidates.push({
          ...candidate,
          score: computeCandidateScore(input, candidate),
        });
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

  for (const candidateUrl of candidateUrls) {
    try {
      const response = await safeFetch(candidateUrl, {
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
      const detectedContentType = normalizeSupportedContentType(response.headers.get("content-type"));
      if (
        looksLikeFeed(body) ||
        looksLikeJsonFeed(body) ||
        isDefinitiveFeedContentType(detectedContentType)
      ) {
        if (!seenAcceptedFeeds.has(response.url)) {
          const candidate = {
            feedUrl: response.url,
            discoveredVia: candidateUrl,
            detection: "direct-feed" as const,
            contentType: detectedContentType,
          };
          acceptedCandidates.push({
            ...candidate,
            score: computeCandidateScore(input, candidate),
          });
          seenAcceptedFeeds.add(response.url);
        }
      }

      for (const declaredFeed of resolveHtmlDeclaredFeeds(body, response.url || input.pageUrl)) {
        if (seenAcceptedFeeds.has(declaredFeed.feedUrl)) continue;
        const candidate = {
          feedUrl: declaredFeed.feedUrl,
          discoveredVia: candidateUrl,
          detection: "html-link" as const,
          contentType: declaredFeed.contentType,
        };
        acceptedCandidates.push({
          ...candidate,
          score: computeCandidateScore(input, candidate),
        });
        seenAcceptedFeeds.add(declaredFeed.feedUrl);
      }

      for (const headerFeed of parseLinkHeaderFeeds(response.headers.get("link"), response.url || input.pageUrl)) {
        if (seenAcceptedFeeds.has(headerFeed.feedUrl)) continue;
        const candidate = {
          feedUrl: headerFeed.feedUrl,
          discoveredVia: candidateUrl,
          detection: "http-link" as const,
          contentType: headerFeed.contentType,
        };
        acceptedCandidates.push({
          ...candidate,
          score: computeCandidateScore(input, candidate),
        });
        seenAcceptedFeeds.add(headerFeed.feedUrl);
      }

      for (const extractedFeedUrl of extractFeedLikeUrlsFromHtml(body, response.url || input.pageUrl)) {
        if (seenAcceptedFeeds.has(extractedFeedUrl)) continue;
        const candidate = {
          feedUrl: extractedFeedUrl,
          discoveredVia: candidateUrl,
          detection: "html-raw-url" as const,
          contentType: null,
        };
        acceptedCandidates.push({
          ...candidate,
          score: computeCandidateScore(input, candidate),
        });
        seenAcceptedFeeds.add(extractedFeedUrl);
      }

      const fingerprints = detectCmsFingerprints(body, response.url || input.pageUrl, response.headers);
      for (const fingerprintCandidate of buildCmsFingerprintCandidates(response.url || input.pageUrl, fingerprints)) {
        if (seenAcceptedFeeds.has(fingerprintCandidate)) continue;
        const candidate = {
          feedUrl: fingerprintCandidate,
          discoveredVia: `${candidateUrl}#${fingerprints.join(",")}`,
          detection: "cms-fingerprint" as const,
          contentType: null,
        };
        acceptedCandidates.push({
          ...candidate,
          score: computeCandidateScore(input, candidate),
        });
        seenAcceptedFeeds.add(fingerprintCandidate);
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

  const sitemapCandidates = await collectSitemapFeedCandidates(input, seenAcceptedFeeds);
  if (sitemapCandidates.length > 0) {
    acceptedCandidates.push(...sitemapCandidates);
    const winner = await resolveBestVerifiedCandidate();
    if (winner) {
      return winner;
    }
  }

  return {
    feedUrl: null,
    discoveredVia: null,
    detection: "none" as const,
    score: 0,
    scopeConfidence: "low" as const,
    topCandidates: summarizeTopCandidates(acceptedCandidates),
    rejectedCandidates,
    lastError,
  };
}
