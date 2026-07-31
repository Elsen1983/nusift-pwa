import { prisma } from "../utils/prisma";
import { requireUserId } from "../utils/require-user";
import {
  buildUserFeedPublicationWhere,
  isEffectivelyPublishableArticle,
} from "../utils/news-pipeline/publication-gate";
import { buildSubscriptionArticleScope, getSubscriptionScope } from "../utils/subscription-scope";

const toSourceLabel = (frontPageUrl: string) => {
  try {
    return new URL(frontPageUrl).hostname.replace(/^www\./, "");
  } catch {
    return frontPageUrl;
  }
};

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      sourceSubscriptions: {
        where: { isActive: true },
        select: { sourceId: true },
      },
      categorySubscriptions: {
        where: { isActive: true },
        select: {
          categoryId: true,
          category: {
            select: {
              pathUrl: true,
            },
          },
        },
      },
    },
  });

  const scope = getSubscriptionScope(
    user?.sourceSubscriptions || [],
    user?.categorySubscriptions || [],
  );
  const subscriptionPredicates = buildSubscriptionArticleScope(scope);

  if (subscriptionPredicates.length === 0) {
    return [];
  }

  const articles = await prisma.article.findMany({
    where: {
      // User-feed publication boundary: only rows that completed Agent 3
      // successfully and have durable, minimally complete content are visible.
      // Candidates/failures remain available to admin and diagnostic paths.
      ...buildUserFeedPublicationWhere(),
      OR: subscriptionPredicates,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    select: {
      id: true,
      title: true,
      canonicalUrl: true,
      date: true,
      score: true,
      isPaywall: true,
      tags: true,
      signals: true,
      reasoning: true,
      bodyText: true,
      source: {
        select: {
          frontPageUrl: true,
          mediaName: true,
        },
      },
      category: {
        select: {
          pathUrl: true,
        },
      },
    },
  });

  return articles
    // Defense in depth for legacy rows containing null/blank values despite
    // the durable publication fields. The DB predicate remains the primary
    // publication gate; this protects the API if old data is malformed.
    .filter(isEffectivelyPublishableArticle)
    .map((article) => ({
    id: article.id,
    title: article.title,
    source: article.source.mediaName || toSourceLabel(article.source.frontPageUrl),
    sourceUrl: article.source.frontPageUrl,
    sourceTargetUrl: article.category?.pathUrl || article.source.frontPageUrl,
    canonicalUrl: article.canonicalUrl || article.source.frontPageUrl,
    categoryPathUrl: article.category?.pathUrl || null,
    date: article.date.toISOString(),
    score: article.score,
    isPaywall: article.isPaywall,
    tags: article.tags,
    signals: article.signals,
    reasoning: article.reasoning || "",
    bodyText: article.bodyText || null,
  }));
});
