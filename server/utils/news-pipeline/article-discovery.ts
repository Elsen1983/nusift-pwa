import { prisma } from "../prisma";
import { safeFetch } from "../ssrf-guard";
import { logAgentScan } from "./log";
import { createPipelineRun, finalizePipelineRun } from "./artifacts";
import { normalizeUrl } from "./text";
import { persistCandidates } from "./ingest";
import { resolveActivePipelineTargets } from "./targets";
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
} from "./article-discovery-helpers";
import type { IngestCandidate, IngestRejectedItem, IngestSkipSummary, PipelineResult } from "./types";

// DISCOVERY_FRESHNESS_MS re-exported from article-discovery-helpers for backward compat
const MAX_LISTING_PAGES = 3;
const MAX_LINKS_PER_PAGE = 20;
const MAX_TOTAL_CANDIDATES = 60;
const USER_AGENT = "NuSift/1.0 Agent2-Discovery";

type ArticleDiscoveryDom = {
  window: {
    document: Document;
    close: () => void;
  };
};

export type ArticleDiscoveryTarget = {
  targetType: "source" | "category";
  sourceId: string;
  categoryId?: string | null;
  targetUrl: string;
  rssStatus: string;
  currentFeedProductive: boolean;
  consecutiveNonProductiveRuns: number;
  mediaName: string;
};

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
    | "non_html_content"
    | "empty_html"
    | "blocked_or_challenge_like_html"
    | "no_links_found"
    | "no_article_like_links"
    | "ok"
    | "parser_error";
  hints: string[];
};

