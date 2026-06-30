import { prisma } from "../utils/prisma";
import { requireUserId } from "../utils/require-user";

type DateWindow = "today" | "last_48h" | "last_1w" | "last_2w";

function windowStart(window: DateWindow): Date {
  const now = new Date();
  switch (window) {
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case "last_48h":
      return new Date(now.getTime() - 48 * 60 * 60 * 1000);
    case "last_1w":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "last_2w":
      return new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    default:
      return new Date(now.getTime() - 48 * 60 * 60 * 1000);
  }
}

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
  const userId = requireUserId(event);
  const query = getQuery(event);

  const window = (typeof query.window === "string" ? query.window : "last_48h") as DateWindow;
  const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 50);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true },
  });

  if ((window === "last_1w" || window === "last_2w") && user?.tier !== "PRO") {
    throw createError({ statusCode: 403, statusMessage: "PRO tier required for this date window." });
  }

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

  const sourceIds = sourceSubs.map((s) => s.sourceId);
  const categoryIds = categorySubs.map((s) => s.categoryId);

  if (sourceIds.length === 0 && categoryIds.length === 0) {
    return { items: [], total: 0, limit, offset };
  }

  const since = windowStart(window);
  const where = {
    date: { gte: since },
    OR: [
      ...(sourceIds.length ? [{ sourceId: { in: sourceIds } }] : []),
      ...(categoryIds.length ? [{ categoryId: { in: categoryIds } }] : []),
    ],
  };

  const [articles, total] = await Promise.all([
    prisma.article.findMany({
      where,
      include: { source: { select: { frontPageUrl: true, mediaName: true } } },
      orderBy: [{ date: "desc" }],
      take: limit,
      skip: offset,
    }),
    prisma.article.count({ where }),
  ]);

  return {
    items: articles.map((article) => ({
      id: article.id,
      title: article.title,
      source: extractDomain(article.source.frontPageUrl) || article.source.mediaName,
      date: formatArticleDate(article.date),
      score: article.score,
      isPaywall: article.isPaywall,
      tags: article.tags,
      reasoning: article.reasoning ?? article.summary ?? "",
      signals: article.signals,
      canonicalUrl: article.canonicalUrl,
    })),
    total,
    limit,
    offset,
  };
});