import { prisma } from "../prisma";
import { createHeadlessQueueArtifactIfAbsent } from "./headless-queue-artifact";
import { governedSafeFetch, governedSafeFetchAndParse, GovernedFetchDeferredError, GovernedFetchRequestBudgetError } from "./governed-fetch";
import { logAgentScan } from "./log";
import { createPipelineRun, finalizePipelineRun } from "./artifacts";
import { normalizeUrl } from "./text";
import { persistCandidates } from "./ingest";
import { resolveActivePipelineTargets } from "./targets";
import { resolveHardSourceProfilesForTarget } from "./hard-source-profile";
import { lookupActiveDiscoveryProfile, type Agent2DiscoveryProfile } from "./agent2-discovery-profile";
import {
  BLOCKED_UTILITY_PATTERNS,
  DISCOVERY_FRESHNESS_MS,
  discoverSitemapUrls,
  filterSitemapArticleUrls,
  extractJsonLdArticles,
  scoreCandidateUrl,
  assessArticleDiscoveryQuality,
  ArticleDiscoveryOutcomeTracker,
  evaluateArticleLinkCandidate,
  normalizePublishedAt,
  extractPageMetadata,
  isBlockedDiscoveryPath,
  buildStaleSampleLog,
  type ArticleDiscoveryCandidateOutcome,
  type ArticleDiscoveryOutcomeSummary,
  type ArticleDiscoveryQualityAssessment,
  type ArticleDiscoverySourceKind,
  type JsonLdArticle,
  type DiscoveryNetworkTelemetry,
  createStaticDiscoveryRequestBudget,
  type StaticDiscoveryRequestBudget,
  type StaticDiscoveryRateLimitEvidence,
  type StaticDiscoveryRequestBudgetSnapshot,
  readStaticResponseHeader,
  type StaticDiscoveryGovernedFetchContext,
} from "./article-discovery-helpers";
import { Prisma } from "@prisma/client";
import { isLikelyArticleUrl } from "./article-url-policy";
import { buildVerifiedHostScope, serializeHostScope, isHostVerified, type VerifiedHostScope } from "./canonical-host-scope";
import type { IngestCandidate, IngestRejectedItem, IngestSkipSummary, PipelineResult } from "./types";
import {
  createNoopStageBatchProbe,
  type StageBatchProbe,
} from "./stage-telemetry";
import { boundedPipelineItemError, isUnsafePipelineInvariantError } from "./item-failure";
import { evaluateRssOwnedTargetForAgent2 } from "./rss-owned-target";
import { shouldRunAgent2Discovery } from "./feed-first-policy";
import { NUSIFT_CRAWLER_USER_AGENT } from "./publisher-user-agent";

// DISCOVERY_FRESHNESS_MS re-exported from article-discovery-helpers for backward compat
const MAX_LISTING_PAGES = 3;
const MAX_LINKS_PER_PAGE = 20;
export const MAX_ACCEPTED_CANDIDATES = 60;
export const MAX_EVALUATED_CANDIDATES = 30;
export const MAX_STATIC_REQUESTS = 40;
const USER_AGENT = NUSIFT_CRAWLER_USER_AGENT;

/**
 * Build compact verified host-transition evidence for a discovery run.
 * Accepts bounded final URLs observed during the crawl; every entry is
 * sanitized (query values redacted) by the shared canonical-host-scope helper.
 */
const buildCanonicalHostEvidence = (
  configuredTargetUrl: string,
  finalUrls: string[],
) => {
  const scope = buildVerifiedHostScope({
    configuredTargetUrl,
    finalUrl: finalUrls[finalUrls.length - 1] ?? null,
    redirectUrls: finalUrls.slice(0, -1),
  });
  return serializeHostScope(scope);
};

export type ArticleDiscoveryTarget = {
  targetType: "source" | "category";
  sourceId: string;
  categoryId?: string | null;
  targetUrl: string;
  rssStatus: string;
  currentFeedProductive: boolean;
  consecutiveNonProductiveRuns: number;
  lastProductiveAt?: Date | null;
  nextRetryAt?: Date | null;
  /** Persisted category/source discovery evidence, when available. */
  scopeMatches?: boolean;
  mediaName: string;
};

const readScopeMatch = (evidence: unknown): boolean | undefined => {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return undefined;
  const record = evidence as Record<string, unknown>;
  const outcome = record.outcome && typeof record.outcome === "object" && !Array.isArray(record.outcome)
    ? record.outcome as Record<string, unknown>
    : null;
  const value = outcome?.scopeMatch ?? record.scopeMatch;
  if (value === "exact" || value === "probable") return true;
  if (value === "generic" || value === "unrelated") return false;
  return undefined;
};

const agent2TargetKey = (input: {
  sourceId: string | null | undefined;
  categoryId?: string | null;
  targetUrl?: string | null;
}) => `${input.sourceId || ""}|${input.categoryId || ""}|${input.targetUrl || ""}`;

export type ArticleDiscoveryResult = {
  targetType: "source" | "category";
  sourceId: string;
  categoryId?: string | null;
  targetUrl: string;
  discoveryMethod: "jsdom";
  discoverySources: {
    listingPages: number;
    sitemapUrls: number;
    jsonldUrls: number;
  };
  listingDiagnostics: ListingFetchDiagnostic[];
  pagesVisited: string[];
  candidates: IngestCandidate[];
  failed: number;
  skipSummary: IngestSkipSummary;
  rejectedItems: IngestRejectedItem[];
  outcomeSummary: ArticleDiscoveryOutcomeSummary;
  acceptedOutcomes: ArticleDiscoveryCandidateOutcome[];
  rejectedOutcomes: ArticleDiscoveryCandidateOutcome[];
  qualityAssessment: ArticleDiscoveryQualityAssessment;
  /** Compact discovery profile metadata when an active profile was applied. */
  appliedProfileAudit?: {
    appliedDiscoveryProfileId: string | null;
    appliedDiscoveryProfileAction: string | null;
    appliedDiscoveryProfileVersion: number;
    appliedDiscoveryProfileRules: string[];
    appliedDiscoveryProfileSource: string;
    appliedDiscoveryProfileAt: string;
  } | null;
  /**
   * Bounded evidence of verified host transitions (redirect / final URL /
   * document canonical) accepted during this discovery run. Query values
   * are redacted. Empty when no host transition occurred.
   */
  canonicalHostEvidence: Array<{
    host: string;
    establishedBy: "configured_target" | "redirect" | "final_url" | "document_canonical";
    via: string;
    trusted: boolean;
  }>;
  /** Static discovery was interrupted by a bounded retryable condition. */
  retryable: boolean;
  /** False when HTTP 429, governor deferral, or request-budget exhaustion stopped the shortlist early. */
  discoveryComplete: boolean;
  detailEvaluationStoppedReason: "rate_limited" | "request_budget_exhausted" | "governor_deferred" | "evaluation_cap" | "accepted_cap" | null;
  rateLimitEvidence: StaticDiscoveryRateLimitEvidence[];
  requestBudget: StaticDiscoveryRequestBudgetSnapshot;
};

type ListingArticleLink = {
  url: string;
  sourcePageUrl: string;
};

export type ListingFetchDiagnostic = {
  url: string;
  finalUrl: string | null;
  status: number | null;
  contentType: string | null;
  htmlLength: number | null;
  title: string | null;
  rawLinkCount: number;
  articleLikeLinkCount: number;
  paginationLinkCount: number;
  reason:
    | "fetch_failed"
    | "governor_deferred"
    | "non_html_content"
    | "empty_html"
    | "blocked_or_challenge_like_html"
    | "no_links_found"
    | "no_article_like_links"
    | "ok"
    | "parser_error"
    | "rate_limited"
    | "request_budget_exhausted";
  hints: string[];
  rateLimited?: boolean;
  retryAfterAt?: string | null;
  retryAfterSource?: "delta_seconds" | "http_date" | "fallback" | null;
  requestBudgetExhausted?: boolean;
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

const normalizePath = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
};

// isWithinFreshnessWindow, isBlockedDiscoveryPath, extractPageMetadata,
// normalizePublishedAt — now imported from article-discovery-helpers

const decodeHtmlAttribute = (value: string) =>
  value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

const stripTags = (value: string) => value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const extractAttribute = (tag: string, name: string) => {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? decodeHtmlAttribute(value.trim()) : null;
};

const extractTitleFromHtml = (html: string) => {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? stripTags(decodeHtmlAttribute(match[1])) || null : null;
};

type HtmlLinkTag = {
  tag: string;
  href: string;
  text: string;
  tagName: "a" | "link";
  ariaLabel: string | null;
  title: string | null;
};

const extractHtmlLinkTags = (html: string): HtmlLinkTag[] => {
  const links: HtmlLinkTag[] = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>[\s\S]*?<\/a>/gi;
  const linkPattern = /<link\b[^>]*href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const tag = match[0];
    const href = extractAttribute(tag, "href");
    if (!href) continue;
    links.push({
      tag,
      href,
      text: stripTags(tag),
      tagName: "a",
      ariaLabel: extractAttribute(tag, "aria-label"),
      title: extractAttribute(tag, "title"),
    });
  }

  for (const match of html.matchAll(linkPattern)) {
    const tag = match[0];
    const href = extractAttribute(tag, "href");
    if (!href) continue;
    links.push({
      tag,
      href,
      text: "",
      tagName: "link",
      ariaLabel: extractAttribute(tag, "aria-label"),
      title: extractAttribute(tag, "title"),
    });
  }

  return links;
};

