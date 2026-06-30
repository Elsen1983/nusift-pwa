import { prisma } from "../utils/prisma";
import { requireUserId } from "../utils/require-user";

function formatArticleDate(date: Date): string {
  return date
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);

  const [sourceSubs, categorySubs] = await Promise.all([
    prisma.userSourceSubscription.findMany({
      where: { userId, isActive: true },
      select: { sourceId: true },
    }),
    prisma.userCategorySubscription.findMany({
      where: { userId, isActive: true },
      select: { categoryId: true },
    }),
  ]);

  const sourceIds = sourceSubs.map((sub) => sub.sourceId);
  const categoryIds = categorySubs.map((sub) => sub.categoryId);

  if (sourceIds.length === 0 && categoryIds.length === 0) {
    return [];
  }

  const articles = await prisma.article.findMany({
    where: {
      OR: [
        ...(sourceIds.length > 0 ? [{ sourceId: { in: sourceIds } }] : []),
        ...(categoryIds.length > 0 ? [{ categoryId: { in: categoryIds } }] : []),
      ],
    },
    include: {
      source: { select: { frontPageUrl: true, mediaName: true } },
    },
    orderBy: { date: "desc" },
    take: 50,
  });

  return articles.map((article) => ({
    id: article.id,
    title: article.title,
    source: extractDomain(article.source.frontPageUrl) || article.source.mediaName,
    date: formatArticleDate(article.date),
    score: article.score,
    isPaywall: article.isPaywall,
    tags: article.tags,
    reasoning: article.reasoning || "",
    signals: article.signals,
  }));
});