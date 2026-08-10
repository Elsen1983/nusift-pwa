import { prisma } from "../prisma";
import { safeFetch } from "../ssrf-guard";
import { SSRFError } from "../ssrf-guard";
import { isLikelyRedirectorUrl, resolveSafeRedirectChain } from "../safe-redirect-resolver";
import { logAgentScan } from "./log";
import { cleanFeedValue, hashText, normalizeFeedText, normalizeUrl, stripHtml } from "./text";
import { normalizeFeedTextDetailed } from "./normalize-feed-text";
import { getFeedProductivityResetData } from "./feed-productivity";
import type {
  DiscoveryOutcome,
  HardCaseDiscoveryCandidate,
  IngestCandidate,
  IngestRejectedItem,
  IngestResult,
  IngestSkipSummary,
  ScopeMatch,
  TaxonomyEvidence,
} from "./types";
import { emptyTaxonomyEvidence, nonNullish, serializeDiscoveryPayload, validateDiscoveryEvidence } from "./types";

import { buildFeedUrlCandidates } from "./import-rss";
import { discoverFeedForUrl, hasQueryScopedCategoryTokens } from "./feed-discovery";
import { resolveHeadlessMarkersByAgent1Rss } from "./agent1-rss-cleanup";
import { classifyArticleUrl } from "./article-url-policy";
import { observeAndLogUrlPolicyDecisions } from "./url-policy-decision-observer";
import {
  getRedirectRetryState,
  recordRedirectRetryState,
  resolveRedirectRetryState,
} from "./redirect-retry-state";
import type { StageBatchProbe } from "./stage-telemetry";
import { classifyEarlyAccessHint } from "./paywall-detection";

type ParsedFeedItem = {
  title: string;
  link: string;
  guid: string;
  pubDate: string;
  description: string;
  categories: string[];
};

type ParsedFeedEntry = {
  item: ParsedFeedItem;
  rawLink: string;
  canonicalUrl: string;
  rssGuid: string | null;
};

const INGEST_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_RSS_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_RSS_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_INLINE_RSS_RATE_LIMIT_RETRY_MS = 2_000;
const MAX_REDIRECT_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_REDIRECT_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

const getInlineRssRateLimitRetryDelayMs = (response: Pick<Response, "headers">) => {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (!retryAfter) return MAX_INLINE_RSS_RATE_LIMIT_RETRY_MS;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const delayMs = seconds * 1000;
    return delayMs <= MAX_INLINE_RSS_RATE_LIMIT_RETRY_MS ? delayMs : null;
  }

  const retryAtMs = Date.parse(retryAfter);
  if (!Number.isFinite(retryAtMs)) return null;
  const delayMs = Math.max(0, retryAtMs - Date.now());
  return delayMs <= MAX_INLINE_RSS_RATE_LIMIT_RETRY_MS ? delayMs : null;
};

export const getRssRateLimitRetryAt = (
  response: Pick<Response, "headers">,
  nowMs = Date.now(),
) => {
  const retryAfter = response.headers.get("retry-after")?.trim();
  let cooldownMs = DEFAULT_RSS_RATE_LIMIT_COOLDOWN_MS;

  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      cooldownMs = seconds * 1000;
    } else {
      const retryAtMs = Date.parse(retryAfter);
      if (Number.isFinite(retryAtMs)) {
        cooldownMs = Math.max(0, retryAtMs - nowMs);
      }
    }
  }

  return new Date(nowMs + Math.min(cooldownMs, MAX_RSS_RATE_LIMIT_COOLDOWN_MS));
};

const parseRssItems = (xml: string) => {
  const items: ParsedFeedItem[] = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const readTag = (block: string, tag: string) =>
    cleanFeedValue(
      block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ||
        "",
    );

  for (const match of xml.matchAll(itemRegex)) {
    const block = match[0] || "";
    const categories = [...block.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)]
      .map((categoryMatch) => cleanFeedValue(categoryMatch[1] || ""))
      .filter(Boolean);
    items.push({
      title: readTag(block, "title"),
      link: readTag(block, "link"),
      guid: readTag(block, "guid"),
      pubDate: readTag(block, "pubDate"),
      description: readTag(block, "description"),
      categories,
    });
  }

  return items;
};

const parseAtomItems = (xml: string) => {
  const items: ParsedFeedItem[] = [];
  const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
  const readTag = (block: string, tag: string) =>
    cleanFeedValue(
      block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ||
        "",
    );

  for (const match of xml.matchAll(entryRegex)) {
    const block = match[0] || "";
    const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);
    const categories = [...block.matchAll(/<category[^>]+(?:term|label)=["']([^"']+)["'][^>]*\/?>/gi)]
      .map((categoryMatch) => cleanFeedValue(categoryMatch[1] || ""))
      .filter(Boolean);
    items.push({
      title: readTag(block, "title"),
      link: cleanFeedValue(linkMatch?.[1] || ""),
      guid: readTag(block, "id"),
      pubDate: readTag(block, "updated") || readTag(block, "published"),
      description: readTag(block, "summary") || readTag(block, "content"),
      categories,
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
      categories: Array.isArray(item?.tags)
        ? item.tags.map((tag: unknown) => cleanFeedValue(String(tag || ""))).filter(Boolean)
        : [],
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

  return { format: "unknown" as const, items: [] as ParsedFeedItem[] };
};

const emptySkipSummary = (): IngestSkipSummary => ({
  emptyLink: 0,
  outOfScope: 0,
  staleOrMissingPublishedAt: 0,
  alreadySeenFeedItem: 0,
  htmlFallbackNonArticle: 0,
  htmlFallbackStale: 0,
  rssStaleSkipped: 0,
  staleOutsideRetentionWindow: 0,
  staleMissingPublishedAt: 0,
  staleInvalidPublishedAt: 0,
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

type ExistingArticleMatch = {
  id: number;
  rssGuid: string | null;
  canonicalUrl: string | null;
  categoryId: string | null;
  tags: string[];
};

const shouldPreserveDuplicateForEnrichment = (
  existingArticle: ExistingArticleMatch,
  categoryId: string | null | undefined,
  rawTags: string[],
) => {
  if (categoryId && !existingArticle.categoryId) {
    return true;
  }

  if ((!existingArticle.tags || existingArticle.tags.length === 0) && rawTags.length > 0) {
    return true;
  }

  return false;
};

const getRootHost = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * Build a discovery evidence payload for persistence.
 *
 * Produces the legacy flat field layout for backward compatibility AND
 * includes a canonical `outcome` field of type `DiscoveryOutcome` for
 * structured downstream consumption and auditing.
 */
export const buildDiscoveryEvidencePayload = (
  targetUrl: string,
  discovery: {
    feedUrl: string | null;
    discoveredVia?: string | null;
    detection: string;
    scopeConfidence?: string;
    scopeMatch?: ScopeMatch;
    taxonomyEvidence?: TaxonomyEvidence;
    score?: number;
    topCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      scopeMatch?: ScopeMatch;
      taxonomyEvidence?: TaxonomyEvidence;
    }>;
    rejectedCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      reason: string;
      scopeMatch?: ScopeMatch;
      taxonomyEvidence?: TaxonomyEvidence;
    }>;
    lastError?: string;
    canonicalIdentity?: string | null;
  },
) => {
  // Build the canonical DiscoveryOutcome directly, avoiding type assertions.
  // The loosely-typed discovery input may have nullable fields that
  // FeedDiscoveryResult requires as non-null, so we construct the outcome
  // fields explicitly rather than routing through createDiscoveryOutcome.
  const now = new Date().toISOString();
  const outcome: DiscoveryOutcome = {
    feedUrl: discovery.feedUrl,
    discoveredVia: discovery.discoveredVia || null,
    detection: discovery.detection,
    contentType: null,
    score: discovery.score ?? 0,
    scopeConfidence: (discovery.scopeConfidence || "low") as "high" | "medium" | "low",
    scopeMatch: discovery.scopeMatch || "generic",
    taxonomyEvidence: discovery.taxonomyEvidence ?? emptyTaxonomyEvidence(),
    topCandidates: (discovery.topCandidates || []) as DiscoveryOutcome["topCandidates"],
    rejectedCandidates: (discovery.rejectedCandidates || []) as DiscoveryOutcome["rejectedCandidates"],
    lastError: discovery.lastError,
    canonicalIdentity: discovery.canonicalIdentity ?? null,
    evaluatedAt: now,
    targetUrl,
    verified: Boolean(discovery.feedUrl),
    resolverPath: "fetch",
    browserAttempted: false,
    browserMethod: "none",
    browserCandidateCount: 0,
    browserCandidates: [],
    browserError: null,
  };

  return serializeDiscoveryPayload(outcome,
    // Preserve legacy flat-field backward-compat: null when input had no taxonomy evidence
    !discovery.taxonomyEvidence ? { taxonomyEvidence: null } : undefined,
  );
};

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
    scopeMatch?: ScopeMatch;
    taxonomyEvidence?: TaxonomyEvidence;
    topCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      scopeMatch?: ScopeMatch;
      taxonomyEvidence?: TaxonomyEvidence;
    }>;
    rejectedCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      reason: string;
      scopeMatch?: ScopeMatch;
      taxonomyEvidence?: TaxonomyEvidence;
    }>;
    lastError?: string;
    canonicalIdentity?: string | null;
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
  discovery: {
    feedUrl: input.discovery.feedUrl,
    discoveredVia: input.discovery.discoveredVia ?? null,
    detection: input.discovery.detection,
    score: input.discovery.score ?? 0,
    scopeConfidence: input.discovery.scopeConfidence || "low",
    scopeMatch: input.discovery.scopeMatch,
    taxonomyEvidence: input.discovery.taxonomyEvidence,
    canonicalIdentity: input.discovery.canonicalIdentity ?? null,
    topCandidates: input.discovery.topCandidates || [],
    rejectedCandidates: input.discovery.rejectedCandidates || [],
    lastError: input.discovery.lastError,
  },
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