const isLikelyArticleLink = (href: string, sourceUrl: string, verifiedHostScope?: VerifiedHostScope | null) => {
  try {
    const url = new URL(href);
    const sameHost = verifiedHostScope
      ? isHostVerified(verifiedHostScope, href)
      : url.hostname.replace(/^www\./, "") === new URL(sourceUrl).hostname.replace(/^www\./, "");
    if (!sameHost) return false;
    const path = normalizePath(href).replace(/^\/|\/$/g, "");
    if (!path || isBlockedDiscoveryPath(href)) return false;
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

const extractListingArticleLinks = (
  html: string,
  pageUrl: string,
  categoryPathUrl?: string | null,
  deniedPathPrefixes?: string[] | null,
  verifiedHostScope?: VerifiedHostScope | null,
) => {
  const links = new Map<string, { url: string; score: number; order: number }>();
  const htmlLinks = extractHtmlLinkTags(html).filter((link) => link.tagName === "a");
  let order = 0;

  for (const link of htmlLinks) {
    order += 1;
    const href = link.href;
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    try {
      const resolved = new URL(href, pageUrl).toString();
      if (links.has(resolved)) continue;
      if (isBlockedDiscoveryPath(resolved)) continue;
      if (!isLikelyArticleUrl(resolved)) continue;
      if (!isLikelyArticleLink(resolved, pageUrl, verifiedHostScope)) continue;
      // Check deniedPathPrefixes from active discovery profile
      if (deniedPathPrefixes && deniedPathPrefixes.length > 0) {
        try {
          const linkPath = new URL(resolved).pathname;
          if (deniedPathPrefixes.some((prefix) => linkPath.startsWith(prefix))) continue;
        } catch { /* invalid URL already filtered */ }
      }
      const score = scoreCandidateUrl(resolved, pageUrl, {
        title: link.text || link.title || link.ariaLabel,
        categoryPathUrl,
        verifiedHostScope,
      });
      if (score.rejected) continue;
      links.set(resolved, { url: resolved, score: score.score, order });
    } catch {
      continue;
    }
  }

  return [...links.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_LINKS_PER_PAGE)
    .map((link) => link.url);
};

const extractPaginationLinks = (html: string, pageUrl: string, verifiedHostScope?: VerifiedHostScope | null) => {
  const links = new Set<string>();
  const htmlLinks = extractHtmlLinkTags(html);

  for (const link of htmlLinks) {
    const href = link.href;
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    const rel = extractAttribute(link.tag, "rel")?.toLowerCase() || "";
    const label = `${link.text} ${link.ariaLabel || ""} ${link.title || ""}`.toLowerCase();
    const looksPaginated = /(?:[?&](?:page|p)=|\/page\/\d+)/i.test(href);
    const looksNext = rel.split(/\s+/).includes("next") || /next|older|more|page\s*\d+/i.test(label);
    if (!looksPaginated && !looksNext) continue;
    try {
      const resolved = new URL(href, pageUrl).toString();
      if (isBlockedDiscoveryPath(resolved)) continue;
      if (verifiedHostScope
        ? !isHostVerified(verifiedHostScope, resolved)
        : new URL(resolved).hostname.replace(/^www\./, "") !== new URL(pageUrl).hostname.replace(/^www\./, "")) continue;
      links.add(resolved);
    } catch {
      continue;
    }
  }

  return [...links].slice(0, 2);
};

const detectListingFetchReason = (input: {
  ok: boolean;
  contentType: string | null;
  htmlLength: number;
  rawLinkCount: number;
  articleLikeLinkCount: number;
  title: string | null;
  html: string;
}): ListingFetchDiagnostic["reason"] => {
  if (!input.ok) return "fetch_failed";
  if (input.contentType && !/html|xhtml/i.test(input.contentType)) return "non_html_content";
  if (input.htmlLength === 0) return "empty_html";
  const blockText = `${input.title || ""} ${input.html.slice(0, 4000)}`.toLowerCase();
  if (/(captcha|cloudflare|access denied|enable javascript|bot detection|unusual traffic|verify you are human)/i.test(blockText)) {
    return "blocked_or_challenge_like_html";
  }
  if (input.rawLinkCount === 0) return "no_links_found";
  if (input.articleLikeLinkCount === 0) return "no_article_like_links";
  return "ok";
};

const buildListingHints = (input: {
  title: string | null;
  reason: ListingFetchDiagnostic["reason"];
  html: string;
}) => {
  const hints: string[] = [];
  if (input.title) hints.push(`title=${input.title.slice(0, 80)}`);
  const text = input.html.slice(0, 4000).toLowerCase();
  for (const keyword of ["captcha", "cloudflare", "access denied", "enable javascript", "verify you are human"]) {
    if (text.includes(keyword)) hints.push(`keyword=${keyword}`);
    if (hints.length >= 3) break;
  }
  if (input.reason !== "ok" && hints.length === 0) hints.push(`reason=${input.reason}`);
  return hints.slice(0, 3);
};

const formatListingDiagnosticsForLog = (diagnostics: ListingFetchDiagnostic[]) => {
  if (diagnostics.length === 0) return "";
  const samples = diagnostics.slice(0, 2).map((diag) => {
    let hostPath = diag.url;
    try {
      const u = new URL(diag.url);
      hostPath = `${u.hostname.replace(/^www\./, "")}${u.pathname}`;
    } catch {
      hostPath = diag.url.slice(0, 80);
    }
    return `${diag.reason}|status=${diag.status ?? "n/a"}|html=${diag.htmlLength ?? "n/a"}|links=${diag.rawLinkCount}/${diag.articleLikeLinkCount}|${hostPath}`;
  });
  return ` listingDiagnostics=[${samples.join(", ")}]`;
};

const crawlListingPages = async (
  targetUrl: string,
  categoryPathUrl?: string | null,
  deniedPathPrefixes?: string[] | null,
  telemetry?: DiscoveryNetworkTelemetry,
  requestBudget?: StaticDiscoveryRequestBudget,
  governedFetchContext?: StaticDiscoveryGovernedFetchContext,
) => {
  const visitedPages: string[] = [];
  const diagnostics: ListingFetchDiagnostic[] = [];
  const articleLinks = new Map<string, ListingArticleLink>();
  const seenPages = new Set<string>();
  const queue = [targetUrl];
  let firstPageHtml: string | null = null;
  let governorDeferred = false;

  while (queue.length > 0 && visitedPages.length < MAX_LISTING_PAGES) {
    const pageUrl = queue.shift()!;
    const normalizedPageUrl = normalizeUrl(pageUrl);
    if (seenPages.has(normalizedPageUrl)) continue;
    seenPages.add(normalizedPageUrl);

    let fetchedPage: { response: Response; html: string } | null = null;
    try {
      fetchedPage = await governedSafeFetchAndParse(pageUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
        telemetry,
      }, {
        ...(governedFetchContext ?? {}),
        agent: "agent2",
        stage: "article-discovery",
        purpose: "listing",
        requestBudget: requestBudget ? {
          snapshot: requestBudget.snapshot,
          consume: requestBudget.consume,
          phase: "listing",
        } : undefined,
      }, async (response) => ({
        response,
        html: response.ok ? await response.text() : "",
      }));
    } catch (error: any) {
      if (error instanceof GovernedFetchRequestBudgetError) {
        requestBudget?.recordWorkSkipped("listing", pageUrl, "request budget exhausted");
        diagnostics.push({
          url: pageUrl,
          finalUrl: null,
          status: null,
          contentType: null,
          htmlLength: null,
          title: null,
          rawLinkCount: 0,
          articleLikeLinkCount: 0,
          paginationLinkCount: 0,
          reason: "request_budget_exhausted",
          hints: ["static request budget exhausted"],
          requestBudgetExhausted: true,
        });
        break;
      }
      if (error instanceof GovernedFetchDeferredError) {
        governorDeferred = true;
        diagnostics.push({
          url: pageUrl,
          finalUrl: null,
          status: null,
          contentType: null,
          htmlLength: null,
          title: null,
          rawLinkCount: 0,
          articleLikeLinkCount: 0,
          paginationLinkCount: 0,
          reason: "governor_deferred",
          hints: [`governor_deferred=${error.reason}`],
        });
        break;
      }
      diagnostics.push({
        url: pageUrl,
        finalUrl: null,
        status: null,
        contentType: null,
        htmlLength: null,
        title: null,
        rawLinkCount: 0,
        articleLikeLinkCount: 0,
        paginationLinkCount: 0,
        reason: "fetch_failed",
        hints: [`error=${String(error?.message || error).slice(0, 80)}`],
      });
      continue;
    }

    if (!fetchedPage) continue;
    const { response, html } = fetchedPage;
    const contentType = typeof response.headers?.get === "function"
      ? response.headers.get("content-type")
      : null;
    if (!response.ok) {
      const rateLimited = response.status === 429;
      const rateLimitEvidence = rateLimited
        ? requestBudget?.recordRateLimit("listing", pageUrl, readStaticResponseHeader(response, "retry-after"))
        : undefined;
      if (rateLimited) telemetry?.recordRateLimited(429);
      if (rateLimited) {
        // A confirmed listing 429 invalidates the remaining pagination queue.
        // Do not fetch page 3, robots, sitemaps, or details after this point.
        queue.length = 0;
      }
      diagnostics.push({
        url: pageUrl,
        finalUrl: response.url || null,
        status: response.status,
        contentType,
        htmlLength: null,
        title: null,
        rawLinkCount: 0,
        articleLikeLinkCount: 0,
        paginationLinkCount: 0,
        reason: rateLimited ? "rate_limited" : "fetch_failed",
        hints: [`status=${response.status}`],
        rateLimited,
        retryAfterAt: rateLimitEvidence?.retryAfterAt ?? null,
        retryAfterSource: rateLimitEvidence?.retryAfterSource ?? null,
      });
      if (rateLimited) break;
      continue;
    }

    // The effective page URL is the final URL after redirects. A configured
    // root host may redirect to a publisher-controlled subdomain that renders
    // the actual content; candidate links must be evaluated against this
    // verified effective host, not the originally configured host.
    const effectivePageUrl = response.url || pageUrl;
    // Establish only this response's full final URL as bounded evidence. The
    // scope is enforced during extraction; it is not diagnostics-only.
    const pageHostScope = buildVerifiedHostScope({
      configuredTargetUrl: targetUrl,
      finalUrl: response.url || pageUrl,
    });
    let rawLinkCount = 0;
    let articleLikeLinks: string[] = [];
    let paginationLinks: string[] = [];
    let title: string | null = null;
    try {
      const htmlLinks = extractHtmlLinkTags(html);
      rawLinkCount = htmlLinks.filter((link) => link.tagName === "a").length;
      articleLikeLinks = extractListingArticleLinks(html, effectivePageUrl, categoryPathUrl, deniedPathPrefixes, pageHostScope);
      paginationLinks = extractPaginationLinks(html, effectivePageUrl, pageHostScope);
      title = extractTitleFromHtml(html);
    } catch (error: any) {
      diagnostics.push({
        url: pageUrl,
        finalUrl: response.url || null,
        status: response.status,
        contentType,
        htmlLength: html.length,
        title: null,
        rawLinkCount: 0,
        articleLikeLinkCount: 0,
        paginationLinkCount: 0,
        reason: "parser_error",
        hints: [`html parser failed: ${String(error?.message || error).slice(0, 80)}`],
      });
      continue;
    }
    visitedPages.push(pageUrl);
    // Capture first page HTML for downstream JSON-LD extraction (avoids double fetch)
    if (!firstPageHtml) firstPageHtml = html;

    const reason = detectListingFetchReason({
      ok: response.ok,
      contentType,
      htmlLength: html.length,
      rawLinkCount,
      articleLikeLinkCount: articleLikeLinks.length,
      title,
      html,
    });
    diagnostics.push({
      url: pageUrl,
      finalUrl: response.url || null,
      status: response.status,
      contentType,
      htmlLength: html.length,
      title,
      rawLinkCount,
      articleLikeLinkCount: articleLikeLinks.length,
      paginationLinkCount: paginationLinks.length,
      reason,
      hints: buildListingHints({ title, reason, html }),
    });

    for (const link of articleLikeLinks) {
      if (!articleLinks.has(link)) {
        articleLinks.set(link, { url: link, sourcePageUrl: pageUrl });
      }
    }

    for (const nextLink of paginationLinks) {
      const normalized = normalizeUrl(nextLink);
      if (!seenPages.has(normalized)) {
        queue.push(nextLink);
      }
    }
  }

  return { visitedPages, articleLinks: [...articleLinks.values()], firstPageHtml, diagnostics, governorDeferred };
};

type CandidateEvaluationResult = {
  candidate: IngestCandidate;
  outcome: ArticleDiscoveryCandidateOutcome;
} | {
  candidate: null;
  outcome: ArticleDiscoveryCandidateOutcome;
};

const resolveSourceKind = (sourcePageUrl: string): ArticleDiscoverySourceKind => {
  if (sourcePageUrl.startsWith("sitemap:")) return "sitemap";
  if (sourcePageUrl.startsWith("jsonld:")) return "jsonld";
  if (sourcePageUrl.startsWith("browser:")) return "browser";
  return "listing";
};

const makeOutcome = (
  url: string,
  sourcePageUrl: string,
  status: ArticleDiscoveryCandidateOutcome["status"],
  overrides?: Partial<ArticleDiscoveryCandidateOutcome>,
): ArticleDiscoveryCandidateOutcome => ({
  url,
  sourceKind: resolveSourceKind(sourcePageUrl),
  status,
  ...overrides,
});

const discoverArticleCandidatesForPage = async (
  articleLink: ListingArticleLink,
  target: ArticleDiscoveryTarget,
  skipSummary: IngestSkipSummary,
  rejectedItems: IngestRejectedItem[],
  overrides?: {
    freshnessMs?: number;
    deniedPathPrefixes?: string[] | null;
    telemetry?: DiscoveryNetworkTelemetry;
    requestBudget?: StaticDiscoveryRequestBudget;
    governedFetchContext?: StaticDiscoveryGovernedFetchContext;
    /** Authoritative verified host scope established by discovery evidence. */
    verifiedHostScope?: VerifiedHostScope | null;
    /** @deprecated compatibility-only input for isolated callers. */
    verifiedHosts?: string[] | null;
  },
): Promise<CandidateEvaluationResult> => {
  const { url: articleUrl, sourcePageUrl } = articleLink;

  // Early denied-path check — avoids an expensive HTTP fetch for denied paths
  if (overrides?.deniedPathPrefixes && overrides.deniedPathPrefixes.length > 0) {
    try {
      const linkPath = new URL(articleUrl).pathname;
      if (overrides.deniedPathPrefixes.some((prefix) => linkPath.startsWith(prefix))) {
        const outcome = makeOutcome(articleUrl, sourcePageUrl, "rejected_utility_path", {
          reason: "discovery_profile_denied_path",
        });
        skipSummary.outOfScope += 1;
        pushRejectedItem(rejectedItems, {
          reason: "discovery_profile_denied_path",
          rawLink: articleUrl,
          canonicalUrl: null,
          title: null,
          publishedAt: null,
        });
        return { candidate: null, outcome };
      }
    } catch { /* invalid URL — let normal evaluation handle it */ }
  }

  const result = await evaluateArticleLinkCandidate({
    articleUrl,
    sourcePageUrl,
    targetUrl: target.targetUrl,
    sourceId: target.sourceId,
    categoryId: target.categoryId,
    freshnessMs: overrides?.freshnessMs,
    telemetry: overrides?.telemetry,
    requestBudget: overrides?.requestBudget,
    governedFetchContext: overrides?.governedFetchContext,
    // The one authoritative scope is carried into metadata evaluation and URL
    // scoring; raw host arrays are not used by the production path.
    verifiedHostScope: overrides?.verifiedHostScope ?? null,
    verifiedHosts: overrides?.verifiedHostScope ? null : (overrides?.verifiedHosts ?? null),
  });

  if (!result.accepted) {
    const status = result.outcome.status;
    if (status === "rejected_out_of_scope") {
      skipSummary.outOfScope += 1;
      pushRejectedItem(rejectedItems, {
        reason: "out_of_scope",
        rawLink: articleUrl,
        canonicalUrl: result.outcome.canonicalUrl || null,
        title: result.outcome.title || null,
        publishedAt: result.outcome.publishedAt || null,
      });
    } else if (status === "rejected_stale") {
      skipSummary.staleOrMissingPublishedAt += 1;
      skipSummary.htmlFallbackStale += 1;
      // Split by staleReason when available
      const sr = result.outcome.staleReason;
      if (sr === "published_at_before_cutoff") skipSummary.staleOutsideRetentionWindow = (skipSummary.staleOutsideRetentionWindow || 0) + 1;
      else if (sr === "missing_published_at") skipSummary.staleMissingPublishedAt = (skipSummary.staleMissingPublishedAt || 0) + 1;
      else if (sr === "invalid_published_at") skipSummary.staleInvalidPublishedAt = (skipSummary.staleInvalidPublishedAt || 0) + 1;
      pushRejectedItem(rejectedItems, {
        reason: "html_fallback_stale",
        rawLink: articleUrl,
        canonicalUrl: result.outcome.canonicalUrl || null,
        title: result.outcome.title || null,
        publishedAt: result.outcome.publishedAt || null,
      });
    } else if (status !== "rejected_duplicate") {
      skipSummary.htmlFallbackNonArticle += 1;
      pushRejectedItem(rejectedItems, {
        reason: "html_fallback_non_article",
        rawLink: articleUrl,
        canonicalUrl: result.outcome.canonicalUrl || null,
        title: result.outcome.title || null,
        publishedAt: result.outcome.publishedAt || null,
      });
    }
    return { candidate: null, outcome: result.outcome };
  }

  return { candidate: result.candidate as IngestCandidate, outcome: result.outcome };
};

export const isAgent2EligibleTarget = (input: {
  rssStatus: string;
  currentFeedProductive: boolean;
  consecutiveNonProductiveRuns: number;
  rssFeedUrl?: string | null;
  feedProvenance?: string | null;
  lastProductiveAt?: Date | string | null;
  nextRetryAt?: Date | string | null;
  scopeMatches?: boolean;
  /** Explicit admin request: bypass the RSS-owned skip for these targets. */
  bypassRssOwned?: boolean;
}): boolean => {
  const feedFirstDecision = shouldRunAgent2Discovery({
    targetType: input.scopeMatches === undefined ? "source" : "category",
    rssStatus: input.rssStatus,
    rssFeedUrl: input.rssFeedUrl,
    currentFeedProductive: input.currentFeedProductive,
    lastProductiveAt: input.lastProductiveAt,
    consecutiveNonProductiveRuns: input.consecutiveNonProductiveRuns,
    nextRetryAt: input.nextRetryAt,
    scopeMatches: input.scopeMatches,
    manualOverride: input.bypassRssOwned,
  });
  if (input.lastProductiveAt !== undefined || input.nextRetryAt !== undefined) {
    return feedFirstDecision.runAgent2;
  }
  // An explicit admin request escalates the target directly, bypassing the
  // RSS-owned skip and the normal cooldown rules for that target.
  if (input.bypassRssOwned) return true;

  // RSS-owned targets (valid trusted feed: USER_SUBMITTED / ADMIN_CONFIRMED)
  // follow the bounded escalation rules and skip routine Agent 2 discovery
  // while valid. A temporary feed failure never immediately removes ownership.
  const rssOwned = evaluateRssOwnedTargetForAgent2({
    rssStatus: input.rssStatus,
    rssFeedUrl: input.rssFeedUrl,
    feedProvenance: input.feedProvenance,
    currentFeedProductive: input.currentFeedProductive,
    consecutiveNonProductiveRuns: input.consecutiveNonProductiveRuns,
    scopeMatches: input.scopeMatches,
  });
  if (rssOwned.rssOwned) {
    return rssOwned.eligibleForAgent2;
  }

  // Non-RSS-owned targets: normal eligibility rules.
  if (input.rssStatus === "NO_RSS_FOUND") return true;
  if (input.rssStatus === "FAILED") {
    // Invalid feed — escalate once there is at least one confirmed
    // non-productive run (bounded evidence; a single transient failure is not
    // enough to send the target to Agent 2).
    return (input.consecutiveNonProductiveRuns ?? 0) >= 1;
  }
  if (input.rssStatus === "DOMAIN_DEAD") return true;
  if (input.rssStatus === "ACTIVE") {
    return !input.currentFeedProductive && (input.consecutiveNonProductiveRuns ?? 0) >= 2;
  }
  return false;
};

export type TargetSkipReason =
  | "not_found_in_db"
  | "missing_target_url"
  | "rss_active_productive"
  | "rss_owned_productive"
  | "rss_owned_waiting_evidence"
  | "rss_rate_limited_cooldown"
  | "rss_active_waiting_for_second_nonproductive_run"
  | "rss_pending_discovery"
  | "unsupported_status"
  | "requested_filter_excluded";

export type TargetResolutionDiagnostics = {
  totalActive: number;
  eligible: number;
  skipped: number;
  skippedReasons: Record<TargetSkipReason, number>;
};

const EMPTY_SKIP_REASONS = (): Record<TargetSkipReason, number> => ({
  not_found_in_db: 0,
  missing_target_url: 0,
  rss_active_productive: 0,
  rss_owned_productive: 0,
  rss_owned_waiting_evidence: 0,
  rss_rate_limited_cooldown: 0,
  rss_active_waiting_for_second_nonproductive_run: 0,
  rss_pending_discovery: 0,
  unsupported_status: 0,
  requested_filter_excluded: 0,
});

const classifySkipReason = (input: {
  rssStatus: string;
  currentFeedProductive: boolean;
  consecutiveNonProductiveRuns: number;
  lastProductiveAt?: Date | string | null;
  nextRetryAt?: Date | string | null;
  rssFeedUrl?: string | null;
  feedProvenance?: string | null;
  scopeMatches?: boolean;
  bypassRssOwned?: boolean;
}): TargetSkipReason => {
  const hasDurableFeedState = input.lastProductiveAt !== undefined || input.nextRetryAt !== undefined;
  const feedFirstDecision = hasDurableFeedState
    ? shouldRunAgent2Discovery({
        targetType: input.scopeMatches === undefined ? "source" : "category",
        rssStatus: input.rssStatus,
        rssFeedUrl: input.rssFeedUrl,
        currentFeedProductive: input.currentFeedProductive,
        lastProductiveAt: input.lastProductiveAt,
        consecutiveNonProductiveRuns: input.consecutiveNonProductiveRuns,
        nextRetryAt: input.nextRetryAt,
        scopeMatches: input.scopeMatches,
        manualOverride: input.bypassRssOwned,
      })
    : null;
  if (feedFirstDecision && !feedFirstDecision.runAgent2) {
    if (feedFirstDecision.reason === "active_feed_rate_limited") return "rss_rate_limited_cooldown";
    if (feedFirstDecision.reason === "productive_fresh_feed") {
      const trustedFeed = Boolean(input.rssFeedUrl) &&
        (input.feedProvenance === "USER_SUBMITTED" || input.feedProvenance === "ADMIN_CONFIRMED");
      return trustedFeed ? "rss_owned_productive" : "rss_active_productive";
    }
  }
  const rssOwned = input.bypassRssOwned
    ? { rssOwned: false as const, eligibleForAgent2: true as const, reason: "not_rss_owned" as const }
    : evaluateRssOwnedTargetForAgent2({
        rssStatus: input.rssStatus,
        rssFeedUrl: input.rssFeedUrl,
        feedProvenance: input.feedProvenance,
        currentFeedProductive: input.currentFeedProductive,
        consecutiveNonProductiveRuns: input.consecutiveNonProductiveRuns,
        scopeMatches: input.scopeMatches,
      });
  if (rssOwned.rssOwned) {
    if (rssOwned.eligibleForAgent2) return "unsupported_status"; // unreachable: eligible targets are not skipped
    if (rssOwned.reason === "rss_owned_productive") return "rss_owned_productive";
    if (rssOwned.reason === "rss_owned_waiting_evidence") return "rss_owned_waiting_evidence";
    return "rss_owned_waiting_evidence";
  }
  if (input.rssStatus === "ACTIVE") {
    return input.currentFeedProductive
      ? "rss_active_productive"
      : "rss_active_waiting_for_second_nonproductive_run";
  }
  if (input.rssStatus === "PENDING_DISCOVERY") {
    return "rss_pending_discovery";
  }
  return "unsupported_status";
};

export async function resolveAgent2Targets(input?: {
  sourceIds?: string[];
  categoryIds?: string[];
  /** Explicit admin request: bypass the RSS-owned skip for requested targets. */
  bypassRssOwned?: boolean;
}): Promise<{ targets: ArticleDiscoveryTarget[]; diagnostics: TargetResolutionDiagnostics }> {
  const activeTargets = await resolveActivePipelineTargets();
  const targetKeys = new Set(activeTargets.map((target) => `${target.sourceId}|${target.categoryId || ""}`));

  const requestedSourceIds = input?.sourceIds && input.sourceIds.length > 0 ? new Set(input.sourceIds) : null;
  const requestedCategoryIds = input?.categoryIds && input.categoryIds.length > 0 ? new Set(input.categoryIds) : null;

  const sourceIds = [...new Set(activeTargets.map((target) => target.sourceId))];
  const categoryIds = [...new Set(activeTargets.map((target) => target.categoryId).filter((value): value is string => Boolean(value)))];

  const [sources, categories] = await Promise.all([
    sourceIds.length
      ? prisma.newsSource.findMany({
          where: { id: { in: sourceIds } },
          select: {
            id: true,
            frontPageUrl: true,
            mediaName: true,
            rssStatus: true,
            rssFeedUrl: true,
            feedProvenance: true,
            currentFeedProductive: true,
            consecutiveNonProductiveRuns: true,
            lastProductiveAt: true,
            nextRetryAt: true,
            discoveryEvidence: true,
          },
        })
      : Promise.resolve([]),
    categoryIds.length
      ? prisma.sourceCategory.findMany({
          where: { id: { in: categoryIds } },
          select: {
            id: true,
            newsSourceId: true,
            pathUrl: true,
            rssStatus: true,
            rssFeedUrl: true,
            feedProvenance: true,
            currentFeedProductive: true,
            consecutiveNonProductiveRuns: true,
            lastProductiveAt: true,
            nextRetryAt: true,
            discoveryEvidence: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  const targets: ArticleDiscoveryTarget[] = [];
  const skippedReasons = EMPTY_SKIP_REASONS();
  const escalationReasons: Record<string, number> = {};
  const skippedSamples: Array<{
    sourceId: string;
    categoryId: string | null;
    targetType: string;
    targetUrl: string;
    rssStatus: string;
    currentFeedProductive: boolean;
    consecutiveNonProductiveRuns: number;
    lastProductiveAt?: Date | null;
    nextRetryAt?: Date | null;
    skipReason: TargetSkipReason;
  }> = [];
  const MAX_SKIP_SAMPLES = 5;

  // Collect all category-level targets (eligible + skipped) for audit diagnostics.
  // This makes it possible to trace a specific category through A2 resolution.
  const categoryAuditEntries: Array<{
    sourceId: string;
    categoryId: string;
    targetUrl: string;
    rssStatus: string;
    currentFeedProductive: boolean;
    consecutiveNonProductiveRuns: number;
    eligible: boolean;
    skipReason: string | null;
  }> = [];
  const MAX_CATEGORY_AUDIT = 20;

  for (const target of activeTargets) {
    const key = `${target.sourceId}|${target.categoryId || ""}`;
    if (!targetKeys.has(key)) continue;
    if (requestedSourceIds && !requestedSourceIds.has(target.sourceId)) {
      skippedReasons.requested_filter_excluded += 1;
      continue;
    }
    if (requestedCategoryIds && target.categoryId && !requestedCategoryIds.has(target.categoryId)) {
      skippedReasons.requested_filter_excluded += 1;
      continue;
    }
    if (requestedCategoryIds && !target.categoryId && requestedCategoryIds.size > 0) {
      skippedReasons.requested_filter_excluded += 1;
      continue;
    }

    if (target.categoryId) {
      const category = categoryById.get(target.categoryId);
      const source = sourceById.get(target.sourceId);
      if (!category || !source) {
        skippedReasons.not_found_in_db += 1;
        if (categoryAuditEntries.length < MAX_CATEGORY_AUDIT) {
          categoryAuditEntries.push({
            sourceId: target.sourceId,
            categoryId: target.categoryId,
            targetUrl: "",
            rssStatus: "NOT_FOUND_IN_DB",
            currentFeedProductive: false,
            consecutiveNonProductiveRuns: 0,
            eligible: false,
            skipReason: "not_found_in_db",
          });
        }
        continue;
      }
      const categoryEvaluation = evaluateRssOwnedTargetForAgent2({
        rssStatus: category.rssStatus,
        rssFeedUrl: category.rssFeedUrl,
        feedProvenance: category.feedProvenance,
        currentFeedProductive: category.currentFeedProductive,
        lastProductiveAt: category.lastProductiveAt,
        consecutiveNonProductiveRuns: category.consecutiveNonProductiveRuns,
        nextRetryAt: category.nextRetryAt,
        scopeMatches: readScopeMatch(category.discoveryEvidence),
      });
      if (categoryEvaluation.rssOwned && categoryEvaluation.eligibleForAgent2) {
        escalationReasons[categoryEvaluation.reason] = (escalationReasons[categoryEvaluation.reason] || 0) + 1;
      }
      const categorySkipReason = isAgent2EligibleTarget({
        ...category,
        scopeMatches: readScopeMatch(category.discoveryEvidence),
        bypassRssOwned: input?.bypassRssOwned,
      })
        ? null /* eligible */
        : classifySkipReason({
            ...category,
            scopeMatches: readScopeMatch(category.discoveryEvidence),
            bypassRssOwned: input?.bypassRssOwned,
          });
      if (categoryAuditEntries.length < MAX_CATEGORY_AUDIT) {
        categoryAuditEntries.push({
          sourceId: target.sourceId,
          categoryId: target.categoryId,
          targetUrl: category.pathUrl,
          rssStatus: category.rssStatus,
          currentFeedProductive: category.currentFeedProductive,
          consecutiveNonProductiveRuns: category.consecutiveNonProductiveRuns,
          eligible: categorySkipReason === null,
          skipReason: categorySkipReason,
        });
      }
      if (categorySkipReason) {
        skippedReasons[categorySkipReason] += 1;
        if (skippedSamples.length < MAX_SKIP_SAMPLES) {
          skippedSamples.push({
            sourceId: target.sourceId,
            categoryId: target.categoryId,
            targetType: "category",
            targetUrl: category.pathUrl,
            rssStatus: category.rssStatus,
            currentFeedProductive: category.currentFeedProductive,
            lastProductiveAt: category.lastProductiveAt,
            consecutiveNonProductiveRuns: category.consecutiveNonProductiveRuns,
            nextRetryAt: category.nextRetryAt,
            skipReason: categorySkipReason,
          });
        }
        continue;
      }
      targets.push({
        targetType: "category",
        sourceId: target.sourceId,
        categoryId: target.categoryId,
        targetUrl: category.pathUrl,
        rssStatus: category.rssStatus,
        currentFeedProductive: category.currentFeedProductive,
        consecutiveNonProductiveRuns: category.consecutiveNonProductiveRuns,
        lastProductiveAt: category.lastProductiveAt,
        nextRetryAt: category.nextRetryAt,
        scopeMatches: readScopeMatch(category.discoveryEvidence),
        mediaName: source.mediaName,
      });
    } else {
      const source = sourceById.get(target.sourceId);
      if (!source) {
        skippedReasons.not_found_in_db += 1;
        continue;
      }
      const sourceEvaluation = evaluateRssOwnedTargetForAgent2({
        rssStatus: source.rssStatus,
        rssFeedUrl: source.rssFeedUrl,
        feedProvenance: source.feedProvenance,
        currentFeedProductive: source.currentFeedProductive,
        lastProductiveAt: source.lastProductiveAt,
        consecutiveNonProductiveRuns: source.consecutiveNonProductiveRuns,
        nextRetryAt: source.nextRetryAt,
        scopeMatches: readScopeMatch(source.discoveryEvidence),
      });
      if (sourceEvaluation.rssOwned && sourceEvaluation.eligibleForAgent2) {
        escalationReasons[sourceEvaluation.reason] = (escalationReasons[sourceEvaluation.reason] || 0) + 1;
      }
      const sourceScopeMatches = readScopeMatch(source.discoveryEvidence);
      if (!isAgent2EligibleTarget({
        ...source,
        scopeMatches: sourceScopeMatches,
        bypassRssOwned: input?.bypassRssOwned,
      })) {
        const reason = classifySkipReason({
          ...source,
          scopeMatches: sourceScopeMatches,
          bypassRssOwned: input?.bypassRssOwned,
        });
        skippedReasons[reason] += 1;
        if (skippedSamples.length < MAX_SKIP_SAMPLES) {
          skippedSamples.push({
            sourceId: target.sourceId,
            categoryId: null,
            targetType: "source",
            targetUrl: source.frontPageUrl,
            rssStatus: source.rssStatus,
            currentFeedProductive: source.currentFeedProductive,
            lastProductiveAt: source.lastProductiveAt,
            consecutiveNonProductiveRuns: source.consecutiveNonProductiveRuns,
            nextRetryAt: source.nextRetryAt,
            skipReason: reason,
          });
        }
        continue;
      }
      targets.push({
        targetType: "source",
        sourceId: target.sourceId,
        targetUrl: source.frontPageUrl,
        rssStatus: source.rssStatus,
        currentFeedProductive: source.currentFeedProductive,
        consecutiveNonProductiveRuns: source.consecutiveNonProductiveRuns,
        lastProductiveAt: source.lastProductiveAt,
        nextRetryAt: source.nextRetryAt,
        scopeMatches: readScopeMatch(source.discoveryEvidence),
        mediaName: source.mediaName,
      });
    }
  }

  const skipped = Object.values(skippedReasons).reduce((a, b) => a + b, 0);
  const categoryTotal = categoryAuditEntries.length;
  const categoryEligible = categoryAuditEntries.filter((e) => e.eligible).length;
  const categorySkipped = categoryTotal - categoryEligible;

  await logAgentScan({
    status: "ARTICLE_DISCOVERY_TARGETS_RESOLVED",
    executionTimeMs: 0,
    errorLog: `targets=${targets.length}, skipped=${skipped}, total=${activeTargets.length}. ` +
      `categories={total=${categoryTotal}, eligible=${categoryEligible}, skipped=${categorySkipped}}. ` +
      `reasons=${JSON.stringify(skippedReasons)}, escalations=${JSON.stringify(escalationReasons)}`,
  });

  // Capped per-target skip diagnostics for debugging specific missing targets.
  // Avoids spamming logs — only emits when there are skipped targets.
  if (skippedSamples.length > 0) {
    await logAgentScan({
      status: "ARTICLE_DISCOVERY_TARGET_SKIPPED",
      executionTimeMs: 0,
      errorLog: `sample=${JSON.stringify(skippedSamples)}`,
    });
  }

  // Full category targets audit — shows every category-level target A2 evaluated,
  // including both eligible and skipped. This makes it possible to trace a specific
  // category (e.g. Times of India /world/europe) through the A2 resolution step.
  if (categoryAuditEntries.length > 0) {
    const catEligible = categoryAuditEntries.filter((e) => e.eligible).length;
    const catSkipped = categoryAuditEntries.filter((e) => !e.eligible).length;
    await logAgentScan({
      status: "ARTICLE_DISCOVERY_CATEGORY_TARGETS_AUDIT",
      executionTimeMs: 0,
      errorLog: `categoryTargets=${categoryAuditEntries.length}, eligible=${catEligible}, skipped=${catSkipped}. entries=${JSON.stringify(categoryAuditEntries)}`,
    });
  }

  return {
    targets,
    diagnostics: {
      totalActive: activeTargets.length,
      eligible: targets.length,
      skipped,
      skippedReasons,
    },
  };
}

const serializeDiscoveryCandidate = (candidate: IngestCandidate) => ({
  sourceId: candidate.sourceId,
  categoryId: candidate.categoryId || null,
  sourceUrl: candidate.sourceUrl,
  canonicalUrl: candidate.canonicalUrl,
  rssGuid: candidate.rssGuid || null,
  rawTitle: candidate.rawTitle || null,
  title: candidate.title,
  publishedAt: candidate.publishedAt ? candidate.publishedAt.toISOString() : null,
  rawBodyText: candidate.rawBodyText || null,
  bodyText: candidate.bodyText || null,
  contentHash: candidate.contentHash,
  isPaywall: candidate.isPaywall,
  ...(candidate.accessEvidence ? { accessEvidence: candidate.accessEvidence } : {}),
  rawTags: candidate.rawTags,
  rawSignals: candidate.rawSignals,
  reasoning: candidate.reasoning,
  provenance: {
    origin: candidate.provenance.origin,
    feedUrl: candidate.provenance.feedUrl || null,
    feedFormat: candidate.provenance.feedFormat || null,
    discoveredFromCategoryFeed: candidate.provenance.discoveredFromCategoryFeed || false,
    sourcePageUrl: candidate.provenance.sourcePageUrl || null,
    fetchedAt: candidate.provenance.fetchedAt,
  },
  normalizationFlags: candidate.normalizationFlags || [],
});

const serializeSkipSummary = (skipSummary: IngestSkipSummary) => ({
  emptyLink: skipSummary.emptyLink,
  outOfScope: skipSummary.outOfScope,
  staleOrMissingPublishedAt: skipSummary.staleOrMissingPublishedAt,
  alreadySeenFeedItem: skipSummary.alreadySeenFeedItem,
  htmlFallbackNonArticle: skipSummary.htmlFallbackNonArticle,
  htmlFallbackStale: skipSummary.htmlFallbackStale,
  // ── Granular stale rejection breakdown ─────────────────────────────
  ...(skipSummary.staleOutsideRetentionWindow ? { staleOutsideRetentionWindow: skipSummary.staleOutsideRetentionWindow } : {}),
  ...(skipSummary.staleMissingPublishedAt ? { staleMissingPublishedAt: skipSummary.staleMissingPublishedAt } : {}),
  ...(skipSummary.staleInvalidPublishedAt ? { staleInvalidPublishedAt: skipSummary.staleInvalidPublishedAt } : {}),
});

const serializeRejectedItem = (item: IngestRejectedItem) => ({
  reason: item.reason,
  rawLink: item.rawLink || null,
  canonicalUrl: item.canonicalUrl || null,
  title: item.title || null,
  publishedAt: item.publishedAt || null,
});

export async function persistArticleDiscoveryArtifact(input: {
  pipelineRunId: string;
  result: ArticleDiscoveryResult;
}) {
  const payload = {
    schemaVersion: 2,
    targetType: input.result.targetType,
    sourceId: input.result.sourceId,
    categoryId: input.result.categoryId || null,
    targetUrl: input.result.targetUrl,
    discoveryMethod: input.result.discoveryMethod,
    discoverySources: input.result.discoverySources,
    listingDiagnostics: input.result.listingDiagnostics,
    pagesVisited: input.result.pagesVisited,
    candidateCount: input.result.candidates.length,
    failed: input.result.failed,
    skipSummary: serializeSkipSummary(input.result.skipSummary),
    rejectedItems: input.result.rejectedItems.map(serializeRejectedItem),
    candidates: input.result.candidates.map(serializeDiscoveryCandidate),
    // Outcome audit data
    outcomeSummary: input.result.outcomeSummary,
    acceptedCandidates: input.result.acceptedOutcomes,
    rejectedCandidates: input.result.rejectedOutcomes,
    topRejectionReasons: input.result.outcomeSummary.topRejectionReasons,
    // Quality assessment
    qualityAssessment: input.result.qualityAssessment,
    // Discovery profile audit metadata (if an active profile was applied)
    ...(input.result.appliedProfileAudit ? { appliedProfileAudit: input.result.appliedProfileAudit } : {}),
    // Verified host-transition evidence (redirect/final-URL/document-canonical)
    canonicalHostEvidence: input.result.canonicalHostEvidence,
    retryable: input.result.retryable,
    discoveryComplete: input.result.discoveryComplete,
    detailEvaluationStoppedReason: input.result.detailEvaluationStoppedReason,
    rateLimitEvidence: input.result.rateLimitEvidence,
    requestBudget: input.result.requestBudget,
  };

  return prisma.pipelineArtifact.create({
    data: {
      pipelineRunId: input.pipelineRunId,
      sourceId: input.result.sourceId,
      categoryId: input.result.categoryId || null,
      artifactType: "article_discovery_candidates",
      status: input.result.retryable
        ? input.result.detailEvaluationStoppedReason === "rate_limited"
          ? "DEFERRED_RATE_LIMIT"
          : "DEFERRED_STATIC_DISCOVERY"
        : input.result.failed > 0 && input.result.candidates.length === 0
          ? "FAILED"
          : "CAPTURED",
      candidateCount: input.result.candidates.length,
      // The payload is assembled from bounded serializer outputs and plain
      // diagnostic primitives. Prisma cannot infer the nested candidate
      // records as InputJsonValue because their source interfaces have index
      // signatures only at runtime; keep the cast at this JSON boundary.
      payload: payload as unknown as Prisma.InputJsonValue,
      errorLog:
        input.result.retryable
          ? `Static discovery deferred for ${input.result.targetUrl}; retryable=${input.result.retryable}, stopReason=${input.result.detailEvaluationStoppedReason ?? "unknown"}.`
          : input.result.failed > 0 && input.result.candidates.length === 0
            ? `No article candidates discovered for ${input.result.targetUrl}.`
            : null,
    },
  });
}

export async function discoverArticlesFromTarget(
  target: ArticleDiscoveryTarget,
  telemetry?: DiscoveryNetworkTelemetry,
  options?: {
    maxAcceptedCandidates?: number;
    maxEvaluatedCandidates?: number;
    maxRequests?: number;
  },
): Promise<ArticleDiscoveryResult> {
  const skipSummary = emptySkipSummary();
  const rejectedItems: IngestRejectedItem[] = [];
  const pagesVisited: string[] = [];
  const candidates: IngestCandidate[] = [];
  const seenCanonicalUrls = new Set<string>();
  const startedAt = Date.now();
  const discoverySources = { listingPages: 0, sitemapUrls: 0, jsonldUrls: 0 };
  const maxAcceptedCandidates = Math.max(1, Math.floor(options?.maxAcceptedCandidates ?? MAX_ACCEPTED_CANDIDATES));
  const maxEvaluatedCandidates = Math.max(1, Math.floor(options?.maxEvaluatedCandidates ?? MAX_EVALUATED_CANDIDATES));
  const requestBudget = createStaticDiscoveryRequestBudget(options?.maxRequests ?? MAX_STATIC_REQUESTS);
  const tracker = new ArticleDiscoveryOutcomeTracker();

  // ── Lookup active discovery profile (if any) ──────────────────────────
  let activeProfile: Agent2DiscoveryProfile | null = null;
  try {
    activeProfile = await lookupActiveDiscoveryProfile({
      sourceId: target.sourceId,
      categoryId: target.categoryId ?? null,
      targetUrl: target.targetUrl,
    });
  } catch {
    // Non-fatal — continue without profile
  }

  const relaxCategoryScope = activeProfile?.rules.relaxCategoryScope === true;
  const allowWeakDates = activeProfile?.rules.allowWeakDateFromListingContext === true;
  const deniedPathPrefixes = activeProfile?.rules.deniedPathPrefixes ?? null;
  const preferListingAnchors = activeProfile?.rules.preferListingAnchors === true;
  // preferListingAnchors: documented but not yet wired — requires a scoring
  // boost for listing-anchor links vs sitemap/jsonld links, which would need
  // changes to the link merge/sort logic in Phase 2. Deferred to avoid a
  // broad refactor of the candidate collection pipeline.
  // When relaxCategoryScope is active, pass null to disable category-path filtering
  const effectiveCategoryPathUrl = relaxCategoryScope ? null : (target.categoryId ? target.targetUrl : null);

  // Compact discovery profile metadata for artifact/log audit
  const profileAudit = activeProfile ? {
    appliedDiscoveryProfileId: activeProfile.evidence.fromProfileArtifactId ?? null,
    appliedDiscoveryProfileAction: activeProfile.evidence.reasonCodes[0] ?? null,
    appliedDiscoveryProfileVersion: activeProfile.schemaVersion,
    appliedDiscoveryProfileRules: Object.keys(activeProfile.rules),
    appliedDiscoveryProfileSource: "agent2_discovery_profile",
    appliedDiscoveryProfileAt: new Date().toISOString(),
  } : null;

  await logAgentScan({
    sourceId: target.sourceId,
    categoryId: target.categoryId || undefined,
    status: "ARTICLE_DISCOVERY_STARTED",
    executionTimeMs: 0,
    errorLog: `Scanning ${target.targetUrl} as Agent 2 ${target.targetType} target.` +
      (activeProfile ? ` activeProfile=${activeProfile.status}, profileId=${activeProfile.evidence.fromProfileArtifactId ?? "n/a"}, relaxScope=${relaxCategoryScope}, weakDates=${allowWeakDates}, deniedPrefixes=${deniedPathPrefixes?.length ?? 0}.` : ""),
  });

  // ── Phase 1: Listing-first static source collection ────────────────────
  // A listing is sufficient when it exposes enough viable links to fill the
  // detail evaluation cap. This is deliberately based on pre-evaluation link
  // evidence, never on accepted candidates that have not been evaluated yet.
  let listingGovernorDeferred = false;
  const listing = await crawlListingPages(
    target.targetUrl,
    effectiveCategoryPathUrl,
    deniedPathPrefixes,
    telemetry,
    requestBudget,
    {
      sourceId: target.sourceId,
      categoryId: target.categoryId ?? null,
    },
  ).catch((error: any) => {
    if (error instanceof GovernedFetchDeferredError) {
      listingGovernorDeferred = true;        return { visitedPages: [], articleLinks: [], firstPageHtml: null, diagnostics: [], governorDeferred: true };
    }
    throw new Error(`Article discovery fetch failed: ${error?.message || String(error)}`);
  });
  // A page is sufficient when it exposes the largest viable static batch the
  // listing extractor can provide (20 links/page), or the caller's smaller
  // evaluation cap. This avoids sitemap traffic merely because the default
  // evaluation cap (30) exceeds the per-page listing-link cap (20).
  const listingSufficiencyThreshold = Math.min(maxEvaluatedCandidates, MAX_LINKS_PER_PAGE);
  listingGovernorDeferred ||= listing.governorDeferred === true;
  const listingIsSufficient = listing.articleLinks.length >= listingSufficiencyThreshold;
  const listingRateLimited = requestBudget.rateLimitEvidence.some((e) => e.phase === "listing");
  const listingBudgetSnapshot = requestBudget.snapshot();
  // A listing-level 429 is already a confirmed host cooldown. Do not amplify
  // it with robots/sitemap probes. If the listing was sparse and no request
  // slot remains, record the known skipped fallback explicitly rather than
  // pretending the target completed normally.
  const listingBudgetAvailable = listingBudgetSnapshot.remaining > 0;
  const shouldProbeSitemap = !listingGovernorDeferred && !listingIsSufficient && !listingRateLimited && listingBudgetAvailable;
  if (!listingIsSufficient && !listingRateLimited && !listingBudgetAvailable) {
    requestBudget.recordWorkSkipped("sitemap", `${new URL(target.targetUrl).origin}/sitemap.xml`, "sparse listing requires sitemap fallback");
  }
  const sitemapEntries = shouldProbeSitemap
    ? await discoverSitemapUrls(
        target.targetUrl,
        telemetry,
        requestBudget,
        {
          sourceId: target.sourceId,
          categoryId: target.categoryId ?? null,
          mode: undefined,
        },
      ).catch((error) => {
        if (error instanceof GovernedFetchDeferredError) {
          listingGovernorDeferred = true;
        }
        return [];
      })
    : [];
  const initialBudgetSnapshot = requestBudget.snapshot();
  // Final-slot consumption is an exact boundary, not exhaustion evidence. A
  // pre-detail budget stop exists only when known work was refused/skipped.
  const initialBudgetExhausted = initialBudgetSnapshot.exhausted && initialBudgetSnapshot.skippedWork.length > 0;
  const initialRateLimitEvidence = requestBudget.rateLimitEvidence.length > 0;

  const targetPageJsonLd = listing.firstPageHtml
    ? extractJsonLdArticles(listing.firstPageHtml, target.targetUrl)
    : [];

  pagesVisited.push(...listing.visitedPages);
  discoverySources.listingPages = listing.visitedPages.length;

  // ── Verified host transition evidence ──────────────────────────────────
  // Build a bounded evidence set from the listing pages' final URLs. When a
  // configured root host redirects to a publisher-controlled subdomain, the
  // final URL directly establishes the effective host for candidate links.
  const observedFinalUrls = listing.diagnostics
    .map((diag) => diag.finalUrl)
    .filter((url): url is string => Boolean(url));
  const verifiedHostScope = buildVerifiedHostScope({
    configuredTargetUrl: target.targetUrl,
    // Preserve full URL evidence. The scope itself decides which transitions
    // are trusted and records rejected public hosts for diagnostics.
    observedFinalUrls,
    finalUrl: observedFinalUrls[observedFinalUrls.length - 1] ?? target.targetUrl,
  });
  const canonicalHostEvidence = serializeHostScope(verifiedHostScope);

  // ── Phase 2: Merge all article link sources ────────────────────────────
  const allArticleLinks = new Map<string, ListingArticleLink>();

  for (const link of listing.articleLinks) {
    allArticleLinks.set(link.url, link);
  }

  const filteredSitemap = filterSitemapArticleUrls(
    sitemapEntries,
    target.targetUrl,
    effectiveCategoryPathUrl,
    verifiedHostScope,
  )
    .map((entry) => ({
      entry,
      score: scoreCandidateUrl(entry.url, target.targetUrl, {
        categoryPathUrl: target.categoryId ? target.targetUrl : null,
        verifiedHostScope,
      }).score,
    }))
    .sort((a, b) => b.score - a.score || a.entry.url.length - b.entry.url.length)
    .map(({ entry }) => entry);
  for (const entry of filteredSitemap) {
    if (!allArticleLinks.has(entry.url)) {
      allArticleLinks.set(entry.url, { url: entry.url, sourcePageUrl: `sitemap:${target.targetUrl}` });
      discoverySources.sitemapUrls += 1;
    }
  }

  for (const article of targetPageJsonLd) {
    if (!allArticleLinks.has(article.url)) {
      allArticleLinks.set(article.url, { url: article.url, sourcePageUrl: `jsonld:${target.targetUrl}` });
      discoverySources.jsonldUrls += 1;
    }
  }

  // ── Phase 3: Extract candidates from merged links with outcome tracking ─
  let detailEvaluationStoppedReason: ArticleDiscoveryResult["detailEvaluationStoppedReason"] = listingGovernorDeferred
    ? "governor_deferred"
    : initialRateLimitEvidence
      ? "rate_limited"
      : initialBudgetExhausted
        ? "request_budget_exhausted"
        : null;
  let evaluatedCandidateCount = 0;
  let discoveryComplete = detailEvaluationStoppedReason === null;
  for (const articleLink of allArticleLinks.values()) {
    // Listing/sitemap/robots rate limits and pre-detail budget exhaustion are
    // terminal for this static attempt. Do not turn them into synthetic detail
    // evaluations or issue any later article requests.
    if (detailEvaluationStoppedReason === "rate_limited" || detailEvaluationStoppedReason === "request_budget_exhausted") {
      discoveryComplete = false;
      break;
    }
    if (requestBudget.snapshot().exhausted || requestBudget.snapshot().remaining <= 0) {
      requestBudget.recordWorkSkipped("article_detail", articleLink.url, "article detail remained after request budget was exhausted");
      detailEvaluationStoppedReason = "request_budget_exhausted";
      discoveryComplete = false;
      break;
    }
    if (candidates.length >= maxAcceptedCandidates) {
      detailEvaluationStoppedReason = "accepted_cap";
      break;
    }
    if (evaluatedCandidateCount >= maxEvaluatedCandidates) {
      // Evaluation cap is intentional bounded completion. There is no cursor,
      // so retrying the same first N URLs would not make forward progress.
      detailEvaluationStoppedReason = "evaluation_cap";
      discoveryComplete = true;
      break;
    }
    evaluatedCandidateCount += 1;
    try {
      const result = await discoverArticleCandidatesForPage(
        articleLink,
        target,
        skipSummary,
        rejectedItems,
        {
          // Note: allowWeakDates no longer overrides freshnessMs. The shared
          // 7-day retention window is enforced for all candidates. allowWeakPublishedAt
          // (the browser-only flag) still handles missing-date acceptance independently.
          ...(deniedPathPrefixes && deniedPathPrefixes.length > 0 ? { deniedPathPrefixes } : {}),
          telemetry,
          requestBudget,
          governedFetchContext: {
            sourceId: target.sourceId,
            categoryId: target.categoryId ?? null,
          },
          verifiedHostScope,
        },
      );

      // Every call above is one detail evaluation attempt, regardless of its
      // eventual accepted/rejected/failed/stale/duplicate outcome.
      if (!result.candidate) {
        tracker.record(result.outcome);
        if (result.outcome.rateLimited) {
          detailEvaluationStoppedReason = "rate_limited";
          discoveryComplete = false;
          telemetry?.recordRateLimited?.(429);
          break;
        }
        if (result.outcome.governorDeferred) {
          detailEvaluationStoppedReason = "governor_deferred";
          discoveryComplete = false;
          break;
        }
        if (result.outcome.requestBudgetExhausted) {
          detailEvaluationStoppedReason = "request_budget_exhausted";
          discoveryComplete = false;
          break;
        }
        continue;
      }

      // Duplicate check BEFORE recording accepted — prevents the same URL
      // from appearing as both accepted and rejected in the outcome summary.
      if (seenCanonicalUrls.has(result.candidate.canonicalUrl)) {
        skipSummary.alreadySeenFeedItem += 1;
        tracker.record(makeOutcome(result.candidate.canonicalUrl, articleLink.sourcePageUrl, "rejected_duplicate", {
          canonicalUrl: result.candidate.canonicalUrl,
          title: result.candidate.title,
          reason: "duplicate canonical URL" }));
        continue;
      }

      // Not a duplicate — record accepted and persist.
      seenCanonicalUrls.add(result.candidate.canonicalUrl);
      candidates.push(result.candidate);
      tracker.record(result.outcome);
      if (result.outcome.rateLimited) {
        detailEvaluationStoppedReason = "rate_limited";
        discoveryComplete = false;
        telemetry?.recordRateLimited?.(429);
        break;
      }
    } catch (error: any) {
      if (error instanceof GovernedFetchDeferredError) {
        detailEvaluationStoppedReason = "governor_deferred";
        discoveryComplete = false;
        break;
      }
      skipSummary.htmlFallbackNonArticle += 1;
      pushRejectedItem(rejectedItems, {
        reason: "html_fallback_non_article",
        rawLink: articleLink.url,
        canonicalUrl: null,
        title: null,
        publishedAt: null,
      });
      tracker.record(makeOutcome(articleLink.url, articleLink.sourcePageUrl, "detail_validation_failed", { reason: error?.message || "unknown error" }));
    }
  }

  const summary = tracker.getSummary();
  const topReason = summary.topRejectionReasons[0]?.reason || "none";

  // ── Quality assessment ─────────────────────────────────────────────────
  // Consuming the final allowed request is not itself an incomplete outcome:
  // the exact-boundary run is complete when no known work was skipped. The
  // budget marks incompleteness only when consume() refused known work or the
  // caller explicitly recorded skipped work.
  const finalBudgetSnapshot = requestBudget.snapshot();
  if (finalBudgetSnapshot.exhausted && finalBudgetSnapshot.skippedWork.length > 0 && !detailEvaluationStoppedReason) {
    detailEvaluationStoppedReason = "request_budget_exhausted";
    discoveryComplete = false;
  }
  const rateLimitEvidence = [...requestBudget.rateLimitEvidence];
  const retryable = rateLimitEvidence.length > 0 || detailEvaluationStoppedReason === "request_budget_exhausted" || detailEvaluationStoppedReason === "governor_deferred" || !discoveryComplete;
  const qualityAssessment = assessArticleDiscoveryQuality({
    acceptedCount: candidates.length,
    totalEvaluated: summary.totalEvaluated,
    pagesVisited: pagesVisited.length,
    failed: candidates.length > 0 || retryable ? 0 : 1,
    byStatus: summary.byStatus,
  });

  // ── Stale sample for log ──────────────────────────────────────────────
  // Append whenever any rejected_stale outcomes exist, regardless of the
  // top rejection reason (which may be "invalid publishedAt", "missing
  // publishedAt", etc.).
  const staleSampleSuffix = buildStaleSampleLog(tracker.getRejected());
  const listingDiagnosticSuffix = formatListingDiagnosticsForLog(listing.diagnostics);

  await logAgentScan({
    sourceId: target.sourceId,
    categoryId: target.categoryId || undefined,
    status: candidates.length > 0 && !retryable ? "ARTICLE_DISCOVERY_COMPLETED" : "ARTICLE_DISCOVERY_FAILED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Discovered ${candidates.length} accepted, ${summary.rejected} rejected from ${summary.totalEvaluated} evaluated. ` +
      `complete=${discoveryComplete}, retryable=${retryable}, stopReason=${detailEvaluationStoppedReason ?? "none"}, ` +
      `Sources: listing=${discoverySources.listingPages}, sitemap=${discoverySources.sitemapUrls}, jsonld=${discoverySources.jsonldUrls}. ` +
      `Top rejection: ${topReason}. ` +
      `Quality: ${qualityAssessment.quality} (confidence=${qualityAssessment.confidence}, escalate=${qualityAssessment.shouldEscalateToHeadless}). ` +
      `Skipped: alreadySeen=${skipSummary.alreadySeenFeedItem}, stale=${skipSummary.staleOrMissingPublishedAt}, nonArticle=${skipSummary.htmlFallbackNonArticle}.` +
      staleSampleSuffix +
      listingDiagnosticSuffix,
  });

  return {
    targetType: target.targetType,
    sourceId: target.sourceId,
    categoryId: target.categoryId || null,
    targetUrl: target.targetUrl,
    discoveryMethod: "jsdom",
    discoverySources,
    listingDiagnostics: listing.diagnostics,
    pagesVisited,
    candidates,
    // A rate-limited/incomplete static attempt is retryable, not a hard
    // discovery failure, even when it produced zero candidates.
    failed: candidates.length > 0 || retryable ? 0 : 1,
    skipSummary,
    rejectedItems,
    outcomeSummary: summary,
    acceptedOutcomes: tracker.getAccepted(),
    rejectedOutcomes: tracker.getRejected(),
    qualityAssessment,
    appliedProfileAudit: profileAudit,
    canonicalHostEvidence,
    retryable,
    discoveryComplete,
    detailEvaluationStoppedReason,
    rateLimitEvidence,
    requestBudget: requestBudget.snapshot(),
  };
}

/**
 * Check whether a marker targetUrl is same-origin and path-compatible with
 * the productive source targetUrl. Used for source-level subpath matching:
 * e.g. productive https://www.nba.com can resolve https://www.nba.com/news.
 */
function isSameOriginSubpath(rootUrl: string, candidateUrl: string): boolean {
  try {
    const root = new URL(rootUrl);
    const candidate = new URL(candidateUrl);
    if (root.origin !== candidate.origin) return false;
    const rootPath = root.pathname.replace(/\/+$/, "") || "/";
    const candidatePath = candidate.pathname.replace(/\/+$/, "") || "/";
    // Exact match
    if (candidatePath === rootPath) return true;
    // Root is "/" — any non-root path is a subpath
    if (rootPath === "/") return candidatePath !== "/";
    // Candidate is nested under root path
    return candidatePath.startsWith(`${rootPath}/`);
  } catch {
    return false;
  }
}

/**
 * When Agent 2 finishes a target with "productive" quality, resolve any older
 * PENDING_HEADLESS markers for the same target so they stop cluttering the
 * active headless queue. Non-fatal — a failure here never blocks the batch.
 *
 * Matching rules:
 * - Category-level: strict match on sourceId + categoryId + targetUrl.
 * - Source-level (categoryId null): also resolves same-source subpath markers
 *   where the marker's targetUrl is same-origin and under the productive root.
 */
async function resolveStaleHeadlessMarkers(input: {
  result: ArticleDiscoveryResult;
  artifactId?: string;
  pipelineRunId?: string;
}) {
  const { result, artifactId, pipelineRunId } = input;

  // Only resolve for productive runs.
  if (result.qualityAssessment.quality !== "productive") return;

  try {
    // Build the WHERE clause to find matching PENDING_HEADLESS markers.
    const where: Record<string, unknown> = {
      artifactType: "article_discovery_headless_required",
      status: "PENDING_HEADLESS",
      sourceId: result.sourceId,
    };

    // When categoryId exists, match it strictly; otherwise look at all
    // source-level markers (categoryId = null) for potential subpath match.
    if (result.categoryId) {
      where.categoryId = result.categoryId;
    } else {
      where.categoryId = null;
    }

    const markers = await prisma.pipelineArtifact.findMany({
      where,
      select: { id: true, payload: true },
      orderBy: { createdAt: "desc" },
    });

    // Classify each marker as exact or source_subpath match.
    const classified: Array<{ marker: typeof markers[number]; matchMode: "exact" | "source_subpath" }> = [];
    for (const marker of markers) {
      const payload = marker.payload as Record<string, unknown> | null;
      if (!payload || typeof payload !== "object") continue;
      const markerTargetUrl = typeof payload.targetUrl === "string" ? payload.targetUrl : null;

      if (!markerTargetUrl) {
        // No targetUrl in payload → skip (cannot verify origin/path compatibility)
        continue;
      }

      // Exact match
      if (markerTargetUrl === result.targetUrl) {
        classified.push({ marker, matchMode: "exact" });
        continue;
      }

      // Source-level subpath: marker targetUrl is under productive root
      if (!result.categoryId && isSameOriginSubpath(result.targetUrl, markerTargetUrl)) {
        classified.push({ marker, matchMode: "source_subpath" });
      }
      // Category-level: no subpath match — strict categoryId already filtered.
    }

    await resolveHardSourceProfilesForTarget({
      sourceId: result.sourceId,
      categoryId: result.categoryId || null,
      targetUrl: result.targetUrl,
      resolvedBy: "agent2_static",
      resolvedReason: "Agent 2 static discovery became productive",
      resolvedPipelineRunId: pipelineRunId,
    });

    if (classified.length === 0) return;

    const resolvedAt = new Date().toISOString();
    let resolvedCount = 0;
    for (const { marker, matchMode } of classified) {
      try {
        const existingPayload = (marker.payload as Record<string, unknown>) || {};
        await prisma.pipelineArtifact.update({
          where: { id: marker.id },
          data: {
            status: "RESOLVED_BY_STATIC_DISCOVERY",
            payload: {
              ...existingPayload,
              resolvedByStaticDiscoveryAt: resolvedAt,
              resolvedByStaticDiscoveryRunId: pipelineRunId || null,
              resolvedByStaticDiscoveryArtifactId: artifactId || null,
              resolvedByStaticDiscoveryQuality: "productive",
              resolvedByStaticDiscoveryAcceptedCount: result.candidates.length,
              resolvedByStaticDiscoveryEvaluatedCount: result.outcomeSummary.totalEvaluated,
              resolvedByStaticDiscoveryMatchMode: matchMode,
            },
          },
        });
        resolvedCount += 1;
      } catch {
        // Individual marker update failure is non-fatal.
      }
    }

    if (resolvedCount > 0) {
      const matchModes = [...new Set(classified.map((c) => c.matchMode))];
      await logAgentScan({
        sourceId: result.sourceId,
        categoryId: result.categoryId || undefined,
        status: "ARTICLE_DISCOVERY_HEADLESS_MARKERS_RESOLVED",
        executionTimeMs: 0,
        errorLog:
          `Resolved ${resolvedCount} PENDING_HEADLESS marker(s) for ${result.targetUrl}. ` +
          `matchMode=${matchModes.join("+")}, ` +
          `runId=${pipelineRunId || "n/a"}, ` +
          `accepted=${result.candidates.length}, evaluated=${result.outcomeSummary.totalEvaluated}.`,
      });
    }

  } catch (error: any) {
    await logAgentScan({
      sourceId: result.sourceId,
      categoryId: result.categoryId || undefined,
      status: "ARTICLE_DISCOVERY_HEADLESS_MARKERS_RESOLVE_FAILED",
      executionTimeMs: 0,
      errorLog: `Failed to resolve stale headless markers for ${result.targetUrl}: ${error?.message || String(error)}`,
    }).catch(() => {}); // Log failure itself is non-fatal.
  }
}

export type Agent2BatchStoppedReason =
  | "completed"
  | "max_targets"
  | "time_budget"
  | "no_targets";

export type Agent2BatchResult = {
  /** PipelineRun ID, or null when no targets exist. */
  pipelineRunId: string | null;
  targets: ArticleDiscoveryTarget[];
  result: PipelineResult;
  /** Why the batch stopped. */
  stoppedReason: Agent2BatchStoppedReason;
  /** Number of targets actually processed in this run. */
  processed: number;
  /** Authoritative count of processed targets with no discovery/persistence failure. */
  succeeded: number;
  /** Number of targets deferred due to budget/limit constraints. */
  deferred: number;
  /** Number of targets remaining in the active bounded batch cycle. */
  remainingEligible: number;
  /** Mutually exclusive selected-target disposition buckets. */
  targetDispositions: {
    succeeded: number;
    failedRetryable: number;
    failedPermanent: number;
    skipped: number;
    deferred: number;
    quarantined: number;
    claimLost: number;
    persistenceFailed: number;
  };
  selectedTargets: number;
  /** Candidate/link productivity, separate from target dispositions. */
  productivity: {
    rawLinks: number;
    evaluatedCandidates: number;
    acceptedCandidates: number;
    rejectedCandidates: number;
    insertedCandidates: number;
    skippedCandidates: number;
    candidatePersistenceFailures: number;
  };
};

const readPayloadRecord = (payload: Prisma.JsonValue | null): Record<string, unknown> | null =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;

async function getLatestDeferredTargetPriority(input?: {
  sourceIds?: string[];
  categoryIds?: string[];
}): Promise<string[]> {
  const latestRun = await prisma.pipelineRun.findFirst({
    where: {
      status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] },
      artifacts: {
        some: {
          artifactType: { in: ["article_discovery_candidates", "article_discovery_deferred"] },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (!latestRun) return [];

  const sourceFilter = input?.sourceIds && input.sourceIds.length > 0
    ? { in: input.sourceIds }
    : undefined;
  const categoryFilter = input?.categoryIds && input.categoryIds.length > 0
    ? { in: input.categoryIds }
    : undefined;

  const deferredArtifacts = await prisma.pipelineArtifact.findMany({
    where: {
      pipelineRunId: latestRun.id,
      artifactType: "article_discovery_deferred",
      status: { in: ["DEFERRED_MAX_TARGETS", "DEFERRED_TIME_BUDGET"] },
      ...(sourceFilter ? { sourceId: sourceFilter } : {}),
      ...(categoryFilter ? { categoryId: categoryFilter } : {}),
    },
    select: {
      sourceId: true,
      categoryId: true,
      payload: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  return deferredArtifacts
    .map((artifact) => {
      const payload = readPayloadRecord(artifact.payload);
      if (!payload) return null;
      const targetUrl = typeof payload.targetUrl === "string" ? payload.targetUrl : null;
      const position = typeof payload.position === "number" && Number.isFinite(payload.position)
        ? payload.position
        : Number.MAX_SAFE_INTEGER;
      return {
        key: agent2TargetKey({
          sourceId: artifact.sourceId,
          categoryId: artifact.categoryId,
          targetUrl,
        }),
        position,
      };
    })
    .filter((entry): entry is { key: string; position: number } => Boolean(entry))
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.key);
}

async function prioritizeDeferredTargets(
  targets: ArticleDiscoveryTarget[],
  input?: { sourceIds?: string[]; categoryIds?: string[] }
): Promise<ArticleDiscoveryTarget[]> {
  let deferredPriority: string[] = [];
  try {
    deferredPriority = await getLatestDeferredTargetPriority(input);
  } catch {
    return targets;
  }
  if (deferredPriority.length === 0) return targets;

  const priorityByKey = new Map(deferredPriority.map((key, index) => [key, index]));
  const deferredTargets = targets
    .filter((target) => priorityByKey.has(agent2TargetKey(target)))
    .sort((a, b) => {
      const aPriority = priorityByKey.get(agent2TargetKey(a)) ?? Number.MAX_SAFE_INTEGER;
      const bPriority = priorityByKey.get(agent2TargetKey(b)) ?? Number.MAX_SAFE_INTEGER;
      return aPriority - bPriority;
    });
  if (deferredTargets.length === 0) return targets;

  const deferredKeys = new Set(deferredTargets.map(agent2TargetKey));
  return [
    ...deferredTargets,
    ...targets.filter((target) => !deferredKeys.has(agent2TargetKey(target))),
  ];
}

export async function runArticleDiscoveryBatch(input?: {
  sourceIds?: string[];
  categoryIds?: string[];
  /**
   * Explicit admin request: bypass the RSS-owned skip for the requested
   * targets. Routine pipeline runs never set this.
   */
  bypassRssOwned?: boolean;
  /**
   * Maximum number of targets to process in this batch.
   * Default: 5. Set higher for dedicated Agent 2 cron slots.
   */
  maxTargets?: number;
  /**
   * Soft time budget in milliseconds. When elapsed time exceeds
   * (timeBudgetMs - minRemainingMs), the batch stops cleanly before
   * starting a new target.
   * Default: 240000 (4 minutes).
   */
  timeBudgetMs?: number;
  /**
   * Minimum remaining time before the batch stops early.
   * The batch will not start a new target if remaining < minRemainingMs.
   * Default: 30000 (30 seconds).
   */
  minRemainingMs?: number;
  /** Operation-level stage telemetry probe (optional, no-op by default). */
  telemetry?: StageBatchProbe;
}): Promise<Agent2BatchResult> {
  const probe = input?.telemetry ?? createNoopStageBatchProbe();
  const maxTargets = input?.maxTargets ?? 5;
  const timeBudgetMs = input?.timeBudgetMs ?? 240_000;
  const minRemainingMs = input?.minRemainingMs ?? 30_000;

  const startedAt = Date.now();
  const { targets: resolvedTargets } = await resolveAgent2Targets(input);
  const targets = await prioritizeDeferredTargets(resolvedTargets, input);

  if (targets.length === 0) {
    await logAgentScan({
      status: "A2_BATCH_STOPPED",
      executionTimeMs: Date.now() - startedAt,
      errorLog: `stoppedReason=no_targets, eligible=0, elapsed=${Date.now() - startedAt}ms`,
    });
    // No PipelineRun created when there are zero targets.
    return {
      pipelineRunId: null,
      targets,
      result: { sourcesScanned: 0, candidatesFound: 0, inserted: 0, skipped: 0, failed: 0, artifactCount: 0 },
      stoppedReason: "no_targets",
      processed: 0,
      succeeded: 0,
      deferred: 0,
      remainingEligible: 0,
      targetDispositions: {
        succeeded: 0, failedRetryable: 0, failedPermanent: 0, skipped: 0,
        deferred: 0, quarantined: 0, claimLost: 0, persistenceFailed: 0,
      },
      selectedTargets: 0,
      productivity: {
        rawLinks: 0, evaluatedCandidates: 0, acceptedCandidates: 0,
        rejectedCandidates: 0, insertedCandidates: 0, skippedCandidates: 0,
        candidatePersistenceFailures: 0,
      },
    } as Agent2BatchResult;
  }

  const pipelineRun = await createPipelineRun(Math.min(targets.length, maxTargets));

  await logAgentScan({
    status: "ARTICLE_DISCOVERY_BATCH_STARTED",
    executionTimeMs: 0,
    errorLog: `Agent 2 discovery started for ${targets.length} target(s). runId=${pipelineRun.id}. maxTargets=${maxTargets}, timeBudgetMs=${timeBudgetMs}, minRemainingMs=${minRemainingMs}.`,
  });

  let candidatesFound = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let artifactCount = 0;
  let processed = 0;
  let succeeded = 0;
  let targetFailedRetryable = 0;
  let targetPersistenceFailed = 0;
  let rawLinks = 0;
  let evaluatedCandidates = 0;
  let acceptedCandidates = 0;
  let rejectedCandidates = 0;
  let stoppedReason: Agent2BatchStoppedReason = "completed";

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;

    // ── Budget guard: check before starting each target ──
    if (processed >= maxTargets) {
      stoppedReason = "max_targets";
      break;
    }

    const elapsed = Date.now() - startedAt;
    const remaining = timeBudgetMs - elapsed;
    if (remaining < minRemainingMs) {
      stoppedReason = "time_budget";
      break;
    }

    try {
      const result = await discoverArticlesFromTarget(target, probe);
      for (const diagnostic of result.listingDiagnostics) {
        if (diagnostic.status === 403) probe.recordAccessDenied403();
        // Only count fetch failures whose evidence mentions a timeout/abort;
        // DNS/connection errors are not timeouts.
        if (
          diagnostic.reason === "fetch_failed" &&
          diagnostic.hints.some((hint) => /timeout|timed out|abort/i.test(hint))
        ) {
          probe.recordTimeout();
        }
      }
      rawLinks += result.listingDiagnostics.reduce((sum, diagnostic) => sum + diagnostic.rawLinkCount, 0);
      evaluatedCandidates += result.outcomeSummary.totalEvaluated;
      acceptedCandidates += result.candidates.length;
      rejectedCandidates += result.outcomeSummary.rejected;
      candidatesFound += result.candidates.length;
      const artifact = await probe.timed("persistence", () => persistArticleDiscoveryArtifact({ pipelineRunId: pipelineRun.id, result }));
      probe.recordDbOperation();
      artifactCount += 1;

      // Persist a marker whenever static discovery needs headless recovery or
      // remains retryable/incomplete. A productive-quality partial result is
      // still incomplete, so quality alone must never suppress the marker.
      const needsHeadlessMarker = result.qualityAssessment.shouldEscalateToHeadless
        || result.retryable
        || result.discoveryComplete === false;
      if (needsHeadlessMarker) {
        const rateLimit = result.rateLimitEvidence[0] ?? null;
        const queued = await probe.timed("persistence", () => createHeadlessQueueArtifactIfAbsent({
          pipelineRunId: pipelineRun.id,
          sourceId: target.sourceId,
          categoryId: target.categoryId || null,
          targetUrl: target.targetUrl,
          payload: {
              schemaVersion: 2,
              artifactKind: "headless_escalation_marker",
              sourceId: target.sourceId,
              categoryId: target.categoryId || null,
              targetUrl: target.targetUrl,
              quality: result.qualityAssessment.quality,
              escalationReasons: result.qualityAssessment.escalationReasons,
              explanation: result.qualityAssessment.explanation,
              outcomeSummary: result.outcomeSummary,
              discoverySources: result.discoverySources,
              stopReason: result.detailEvaluationStoppedReason,
              rateLimitPhase: rateLimit?.phase ?? null,
              retryAfterAt: rateLimit?.retryAfterAt ?? null,
              retryAfterSource: rateLimit?.retryAfterSource ?? null,
              rateLimitEvidence: result.rateLimitEvidence,
              requestBudget: result.requestBudget,
              discoveryComplete: result.discoveryComplete,
              retryable: result.retryable,
              acceptedCount: result.candidates.length,
              evaluatedCount: result.outcomeSummary.totalEvaluated,
              createdAt: new Date().toISOString(),
          },
        }));
        if (queued.created) artifactCount += 1;
      }

      // Candidate persistence is the durability boundary for Agent 2 success.
      // Resolve stale headless markers only after every candidate persistence
      // attempt has completed without a reported failure. The discovery artifact
      // remains available for audit even when persistence must be retried.
      const persisted = await probe.timed("persistence", () => persistCandidates(result.candidates));
      probe.recordDbOperation();
      inserted += persisted.inserted;
      skipped += persisted.skipped;
      failed += persisted.failed + result.failed;

      if (persisted.failed === 0 && !result.retryable && result.discoveryComplete) {
        // A fully completed productive static shortlist may resolve older
        // headless markers. Partial/rate-limited static discovery must not
        // claim the target was completely processed, even when candidates
        // before the 429 were persisted successfully.
        await probe.timed("persistence", () => resolveStaleHeadlessMarkers({ result, artifactId: artifact.id, pipelineRunId: pipelineRun.id }));
        probe.recordDbOperation();
      } else if (persisted.failed > 0) {
        await logAgentScan({
          sourceId: target.sourceId,
          categoryId: target.categoryId || undefined,
          status: "ARTICLE_DISCOVERY_PERSISTENCE_FAILED",
          executionTimeMs: 0,
          errorLog: `Candidate persistence reported ${persisted.failed} failure(s) for ${target.targetUrl}; transient/incomplete headless marker remains retryable.`,
        });
      }

      processed += 1;
      if (persisted.failed > 0) targetPersistenceFailed += 1;
      else if (result.retryable || result.failed > 0) targetFailedRetryable += 1;
      else {
        succeeded += 1;
      }
    } catch (error: any) {
      if (isUnsafePipelineInvariantError(error)) throw error;
      failed += 1;
      targetFailedRetryable += 1;
      processed += 1;
      await logAgentScan({
        sourceId: target.sourceId,
        categoryId: target.categoryId || undefined,
        status: "ARTICLE_DISCOVERY_FAILED",
        executionTimeMs: 0,
        errorLog: boundedPipelineItemError(error),
      });
    }
  }

  // ── Deferred targets: create audit artifacts for unprocessed targets ──
  const deferredTargets = targets.slice(processed);
  const deferredCount = deferredTargets.length;
  const elapsedMs = Date.now() - startedAt;

  if (deferredCount > 0) {
    const deferredStatus = stoppedReason === "max_targets"
      ? "DEFERRED_MAX_TARGETS"
      : "DEFERRED_TIME_BUDGET";

    await prisma.pipelineArtifact.createMany({
      data: deferredTargets.map((target, position) => ({
        pipelineRunId: pipelineRun.id,
        sourceId: target.sourceId,
        categoryId: target.categoryId || null,
        artifactType: "article_discovery_deferred",
        status: deferredStatus,
        candidateCount: 0,
        payload: {
          schemaVersion: 1,
          artifactKind: "agent2_deferred_target",
          sourceId: target.sourceId,
          categoryId: target.categoryId || null,
          targetType: target.targetType,
          targetUrl: target.targetUrl,
          reason: stoppedReason,
          runId: pipelineRun.id,
          deferredAt: new Date().toISOString(),
          elapsedMs,
          timeBudgetMs,
          minRemainingMs,
          maxTargets,
          position,
          totalTargetsResolved: targets.length,
        } satisfies Prisma.InputJsonValue,
        errorLog: `Deferred target ${target.targetUrl}. reason=${stoppedReason}, position=${position + 1}/${deferredCount}.`,
      })),
    });
    probe.recordDbOperation();
    artifactCount += deferredCount;

    await logAgentScan({
      status: "A2_TARGETS_DEFERRED",
      executionTimeMs: elapsedMs,
      errorLog: `deferred=${deferredCount}, reason=${stoppedReason}, processed=${processed}, total=${targets.length}, elapsed=${elapsedMs}ms.`,
    });
  }

  const result: PipelineResult = {
    sourcesScanned: processed,
    candidatesFound,
    inserted,
    skipped,
    failed,
    artifactCount,
  };

  await finalizePipelineRun({
    pipelineRunId: pipelineRun.id,
    result,
  });

  // User-facing remaining count tracks the active bounded batch cycle.
  // totalEligibleNow in getAgent2Progress still exposes global eligibility.
  const remainingEligible = deferredCount;

  await logAgentScan({
    status: stoppedReason === "completed"
      ? "ARTICLE_DISCOVERY_BATCH_FINISHED"
      : "A2_BATCH_STOPPED",
    executionTimeMs: elapsedMs,
    errorLog: `Agent 2 discovery ${stoppedReason === "completed" ? "finished" : "stopped"}. runId=${pipelineRun.id}, ` +
      `targets=${targets.length}, processed=${processed}, deferred=${deferredCount}, ` +
      `candidates=${candidatesFound}, inserted=${inserted}, skipped=${skipped}, failed=${failed}, ` +
      `stoppedReason=${stoppedReason}, remainingEligible=${remainingEligible}, elapsed=${elapsedMs}ms.`,
  });

  return {
    pipelineRunId: pipelineRun.id,
    targets,
    result,
    stoppedReason,
    processed,
    succeeded,
    deferred: deferredCount,
    remainingEligible,
    targetDispositions: {
      succeeded,
      failedRetryable: targetFailedRetryable,
      failedPermanent: 0,
      skipped: 0,
      deferred: deferredCount,
      quarantined: 0,
      claimLost: 0,
      persistenceFailed: targetPersistenceFailed,
    },
    selectedTargets: processed + deferredCount,
    productivity: {
      rawLinks,
      evaluatedCandidates,
      acceptedCandidates,
      rejectedCandidates,
      insertedCandidates: inserted,
      skippedCandidates: skipped,
      candidatePersistenceFailures: targetPersistenceFailed,
    },
  };
}

/**
 * Get compact Agent 2 progress state for admin UI.
 * Queries the latest A2 PipelineRun and recent deferred artifacts.
 */
export async function getAgent2Progress(): Promise<{
  totalEligibleNow: number;
  latestRunId: string | null;
  latestRunStartedAt: string | null;
  latestRunFinishedAt: string | null;
  lastDurationMs: number | null;
  processedLastRun: number;
  deferredLastRun: number;
  remainingEligible: number;
  stoppedReason: string | null;
  recentDeferredTargets: Array<{
    sourceId: string | null;
    categoryId: string | null;
    targetUrl: string;
    reason: string;
    position: number;
    totalTargetsResolved: number;
  }>;
}> {
  // Get current eligible count
  const { targets: currentTargets } = await resolveAgent2Targets();

  // Get latest Agent 2 PipelineRun
  const latestRun = await prisma.pipelineRun.findFirst({
    where: {
      status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] },
      artifacts: {
        some: {
          artifactType: { in: ["article_discovery_candidates", "article_discovery_deferred"] },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      startedAt: true,
      finishedAt: true,
      targetCount: true,
      candidatesFound: true,
      inserted: true,
      skipped: true,
      failed: true,
      artifactCount: true,
    },
  });

  // Get recent deferred artifacts from the latest run
  let recentDeferredTargets: Array<{
    sourceId: string | null;
    categoryId: string | null;
    targetUrl: string;
    reason: string;
    position: number;
    totalTargetsResolved: number;
  }> = [];

  let processedLastRun = 0;
  let deferredLastRun = 0;
  let stoppedReason: string | null = null;

  if (latestRun) {
    const deferredArtifacts = await prisma.pipelineArtifact.findMany({
      where: {
        pipelineRunId: latestRun.id,
        artifactType: "article_discovery_deferred",
      },
      take: 10,
      select: {
        sourceId: true,
        categoryId: true,
        payload: true,
      },
    });

    deferredLastRun = await prisma.pipelineArtifact.count({
      where: {
        pipelineRunId: latestRun.id,
        artifactType: "article_discovery_deferred",
      },
    });

    // Count non-deferred discovery artifacts for this run to get actual processed count.
    // latestRun.targetCount may be bounded (min(targets, maxTargets)), so we count
    // actual discovery artifacts rather than relying on targetCount - deferred.
    const discoveryArtifactCount = await prisma.pipelineArtifact.count({
      where: {
        pipelineRunId: latestRun.id,
        artifactType: { in: ["article_discovery_candidates", "article_discovery_headless_required"] },
      },
    });
    processedLastRun = discoveryArtifactCount;

    if (deferredLastRun > 0 && deferredArtifacts.length > 0) {
      const firstPayload = deferredArtifacts[0]!.payload as Record<string, unknown> | null;
      stoppedReason = typeof firstPayload?.reason === "string" ? firstPayload.reason : null;
    }

    recentDeferredTargets = deferredArtifacts.map((a) => {
      const payload = a.payload as Record<string, unknown> | null;
      return {
        sourceId: a.sourceId,
        categoryId: a.categoryId,
        targetUrl: typeof payload?.targetUrl === "string" ? payload.targetUrl : "",
        reason: typeof payload?.reason === "string" ? payload.reason : "unknown",
        position: typeof payload?.position === "number" ? payload.position : 0,
        totalTargetsResolved: typeof payload?.totalTargetsResolved === "number" ? payload.totalTargetsResolved : 0,
      };
    });
  }

  const lastDurationMs = latestRun?.finishedAt && latestRun?.startedAt
    ? new Date(latestRun.finishedAt).getTime() - new Date(latestRun.startedAt).getTime()
    : null;

  return {
    totalEligibleNow: currentTargets.length,
    latestRunId: latestRun?.id ?? null,
    latestRunStartedAt: latestRun?.startedAt?.toISOString() ?? null,
    latestRunFinishedAt: latestRun?.finishedAt?.toISOString() ?? null,
    lastDurationMs,
    processedLastRun,
    deferredLastRun,
    remainingEligible: deferredLastRun,
    stoppedReason,
    recentDeferredTargets,
  };
}
