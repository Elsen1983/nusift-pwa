import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { safeFetch } from "../ssrf-guard";
import { SSRFError } from "../ssrf-guard";
import { logAgentScan } from "./log";
import { cleanFeedValue, hashText, normalizeFeedText, normalizeUrl, stripHtml } from "./text";
import { normalizeFeedTextDetailed } from "./normalize-feed-text";
import type {
  HardCaseDiscoveryCandidate,
  IngestCandidate,
  IngestRejectedItem,
  IngestResult,
  IngestSkipSummary,
} from "./types";
import { buildFeedUrlCandidates } from "./import-rss";
import { discoverFeedForUrl } from "./feed-discovery";

const parseRssItems = (xml: string) => {
  const items: Array<Record<string, string>> = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const readTag = (block: string, tag: string) =>
    cleanFeedValue(
      block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ||
        "",
    );

  for (const match of xml.matchAll(itemRegex)) {
    const block = match[0] || "";
    items.push({
      title: readTag(block, "title"),
      link: readTag(block, "link"),
      guid: readTag(block, "guid"),
      pubDate: readTag(block, "pubDate"),
      description: readTag(block, "description"),
    });
  }

  return items;
};

const parseAtomItems = (xml: string) => {
  const items: Array<Record<string, string>> = [];
  const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
  const readTag = (block: string, tag: string) =>
    cleanFeedValue(
      block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ||
        "",
    );

  for (const match of xml.matchAll(entryRegex)) {
    const block = match[0] || "";
    const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);
    items.push({
      title: readTag(block, "title"),
      link: cleanFeedValue(linkMatch?.[1] || ""),
      guid: readTag(block, "id"),
      pubDate: readTag(block, "updated") || readTag(block, "published"),
      description: readTag(block, "summary") || readTag(block, "content"),
    });
  }

  return items;
};

const parseJsonFeedItems = (body: string) => {
  try {
    const parsed = JSON.parse(body);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.version !== "string" ||
      !parsed.version.toLowerCase().includes("jsonfeed") ||
      !Array.isArray(parsed.items)
    ) {
      return [];
    }

    return parsed.items.map((item: any) => ({
      title: cleanFeedValue(String(item?.title || "")),
      link: cleanFeedValue(String(item?.url || item?.external_url || "")),
      guid: cleanFeedValue(String(item?.id || item?.url || "")),
      pubDate: cleanFeedValue(
        String(item?.date_published || item?.date_modified || ""),
      ),
      description: cleanFeedValue(
        String(item?.summary || item?.content_text || item?.content_html || ""),
      ),
    }));
  } catch {
    return [];
  }
};

const parseFeedItems = (body: string) => {
  const rssItems = parseRssItems(body);
  if (rssItems.length > 0) {
    return { format: "rss" as const, items: rssItems };
  }

  const atomItems = parseAtomItems(body);
  if (atomItems.length > 0) {
    return { format: "atom" as const, items: atomItems };
  }

  const jsonItems = parseJsonFeedItems(body);
  if (jsonItems.length > 0) {
    return { format: "json" as const, items: jsonItems };
  }

  return { format: "unknown" as const, items: [] as Array<Record<string, string>> };
};

const emptySkipSummary = (): IngestSkipSummary => ({
  emptyLink: 0,
  outOfScope: 0,
  staleOrMissingPublishedAt: 0,
  htmlFallbackNonArticle: 0,
  htmlFallbackStale: 0,
});

const pushRejectedItem = (
  rejectedItems: IngestRejectedItem[],
  item: IngestRejectedItem,
) => {
  if (rejectedItems.length >= 50) return;
  rejectedItems.push(item);
};

const getContentType = (response: Response) =>
  response.headers.get("content-type") || "unknown";

const getRootHost = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const buildDiscoveryEvidencePayload = (
  targetUrl: string,
  discovery: {
    feedUrl: string | null;
    discoveredVia?: string | null;
    detection: string;
    scopeConfidence?: string;
    score?: number;
    topCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
    }>;
    rejectedCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      reason: string;
    }>;
    lastError?: string;
  },
) =>
  ({
    evaluatedAt: new Date().toISOString(),
    targetUrl,
    feedUrl: discovery.feedUrl,
    discoveredVia: discovery.discoveredVia || null,
    detection: discovery.detection,
    scopeConfidence: discovery.scopeConfidence || "low",
    score: discovery.score ?? 0,
    topCandidates: discovery.topCandidates || [],
    rejectedCandidates: discovery.rejectedCandidates || [],
    lastError: discovery.lastError || null,
  }) satisfies Prisma.InputJsonValue;

const getHardCaseQueueReason = (discovery: {
  topCandidates?: unknown[];
  rejectedCandidates?: unknown[];
  lastError?: string;
}) => {
  if ((discovery.rejectedCandidates?.length || 0) > 0) {
    return "candidate_verification_failed" as const;
  }

  if (String(discovery.lastError || "").trim().length > 0) {
    return "blocked_or_fetch_failed" as const;
  }

  return "no_feed_discovered" as const;
};

