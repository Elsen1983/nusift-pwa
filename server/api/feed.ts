import { prisma } from "../utils/prisma";
import { requireUserId } from "../utils/require-user";

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

  const sourceIds = user?.sourceSubscriptions.map((subscription) => subscription.sourceId) || [];
  const categoryIds = user?.categorySubscriptions.map((subscription) => subscription.categoryId) || [];
  const categoryPathUrls =
    user?.categorySubscriptions
      .map((subscription) => subscription.category?.pathUrl)
      .filter((pathUrl): pathUrl is string => Boolean(pathUrl)) || [];

  if (sourceIds.length === 0 && categoryIds.length === 0 && categoryPathUrls.length === 0) {
    return [];
  }

  const articles = await prisma.article.findMany({
    where: {
      OR: [
        sourceIds.length > 0 ? { sourceId: { in: sourceIds } } : undefined,
        categoryIds.length > 0 ? { categoryId: { in: categoryIds } } : undefined,
        categoryPathUrls.length > 0
          ? {
              category: {
                pathUrl: { in: categoryPathUrls },
              },
            }
          : undefined,
      ].filter(Boolean) as any,
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

  return articles.map((article) => ({
    id: article.id,
    title: article.title,
    source: article.source.mediaName || toSourceLabel(article.source.frontPageUrl),
    sourceUrl: article.source.frontPageUrl,
    canonicalUrl: article.canonicalUrl || article.source.frontPageUrl,
    categoryPathUrl: article.category?.pathUrl || null,
    date: article.date.toISOString(),
    score: article.score,
    isPaywall: article.isPaywall,
    tags: article.tags,
    signals: article.signals,
    reasoning: article.reasoning || "",
  }));
});
