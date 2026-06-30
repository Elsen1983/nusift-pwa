import { Prisma } from "@prisma/client";
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

type FeedRow = {
  id: number;
  title: string;
  date: Date;
  score: number;
  isPaywall: boolean;
  tags: string[];
  reasoning: string | null;
  signals: string[];
  canonicalUrl: string;
  summary: string | null;
  frontPageUrl: string;
  mediaName: string;
  rank_score: number | null;
  rank_reasoning: string | null;
  rank_signals: string[] | null;
};

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
  const subscriptionClauses: Prisma.Sql[] = [];
  if (sourceIds.length > 0) {
    subscriptionClauses.push(Prisma.sql`a."sourceId" IN (${Prisma.join(sourceIds)})`);
  }
  if (categoryIds.length > 0) {
    subscriptionClauses.push(Prisma.sql`a."categoryId" IN (${Prisma.join(categoryIds)})`);
  }

  const subscriptionFilter =
    subscriptionClauses.length === 1
      ? subscriptionClauses[0]!
      : Prisma.sql`(${Prisma.join(subscriptionClauses, " OR ")})`;

  const [rows, countRows] = await Promise.all([
    prisma.$queryRaw<FeedRow[]>`
      SELECT
        a.id,
        a.title,
        a.date,
        a.score,
        a."isPaywall",
        a.tags,
        a.reasoning,
        a.signals,
        a."canonicalUrl",
        a.summary,
        s."frontPageUrl",
        s."mediaName",
        uar.score AS rank_score,
        uar.reasoning AS rank_reasoning,
        uar.signals AS rank_signals
      FROM "Article" a
      INNER JOIN "NewsSource" s ON s.id = a."sourceId"
      LEFT JOIN "UserArticleRank" uar
        ON uar."articleId" = a.id AND uar."userId" = ${userId}
      WHERE a.date >= ${since}
        AND ${subscriptionFilter}
      ORDER BY COALESCE(uar.score, a.score) DESC, a.date DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `,
    prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*)::bigint AS total
      FROM "Article" a
      WHERE a.date >= ${since}
        AND ${subscriptionFilter}
    `,
  ]);

  const total = Number(countRows[0]?.total ?? 0);

  return {
    items: rows.map((article) => ({
      id: article.id,
      title: article.title,
      source: extractDomain(article.frontPageUrl) || article.mediaName,
      date: formatArticleDate(article.date),
      score: article.rank_score ?? article.score,
      isPaywall: article.isPaywall,
      tags: article.tags,
      reasoning: article.rank_reasoning ?? article.reasoning ?? article.summary ?? "",
      signals: article.rank_signals ?? article.signals,
      canonicalUrl: article.canonicalUrl,
    })),
    total,
    limit,
    offset,
  };
});