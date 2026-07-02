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

  const [rootSubscriptions, categorySubscriptions] = await Promise.all([
    prisma.userSourceSubscription.findMany({
      where: {
        userId,
        isActive: true,
      },
      select: {
        sourceId: true,
      },
    }),
    prisma.userCategorySubscription.findMany({
      where: {
        userId,
        isActive: true,
      },
      select: {
        categoryId: true,
      },
    }),
  ]);

  const sourceIds = rootSubscriptions.map((subscription) => subscription.sourceId);
  const categoryIds = categorySubscriptions.map((subscription) => subscription.categoryId);

  if (sourceIds.length === 0 && categoryIds.length === 0) {
    return [];
  }

  const articles = await prisma.article.findMany({
    where: {
      OR: [
        sourceIds.length > 0 ? { sourceId: { in: sourceIds } } : undefined,
        categoryIds.length > 0 ? { categoryId: { in: categoryIds } } : undefined,
      ].filter(Boolean) as any,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      id: true,
      title: true,
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
    },
  });

  return articles.map((article) => ({
    id: article.id,
    title: article.title,
    source: article.source.mediaName || toSourceLabel(article.source.frontPageUrl),
    sourceUrl: article.source.frontPageUrl,
    date: article.date.toISOString(),
    score: article.score,
    isPaywall: article.isPaywall,
    tags: article.tags,
    signals: article.signals,
    reasoning: article.reasoning || "",
  }));
});
