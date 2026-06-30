import { IngestStatus } from "@prisma/client";
import { prisma } from "../prisma";
import { buildUserRankingContext, findEligibleUserIdsForArticle } from "./context";
import { scoreArticleHeuristic } from "./heuristic";

export interface RankStats {
  articlesProcessed: number;
  usersProcessed: number;
  ranksWritten: number;
  errors: number;
  errorLines: string[];
}

export async function rankPendingArticles(options?: {
  articleLimit?: number;
}): Promise<RankStats> {
  const articleLimit = options?.articleLimit ?? 100;

  const stats: RankStats = {
    articlesProcessed: 0,
    usersProcessed: 0,
    ranksWritten: 0,
    errors: 0,
    errorLines: [],
  };

  const pending = await prisma.article.findMany({
    where: { ingestStatus: IngestStatus.NEEDS_RANKING },
    take: articleLimit,
    orderBy: { createdAt: "asc" },
    include: {
      source: { select: { countryCode: true, continent: true } },
      category: { select: { name: true } },
    },
  });

  const contextCache = new Map<string, Awaited<ReturnType<typeof buildUserRankingContext>>>();

  for (const article of pending) {
    stats.articlesProcessed += 1;

    try {
      const userIds = await findEligibleUserIdsForArticle({
        sourceId: article.sourceId,
        categoryId: article.categoryId,
      });

      for (const userId of userIds) {
        stats.usersProcessed += 1;

        let context = contextCache.get(userId);
        if (!context) {
          context = await buildUserRankingContext(userId);
          contextCache.set(userId, context);
        }

        const result = scoreArticleHeuristic(
          {
            id: article.id,
            title: article.title,
            summary: article.summary,
            tags: article.tags,
            date: article.date,
            sourceId: article.sourceId,
            categoryId: article.categoryId,
            sourceCountryCode: article.source.countryCode,
            sourceContinent: article.source.continent,
            categoryName: article.category?.name ?? null,
          },
          context,
        );

        await prisma.userArticleRank.upsert({
          where: {
            userId_articleId: { userId, articleId: article.id },
          },
          create: {
            userId,
            articleId: article.id,
            score: result.score,
            reasoning: result.reasoning,
            signals: result.signals,
          },
          update: {
            score: result.score,
            reasoning: result.reasoning,
            signals: result.signals,
            rankedAt: new Date(),
          },
        });
        stats.ranksWritten += 1;
      }

      await prisma.article.update({
        where: { id: article.id },
        data: { ingestStatus: IngestStatus.RANKED },
      });
    } catch (error: any) {
      stats.errors += 1;
      stats.errorLines.push(`article ${article.id}: ${error?.message ?? error}`);
    }
  }

  return stats;
}