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
        if (categoryPathUrl) {
          const articlePath = normalizePath(resolved);
          const categoryPath = normalizePath(categoryPathUrl);
          if (categoryPath !== "/" && !(articlePath === categoryPath || articlePath.startsWith(`${categoryPath}/`))) {
            continue;
          }
        }
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

const crawlListingPages = async (
  targetUrl: string,
  categoryPathUrl?: string | null,
) => {
  const visitedPages: string[] = [];
  const articleLinks = new Map<string, ListingArticleLink>();
  const seenPages = new Set<string>();
  const queue = [targetUrl];
  let firstPageHtml: string | null = null;

  while (queue.length > 0 && visitedPages.length < MAX_LISTING_PAGES) {
    const pageUrl = queue.shift()!;
    const normalizedPageUrl = normalizeUrl(pageUrl);
    if (seenPages.has(normalizedPageUrl)) continue;
    seenPages.add(normalizedPageUrl);

    const response = await safeFetch(pageUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) continue;

    const html = await response.text();
    let dom: ArticleDiscoveryDom;
    try {
      const { JSDOM } = await import("jsdom");
      dom = new JSDOM(html, { url: pageUrl, contentType: "text/html" });
    } catch {
      continue;
    }
    visitedPages.push(pageUrl);
    // Capture first page HTML for downstream JSON-LD extraction (avoids double fetch)
    if (!firstPageHtml) firstPageHtml = html;

    for (const link of extractListingArticleLinks(dom.window.document, pageUrl, categoryPathUrl)) {
      if (!articleLinks.has(link)) {
        articleLinks.set(link, { url: link, sourcePageUrl: pageUrl });
      }
    }

    for (const nextLink of extractPaginationLinks(dom.window.document, pageUrl)) {
      const normalized = normalizeUrl(nextLink);
      if (!seenPages.has(normalized)) {
        queue.push(nextLink);
      }
    }

    dom.window.close();
  }

  return { visitedPages, articleLinks: [...articleLinks.values()], firstPageHtml };
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

  await logAgentScan({
    sourceId: target.sourceId,
    categoryId: target.categoryId || undefined,
    status: candidates.length > 0 ? "ARTICLE_DISCOVERY_COMPLETED" : "ARTICLE_DISCOVERY_FAILED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Discovered ${candidates.length} accepted, ${summary.rejected} rejected from ${summary.totalEvaluated} evaluated. ` +
      `Sources: listing=${discoverySources.listingPages}, sitemap=${discoverySources.sitemapUrls}, jsonld=${discoverySources.jsonldUrls}. ` +
      `Top rejection: ${topReason}. ` +
      `Quality: ${qualityAssessment.quality} (confidence=${qualityAssessment.confidence}, escalate=${qualityAssessment.shouldEscalateToHeadless}). ` +
      `Skipped: alreadySeen=${skipSummary.alreadySeenFeedItem}, stale=${skipSummary.staleOrMissingPublishedAt}, nonArticle=${skipSummary.htmlFallbackNonArticle}.`,
  });

  return {
    targetType: target.targetType,
    sourceId: target.sourceId,
    categoryId: target.categoryId || null,
    targetUrl: target.targetUrl,
    discoveryMethod: "jsdom",
    discoverySources,
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
      await persistArticleDiscoveryArtifact({ pipelineRunId: pipelineRun.id, result });
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