export const shouldQueueHardCaseDiscovery = (discovery: {
  feedUrl: string | null;
  topCandidates?: unknown[];
  rejectedCandidates?: unknown[];
  lastError?: string;
}) => {
  if (discovery.feedUrl) return false;
  return (
    (discovery.topCandidates?.length || 0) > 0 ||
    (discovery.rejectedCandidates?.length || 0) > 0 ||
    String(discovery.lastError || "").trim().length > 0
  );
};

const buildHardCaseDiscoveryCandidate = (input: {
  targetType: "source" | "category";
  sourceId: string;
  categoryId?: string | null;
  targetUrl: string;
  existingFeedUrl?: string | null;
  discovery: {
    feedUrl: string | null;
    discoveredVia?: string | null;
    detection: string;
    score?: number;
    scopeConfidence?: string;
    topCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
    }>;
    rejectedCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      reason: string;
    }>;
    lastError?: string;
  };
}): HardCaseDiscoveryCandidate | null => {
  if (!shouldQueueHardCaseDiscovery(input.discovery)) {
    return null;
  }

  return {
    targetType: input.targetType,
    sourceId: input.sourceId,
    categoryId: input.categoryId || null,
    targetUrl: input.targetUrl,
    existingFeedUrl: input.existingFeedUrl || null,
    queueReason: getHardCaseQueueReason(input.discovery),
    discovery: input.discovery,
  };
};