const emptySkipSummary = (): IngestSkipSummary => ({
  emptyLink: 0,
  outOfScope: 0,
  staleOrMissingPublishedAt: 0,
  alreadySeenFeedItem: 0,
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

const normalizePath = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
};

// isWithinFreshnessWindow, isBlockedDiscoveryPath, extractPageMetadata,
// normalizePublishedAt — now imported from article-discovery-helpers

const isLikelyArticleLink = (href: string, sourceUrl: string) => {
  try {
    const url = new URL(href);
    if (url.hostname.replace(/^www\./, "") !== new URL(sourceUrl).hostname.replace(/^www\./, "")) {
      return false;
    }
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
  document: Document,
  pageUrl: string,
  categoryPathUrl?: string | null,
) => {
  const links = new Set<string>();
  const selectors = [
    "article a[href]",
    "main a[href]",
    "section a[href]",
    "h1 a[href]",
    "h2 a[href]",
    "h3 a[href]",
    "h4 a[href]",
    "li a[href]",
    "a[href]",
  ];

  for (const selector of selectors) {
    const anchors = document.querySelectorAll(selector);
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
      try {
        const resolved = new URL(href, pageUrl).toString();
        if (links.has(resolved)) continue;
        if (isBlockedDiscoveryPath(resolved)) continue;
        if (!isLikelyArticleLink(resolved, pageUrl)) continue;
        links.add(resolved);
        if (links.size >= MAX_LINKS_PER_PAGE) break;
      } catch {
        continue;
      }
    }
    if (links.size >= MAX_LINKS_PER_PAGE) break;
  }

  return [...links];
};

const extractPaginationLinks = (document: Document, pageUrl: string) => {
  const links = new Set<string>();
  const selectors = [
    'a[rel="next"]',
    'link[rel="next"]',
    'a[aria-label*="next" i]',
    'a[title*="next" i]',
    'a[aria-label*="older" i]',
    'a[title*="older" i]',
    'a[href*="page="]',
    'a[href*="p="]',
  ];

  for (const selector of selectors) {
    const anchors = document.querySelectorAll(selector);
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
      const isLinkElement = anchor.tagName.toLowerCase() === "link";
      if (!isLinkElement) {
        const text = (anchor.textContent || "").toLowerCase();
        const label = `${text} ${(anchor.getAttribute("aria-label") || "").toLowerCase()} ${(anchor.getAttribute("title") || "").toLowerCase()}`;
        if (!/next|older|more|page\s*\d+/i.test(label) && !selector.includes("page=")) continue;
      }
      try {
        const resolved = new URL(href, pageUrl).toString();
        if (isBlockedDiscoveryPath(resolved)) continue;
        if (new URL(resolved).hostname.replace(/^www\./, "") !== new URL(pageUrl).hostname.replace(/^www\./, "")) continue;
        links.add(resolved);
      } catch {
        continue;
      }
    }
  }

  return [...links];
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
) => {
  const visitedPages: string[] = [];
  const diagnostics: ListingFetchDiagnostic[] = [];
  const articleLinks = new Map<string, ListingArticleLink>();
  const seenPages = new Set<string>();
  const queue = [targetUrl];
  let firstPageHtml: string | null = null;

  while (queue.length > 0 && visitedPages.length < MAX_LISTING_PAGES) {
    const pageUrl = queue.shift()!;
    const normalizedPageUrl = normalizeUrl(pageUrl);
    if (seenPages.has(normalizedPageUrl)) continue;
    seenPages.add(normalizedPageUrl);

    let response: Response | null = null;
    try {
      response = await safeFetch(pageUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (error: any) {
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

    const contentType = typeof response.headers?.get === "function"
      ? response.headers.get("content-type")
      : null;
    if (!response.ok) {
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
        reason: "fetch_failed",
        hints: [`status=${response.status}`],
      });
      continue;
    }

    const html = await response.text();
    let dom: ArticleDiscoveryDom;
    try {
      const { JSDOM } = await import("jsdom");
      dom = new JSDOM(html, { url: pageUrl, contentType: "text/html" });
    } catch {
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
        hints: ["jsdom parser failed"],
      });
      continue;
    }
    visitedPages.push(pageUrl);
    // Capture first page HTML for downstream JSON-LD extraction (avoids double fetch)
    if (!firstPageHtml) firstPageHtml = html;

    const rawLinkCount = dom.window.document.querySelectorAll("a[href]").length;
    const articleLikeLinks = extractListingArticleLinks(dom.window.document, pageUrl, categoryPathUrl);
    const paginationLinks = extractPaginationLinks(dom.window.document, pageUrl);
    const title = (dom.window.document.querySelector("title")?.textContent || "").trim() || null;
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

    dom.window.close();
  }

  return { visitedPages, articleLinks: [...articleLinks.values()], firstPageHtml, diagnostics };
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
): Promise<CandidateEvaluationResult> => {
  const { url: articleUrl, sourcePageUrl } = articleLink;

  const result = await evaluateArticleLinkCandidate({
    articleUrl,
    sourcePageUrl,
    targetUrl: target.targetUrl,
    sourceId: target.sourceId,
    categoryId: target.categoryId,
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
}) =>
  input.rssStatus === "NO_RSS_FOUND" ||
  (input.rssStatus === "ACTIVE" && !input.currentFeedProductive && input.consecutiveNonProductiveRuns >= 2);

export async function resolveAgent2Targets(input?: {
  sourceIds?: string[];
  categoryIds?: string[];
}) {
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
            currentFeedProductive: true,
            consecutiveNonProductiveRuns: true,
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
            currentFeedProductive: true,
            consecutiveNonProductiveRuns: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  const targets: ArticleDiscoveryTarget[] = [];

  for (const target of activeTargets) {
    const key = `${target.sourceId}|${target.categoryId || ""}`;
    if (!targetKeys.has(key)) continue;
    if (requestedSourceIds && !requestedSourceIds.has(target.sourceId)) continue;
    if (requestedCategoryIds && target.categoryId && !requestedCategoryIds.has(target.categoryId)) continue;
    if (requestedCategoryIds && !target.categoryId && requestedCategoryIds.size > 0) continue;

    if (target.categoryId) {
      const category = categoryById.get(target.categoryId);
      const source = sourceById.get(target.sourceId);
      if (!category || !source) continue;
      if (!isAgent2EligibleTarget(category)) continue;
      targets.push({
        targetType: "category",
        sourceId: target.sourceId,
        categoryId: target.categoryId,
        targetUrl: category.pathUrl,
        rssStatus: category.rssStatus,
        currentFeedProductive: category.currentFeedProductive,
        consecutiveNonProductiveRuns: category.consecutiveNonProductiveRuns,
        mediaName: source.mediaName,
      });
    } else {
      const source = sourceById.get(target.sourceId);
      if (!source) continue;
      if (!isAgent2EligibleTarget(source)) continue;
      targets.push({
        targetType: "source",
        sourceId: target.sourceId,
        targetUrl: source.frontPageUrl,
        rssStatus: source.rssStatus,
        currentFeedProductive: source.currentFeedProductive,
        consecutiveNonProductiveRuns: source.consecutiveNonProductiveRuns,
        mediaName: source.mediaName,
      });
    }
  }

  return targets;
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
  };

  return prisma.pipelineArtifact.create({
    data: {
      pipelineRunId: input.pipelineRunId,
      sourceId: input.result.sourceId,
      categoryId: input.result.categoryId || null,
      artifactType: "article_discovery_candidates",
      status: input.result.failed > 0 && input.result.candidates.length === 0 ? "FAILED" : "CAPTURED",
      candidateCount: input.result.candidates.length,
      payload,
      errorLog:
        input.result.failed > 0 && input.result.candidates.length === 0
          ? `No article candidates discovered for ${input.result.targetUrl}.`
          : null,
    },
  });
}

