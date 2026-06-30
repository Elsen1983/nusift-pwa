import { prisma } from "../prisma";

export interface UserInterestProfile {
  id: string;
  name: string;
  weight: number;
  prompt: string;
  chips: string[];
}

export interface UserRankingContext {
  userId: string;
  primaryRegion: string | null;
  interests: UserInterestProfile[];
  subscribedSourceIds: Set<string>;
  subscribedCategoryIds: Set<string>;
  sourceRatingAvg: Map<string, number>;
  recentSourceReads: Map<string, number>;
}

function parseInterests(raw: unknown): UserInterestProfile[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const name = typeof item.name === "string" ? item.name : "";
      if (!name) return null;

      return {
        id: typeof item.id === "string" ? item.id : name.toLowerCase().replace(/\s+/g, "_"),
        name,
        weight: typeof item.weight === "number" ? Math.min(Math.max(item.weight, 0), 100) : 50,
        prompt: typeof item.prompt === "string" ? item.prompt : "",
        chips: Array.isArray(item.chips)
          ? item.chips.filter((chip): chip is string => typeof chip === "string")
          : [],
      };
    })
    .filter((item): item is UserInterestProfile => item !== null);
}

export async function buildUserRankingContext(userId: string): Promise<UserRankingContext> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [user, sourceSubs, categorySubs, ratings, reads] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { primaryRegion: true, topInterests: true },
    }),
    prisma.userSourceSubscription.findMany({
      where: { userId, isActive: true },
      select: { sourceId: true },
    }),
    prisma.userCategorySubscription.findMany({
      where: { userId, isActive: true },
      select: { categoryId: true },
    }),
    prisma.articleRating.findMany({
      where: { userId },
      select: { score: true, article: { select: { sourceId: true } } },
      take: 200,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.userReadActivity.findMany({
      where: { userId, timestamp: { gte: since } },
      select: { article: { select: { sourceId: true } } },
      take: 500,
    }),
  ]);

  const sourceRatingAvg = new Map<string, { total: number; count: number }>();
  for (const rating of ratings) {
    const bucket = sourceRatingAvg.get(rating.article.sourceId) ?? { total: 0, count: 0 };
    bucket.total += rating.score;
    bucket.count += 1;
    sourceRatingAvg.set(rating.article.sourceId, bucket);
  }

  const sourceRatingAvgNormalized = new Map<string, number>();
  for (const [sourceId, bucket] of sourceRatingAvg) {
    sourceRatingAvgNormalized.set(sourceId, bucket.total / bucket.count);
  }

  const recentSourceReads = new Map<string, number>();
  for (const read of reads) {
    const sourceId = read.article.sourceId;
    recentSourceReads.set(sourceId, (recentSourceReads.get(sourceId) ?? 0) + 1);
  }

  return {
    userId,
    primaryRegion: user?.primaryRegion ?? null,
    interests: parseInterests(user?.topInterests),
    subscribedSourceIds: new Set(sourceSubs.map((sub) => sub.sourceId)),
    subscribedCategoryIds: new Set(categorySubs.map((sub) => sub.categoryId)),
    sourceRatingAvg: sourceRatingAvgNormalized,
    recentSourceReads,
  };
}

export async function findEligibleUserIdsForArticle(article: {
  sourceId: string;
  categoryId: string | null;
}): Promise<string[]> {
  const [sourceUsers, categoryUsers] = await Promise.all([
    prisma.userSourceSubscription.findMany({
      where: { sourceId: article.sourceId, isActive: true },
      select: { userId: true },
    }),
    article.categoryId
      ? prisma.userCategorySubscription.findMany({
          where: { categoryId: article.categoryId, isActive: true },
          select: { userId: true },
        })
      : Promise.resolve([]),
  ]);

  return [...new Set([...sourceUsers.map((u) => u.userId), ...categoryUsers.map((u) => u.userId)])];
}