const isLikelyArticleLink = (href: string, sourceUrl: string) => {
  try {
    const url = new URL(href);
    if (url.hostname.replace(/^www\./, "") !== getRootHost(sourceUrl)) return false;
    const path = url.pathname.replace(/^\/|\/$/g, "");
    if (!path) return false;
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
};

const BLOCKED_HTML_FALLBACK_PATTERNS = [
  /^\/?$/,
  /^\/news\/?$/i,
  /^\/sport\/?$/i,
  /^\/business\/?$/i,
  /^\/showbiz\/?$/i,
  /^\/whatson\/?$/i,
  /^\/all-about\//i,
  /^\/tag\//i,
  /^\/topics?\//i,
  /^\/newsletter/i,
  /^\/newsletters/i,
  /^\/newsletter-preference/i,
  /^\/preferences/i,
  /^\/about/i,
  /^\/contact/i,
  /^\/privacy/i,
  /^\/terms/i,
  /^\/advertising/i,
  /^\/sitemap/i,
  /^\/auth/i,
];

const isBlockedFallbackPath = (href: string) => {
  try {
    const pathname = new URL(href).pathname.replace(/\/+$/, "") || "/";
    return BLOCKED_HTML_FALLBACK_PATTERNS.some((pattern) => pattern.test(pathname));
  } catch {
    return true;
  }
};

const extractPageMetadata = (html: string) => {
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
  return {
    title: stripHtml(title),
    description: stripHtml(description),
    publishedAt: toDate(publishedAtRaw),
  };
};

const resolvePublishedAtForFeedItem = async (rawPubDate: string, canonicalUrl: string) => {
  const directDate = toDate(rawPubDate);
  if (directDate) {
    return directDate;
  }

  try {
    const response = await safeFetch(canonicalUrl, {
      headers: {
        "User-Agent": "NuSift/1.0 Ingest-Agent",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const meta = extractPageMetadata(html);
    return meta.publishedAt;
  } catch {
    return null;
  }
};

const MAX_ARTICLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const isWithinFreshnessWindow = (publishedAt: Date | null, now = new Date()) => {
  if (!publishedAt) return false;
  const diff = now.getTime() - publishedAt.getTime();
  return diff >= 0 && diff <= MAX_ARTICLE_AGE_MS;
};

const extractHtmlCandidates = async (
  html: string,
  sourceUrl: string,
  sourceId: string,
  categoryPathUrl?: string | null,
) => {
  const candidates: IngestCandidate[] = [];
  const seen = new Set<string>();
  const now = new Date();
  const rejectedItems: IngestRejectedItem[] = [];
  const skipSummary = emptySkipSummary();

  const linkMatches = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const links = linkMatches
    .map((match) => match[1] || "")
    .filter((href) => href && !href.startsWith("#") && !href.startsWith("javascript:"))
    .map((href) => {
      try {
        return new URL(href, sourceUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((href): href is string => Boolean(href))
    .filter((href) => isLikelyArticleLink(href, sourceUrl))
    .filter((href) => !isBlockedFallbackPath(href))
    .filter((href) => {
      try {
        const current = new URL(href);
        const root = new URL(sourceUrl).hostname.replace(/^www\./, "");
        return current.hostname.replace(/^www\./, "") === root;
      } catch {
        return false;
      }
    })
    .filter((href) => {
      if (seen.has(href)) return false;
      seen.add(href);
      return true;
    })
    .slice(0, 8);

  for (const link of links) {
    const detailResponse = await safeFetch(link, {
      headers: {
        "User-Agent": "NuSift/1.0 Ingest-Agent",
        Accept: "text/html,application/xhtml+xml",
      },
    }).catch(() => null);

    if (!detailResponse || !detailResponse.ok) continue;

    const detailHtml = await detailResponse.text();
    const meta = extractPageMetadata(detailHtml);
    const canonicalUrl = normalizeUrl(link);
    if (!canonicalUrl || isBlockedFallbackPath(canonicalUrl)) {
      skipSummary.htmlFallbackNonArticle += 1;
      pushRejectedItem(rejectedItems, {
        reason: "html_fallback_non_article",
        rawLink: link,
        canonicalUrl: canonicalUrl || null,
        title: meta.title || null,
        publishedAt: meta.publishedAt ? meta.publishedAt.toISOString() : null,
      });
      continue;
    }
    if (categoryPathUrl && !isUrlWithinCategoryPath(canonicalUrl, categoryPathUrl)) {
      skipSummary.outOfScope += 1;
      pushRejectedItem(rejectedItems, {
        reason: "out_of_scope",
        rawLink: link,
        canonicalUrl,
        title: meta.title || null,
        publishedAt: meta.publishedAt ? meta.publishedAt.toISOString() : null,
      });
      continue;
    }
    const previewTitle = meta.title || canonicalUrl;
    if (!previewTitle || previewTitle.length < 12) {
      skipSummary.htmlFallbackNonArticle += 1;
      pushRejectedItem(rejectedItems, {
        reason: "html_fallback_non_article",
        rawLink: link,
        canonicalUrl,
        title: previewTitle || null,
        publishedAt: meta.publishedAt ? meta.publishedAt.toISOString() : null,
      });
      continue;
    }
    if (!isWithinFreshnessWindow(meta.publishedAt, now)) {
      skipSummary.htmlFallbackStale += 1;
      pushRejectedItem(rejectedItems, {
        reason: "html_fallback_stale",
        rawLink: link,
        canonicalUrl,
        title: previewTitle,
        publishedAt: meta.publishedAt ? meta.publishedAt.toISOString() : null,
      });
      continue;
    }
    const rawTitle = meta.title || canonicalUrl;
    const rawBodyText = meta.description || stripHtml(detailHtml).slice(0, 600);
    const normalizedTitle = normalizeFeedTextDetailed(rawTitle);
    const normalizedBody = normalizeFeedTextDetailed(rawBodyText);
    const itemTitle = normalizedTitle.value || canonicalUrl;
    const bodyText = normalizedBody.value;
    const contentHash = await hashText([itemTitle, canonicalUrl, bodyText].filter(Boolean).join("|"));

    candidates.push({
      sourceId,
      sourceUrl,
      canonicalUrl,
      rssGuid: null,
      rawTitle,
      title: itemTitle,
      publishedAt: meta.publishedAt,
      rawBodyText,
      bodyText: bodyText || null,
      contentHash,
      isPaywall: /paywall|subscribe|premium/i.test(html),
      rawTags: [],
      rawSignals: [],
      reasoning: `HTML detail fallback from ${link}`,
      normalizationFlags: [...new Set([
        ...(normalizedTitle.changed ? normalizedTitle.flags : []),
        ...(normalizedBody.changed ? normalizedBody.flags : []),
      ])],
      provenance: {
        origin: "html_fallback",
        feedUrl: null,
        feedFormat: null,
        discoveredFromCategoryFeed: false,
        sourcePageUrl: sourceUrl,
        fetchedAt: new Date().toISOString(),
      },
    });
  }

  return { candidates, skipSummary, rejectedItems };
};

const toDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const canonicalFromLink = (link: string) => normalizeUrl(link);

type SourceCategoryMatcher = {
  id: string;
  normalizedPath: string;
};

const normalizePathForCategoryMatch = (url: string) => {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "") || "/";
    return pathname.toLowerCase();
  } catch {
    return "/";
  }
};

const isUrlWithinCategoryPath = (url: string, categoryPathUrl: string) => {
  const categoryPath = normalizePathForCategoryMatch(categoryPathUrl);
  const articlePath = normalizePathForCategoryMatch(url);

  if (categoryPath === "/") {
    return true;
  }

  return articlePath === categoryPath || articlePath.startsWith(`${categoryPath}/`);
};

export const matchCategoryIdForUrl = (
  canonicalUrl: string,
  categories: SourceCategoryMatcher[],
) => {
  const articlePath = normalizePathForCategoryMatch(canonicalUrl);
  const orderedCategories = [...categories].sort(
    (a, b) => b.normalizedPath.length - a.normalizedPath.length,
  );

  for (const category of orderedCategories) {
    if (category.normalizedPath === "/") continue;
    if (
      articlePath === category.normalizedPath ||
      articlePath.startsWith(`${category.normalizedPath}/`)
    ) {
      return category.id;
    }
  }

  return null;
};

const attachCategoryIds = async (candidates: IngestCandidate[]) => {
  const sourceIds = [...new Set(candidates.map((candidate) => candidate.sourceId))];
  if (sourceIds.length === 0) return candidates;

  const categories = await prisma.sourceCategory.findMany({
    where: {
      newsSourceId: { in: sourceIds },
    },
    select: {
      id: true,
      newsSourceId: true,
      pathUrl: true,
    },
  });

  const categoriesBySource = new Map<string, SourceCategoryMatcher[]>();
  for (const category of categories) {
    const normalizedPath = normalizePathForCategoryMatch(category.pathUrl);
    if (!normalizedPath || normalizedPath === "/") continue;

    const existing = categoriesBySource.get(category.newsSourceId) || [];
    existing.push({
      id: category.id,
      normalizedPath,
    });
    categoriesBySource.set(category.newsSourceId, existing);
  }

  for (const entry of categoriesBySource.values()) {
    entry.sort((a, b) => b.normalizedPath.length - a.normalizedPath.length);
  }

  return candidates.map((candidate) => ({
    ...candidate,
    categoryId:
      candidate.categoryId ||
      matchCategoryIdForUrl(
        candidate.canonicalUrl,
        categoriesBySource.get(candidate.sourceId) || [],
      ),
  }));
};

const resolveCategoryFeedUrl = async (
  sourceId: string,
  category: { id: string; pathUrl: string; rssFeedUrl: string | null } | null,
) => {
  if (!category || category.rssFeedUrl) {
    return {
      feedUrl: category?.rssFeedUrl || null,
      hardCaseQueueCandidate: null as HardCaseDiscoveryCandidate | null,
    };
  }

  try {
    const discovery = await discoverFeedForUrl({
      pageUrl: category.pathUrl,
      existingFeedUrl: category.rssFeedUrl,
      userAgent: "NuSift/1.0 Ingest-Agent",
      preferScopedDirectFeed: true,
    });
    const discoveredFeedUrl = discovery.feedUrl;

    await prisma.sourceCategory.update({
      where: { id: category.id },
      data: {
        rssFeedUrl: discoveredFeedUrl,
        rssStatus: discoveredFeedUrl ? "ACTIVE" : "NO_RSS_FOUND",
        lastRssCheckAt: new Date(),
        discoveryEvidence: buildDiscoveryEvidencePayload(
          category.pathUrl,
          discovery,
        ),
      },
    });

    await logAgentScan({
      sourceId,
      categoryId: category.id,
      status: discoveredFeedUrl
        ? "CATEGORY_DISCOVERY_COMPLETED"
        : "CATEGORY_DISCOVERY_FAILED",
      executionTimeMs: 0,
      errorLog: discoveredFeedUrl
        ? `Resolved category feed ${discoveredFeedUrl} during pipeline ingest. method=${discovery.detection}, confidence=${discovery.scopeConfidence}, score=${discovery.score}`
        : `No category feed found for ${category.pathUrl} during pipeline ingest. method=${discovery.detection}, confidence=${discovery.scopeConfidence}, score=${discovery.score}${discovery.lastError ? `, lastError=${discovery.lastError}` : ""}`,
    });

    return {
      feedUrl: discoveredFeedUrl,
      hardCaseQueueCandidate: buildHardCaseDiscoveryCandidate({
        targetType: "category",
        sourceId,
        categoryId: category.id,
        targetUrl: category.pathUrl,
        existingFeedUrl: category.rssFeedUrl,
        discovery,
      }),
    };
  } catch (error: any) {
    const errorMessage = error?.message || String(error);
    await logAgentScan({
      sourceId,
      categoryId: category.id,
      status: "CATEGORY_DISCOVERY_FAILED",
      executionTimeMs: 0,
      errorLog: errorMessage,
    });
    return {
      feedUrl: null,
      hardCaseQueueCandidate: buildHardCaseDiscoveryCandidate({
        targetType: "category",
        sourceId,
        categoryId: category.id,
        targetUrl: category.pathUrl,
        existingFeedUrl: category.rssFeedUrl,
        discovery: {
          feedUrl: null,
          discoveredVia: null,
          detection: "none",
          score: 0,
          scopeConfidence: "low",
          topCandidates: [],
          rejectedCandidates: [],
          lastError: errorMessage,
        },
      }),
    };
  }
};

const resolveSourceFeedUrl = async (
  source: {
    id: string;
    frontPageUrl: string;
    rssFeedUrl: string | null;
    rssStatus?: string | null;
  },
) => {
  if (source.rssFeedUrl && source.rssStatus !== "NO_RSS_FOUND") {
    return {
      feedUrl: source.rssFeedUrl,
      hardCaseQueueCandidate: null as HardCaseDiscoveryCandidate | null,
    };
  }

  try {
    const discovery = await discoverFeedForUrl({
      pageUrl: source.frontPageUrl,
      existingFeedUrl: source.rssFeedUrl,
      userAgent: "NuSift/1.0 Ingest-Agent",
    });
    const discoveredFeedUrl = discovery.feedUrl;

    await prisma.newsSource.update({
      where: { id: source.id },
      data: {
        rssFeedUrl: discoveredFeedUrl,
        rssStatus: discoveredFeedUrl ? "ACTIVE" : "NO_RSS_FOUND",
        lastRssCheckAt: new Date(),
        discoveryEvidence: buildDiscoveryEvidencePayload(
          source.frontPageUrl,
          discovery,
        ),
      },
    });

    await logAgentScan({
      sourceId: source.id,
      status: discoveredFeedUrl
        ? "SOURCE_DISCOVERY_COMPLETED"
        : "SOURCE_DISCOVERY_FAILED",
      executionTimeMs: 0,
      errorLog: discoveredFeedUrl
        ? `Resolved source feed ${discoveredFeedUrl} during pipeline ingest. method=${discovery.detection}, confidence=${discovery.scopeConfidence}, score=${discovery.score}`
        : `No source feed found for ${source.frontPageUrl} during pipeline ingest. method=${discovery.detection}, confidence=${discovery.scopeConfidence}, score=${discovery.score}${discovery.lastError ? `, lastError=${discovery.lastError}` : ""}`,
    });

    return {
      feedUrl: discoveredFeedUrl,
      hardCaseQueueCandidate: buildHardCaseDiscoveryCandidate({
        targetType: "source",
        sourceId: source.id,
        targetUrl: source.frontPageUrl,
        existingFeedUrl: source.rssFeedUrl,
        discovery,
      }),
    };
  } catch (error: any) {
    const errorMessage = error?.message || String(error);
    await logAgentScan({
      sourceId: source.id,
      status: "SOURCE_DISCOVERY_FAILED",
      executionTimeMs: 0,
      errorLog: errorMessage,
    });
    return {
      feedUrl: null,
      hardCaseQueueCandidate: buildHardCaseDiscoveryCandidate({
        targetType: "source",
        sourceId: source.id,
        targetUrl: source.frontPageUrl,
        existingFeedUrl: source.rssFeedUrl,
        discovery: {
          feedUrl: null,
          discoveredVia: null,
          detection: "none",
          score: 0,
          scopeConfidence: "low",
          topCandidates: [],
          rejectedCandidates: [],
          lastError: errorMessage,
        },
      }),
    };
  }
};

const formatPrismaError = (error: any) => {
  if (!error) return "Unknown Prisma error";
  const code = error.code ? `code=${error.code}` : null;
  const meta = error.meta ? `meta=${JSON.stringify(error.meta)}` : null;
  const name = error.name ? `name=${error.name}` : null;
  const message = error.message ? `message=${error.message}` : null;
  return [name, code, meta, message].filter(Boolean).join(" | ");
};

export async function ingestSource(sourceId: string, categoryId?: string): Promise<IngestResult> {
  const startedAt = Date.now();
  const [source, category] = await Promise.all([
    prisma.newsSource.findUnique({
      where: { id: sourceId },
      select: {
        id: true,
        frontPageUrl: true,
        rssFeedUrl: true,
        rssStatus: true,
        mediaName: true,
      },
    }),
    categoryId
      ? prisma.sourceCategory.findUnique({
          where: { id: categoryId },
          select: {
            id: true,
            pathUrl: true,
            rssFeedUrl: true,
          },
        })
      : Promise.resolve(null),
  ]);

  if (!source) {
    await logAgentScan({
      sourceId,
      status: "SOURCE_NOT_FOUND",
      executionTimeMs: Date.now() - startedAt,
      errorLog: "No matching NewsSource record.",
    });
    return {
      sourceId,
      categoryId: categoryId || null,
      candidates: [],
      failed: 1,
      feedUrl: null,
      feedFormat: null,
      skipSummary: emptySkipSummary(),
      rejectedItems: [],
    };
  }

  const categoryFeedResolution = await resolveCategoryFeedUrl(sourceId, category);
  const sourceFeedResolution = await resolveSourceFeedUrl(source);
  const categoryFeedUrl = categoryFeedResolution.feedUrl;
  const sourceFeedUrl = sourceFeedResolution.feedUrl;
  const isUsingDedicatedCategoryFeed = Boolean(categoryId && categoryFeedUrl);
  const hardCaseQueueCandidates = [
    categoryFeedResolution.hardCaseQueueCandidate,
    sourceFeedResolution.hardCaseQueueCandidate,
  ].filter(Boolean) as HardCaseDiscoveryCandidate[];

  await logAgentScan({
    sourceId,
    categoryId,
    status: "SOURCE_FETCH_STARTED",
    executionTimeMs: 0,
    errorLog: `Fetching from ${categoryFeedUrl || sourceFeedUrl || category?.pathUrl || source.frontPageUrl} (rss=${Boolean(categoryFeedUrl || sourceFeedUrl)})`,
  });

  const preferredFeedUrl = categoryFeedUrl || sourceFeedUrl || null;
  const preferredFrontPageUrl = category?.pathUrl || source.frontPageUrl;
  const feedUrls = buildFeedUrlCandidates(preferredFeedUrl, preferredFrontPageUrl);
  try {
    let response: Response | null = null;
    let xml = "";
    let feedUrl = feedUrls[0] || preferredFrontPageUrl;
    let lastFeedFetchError = "";

    if (categoryFeedUrl) {
      await logAgentScan({
        sourceId,
        categoryId,
        status: "CATEGORY_FEED_USED",
        executionTimeMs: 0,
        errorLog: `Using category feed ${categoryFeedUrl}.`,
      });
    } else if (categoryId) {
      await logAgentScan({
        sourceId,
        categoryId,
        status: "CATEGORY_FEED_FALLBACK_TO_ROOT",
        executionTimeMs: 0,
        errorLog: `No category feed set. Falling back to root feed ${sourceFeedUrl || source.frontPageUrl}.`,
      });
    }

    for (const candidateFeedUrl of feedUrls) {
      try {
        const candidateResponse = await safeFetch(candidateFeedUrl, {
          headers: {
            "User-Agent": "NuSift/1.0 Ingest-Agent",
            Accept: "application/rss+xml, application/xml, text/xml, text/html",
          },
        });

        if (!candidateResponse.ok) {
          lastFeedFetchError = `Fetch failed for ${candidateFeedUrl} with HTTP ${candidateResponse.status}.`;
          continue;
        }

        const candidateXml = await candidateResponse.text();
        const parsedCandidateFeed = parseFeedItems(candidateXml);
        await logAgentScan({
          sourceId,
          categoryId,
          status:
            parsedCandidateFeed.format === "rss"
              ? "RSS_PARSED"
              : parsedCandidateFeed.format === "atom"
                ? "ATOM_PARSED"
                : parsedCandidateFeed.format === "json"
                  ? "JSON_FEED_PARSED"
                  : "FEED_EMPTY",
          executionTimeMs: Date.now() - startedAt,
          errorLog: `Parsed ${parsedCandidateFeed.items.length} ${parsedCandidateFeed.format.toUpperCase()} item(s) from ${candidateFeedUrl}. contentType=${getContentType(candidateResponse)} bodyLength=${candidateXml.length}.`,
        });

        if (parsedCandidateFeed.items.length > 0) {
          response = candidateResponse;
          xml = candidateXml;
          feedUrl = candidateFeedUrl;
          break;
        }

        lastFeedFetchError = `No RSS/Atom items found for ${candidateFeedUrl}.`;
      } catch (error: any) {
        lastFeedFetchError = `${error?.message || String(error)} for ${candidateFeedUrl}`;
      }
    }

    if (!response) {
      await logAgentScan({
        sourceId,
        categoryId,
        status: "FEED_EMPTY",
        executionTimeMs: Date.now() - startedAt,
        errorLog: lastFeedFetchError || `No usable feed response from ${feedUrls.join(", ")}.`,
      });
      throw new Error(lastFeedFetchError || "No usable feed response.");
    }

    const candidates: IngestCandidate[] = [];
    const parsedFeed = parseFeedItems(xml);
    const parsedCandidateOrigin: "rss" | "atom" | "json" =
      parsedFeed.format === "unknown" ? "rss" : parsedFeed.format;
    const now = new Date();
    const skipSummary = emptySkipSummary();
    const rejectedItems: IngestRejectedItem[] = [];

    for (const item of parsedFeed.items) {
      const rawLink = item.link.trim();
      if (!rawLink) {
        skipSummary.emptyLink += 1;
        pushRejectedItem(rejectedItems, {
          reason: "empty_link",
          rawLink: null,
          canonicalUrl: null,
          title: item.title || null,
          publishedAt: null,
        });
        continue;
      }

      const canonicalUrl = canonicalFromLink(rawLink);
      if (
        category?.pathUrl &&
        !isUsingDedicatedCategoryFeed &&
        !isUrlWithinCategoryPath(canonicalUrl, category.pathUrl)
      ) {
        skipSummary.outOfScope += 1;
        pushRejectedItem(rejectedItems, {
          reason: "out_of_scope",
          rawLink,
          canonicalUrl,
          title: item.title || null,
          publishedAt: null,
        });
        continue;
      }
      const publishedAt = await resolvePublishedAtForFeedItem(item.pubDate, canonicalUrl);
      if (!isWithinFreshnessWindow(publishedAt, now)) {
        skipSummary.staleOrMissingPublishedAt += 1;
        pushRejectedItem(rejectedItems, {
          reason: "stale_or_missing_published_at",
          rawLink,
          canonicalUrl,
          title: item.title || null,
          publishedAt: publishedAt ? publishedAt.toISOString() : null,
        });
        continue;
      }
      const rawTitle = item.title || canonicalUrl;
      const rawBodyText = item.description || "";
      const normalizedTitle = normalizeFeedTextDetailed(rawTitle);
      const normalizedBody = normalizeFeedTextDetailed(rawBodyText);
      const title = stripHtml(normalizedTitle.value);
      const bodyText = stripHtml(normalizedBody.value);
      const contentHash = await hashText(
        [title, canonicalUrl, bodyText].filter(Boolean).join("|"),
      );

      candidates.push({
        sourceId: source.id,
        categoryId: categoryId || undefined,
        sourceUrl: source.frontPageUrl,
        canonicalUrl,
        rssGuid: item.guid.trim() || null,
        rawTitle,
        title,
        publishedAt,
        rawBodyText,
        bodyText: bodyText || null,
        contentHash,
        isPaywall: /paywall|subscribe|premium/i.test(xml),
        rawTags: [],
        rawSignals: [],
        reasoning: `${parsedCandidateOrigin.toUpperCase()} ingest from ${source.mediaName || source.frontPageUrl}`,
        normalizationFlags: [...new Set([
          ...(normalizedTitle.changed ? normalizedTitle.flags : []),
          ...(normalizedBody.changed ? normalizedBody.flags : []),
        ])],
        provenance: {
          origin: parsedCandidateOrigin,
          feedUrl,
          feedFormat: parsedCandidateOrigin,
          discoveredFromCategoryFeed: isUsingDedicatedCategoryFeed,
          sourcePageUrl: preferredFrontPageUrl,
          fetchedAt: new Date().toISOString(),
        },
      });
    }

    if (candidates.length === 0) {
      await logAgentScan({
        sourceId,
        categoryId,
        status: "HTML_FALLBACK_ATTEMPTED",
        executionTimeMs: Date.now() - startedAt,
        errorLog: `No RSS/Atom candidates found for ${feedUrl}. Trying HTML fallback at ${preferredFrontPageUrl}.`,
      });

      try {
        const htmlResponse = feedUrl === preferredFrontPageUrl
          ? response
          : await safeFetch(preferredFrontPageUrl, {
              headers: {
                "User-Agent": "NuSift/1.0 Ingest-Agent",
                Accept: "text/html,application/xhtml+xml",
              },
            });

        if (!htmlResponse.ok) {
          await logAgentScan({
            sourceId,
            categoryId,
            status: `HTML_FALLBACK_FAILED_${htmlResponse.status}`,
            executionTimeMs: Date.now() - startedAt,
            errorLog: `HTML fallback failed for ${preferredFrontPageUrl} with HTTP ${htmlResponse.status}.`,
          });
          return {
            sourceId,
            categoryId: categoryId || null,
            candidates: [],
            failed: 1,
            feedUrl,
            feedFormat: parsedFeed.format,
            skipSummary,
            rejectedItems,
            hardCaseQueueCandidates,
          };
        }

        const html = await htmlResponse.text();
        const htmlFallback = await extractHtmlCandidates(
          html,
          preferredFrontPageUrl,
          source.id,
          category?.pathUrl && !isUsingDedicatedCategoryFeed ? category.pathUrl : null,
        );
        skipSummary.outOfScope += htmlFallback.skipSummary.outOfScope;
        skipSummary.htmlFallbackNonArticle += htmlFallback.skipSummary.htmlFallbackNonArticle;
        skipSummary.htmlFallbackStale += htmlFallback.skipSummary.htmlFallbackStale;
        rejectedItems.push(...htmlFallback.rejectedItems);
        const htmlCandidates = htmlFallback.candidates
          .map((candidate) => ({
            ...candidate,
            categoryId: categoryId || candidate.categoryId,
          }));
        candidates.push(...htmlCandidates);

        await logAgentScan({
          sourceId,
          categoryId,
          status: "HTML_FALLBACK_COMPLETED",
          executionTimeMs: Date.now() - startedAt,
          errorLog: `Prepared ${htmlCandidates.length} HTML fallback candidate(s) from ${preferredFrontPageUrl}.`,
        });
      } catch (fallbackError: any) {
        await logAgentScan({
          sourceId,
          categoryId,
          status: "HTML_FALLBACK_EXCEPTION",
          executionTimeMs: Date.now() - startedAt,
          errorLog: fallbackError?.message || String(fallbackError),
        });
        return {
          sourceId,
          categoryId: categoryId || null,
          candidates: [],
          failed: 1,
          feedUrl,
          feedFormat: parsedFeed.format,
          skipSummary,
          rejectedItems,
          hardCaseQueueCandidates,
        };
      }
    }

    await logAgentScan({
      sourceId,
      categoryId,
      status: "SOURCE_FETCH_COMPLETED",
      executionTimeMs: Date.now() - startedAt,
      errorLog: `Prepared ${candidates.length} candidate(s). skippedEmptyLink=${skipSummary.emptyLink}, skippedOutOfScope=${skipSummary.outOfScope}, skippedStale=${skipSummary.staleOrMissingPublishedAt}, skippedHtmlNonArticle=${skipSummary.htmlFallbackNonArticle}, skippedHtmlStale=${skipSummary.htmlFallbackStale}.`,
    });

    return {
      sourceId,
      categoryId: categoryId || null,
      candidates: await attachCategoryIds(candidates),
      failed: 0,
      feedUrl,
      feedFormat: parsedFeed.format,
      skipSummary,
      rejectedItems,
      hardCaseQueueCandidates,
    };
  } catch (error: any) {
    const isSecurityError = error instanceof SSRFError;
    await logAgentScan({
      sourceId,
      categoryId,
      status: isSecurityError ? "SOURCE_FETCH_BLOCKED_SECURITY" : "SOURCE_FETCH_EXCEPTION",
      executionTimeMs: Date.now() - startedAt,
      errorLog: error?.message || String(error),
    });

    if (sourceFeedUrl && source.frontPageUrl) {
      try {
        const htmlResponse = await safeFetch(source.frontPageUrl, {
          headers: {
            "User-Agent": "NuSift/1.0 Ingest-Agent",
            Accept: "text/html,application/xhtml+xml",
          },
        });

        if (htmlResponse.ok) {
          const html = await htmlResponse.text();
          const htmlFallback = await extractHtmlCandidates(
            html,
            source.frontPageUrl,
            source.id,
          );
          if (htmlFallback.candidates.length > 0) {
            await logAgentScan({
              sourceId,
              status: "HTML_FALLBACK_COMPLETED",
              executionTimeMs: Date.now() - startedAt,
              errorLog: `Security/RSS path failed, HTML fallback produced ${htmlFallback.candidates.length} candidate(s).`,
            });
            return {
              sourceId,
              categoryId: categoryId || null,
              candidates: await attachCategoryIds(htmlFallback.candidates),
              failed: 0,
              feedUrl: source.frontPageUrl,
              feedFormat: "html_fallback",
              skipSummary: htmlFallback.skipSummary,
              rejectedItems: htmlFallback.rejectedItems,
              hardCaseQueueCandidates,
            };
          }
        }
      } catch (fallbackError: any) {
        await logAgentScan({
          sourceId,
          status: "HTML_FALLBACK_EXCEPTION",
          executionTimeMs: Date.now() - startedAt,
          errorLog: fallbackError?.message || String(fallbackError),
        });
      }
    }

    return {
      sourceId,
      categoryId: categoryId || null,
      candidates: [],
      failed: 1,
      feedUrl: source.rssFeedUrl || source.frontPageUrl,
      feedFormat: null,
      skipSummary: emptySkipSummary(),
      rejectedItems: [],
      hardCaseQueueCandidates,
    };
  }
}

export async function persistCandidates(candidates: IngestCandidate[]) {
  if (candidates.length === 0) {
    return { inserted: 0, skipped: 0, failed: 0 };
  }

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  const dedupedCandidates: IngestCandidate[] = [];
  const seenKeys = new Set<string>();

  for (const candidate of candidates) {
    const dedupeKey = [
      candidate.rssGuid || "",
      candidate.canonicalUrl || "",
      candidate.contentHash || "",
    ].join("|");

    if (seenKeys.has(dedupeKey)) {
      skipped += 1;
      continue;
    }

    seenKeys.add(dedupeKey);
    dedupedCandidates.push(candidate);
  }

  const rssGuids = [...new Set(dedupedCandidates.map((candidate) => candidate.rssGuid).filter(Boolean))] as string[];
  const canonicalUrls = [...new Set(dedupedCandidates.map((candidate) => candidate.canonicalUrl).filter(Boolean))] as string[];
  const contentHashes = [...new Set(dedupedCandidates.map((candidate) => candidate.contentHash).filter(Boolean))] as string[];

  const existingArticles =
    rssGuids.length || canonicalUrls.length || contentHashes.length
      ? await prisma.article.findMany({
          where: {
            OR: [
              rssGuids.length ? { rssGuid: { in: rssGuids } } : undefined,
              canonicalUrls.length ? { canonicalUrl: { in: canonicalUrls } } : undefined,
              contentHashes.length ? { contentHash: { in: contentHashes } } : undefined,
            ].filter(Boolean) as any,
          },
          select: {
            rssGuid: true,
            canonicalUrl: true,
            contentHash: true,
          },
        })
      : [];

  const existingRssGuids = new Set(existingArticles.map((article) => article.rssGuid).filter(Boolean));
  const existingCanonicalUrls = new Set(existingArticles.map((article) => article.canonicalUrl).filter(Boolean));
  const existingContentHashes = new Set(existingArticles.map((article) => article.contentHash).filter(Boolean));

  const newCandidates = dedupedCandidates.filter((candidate) => {
    const isDuplicate =
      (candidate.rssGuid && existingRssGuids.has(candidate.rssGuid)) ||
      (candidate.canonicalUrl && existingCanonicalUrls.has(candidate.canonicalUrl)) ||
      (candidate.contentHash && existingContentHashes.has(candidate.contentHash));

    if (isDuplicate) {
      skipped += 1;
      return false;
    }

    return true;
  });

  if (newCandidates.length === 0) {
    return { inserted, skipped, failed };
  }

  try {
    const result = await prisma.article.createMany({
      data: newCandidates.map((candidate) => ({
        title: candidate.title,
        sourceId: candidate.sourceId,
        categoryId: candidate.categoryId,
        sourceUrl: candidate.sourceUrl,
        canonicalUrl: candidate.canonicalUrl,
        rssGuid: candidate.rssGuid,
        contentHash: candidate.contentHash,
        bodyText: candidate.bodyText,
        publishedAt: candidate.publishedAt,
        date: candidate.publishedAt || new Date(),
        processingStage: "INGESTED",
        processingStatus: "SUCCESS",
        isPaywall: candidate.isPaywall,
        tags: candidate.rawTags,
        signals: candidate.rawSignals,
        reasoning: candidate.reasoning,
      })),
      skipDuplicates: true,
    });
    inserted += result.count;
    skipped += newCandidates.length - result.count;
  } catch (error: any) {
    failed = newCandidates.length;
    const prismaErrorDetails = formatPrismaError(error);
    const sources = [...new Set(newCandidates.map((candidate) => candidate.sourceId))];
    await Promise.all(
      sources.map((sourceId) =>
        logAgentScan({
          sourceId,
          status: "ARTICLE_INSERT_FAILED",
          executionTimeMs: 0,
          errorLog: `Batch insert failed for ${newCandidates.length} article(s). ${prismaErrorDetails}`,
        }),
      ),
    );
  }

  return { inserted, skipped, failed };
}
