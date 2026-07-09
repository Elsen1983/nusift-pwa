import { createError } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

const normalizeComparableUrl = (value?: string | null) =>
  (value || "").trim().replace(/\/+$/, "").toLowerCase();

const isSameRootDomain = (left?: string | null, right?: string | null) => {
  if (!left || !right) return false;

  try {
    const leftHost = new URL(left).hostname.replace(/^www\./, "").toLowerCase();
    const rightHost = new URL(right).hostname.replace(/^www\./, "").toLowerCase();
    return (
      leftHost === rightHost ||
      leftHost.endsWith(`.${rightHost}`) ||
      rightHost.endsWith(`.${leftHost}`)
    );
  } catch {
    return false;
  }
};

const toAbsoluteUrl = (baseUrl: string, candidate: string) => {
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return candidate;
  }
};

const isLikelyRecoveryCandidate = (candidateUrl: string) => {
  const normalized = candidateUrl.toLowerCase();
  return !(
    normalized.includes("/sitemap") ||
    normalized.includes("/data-feed/sitemap") ||
    normalized.includes("/news-sitemap") ||
    normalized.includes("/sitemap_index") ||
    normalized.includes("/sitemap.xml.gz")
  );
};

const buildDomainFallbackFeedCandidates = (targetUrl: string) => {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");

    if (host === "rte.ie" && (!normalizedPath || normalizedPath === "/")) {
      return [
        "https://www.rte.ie/feeds/rss/?index=/news/",
        "https://www.rte.ie/feeds/rss/?index=/sport/",
        "https://www.rte.ie/feeds/rss/?index=/news/business/",
        "https://www.rte.ie/feeds/rss/?index=/news/politics/",
        "https://www.rte.ie/feeds/rss/?index=/news/world/",
      ];
    }
  } catch {}

  return [] as string[];
};

const readDiscoveryEvidence = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as {
    topCandidates?: Array<{
      feedUrl?: string | null;
      score?: number | null;
      detection?: string | null;
      scopeMatch?: "exact" | "probable" | "generic" | "unrelated" | null;
    }>;
    taxonomyEvidence?: {
      canonicalSectionHandles?: string[];
      matchedFeedUrls?: string[];
    } | null;
  };
};