export async function discoverArticlesFromTarget(target: ArticleDiscoveryTarget): Promise<ArticleDiscoveryResult> {
  const skipSummary = emptySkipSummary();
  const rejectedItems: IngestRejectedItem[] = [];
  const pagesVisited: string[] = [];
  const candidates: IngestCandidate[] = [];
  const seenCanonicalUrls = new Set<string>();
  const startedAt = Date.now();
  const discoverySources = { listingPages: 0, sitemapUrls: 0, jsonldUrls: 0 };
  const tracker = new ArticleDiscoveryOutcomeTracker();

  await logAgentScan({
    sourceId: target.sourceId,
    categoryId: target.categoryId || undefined,
    status: "ARTICLE_DISCOVERY_STARTED",
    executionTimeMs: 0,
    errorLog: `Scanning ${target.targetUrl} as Agent 2 ${target.targetType} target.`,
  });

  // ── Phase 1: Parallel source collection ────────────────────────────────
  const [listing, sitemapEntries] = await Promise.all([
    crawlListingPages(
      target.targetUrl,
      target.categoryId ? target.targetUrl : null,
    ).catch((error: any) => {
      throw new Error(`Article discovery fetch failed: ${error?.message || String(error)}`);
    }),
    discoverSitemapUrls(target.targetUrl).catch(() => []),
  ]);

  const targetPageJsonLd = listing.firstPageHtml
    ? extractJsonLdArticles(listing.firstPageHtml, target.targetUrl)
    : [];

  pagesVisited.push(...listing.visitedPages);
  discoverySources.listingPages = listing.visitedPages.length;

  // ── Phase 2: Merge all article link sources ────────────────────────────
  const allArticleLinks = new Map<string, ListingArticleLink>();

  for (const link of listing.articleLinks) {
    allArticleLinks.set(link.url, link);
  }

  const filteredSitemap = filterSitemapArticleUrls(sitemapEntries, target.targetUrl, target.categoryId ? target.targetUrl : null);
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
  for (const articleLink of allArticleLinks.values()) {
    if (candidates.length >= MAX_TOTAL_CANDIDATES) break;
    try {
      const result = await discoverArticleCandidatesForPage(
        articleLink,
        target,
        skipSummary,
        rejectedItems,
      );

      // Record rejection/failure outcomes immediately.
      if (!result.candidate) {
        tracker.record(result.outcome);
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
    } catch (error: any) {
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
  const qualityAssessment = assessArticleDiscoveryQuality({
    acceptedCount: candidates.length,
    totalEvaluated: summary.totalEvaluated,
    pagesVisited: pagesVisited.length,
    failed: candidates.length > 0 ? 0 : 1,
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
    status: candidates.length > 0 ? "ARTICLE_DISCOVERY_COMPLETED" : "ARTICLE_DISCOVERY_FAILED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Discovered ${candidates.length} accepted, ${summary.rejected} rejected from ${summary.totalEvaluated} evaluated. ` +
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
    failed: candidates.length > 0 ? 0 : 1,
    skipSummary,
    rejectedItems,
    outcomeSummary: summary,
    acceptedOutcomes: tracker.getAccepted(),
    rejectedOutcomes: tracker.getRejected(),
    qualityAssessment,
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

export async function runArticleDiscoveryBatch(input?: {
  sourceIds?: string[];
  categoryIds?: string[];
}) {
  const startedAt = Date.now();
  const targets = await resolveAgent2Targets(input);
  const pipelineRun = await createPipelineRun(targets.length);

  await logAgentScan({
    status: "ARTICLE_DISCOVERY_BATCH_STARTED",
    executionTimeMs: 0,
    errorLog: `Agent 2 discovery started for ${targets.length} target(s). runId=${pipelineRun.id}.`,
  });

  let candidatesFound = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let artifactCount = 0;

  for (const target of targets) {
    try {
      const result = await discoverArticlesFromTarget(target);
      candidatesFound += result.candidates.length;
      const artifact = await persistArticleDiscoveryArtifact({ pipelineRunId: pipelineRun.id, result });
      artifactCount += 1;

      // Persist escalation marker artifact when static discovery is insufficient.
      if (result.qualityAssessment.shouldEscalateToHeadless) {
        await prisma.pipelineArtifact.create({
          data: {
            pipelineRunId: pipelineRun.id,
            sourceId: target.sourceId,
            categoryId: target.categoryId || null,
            artifactType: "article_discovery_headless_required",
            status: "PENDING_HEADLESS",
            candidateCount: 0,
            payload: {
              schemaVersion: 1,
              artifactKind: "headless_escalation_marker",
              sourceId: target.sourceId,
              categoryId: target.categoryId || null,
              targetUrl: target.targetUrl,
              quality: result.qualityAssessment.quality,
              escalationReasons: result.qualityAssessment.escalationReasons,
              explanation: result.qualityAssessment.explanation,
              outcomeSummary: result.outcomeSummary,
              discoverySources: result.discoverySources,
              createdAt: new Date().toISOString(),
            },
          },
        });
        artifactCount += 1;
      }

      // Resolve stale PENDING_HEADLESS markers when static discovery is now productive.
      await resolveStaleHeadlessMarkers({ result, artifactId: artifact.id, pipelineRunId: pipelineRun.id });

      const persisted = await persistCandidates(result.candidates);
      inserted += persisted.inserted;
      skipped += persisted.skipped;
      failed += persisted.failed + result.failed;
    } catch (error: any) {
      failed += 1;
      await logAgentScan({
        sourceId: target.sourceId,
        categoryId: target.categoryId || undefined,
        status: "ARTICLE_DISCOVERY_FAILED",
        executionTimeMs: 0,
        errorLog: error?.message || String(error),
      });
    }
  }

  const result: PipelineResult = {
    sourcesScanned: targets.length,
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

  await logAgentScan({
    status: "ARTICLE_DISCOVERY_BATCH_FINISHED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Agent 2 discovery finished. runId=${pipelineRun.id}, targets=${targets.length}, candidates=${candidatesFound}, inserted=${inserted}, skipped=${skipped}, failed=${failed}, artifacts=${artifactCount}.`,
  });

  return {
    pipelineRunId: pipelineRun.id,
    targets,
    result,
  };
}