const resolvePublishedAtForFeedItem = async (
  rawPubDate: string,
  canonicalUrl: string,
  telemetry?: StageBatchProbe,
) => {
  const directDate = toDate(rawPubDate);
  if (directDate) {
    return directDate;
  }

  try {
    const response = await safeFetch(canonicalUrl, {
      signal: AbortSignal.timeout(INGEST_HTTP_TIMEOUT_MS),
      headers: {
        "User-Agent": "NuSift/1.0 Ingest-Agent",
        Accept: "text/html,application/xhtml+xml",
      },
      telemetry,
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

/**
 * Agent 1 article freshness window: 7 days.
 *
 * Unified freshness constant used by both RSS/Atom/JSON feed ingest and
 * HTML fallback ingest. Matches the article retention cleanup window so
 * that articles deleted by maintenance cleanup are not immediately
 * reimported by Agent 1 if the publisher feed still contains old items.
 *
 * Re-exported from the shared article-retention-policy module.
 */
import {
  ARTICLE_RETENTION_DAYS,
  ARTICLE_RETENTION_MS,
  isWithinArticleRetentionWindow,
} from "./article-retention-policy";

export const AGENT1_ARTICLE_FRESHNESS_DAYS = ARTICLE_RETENTION_DAYS;
const AGENT1_ARTICLE_FRESHNESS_MS = ARTICLE_RETENTION_MS;

/**
 * Check whether an article candidate is within the Agent 1 freshness
 * window (7 days). Returns false for null/missing dates and future dates.
 * Used by both the RSS/Atom/JSON feed path and the HTML fallback path.
 *
 * Delegates to the shared article-retention-policy utility.
 */
export const isAgent1ArticleFresh = (publishedAt: Date | null, now = new Date()): boolean =>
  isWithinArticleRetentionWindow(publishedAt, now);

// ── Deprecated aliases (backward compat for tests/imports) ──────────────
export const AGENT1_RSS_FRESHNESS_DAYS = AGENT1_ARTICLE_FRESHNESS_DAYS;
export const isAgent1RssItemFresh = isAgent1ArticleFresh;

/**
 * @deprecated Use `isAgent1ArticleFresh` instead. Now uses the unified
 * 7-day Agent 1 freshness window (was 14 days).
 */
export const isRssIngestWithinFreshnessWindow = isAgent1ArticleFresh;

const extractHtmlCandidates = async (
  html: string,
  sourceUrl: string,
  sourceId: string,
  categoryPathUrl?: string | null,
  telemetry?: StageBatchProbe,
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
      signal: AbortSignal.timeout(INGEST_HTTP_TIMEOUT_MS),
      headers: {
        "User-Agent": "NuSift/1.0 Ingest-Agent",
        Accept: "text/html,application/xhtml+xml",
      },
      telemetry,
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
    if (!isAgent1ArticleFresh(meta.publishedAt, now)) {
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
    const accessEvidence = classifyEarlyAccessHint({
      articleText: `${rawTitle}\n${rawBodyText}`,
      structuredMarkup: detailHtml,
      articleUrl: canonicalUrl,
      sourceStage: "agent1",
    });

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
      // Agent 1 may preserve the hint in accessEvidence, but only a
      // high-confidence current-item block is allowed to set the legacy flag.
      isPaywall: accessEvidence.classification === "PAYWALL_BLOCKED" && accessEvidence.confidence === "HIGH",
      accessEvidence,
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

const CATEGORY_PATH_STOPWORDS = new Set([
  "category",
  "categories",
  "section",
  "sections",
  "topic",
  "topics",
  "interest",
  "interests",
  "tag",
  "tags",
  "all-about",
  "news",
]);

const tokenizeForCategoryFallback = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 || /^\d+$/.test(token));

const extractCategoryScopeTokens = (categoryPathUrl: string) => {
  try {
    const pathname = new URL(categoryPathUrl).pathname.toLowerCase();
    const segments = pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .filter((segment) => !CATEGORY_PATH_STOPWORDS.has(segment));

    const tokens = [...new Set(segments.flatMap(tokenizeForCategoryFallback))];
    return {
      segments,
      tokens,
      primaryToken: segments.length > 0 ? segments[segments.length - 1] : null,
    };
  } catch {
    return { segments: [], tokens: [], primaryToken: null as string | null };
  }
};

const isCommonRootFeedPath = (pathname: string) =>
  pathname === "/" ||
  pathname === "/rss" ||
  pathname === "/feed" ||
  pathname === "/atom" ||
  /^\/(?:rss|feed|atom)\.[a-z0-9]+$/i.test(pathname);

const textContainsToken = (text: string, token: string) => {
  const normalized = ` ${text.toLowerCase()} `;
  const pattern = new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
  return pattern.test(normalized);
};

export const isFallbackFeedItemRelevantToCategory = (
  categoryPathUrl: string,
  item: {
    title?: string | null;
    description?: string | null;
    categories?: string[];
  },
) => {
  const scope = extractCategoryScopeTokens(categoryPathUrl);
  if (scope.tokens.length === 0) return false;

  const title = stripHtml(item.title || "").toLowerCase();
  const description = stripHtml(item.description || "").toLowerCase();
  const categoryText = (item.categories || []).join(" ").toLowerCase();
  const haystacks = [title, description, categoryText].filter(Boolean);
  if (haystacks.length === 0) return false;

  const matchedTokens = new Set<string>();
  for (const token of scope.tokens) {
    if (haystacks.some((haystack) => textContainsToken(haystack, token))) {
      matchedTokens.add(token);
    }
  }

  if (matchedTokens.size === 0) return false;

  if (scope.primaryToken && matchedTokens.has(scope.primaryToken)) {
    return true;
  }

  if (matchedTokens.size >= 2) {
    return true;
  }

  const categoryHasDirectMatch = (item.categories || []).some((category) =>
    scope.tokens.some((token) => textContainsToken(category.toLowerCase(), token)),
  );
  return categoryHasDirectMatch;
};



export const isScopedCategoryFeed = (
  categoryPathUrl: string,
  feedUrl: string | null,
  discoveryEvidence?: { scopeMatch?: ScopeMatch | null; outcome?: { scopeMatch?: ScopeMatch } | null } | null,
) => {
  if (!feedUrl) return false;

  // Prefer canonical outcome scopeMatch when present
  const explicitScopeMatch = discoveryEvidence?.outcome?.scopeMatch ?? discoveryEvidence?.scopeMatch;
  if (feedUrl && hasQueryScopedCategoryTokens(categoryPathUrl, feedUrl)) {
    return true;
  }

  if (explicitScopeMatch === "exact" || explicitScopeMatch === "probable") {
    return true;
  }
  if (explicitScopeMatch === "generic" || explicitScopeMatch === "unrelated") {
    return false;
  }

  try {
    const categoryUrl = new URL(categoryPathUrl);
    const parsedFeedUrl = new URL(feedUrl);
    const categoryPath = normalizePathForCategoryMatch(categoryPathUrl);
    const feedPath = normalizePathForCategoryMatch(feedUrl);

    if (feedPath === categoryPath || feedPath.startsWith(`${categoryPath}/`)) {
      return true;
    }

    const scopeTokens = extractCategoryScopeTokens(categoryPathUrl).tokens;
    const queryAndPath = `${parsedFeedUrl.pathname} ${parsedFeedUrl.search}`.toLowerCase();
    if (scopeTokens.some((token) => textContainsToken(queryAndPath, token))) {
      return true;
    }

    // Check for query-scoped category tokens in JSON payloads and known
    // scope keys (e.g., filters={"superTagSlugs":["eletmod"]}).
    // This handles publishers that use generic feed paths with category
    // tokens encoded in JSON query parameters.
    if (hasQueryScopedCategoryTokens(categoryPathUrl, feedUrl)) {
      return true;
    }

    if (parsedFeedUrl.host === categoryUrl.host && isCommonRootFeedPath(feedPath)) {
      return false;
    }
  } catch {
    return false;
  }

  return false;
};

/**
 * Read discovery evidence from a persisted JSON column.
 * Uses the shared `validateDiscoveryEvidence` validator from types.ts
 * which validates field types and normalizes malformed values to safe defaults.
 * Prefers canonical outcome when present, falls back to legacy flat fields.
 *
 * Field semantics:
 * - `undefined` means the field was genuinely absent from the source payload.
 * - A concrete value means the field was present (and validated/normalized).
 * This distinction matters for `isScopedCategoryFeed` which falls through
 * to URL heuristics when scopeMatch is absent (undefined), but returns
 * `false` immediately when scopeMatch is "generic".
 */
const readCategoryDiscoveryEvidence = (
  discoveryEvidence: unknown,
): { scopeMatch?: ScopeMatch | null; verified?: boolean; taxonomyEvidence?: TaxonomyEvidence | null } | null => {
  const validated = validateDiscoveryEvidence(discoveryEvidence);
  if (!validated) return null;

  return {
    scopeMatch: validated.scopeMatch,
    verified: validated.verified,
    taxonomyEvidence: validated.taxonomyEvidence,
  };
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

export const GENERIC_EVIDENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const hasFreshGenericEvidence = (
  discoveryEvidence: unknown,
  lastRssCheckAt?: Date | null,
  categoryPathUrl?: string | null,
): boolean => {
  const evidence = readCategoryDiscoveryEvidence(discoveryEvidence);
  if (!evidence || evidence.scopeMatch !== "generic") return false;
  if (categoryPathUrl && hasEvidenceQueryScopedFeed(discoveryEvidence, categoryPathUrl)) {
    return false;
  }
  if (!lastRssCheckAt) return true;
  return Date.now() - lastRssCheckAt.getTime() < GENERIC_EVIDENCE_TTL_MS;
};

const hasEvidenceQueryScopedFeed = (discoveryEvidence: unknown, categoryPathUrl: string) => {
  if (!discoveryEvidence || typeof discoveryEvidence !== "object") return false;

  const topLevelFeedUrl = (discoveryEvidence as { feedUrl?: unknown }).feedUrl;
  if (typeof topLevelFeedUrl === "string" && hasQueryScopedCategoryTokens(categoryPathUrl, topLevelFeedUrl)) {
    return true;
  }

  const outcome = (discoveryEvidence as { outcome?: unknown }).outcome;
  if (outcome && typeof outcome === "object") {
    const outcomeFeedUrl = (outcome as { feedUrl?: unknown }).feedUrl;
    return typeof outcomeFeedUrl === "string" && hasQueryScopedCategoryTokens(categoryPathUrl, outcomeFeedUrl);
  }

  return false;
};

// resolveHeadlessMarkersByAgent1Rss is now in ./agent1-rss-cleanup.ts

const resolveCategoryFeedUrl = async (
  sourceId: string,
  category: {
    id: string;
    pathUrl: string;
    rssFeedUrl: string | null;
    feedProvenance?: string | null;
    discoveryEvidence?: unknown;
    lastRssCheckAt?: Date | null;
  } | null,
  // pipelineRunId is passed through to resolveHeadlessMarkersByAgent1Rss when available.
  // Currently not available in ingestSource's scope (pipelineRunId is created at pipeline
  // level, not passed into ingestSource). Left as undefined for forward-compatibility.
  pipelineRunId?: string | null,
  telemetry?: StageBatchProbe,
) => {
  // When the category already has a feed URL, check if it's genuinely scoped.
  // If evidence says "generic", re-run discovery to allow re-evaluation (self-healing
  // for legacy data where generic feeds were incorrectly saved to rssFeedUrl).
  if (!category || (category.rssFeedUrl && isScopedCategoryFeed(
    category.pathUrl,
    category.rssFeedUrl,
    readCategoryDiscoveryEvidence(category.discoveryEvidence),
  ))) {
    return {
      feedUrl: category?.rssFeedUrl || null,
      isScopedFeed: category ? true : false,
      genericFeedDiscovered: false,
      categoryStateAlreadyHandled: false,
      hardCaseQueueCandidate: null as HardCaseDiscoveryCandidate | null,
    };
  }

  // If discovery evidence already indicates a generic root feed was found
  // and the TTL hasn't expired, skip re-discovery. The parent source's feed
  // will be used dynamically by ingestSource.
  if (!category.rssFeedUrl && hasFreshGenericEvidence(category.discoveryEvidence, category.lastRssCheckAt, category.pathUrl)) {
    return {
      feedUrl: null,
      isScopedFeed: false,
      genericFeedDiscovered: true,
      categoryStateAlreadyHandled: false,
      hardCaseQueueCandidate: null as HardCaseDiscoveryCandidate | null,
    };
  }

  try {
    const discovery = await discoverFeedForUrl({
      pageUrl: category.pathUrl,
      existingFeedUrl: category.rssFeedUrl,
      userAgent: "NuSift/1.0 Ingest-Agent",
      preferScopedDirectFeed: true,
      telemetry,
    });
    const discoveredFeedUrl = discovery.feedUrl;
    const isScoped = discoveredFeedUrl
      ? isScopedCategoryFeed(
          category.pathUrl,
          discoveredFeedUrl,
          { scopeMatch: discovery.scopeMatch },
        )
      : false;
    const isGeneric = discoveredFeedUrl && !isScoped;

    // For generic feeds: save discovery evidence but do NOT save rssFeedUrl.
    // This prevents downstream code from mistaking it as a scoped category feed,
    // while avoiding redundant discovery on subsequent runs.
    await prisma.sourceCategory.update({
      where: { id: category.id },
      data: {
        ...(isGeneric
          ? {
              // Do not save generic feed to rssFeedUrl.
              // Keep rssStatus as NO_RSS_FOUND so Agent 2 eligibility works.
              rssStatus: "NO_RSS_FOUND",
              rssFeedUrl: null,
            }
          : {
              rssFeedUrl: discoveredFeedUrl,
              rssStatus: discoveredFeedUrl ? "ACTIVE" : "NO_RSS_FOUND",
            }),
        lastRssCheckAt: new Date(),
        discoveryEvidence: buildDiscoveryEvidencePayload(
          category.pathUrl,
          discovery,
        ),
        ...getFeedProductivityResetData(category.rssFeedUrl, isGeneric ? null : discoveredFeedUrl),
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
        ? isGeneric
          ? `Discovered generic root feed ${discoveredFeedUrl} for category ${category.pathUrl}. scopeMatch=generic; will use parent source feed with category relevance filtering. method=${discovery.detection}, confidence=${discovery.scopeConfidence}, score=${discovery.score}`
          : `Resolved scoped category feed ${discoveredFeedUrl} during pipeline ingest. method=${discovery.detection}, confidence=${discovery.scopeConfidence}, score=${discovery.score}`
        : `No category feed found for ${category.pathUrl} during pipeline ingest. method=${discovery.detection}, confidence=${discovery.scopeConfidence}, score=${discovery.score}${discovery.lastError ? `, lastError=${discovery.lastError}` : ""}`,
    });

    return {
      feedUrl: isGeneric ? null : discoveredFeedUrl,
      isScopedFeed: isScoped,
      genericFeedDiscovered: isGeneric,
      categoryStateAlreadyHandled: false,
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

    // When category feed discovery throws an exception, the category state
    // was not updated by the try block's prisma.sourceCategory.update.
    // Ensure the category is marked so Agent 2 can pick it up.
    await markCategoryAsNoRssFound(category.id, sourceId, {
      reason: "category_discovery_exception",
      targetUrl: category.pathUrl,
      lastError: errorMessage,
      discoveryEvidence: buildDiscoveryEvidencePayload(
        category.pathUrl,
        {
          feedUrl: null,
          detection: "none",
          score: 0,
          scopeConfidence: "low",
          scopeMatch: "unrelated",
          lastError: errorMessage,
        },
      ),
      preserveSubmittedFeed: category.feedProvenance === "USER_SUBMITTED",
    });

    return {
      feedUrl: null,
      isScopedFeed: false,
      genericFeedDiscovered: false,
      // Indicates the catch block already handled the category DB state update,
      // so downstream code should not call markCategoryAsNoRssFound again.
      categoryStateAlreadyHandled: true,
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
          scopeMatch: "unrelated",
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
  telemetry?: StageBatchProbe,
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
      telemetry,
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
        ...getFeedProductivityResetData(source.rssFeedUrl, discoveredFeedUrl),
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
          scopeMatch: "unrelated",
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

/**
 * Canonical reason buckets for why a category is being handed off to Agent 2.
 * Every path that marks a category NO_RSS_FOUND for Agent 2 handoff must
 * use one of these reasons.
 */
export type CategoryHandoffReason =
  | "category_discovery_exception"
  | "root_feed_empty"
  | "root_feed_fetch_exception"
  | "html_fallback_failed"
  | "html_fallback_exception";

/**
 * The single canonical place that defines the NO_RSS_FOUND handoff update shape.
 *
 * When a category target fails RSS discovery or feed fetch completely,
 * update its DB state so Agent 2 can pick it up in the same pipeline cycle.
 *
 * Only applies to category targets that do NOT have a scoped category feed.
 * A category with a genuinely scoped feed that has transient fetch failures
 * should NOT be downgraded — it will be handled by the productivity tracking
 * path (ACTIVE + consecutiveNonProductiveRuns >= 2).
 *
 * Preserves discoveryEvidence when present so the hard-case-queue and
 * future re-discovery have access to prior resolution context.
 *
 * @param opts.discoveryEvidence - Optional discovery evidence payload to persist.
 *   When provided, overwrites existing evidence (used by resolveCategoryFeedUrl catch).
 * @param opts.shouldIncrementNonProductiveRuns - Default true. Set to false when
 *   the caller has already incremented the counter (e.g. via markFeedRunOutcome).
 */
const markCategoryAsNoRssFound = async (
  categoryId: string,
  sourceId: string,
  opts?: {
    reason?: CategoryHandoffReason;
    targetUrl?: string;
    lastError?: string;
    discoveryEvidence?: ReturnType<typeof buildDiscoveryEvidencePayload>;
    shouldIncrementNonProductiveRuns?: boolean;
    preserveSubmittedFeed?: boolean;
  },
) => {
  if (opts?.preserveSubmittedFeed) {
    await logAgentScan({
      sourceId,
      categoryId,
      status: "CATEGORY_HANDOFF_SKIPPED_USER_SUBMITTED",
      executionTimeMs: 0,
      errorLog: `Preserved USER_SUBMITTED feed after ${opts.reason || "unknown"} failure.`,
    });
    return;
  }
  const shouldIncrement = opts?.shouldIncrementNonProductiveRuns !== false;
  try {
    await prisma.sourceCategory.update({
      where: { id: categoryId },
      data: {
        rssStatus: "NO_RSS_FOUND",
        rssFeedUrl: null,
        currentFeedProductive: false,
        ...(shouldIncrement ? { consecutiveNonProductiveRuns: { increment: 1 } } : {}),
        lastRssCheckAt: new Date(),
        ...(opts?.discoveryEvidence ? { discoveryEvidence: opts.discoveryEvidence } : {}),
      },
    });
    await logAgentScan({
      sourceId,
      categoryId,
      status: "CATEGORY_HANDOFF_TO_AGENT2",
      executionTimeMs: 0,
      errorLog: `reason=${opts?.reason || "unknown"}${opts?.targetUrl ? `, targetUrl=${opts.targetUrl}` : ""}${opts?.lastError ? `, lastError=${opts.lastError}` : ""}`,
    });

    // ── Post-handoff DB snapshot verification ─────────────────────────
    // Read back the updated row to prove the write persisted. This catches
    // Prisma Accelerate edge-caching, read-replica lag, or silent write
    // failures that would otherwise leave A1 and A2 disagreeing about the
    // category state.
    try {
      const confirmed = await prisma.sourceCategory.findUnique({
        where: { id: categoryId },
        select: {
          rssStatus: true,
          rssFeedUrl: true,
          currentFeedProductive: true,
          consecutiveNonProductiveRuns: true,
          lastRssCheckAt: true,
        },
      });
      await logAgentScan({
        sourceId,
        categoryId,
        status: "CATEGORY_HANDOFF_STATE_CONFIRMED",
        executionTimeMs: 0,
        errorLog: JSON.stringify({
          sourceId,
          categoryId,
          targetUrl: opts?.targetUrl,
          reason: opts?.reason || "unknown",
          rssStatus: confirmed?.rssStatus ?? "NOT_FOUND",
          rssFeedUrl: confirmed?.rssFeedUrl ?? null,
          currentFeedProductive: confirmed?.currentFeedProductive ?? null,
          consecutiveNonProductiveRuns: confirmed?.consecutiveNonProductiveRuns ?? null,
          lastRssCheckAt: confirmed?.lastRssCheckAt?.toISOString() ?? null,
        }),
      });
    } catch (confirmError: any) {
      await logAgentScan({
        sourceId,
        categoryId,
        status: "CATEGORY_HANDOFF_STATE_CONFIRM_FAILED",
        executionTimeMs: 0,
        errorLog: `readback failed: ${confirmError?.message || String(confirmError)}`,
      }).catch(() => {});
    }
  } catch {
    // Non-fatal: category state update failure should never block the pipeline.
  }
};

export async function ingestSource(
  sourceId: string,
  categoryId?: string,
  telemetry?: StageBatchProbe,
  pipelineRunId?: string,
  options?: { bypassRedirectTerminal?: boolean },
): Promise<IngestResult> {
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
        nextRetryAt: true,
        discoveryEvidence: true,
      },
    }),
    categoryId
      ? prisma.sourceCategory.findUnique({
          where: { id: categoryId },
          select: {
            id: true,
            pathUrl: true,
            rssFeedUrl: true,
            feedProvenance: true,
            discoveryEvidence: true,
            lastRssCheckAt: true,
            nextRetryAt: true,
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


  if (category?.nextRetryAt && category.nextRetryAt.getTime() > Date.now()) {
    await logAgentScan({
      sourceId,
      categoryId,
      status: "A1_TARGET_DEFERRED_RATE_LIMIT",
      executionTimeMs: Date.now() - startedAt,
      errorLog: `RSS retry deferred until ${category.nextRetryAt.toISOString()}.`,
    });
    return {
      sourceId,
      categoryId: categoryId || null,
      candidates: [],
      failed: 0,
      feedUrl: category.rssFeedUrl,
      feedFormat: null,
      deferredReason: "rate_limited",
      retryAt: category.nextRetryAt.toISOString(),
      skipSummary: emptySkipSummary(),
      rejectedItems: [],
    };
  }

  const categoryFeedResolution = await resolveCategoryFeedUrl(sourceId, category, undefined, telemetry);
  const categoryFeedUrl = categoryFeedResolution.feedUrl;
  const isUsingDedicatedCategoryFeed = Boolean(
    categoryId && categoryFeedUrl && categoryFeedResolution.isScopedFeed,
  );
  // A scoped category feed fully owns this target. Resolving the root source
  // as well creates unrelated publisher requests immediately before the real
  // feed fetch and can trigger host-level throttling.
  const sourceFeedResolution = isUsingDedicatedCategoryFeed
    ? {
        feedUrl: null,
        hardCaseQueueCandidate: null as HardCaseDiscoveryCandidate | null,
      }
    : await resolveSourceFeedUrl(source, telemetry);
  const sourceFeedUrl = sourceFeedResolution.feedUrl;
  const genericFeedDiscovered = Boolean(
    categoryId && categoryFeedResolution.genericFeedDiscovered,
  );
  // When resolveCategoryFeedUrl's catch block already handled the category
  // DB state update (set NO_RSS_FOUND), downstream failure paths must not
  // call markCategoryAsNoRssFound again to avoid double-incrementing
  // consecutiveNonProductiveRuns. Also set to true when markCategoryAsNoRssFound
  // is called in the FEED_EMPTY path (!response block) to prevent the outer
  // catch from calling it a second time.
  let categoryFeedDiscoveryFailed = Boolean(
    categoryId && categoryFeedResolution.categoryStateAlreadyHandled,
  );
  const isUnscopedCategoryTarget = Boolean(categoryId && !isUsingDedicatedCategoryFeed);
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
  // A verified scoped category feed is authoritative. Do not append generic
  // origin fallbacks that can hide its real failure and trigger publisher 429s.
  const feedUrls = buildFeedUrlCandidates(
    preferredFeedUrl,
    isUsingDedicatedCategoryFeed ? null : preferredFrontPageUrl,
  );
  let rateLimitedRetryAt: Date | null = null;
  let redirectRetryAtIso: string | null = null;
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
        errorLog: isUsingDedicatedCategoryFeed
          ? `Using scoped category feed ${categoryFeedUrl}.`
          : `Using generic category feed ${categoryFeedUrl}; category relevance filtering remains enabled.`,
      });
    } else if (categoryId && genericFeedDiscovered) {
      await logAgentScan({
        sourceId,
        categoryId,
        status: "CATEGORY_FEED_FALLBACK_TO_ROOT",
        executionTimeMs: 0,
        errorLog: `Using generic category feed (discovered via root); category relevance filtering remains enabled. Falling back to root feed ${sourceFeedUrl || source.frontPageUrl}.`,
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
        const fetchOptions = {
          allowCrossDomainRedirects: true,
          signal: AbortSignal.timeout(INGEST_HTTP_TIMEOUT_MS),
          headers: {
            "User-Agent": "NuSift/1.0 Ingest-Agent",
            Accept: "application/rss+xml, application/xml, text/xml, text/html",
          },
          telemetry,
        };
        let candidateResponse = await safeFetch(candidateFeedUrl, fetchOptions);

        if (candidateResponse.status === 429) {
          const retryDelayMs = getInlineRssRateLimitRetryDelayMs(candidateResponse);
          if (retryDelayMs !== null) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            candidateResponse = await safeFetch(candidateFeedUrl, {
              ...fetchOptions,
              signal: AbortSignal.timeout(INGEST_HTTP_TIMEOUT_MS),
              telemetry,
            });
          }
        }

        if (!candidateResponse.ok) {
          lastFeedFetchError = `Fetch failed for ${candidateFeedUrl} with HTTP ${candidateResponse.status}.`;
          if (candidateResponse.status === 429 && categoryId && isUsingDedicatedCategoryFeed) {
            rateLimitedRetryAt = getRssRateLimitRetryAt(candidateResponse);
            await prisma.sourceCategory.update({
              where: { id: categoryId },
              data: { nextRetryAt: rateLimitedRetryAt },
            });
          }
          await logAgentScan({
            sourceId,
            categoryId,
            status: "FEED_CANDIDATE_FAILED",
            executionTimeMs: Date.now() - startedAt,
            errorLog: lastFeedFetchError,
          });
          continue;
        }

        if (categoryId && isUsingDedicatedCategoryFeed && category?.nextRetryAt) {
          await prisma.sourceCategory.update({
            where: { id: categoryId },
            data: { nextRetryAt: null },
          });
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
        await logAgentScan({
          sourceId,
          categoryId,
          status: "FEED_CANDIDATE_FAILED",
          executionTimeMs: Date.now() - startedAt,
          errorLog: lastFeedFetchError,
        }).catch(() => {});
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

      // When the feed was fetched OK but parsed to 0 RSS/Atom items for
      // an unscoped category target, mark it as NO_RSS_FOUND with the
      // specific "root_feed_empty" reason so Agent 2 can pick it up.
      // Setting categoryFeedDiscoveryFailed prevents the outer catch block
      // from calling markCategoryAsNoRssFound a second time.
      if (isUnscopedCategoryTarget && !categoryFeedDiscoveryFailed) {
        await markCategoryAsNoRssFound(categoryId!, sourceId, {
          reason: "root_feed_empty",
          targetUrl: category?.pathUrl || undefined,
          lastError: lastFeedFetchError || "Feed parsed but produced 0 usable RSS/Atom items.",
          preserveSubmittedFeed: category?.feedProvenance === "USER_SUBMITTED",
        });
        categoryFeedDiscoveryFailed = true;
      }

      throw new Error(lastFeedFetchError || "No usable feed response.");
    }

    const candidates: IngestCandidate[] = [];
    const parsedFeed = parseFeedItems(xml);
    const parsedCandidateOrigin: "rss" | "atom" | "json" =
      parsedFeed.format === "unknown" ? "rss" : parsedFeed.format;
    const now = new Date();
    const skipSummary = emptySkipSummary();
    const rejectedItems: IngestRejectedItem[] = [];
    const redirectResolutionSeen = new Set<string>();

    const scheduleRedirectRetry = (retryAt: Date) => {
      if (redirectRetryAtIso === null || retryAt.getTime() < Date.parse(redirectRetryAtIso)) {
        redirectRetryAtIso = retryAt.toISOString();
      }
    };

    const feedEntries: ParsedFeedEntry[] = parsedFeed.items.map((item: ParsedFeedItem) => {
      const rawLink = item.link.trim();
      return {
        item,
        rawLink,
        canonicalUrl: rawLink ? canonicalFromLink(rawLink) : "",
        rssGuid: item.guid.trim() || null,
      };
    });

    const feedRssGuids = [...new Set(feedEntries.map((entry: ParsedFeedEntry) => entry.rssGuid).filter(Boolean))] as string[];
    const feedCanonicalUrls = [...new Set(feedEntries.map((entry: ParsedFeedEntry) => entry.canonicalUrl).filter(Boolean))];
    const existingFeedArticles =
      feedRssGuids.length || feedCanonicalUrls.length
        ? await prisma.article.findMany({
            where: {
              OR: [
                feedRssGuids.length ? { rssGuid: { in: feedRssGuids } } : undefined,
                feedCanonicalUrls.length ? { canonicalUrl: { in: feedCanonicalUrls } } : undefined,
              ].filter(nonNullish),
            },
            select: {
              id: true,
              rssGuid: true,
              canonicalUrl: true,
              categoryId: true,
              tags: true,
            },
          })
        : [];

    const existingFeedArticlesByGuid = new Map(
      existingFeedArticles
        .filter((article) => article.rssGuid)
        .map((article) => [article.rssGuid!, article]),
    );
    const existingFeedArticlesByCanonicalUrl = new Map(
      existingFeedArticles
        .filter((article) => article.canonicalUrl)
        .map((article) => [article.canonicalUrl!, article]),
    );

    for (const entry of feedEntries) {
      const { item, rawLink } = entry;
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

      const originalCanonicalUrl = entry.canonicalUrl;
      let canonicalUrl = originalCanonicalUrl;
      let redirectedFromUrl: string | null = null;

      // ── Aggregator redirector resolution (safe, generic) ───────────
      // Resolve likely redirector / aggregator URLs one hop at a time with
      // the same security checks as a direct request. The final validated
      // publisher URL becomes the canonical article URL; the original
      // discovered URL is preserved as provenance. Any resolution failure
      // rejects the item THIS run (bounded retry on the next run) so an
      // unresolved or unsafe redirect never reaches Agent 3.
      if (isLikelyRedirectorUrl(canonicalUrl)) {
        const retryState = await getRedirectRetryState({
          sourceId: source.id,
          categoryId: categoryId || null,
          url: canonicalUrl,
          bypassTerminal: options?.bypassRedirectTerminal,
        });
        if (retryState) {
          if (retryState.status === "RETRYABLE" && retryState.nextRetryAt) {
            scheduleRedirectRetry(new Date(retryState.nextRetryAt));
            skipSummary.redirectDuplicateSuppressed = (skipSummary.redirectDuplicateSuppressed || 0) + 1;
          } else if (retryState.status === "EXHAUSTED") {
            skipSummary.redirectRetryExhausted = (skipSummary.redirectRetryExhausted || 0) + 1;
          } else if (retryState.status === "SECURITY_REJECTED") {
            skipSummary.redirectSecurityRejected = (skipSummary.redirectSecurityRejected || 0) + 1;
          } else if (retryState.status === "INVALID_REDIRECT") {
            skipSummary.redirectInvalid = (skipSummary.redirectInvalid || 0) + 1;
          }
          continue;
        }
        if (redirectResolutionSeen.has(canonicalUrl)) {
          skipSummary.redirectDuplicateSuppressed = (skipSummary.redirectDuplicateSuppressed || 0) + 1;
          continue;
        }
        redirectResolutionSeen.add(canonicalUrl);
        const resolution = await resolveSafeRedirectChain(canonicalUrl, {
          timeoutMs: INGEST_HTTP_TIMEOUT_MS,
        });
        if (resolution.ok) {
          canonicalUrl = resolution.finalUrl;
          redirectedFromUrl = originalCanonicalUrl;
          await resolveRedirectRetryState({
            pipelineRunId,
            sourceId: source.id,
            categoryId: categoryId || null,
            originalUrl: originalCanonicalUrl,
            bypassTerminal: options?.bypassRedirectTerminal,
          });
        } else if (resolution.evidence.failureKind === "security_rejected") {
          skipSummary.redirectSecurityRejected = (skipSummary.redirectSecurityRejected || 0) + 1;
          await recordRedirectRetryState({
            pipelineRunId,
            sourceId: source.id,
            categoryId: categoryId || null,
            originalUrl: originalCanonicalUrl,
            evidence: resolution.evidence,
          });
          pushRejectedItem(rejectedItems, {
            reason: "redirect_security_rejected",
            rawLink,
            canonicalUrl,
            title: item.title || null,
            publishedAt: null,
          });
          continue;
        } else if (resolution.evidence.failureKind === "transient_network") {
          skipSummary.redirectTransientFailed = (skipSummary.redirectTransientFailed || 0) + 1;
          const retryAt = new Date(Date.now() + DEFAULT_REDIRECT_RETRY_COOLDOWN_MS);
          scheduleRedirectRetry(retryAt);
          await recordRedirectRetryState({
            pipelineRunId,
            sourceId: source.id,
            categoryId: categoryId || null,
            originalUrl: originalCanonicalUrl,
            evidence: resolution.evidence,
          });
          pushRejectedItem(rejectedItems, {
            reason: "redirect_transient_failure",
            rawLink,
            canonicalUrl,
            title: item.title || null,
            publishedAt: null,
          });
          continue;
        } else if (resolution.evidence.failureKind === "rate_limited") {
          skipSummary.redirectRateLimited = (skipSummary.redirectRateLimited || 0) + 1;
          const retryAt = new Date(Date.now() + Math.min(
            MAX_REDIRECT_RETRY_COOLDOWN_MS,
            resolution.evidence.retryAfterMs ?? DEFAULT_REDIRECT_RETRY_COOLDOWN_MS,
          ));
          scheduleRedirectRetry(retryAt);
          await recordRedirectRetryState({
            pipelineRunId,
            sourceId: source.id,
            categoryId: categoryId || null,
            originalUrl: originalCanonicalUrl,
            evidence: resolution.evidence,
          });
          pushRejectedItem(rejectedItems, {
            reason: "redirect_rate_limited",
            rawLink,
            canonicalUrl,
            title: item.title || null,
            publishedAt: null,
          });
          continue;
        } else {
          skipSummary.redirectInvalid = (skipSummary.redirectInvalid || 0) + 1;
          await recordRedirectRetryState({
            pipelineRunId,
            sourceId: source.id,
            categoryId: categoryId || null,
            originalUrl: originalCanonicalUrl,
            evidence: resolution.evidence,
          });
          pushRejectedItem(rejectedItems, {
            reason: "redirect_invalid",
            rawLink,
            canonicalUrl,
            title: item.title || null,
            publishedAt: null,
          });
          continue;
        }
      }

      if (redirectRetryAtIso) {
        skipSummary.redirectRetryAt = redirectRetryAtIso;
      }

      // ── Article URL policy: reject non-article URLs early ──
      // Runs against the FINAL canonical URL after redirect resolution.
      const urlPolicy = classifyArticleUrl(canonicalUrl);
      if (!urlPolicy.accepted) {
        skipSummary.urlPolicyRejected = (skipSummary.urlPolicyRejected || 0) + 1;
        pushRejectedItem(rejectedItems, {
          reason: "url_policy_rejected",
          rawLink,
          canonicalUrl,
          title: item.title || null,
          publishedAt: null,
        });
        // ── Fire-and-forget URL policy observation ────────────────
        // Observe both production and candidate decisions for rejected URLs.
        observeAndLogUrlPolicyDecisions({
          url: canonicalUrl,
          sourceId: source.id,
          categoryId: categoryId || null,
          agent: "AGENT_1",
          stage: "rss-ingest",
          discoveryMethod: parsedCandidateOrigin === "rss" ? "RSS" : parsedCandidateOrigin === "atom" ? "ATOM" : "JSON_FEED",
        }).catch(() => {});
        continue;
      }

      // ── Fire-and-forget URL policy observation for accepted URLs ──
      // Observe both production and candidate decisions for URLs that
      // passed the URL policy check. This closes the accepted-URL
      // observation gap so the persisted decision log captures the full
      // picture of Agent 1 URL policy behavior.
      observeAndLogUrlPolicyDecisions({
        url: canonicalUrl,
        sourceId: source.id,
        categoryId: categoryId || null,
        agent: "AGENT_1",
        stage: "rss-ingest",
        discoveryMethod: parsedCandidateOrigin === "rss" ? "RSS" : parsedCandidateOrigin === "atom" ? "ATOM" : "JSON_FEED",
      }).catch(() => {});

      if (
        category?.pathUrl &&
        !isUsingDedicatedCategoryFeed &&
        !isUrlWithinCategoryPath(canonicalUrl, category.pathUrl) &&
        !isFallbackFeedItemRelevantToCategory(category.pathUrl, item)
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

      // Deduplication runs against the FINAL canonical URL. When a redirect
      // was resolved, the in-memory map is keyed by the original feed URLs,
      // so do a targeted bounded lookup for the resolved final URL.
      let existingFeedArticle =
        (entry.rssGuid ? existingFeedArticlesByGuid.get(entry.rssGuid) : null) ||
        existingFeedArticlesByCanonicalUrl.get(canonicalUrl);
      if (!existingFeedArticle && redirectedFromUrl && canonicalUrl !== redirectedFromUrl) {
        existingFeedArticle = (await prisma.article.findUnique({
          where: { canonicalUrl },
          select: { id: true, rssGuid: true, canonicalUrl: true, categoryId: true, tags: true },
        })) ?? undefined;
      }

      if (
        existingFeedArticle &&
        !shouldPreserveDuplicateForEnrichment(existingFeedArticle, categoryId, item.categories || [])
      ) {
        skipSummary.alreadySeenFeedItem += 1;
        pushRejectedItem(rejectedItems, {
          reason: "already_seen_feed_item",
          rawLink,
          canonicalUrl,
          title: item.title || null,
          publishedAt: null,
        });
        continue;
      }

      const publishedAt = await resolvePublishedAtForFeedItem(item.pubDate, canonicalUrl, telemetry);
      if (!publishedAt) {
        // Missing or invalid date — preserve existing behavior: skip.
        skipSummary.staleOrMissingPublishedAt += 1;
        // Both missing and invalid collapse here; classify as missing_published_at
        // since resolvePublishedAtForFeedItem returns null for both raw parse failure
        // and HTML meta fallback failure.
        skipSummary.staleMissingPublishedAt = (skipSummary.staleMissingPublishedAt || 0) + 1;
        pushRejectedItem(rejectedItems, {
          reason: "stale_or_missing_published_at",
          rawLink,
          canonicalUrl,
          title: item.title || null,
          publishedAt: null,
        });
        continue;
      }
      if (!isAgent1RssItemFresh(publishedAt, now)) {
        // Parseable date older than the 7-day Agent 1 freshness window.
        skipSummary.rssStaleSkipped += 1;
        skipSummary.staleOutsideRetentionWindow = (skipSummary.staleOutsideRetentionWindow || 0) + 1;
        pushRejectedItem(rejectedItems, {
          reason: "stale_or_missing_published_at",
          rawLink,
          canonicalUrl,
          title: item.title || null,
          publishedAt: publishedAt.toISOString(),
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
      const accessEvidence = classifyEarlyAccessHint({
        articleText: `${rawTitle}\n${rawBodyText}`,
        structuredMarkup: rawBodyText,
        articleUrl: canonicalUrl,
        sourceStage: "agent1",
      });

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
        // Evaluate only this feed item. A newsletter CTA elsewhere in the
        // feed must not mark every item as paywalled.
        // Feed text can carry an early hint, never a definitive runtime
        // block. Agent 3 owns the final compatibility boolean.
        isPaywall: accessEvidence.classification === "PAYWALL_BLOCKED" && accessEvidence.confidence === "HIGH",
        accessEvidence,
        rawTags: item.categories || [],
        rawSignals: [],
        reasoning: `${parsedCandidateOrigin.toUpperCase()} ingest from ${source.mediaName || source.frontPageUrl}${
          redirectedFromUrl ? `; redirected from ${redirectedFromUrl}` : ""
        }`,
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
          ...(redirectedFromUrl ? { redirectedFromUrl } : {}),
        },
      });
    }

    if (redirectRetryAtIso) {
      await logAgentScan({
        sourceId,
        categoryId,
        status: "REDIRECT_RETRY_STATE_RECORDED",
        executionTimeMs: Date.now() - startedAt,
        errorLog: `Per-URL redirect retry state recorded; earliest retry ${redirectRetryAtIso}.`,
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
              signal: AbortSignal.timeout(INGEST_HTTP_TIMEOUT_MS),
              headers: {
                "User-Agent": "NuSift/1.0 Ingest-Agent",
                Accept: "text/html,application/xhtml+xml",
              },
              telemetry,
            });

        if (!htmlResponse.ok) {
          await logAgentScan({
            sourceId,
            categoryId,
            status: `HTML_FALLBACK_FAILED_${htmlResponse.status}`,
            executionTimeMs: Date.now() - startedAt,
            errorLog: `HTML fallback failed for ${preferredFrontPageUrl} with HTTP ${htmlResponse.status}.`,
          });
          if (isUnscopedCategoryTarget && !categoryFeedDiscoveryFailed) {
            await markCategoryAsNoRssFound(categoryId!, sourceId, {
              reason: "html_fallback_failed",
              targetUrl: category?.pathUrl || undefined,
              preserveSubmittedFeed: category?.feedProvenance === "USER_SUBMITTED",
            });
          }
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
          telemetry,
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
        if (isUnscopedCategoryTarget && !categoryFeedDiscoveryFailed) {
          await markCategoryAsNoRssFound(categoryId!, sourceId, {
            reason: "html_fallback_exception",
            targetUrl: category?.pathUrl || undefined,
            lastError: fallbackError?.message || String(fallbackError),
            preserveSubmittedFeed: category?.feedProvenance === "USER_SUBMITTED",
          });
        }
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

    if (skipSummary.alreadySeenFeedItem > 0) {
      await logAgentScan({
        sourceId,
        categoryId,
        status: "FEED_ALREADY_SEEN_SUMMARY",
        executionTimeMs: Date.now() - startedAt,
        errorLog: `Skipped ${skipSummary.alreadySeenFeedItem} already-seen feed item(s) after batched GUID/URL matching.`,
      });
    }

    await logAgentScan({
      sourceId,
      categoryId,
      status: "SOURCE_FETCH_COMPLETED",
      executionTimeMs: Date.now() - startedAt,
      errorLog: `Prepared ${candidates.length} candidate(s). skippedEmptyLink=${skipSummary.emptyLink}, skippedOutOfScope=${skipSummary.outOfScope}, skippedAlreadySeen=${skipSummary.alreadySeenFeedItem}, skippedStale=${skipSummary.staleOrMissingPublishedAt}, rssStaleSkipped=${skipSummary.rssStaleSkipped}, skippedHtmlNonArticle=${skipSummary.htmlFallbackNonArticle}, skippedHtmlStale=${skipSummary.htmlFallbackStale}${skipSummary.urlPolicyRejected ? `, urlPolicyRejected=${skipSummary.urlPolicyRejected}` : ''}.`,
    });

    // A parsed scoped category feed owns this target even when every item was
    // already known or filtered. Agent 2 must not retry the listing page.
    if (category && isUsingDedicatedCategoryFeed) {
      await resolveHeadlessMarkersByAgent1Rss({
        sourceId,
        categoryId: category.id,
        targetUrl: category.pathUrl,
        rssFeedUrl: feedUrl,
      }).catch(() => {});
    }

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
      status: rateLimitedRetryAt
        ? "SOURCE_FETCH_RATE_LIMITED"
        : isSecurityError
          ? "SOURCE_FETCH_BLOCKED_SECURITY"
          : "SOURCE_FETCH_EXCEPTION",
      executionTimeMs: Date.now() - startedAt,
      errorLog: error?.message || String(error),
    });

    if (!isUsingDedicatedCategoryFeed && sourceFeedUrl && source.frontPageUrl) {
      try {
        const htmlResponse = await safeFetch(source.frontPageUrl, {
          signal: AbortSignal.timeout(INGEST_HTTP_TIMEOUT_MS),
          headers: {
            "User-Agent": "NuSift/1.0 Ingest-Agent",
            Accept: "text/html,application/xhtml+xml",
          },
          telemetry,
        });

        if (htmlResponse.ok) {
          const html = await htmlResponse.text();
          const htmlFallback = await extractHtmlCandidates(
            html,
            source.frontPageUrl,
            source.id,
            undefined,
            telemetry,
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

    // When a category target without a scoped feed reaches this point,
    // all RSS paths and HTML fallbacks have failed. Mark it as NO_RSS_FOUND
    // so Agent 2 can pick it up in the same pipeline cycle.
    // Skip if resolveCategoryFeedUrl already handled the DB state update.
    if (isUnscopedCategoryTarget && !categoryFeedDiscoveryFailed) {
      await markCategoryAsNoRssFound(categoryId!, sourceId, {
        reason: "root_feed_fetch_exception",
        targetUrl: category?.pathUrl || undefined,
        lastError: error?.message || String(error),
        preserveSubmittedFeed: category?.feedProvenance === "USER_SUBMITTED",
      });
    }

    return {
      sourceId,
      categoryId: categoryId || null,
      candidates: [],
      failed: rateLimitedRetryAt ? 0 : 1,
      feedUrl: preferredFeedUrl || preferredFrontPageUrl,
      feedFormat: null,
      deferredReason: rateLimitedRetryAt ? "rate_limited" : null,
      retryAt: rateLimitedRetryAt?.toISOString() || null,      skipSummary: redirectRetryAtIso
        ? { ...emptySkipSummary(), redirectRetryAt: redirectRetryAtIso }
        : emptySkipSummary(),
      rejectedItems: [],
      hardCaseQueueCandidates,
    };
  }
}

export async function persistCandidates(candidates: IngestCandidate[]) {
  if (candidates.length === 0) {
    return { inserted: 0, skipped: 0, failed: 0, enriched: 0 };
  }

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let enriched = 0;

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
            ].filter(nonNullish),
          },
          select: {
            id: true,
            rssGuid: true,
            canonicalUrl: true,
            contentHash: true,
            categoryId: true,
            tags: true,
          },
        })
      : [];

  const existingRssGuids = new Set(existingArticles.map((article) => article.rssGuid).filter(Boolean));
  const existingCanonicalUrls = new Set(existingArticles.map((article) => article.canonicalUrl).filter(Boolean));
  const existingContentHashes = new Set(existingArticles.map((article) => article.contentHash).filter(Boolean));
  const existingByRssGuid = new Map(existingArticles.filter((article) => article.rssGuid).map((article) => [article.rssGuid!, article]));
  const existingByCanonicalUrl = new Map(existingArticles.filter((article) => article.canonicalUrl).map((article) => [article.canonicalUrl!, article]));
  const existingByContentHash = new Map(existingArticles.filter((article) => article.contentHash).map((article) => [article.contentHash!, article]));

  const enrichmentUpdates = new Map<number, { categoryId?: string | null; tags?: string[] }>();

  for (const candidate of dedupedCandidates) {
    const existingArticle =
      (candidate.rssGuid ? existingByRssGuid.get(candidate.rssGuid) : null) ||
      existingByCanonicalUrl.get(candidate.canonicalUrl) ||
      existingByContentHash.get(candidate.contentHash);

    if (!existingArticle) continue;

    const nextUpdate = enrichmentUpdates.get(existingArticle.id) || {};
    if (!existingArticle.categoryId && candidate.categoryId) {
      nextUpdate.categoryId = candidate.categoryId;
    }
    if ((!existingArticle.tags || existingArticle.tags.length === 0) && candidate.rawTags.length > 0) {
      nextUpdate.tags = candidate.rawTags;
    }
    if (nextUpdate.categoryId || nextUpdate.tags) {
      enrichmentUpdates.set(existingArticle.id, nextUpdate);
    }
  }

  if (enrichmentUpdates.size > 0) {
    enriched = enrichmentUpdates.size;
    await prisma.$transaction(
      [...enrichmentUpdates.entries()].map(([articleId, update]) =>
        prisma.article.update({
          where: { id: articleId },
          data: {
            ...(update.categoryId ? { categoryId: update.categoryId } : {}),
            ...(update.tags ? { tags: update.tags } : {}),
          },
        }),
      ),
    );
  }

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
    return { inserted, skipped, failed, enriched };
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

  return { inserted, skipped, failed, enriched };
}