const buildFeedHints = (input: {
  targetUrl: string;
  rssFeedUrl?: string | null;
  currentFeedProductive?: boolean | null;
  consecutiveNonProductiveRuns?: number | null;
  lastProductiveFeedUrl?: string | null;
  discoveryEvidence?: unknown;
}) => {
  const evidence = readDiscoveryEvidence(input.discoveryEvidence);
  const matchedFeeds = (evidence?.taxonomyEvidence?.matchedFeedUrls || [])
    .map((candidate) => toAbsoluteUrl(input.targetUrl, candidate))
    .filter((candidate) => isSameRootDomain(candidate, input.targetUrl))
    .filter(isLikelyRecoveryCandidate)
    .map((feedUrl) => ({
      feedUrl,
      score: 60,
      scopeMatch: "probable" as const,
    }));

  const topFeeds = (evidence?.topCandidates || [])
    .map((candidate) => ({
      feedUrl: candidate.feedUrl || "",
      score: candidate.score ?? 0,
      scopeMatch: candidate.scopeMatch ?? "generic",
    }))
    .filter((candidate) => candidate.feedUrl && isSameRootDomain(candidate.feedUrl, input.targetUrl))
    .filter((candidate) => isLikelyRecoveryCandidate(candidate.feedUrl));

  const allCandidates = [...matchedFeeds, ...topFeeds]
    .filter((candidate) => normalizeComparableUrl(candidate.feedUrl) !== normalizeComparableUrl(input.rssFeedUrl));

  const dedupedCandidates = new Map<string, { feedUrl: string; score: number; scopeMatch: string }>();
  for (const candidate of allCandidates) {
    if (candidate.scopeMatch === "unrelated") {
      continue;
    }

    const key = normalizeComparableUrl(candidate.feedUrl);
    const existing = dedupedCandidates.get(key);
    if (!existing || candidate.score > existing.score) {
      dedupedCandidates.set(key, candidate);
    }
  }

  const feedCandidates = [...dedupedCandidates.values()]
    .sort((left, right) => {
      const leftPriority =
        left.scopeMatch === "exact" ? 0 : left.scopeMatch === "probable" ? 1 : 2;
      const rightPriority =
        right.scopeMatch === "exact" ? 0 : right.scopeMatch === "probable" ? 1 : 2;

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return right.score - left.score;
    })
    .map((candidate) => candidate.feedUrl)
    .slice(0, 5);

  const fallbackCandidates =
    feedCandidates.length > 0
      ? []
      : buildDomainFallbackFeedCandidates(input.targetUrl).filter(
          (candidate) => normalizeComparableUrl(candidate) !== normalizeComparableUrl(input.rssFeedUrl),
        );

  const detectedSections = [...new Set((evidence?.taxonomyEvidence?.canonicalSectionHandles || []).filter(Boolean))].slice(0, 6);
  const normalizedCurrentFeedUrl = normalizeComparableUrl(input.rssFeedUrl);
  const normalizedLastProductiveFeedUrl = normalizeComparableUrl(input.lastProductiveFeedUrl);
  const feedVerifiedByArticles =
    input.currentFeedProductive === true ||
    (!!normalizedCurrentFeedUrl && normalizedLastProductiveFeedUrl === normalizedCurrentFeedUrl);

  return {
    feedCandidates: feedCandidates.length > 0 ? feedCandidates : fallbackCandidates,
    detectedSections,
    feedVerifiedByArticles,
    showFeedRecoveryTools: !feedVerifiedByArticles,
  };
};

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        tier: true,
        sourceSubscriptions: {
          include: {
            newsSource: {
              select: {
                id: true,
                frontPageUrl: true,
                mediaName: true,
                rssStatus: true,
                rssFeedUrl: true,
                discoveryEvidence: true,
                currentFeedProductive: true,
                consecutiveNonProductiveRuns: true,
                lastProductiveFeedUrl: true,
                lastProductiveAt: true,
                feedProvenance: true,
                reviewRequests: {
                  where: { status: "OPEN" },
                  select: { id: true, requestedByUserId: true },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        categorySubscriptions: {
          include: {
            category: {
              select: {
                id: true,
                pathUrl: true,
                name: true,
                rssStatus: true,
                rssFeedUrl: true,
                discoveryEvidence: true,
                currentFeedProductive: true,
                consecutiveNonProductiveRuns: true,
                lastProductiveFeedUrl: true,
                lastProductiveAt: true,
                feedProvenance: true,
                reviewRequests: {
                  where: { status: "OPEN" },
                  select: { id: true, requestedByUserId: true },
                },
                newsSource: {
                  select: {
                    id: true,
                    frontPageUrl: true,
                    mediaName: true,
                    rssStatus: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!user) {
      throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    const quotaLimit = user.tier === "PRO" ? 15 : 5;

    const formattedSources = [
      ...user.sourceSubscriptions.map((sub) => {
        const hints = buildFeedHints({
          targetUrl: sub.newsSource.frontPageUrl,
          rssFeedUrl: sub.newsSource.rssFeedUrl,
          currentFeedProductive: sub.newsSource.currentFeedProductive,
          consecutiveNonProductiveRuns: sub.newsSource.consecutiveNonProductiveRuns,
          lastProductiveFeedUrl: sub.newsSource.lastProductiveFeedUrl,
          discoveryEvidence: sub.newsSource.discoveryEvidence,
        });

        const openReviewRequests = sub.newsSource.reviewRequests || [];
        const userHasOpenRequest = openReviewRequests.some((r) => r.requestedByUserId === userId);

        return {
          id: sub.id,
          targetId: sub.newsSource.id,
          type: "ROOT",
          url: sub.newsSource.frontPageUrl,
          name: sub.customAlias || sub.newsSource.mediaName,
          isActive: sub.isActive,
          validationStatus: sub.newsSource.rssStatus,
          createdAt: sub.createdAt,
          rssFeedUrl: sub.newsSource.rssFeedUrl,
          currentFeedProductive: sub.newsSource.currentFeedProductive,
          consecutiveNonProductiveRuns: sub.newsSource.consecutiveNonProductiveRuns,
          lastProductiveFeedUrl: sub.newsSource.lastProductiveFeedUrl,
          lastProductiveAt: sub.newsSource.lastProductiveAt,
          feedProvenance: sub.newsSource.feedProvenance,
          openReviewRequestCount: openReviewRequests.length,
          userHasOpenReviewRequest: userHasOpenRequest,
          detectedSections: hints.detectedSections,
          feedCandidates: hints.feedCandidates,
          feedVerifiedByArticles: hints.feedVerifiedByArticles,
          showFeedRecoveryTools: hints.showFeedRecoveryTools,
        };
      }),
      ...user.categorySubscriptions.map((sub) => {
        let finalValidationStatus = sub.category.rssStatus;
        const parentStatus = sub.category.newsSource.rssStatus;

        if (finalValidationStatus !== "ACTIVE") {
          if (parentStatus === "ACTIVE" || parentStatus === "NO_RSS_FOUND") {
            finalValidationStatus = "NO_RSS_FOUND";
          } else if (parentStatus === "FAILED" || parentStatus === "DOMAIN_DEAD") {
            finalValidationStatus = parentStatus;
          }
        }

        const hints = buildFeedHints({
          targetUrl: sub.category.pathUrl,
          rssFeedUrl: sub.category.rssFeedUrl,
          currentFeedProductive: sub.category.currentFeedProductive,
          consecutiveNonProductiveRuns: sub.category.consecutiveNonProductiveRuns,
          lastProductiveFeedUrl: sub.category.lastProductiveFeedUrl,
          discoveryEvidence: sub.category.discoveryEvidence,
        });

        const openCatReviewRequests = sub.category.reviewRequests || [];
        const userHasOpenCatRequest = openCatReviewRequests.some((r) => r.requestedByUserId === userId);

        return {
          id: sub.id,
          targetId: sub.category.id,
          parentSourceId: sub.category.newsSource.id,
          type: "CATEGORY",
          url: sub.category.pathUrl,
          name: sub.customAlias || `${sub.category.newsSource.mediaName} - ${sub.category.name}`,
          isActive: sub.isActive,
          validationStatus: finalValidationStatus,
          createdAt: sub.createdAt,
          rssFeedUrl: sub.category.rssFeedUrl,
          currentFeedProductive: sub.category.currentFeedProductive,
          consecutiveNonProductiveRuns: sub.category.consecutiveNonProductiveRuns,
          lastProductiveFeedUrl: sub.category.lastProductiveFeedUrl,
          lastProductiveAt: sub.category.lastProductiveAt,
          feedProvenance: sub.category.feedProvenance,
          openReviewRequestCount: openCatReviewRequests.length,
          userHasOpenReviewRequest: userHasOpenCatRequest,
          detectedSections: hints.detectedSections,
          feedCandidates: hints.feedCandidates,
          feedVerifiedByArticles: hints.feedVerifiedByArticles,
          showFeedRecoveryTools: hints.showFeedRecoveryTools,
        };
      }),
    ];

    const activeCount = formattedSources.filter(
      (source) =>
        source.isActive &&
        source.validationStatus !== "FAILED" &&
        source.validationStatus !== "DOMAIN_DEAD",
    ).length;

    return {
      success: true,
      quota: {
        tier: user.tier,
        limit: quotaLimit,
        activeCount,
        availableSlots: Math.max(0, quotaLimit - activeCount),
      },
      sources: formattedSources,
    };
  } catch (error) {
    console.error("Fetch sources error:", error);
    throw createError({ statusCode: 500, statusMessage: "Failed to fetch sources." });
  }
});
