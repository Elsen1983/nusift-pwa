import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import { matchCategoryIdForUrl } from "../../utils/news-pipeline/ingest";
import { logAgentScan } from "../../utils/news-pipeline/log";
import { resolveActivePipelineSourceIds } from "../../utils/news-pipeline/orchestrator";

const normalizePathForCategoryMatch = (url: string) => {
  try {
    return (new URL(url).pathname.replace(/\/+$/, "") || "/").toLowerCase();
  } catch {
    return "/";
  }
};

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Dev endpoints disabled in production." });
  }

  await assertRateLimit(event, "backfill-article-categories", 3, 10 * 60 * 1000);

  const sourceIds = await resolveActivePipelineSourceIds();
  if (sourceIds.length === 0) {
    return { ok: true, scanned: 0, updated: 0, matchedSources: 0 };
  }

  await logAgentScan({
    status: "ARTICLE_CATEGORY_BACKFILL_STARTED",
    executionTimeMs: 0,
    errorLog: `Backfill started for ${sourceIds.length} subscribed source(s).`,
  });

  const [categories, articles] = await Promise.all([
    prisma.sourceCategory.findMany({
      where: { newsSourceId: { in: sourceIds } },
      select: { id: true, newsSourceId: true, pathUrl: true },
    }),
    prisma.article.findMany({
      where: {
        sourceId: { in: sourceIds },
        categoryId: null,
        canonicalUrl: { not: null },
      },
      select: {
        id: true,
        sourceId: true,
        canonicalUrl: true,
      },
    }),
  ]);

  const categoriesBySource = new Map<string, Array<{ id: string; normalizedPath: string }>>();
  for (const category of categories) {
    const normalizedPath = normalizePathForCategoryMatch(category.pathUrl);
    if (!normalizedPath || normalizedPath === "/") continue;
    const list = categoriesBySource.get(category.newsSourceId) || [];
    list.push({ id: category.id, normalizedPath });
    categoriesBySource.set(category.newsSourceId, list);
  }

  let updated = 0;
  for (const article of articles) {
    const matchedCategoryId = matchCategoryIdForUrl(
      article.canonicalUrl || "",
      categoriesBySource.get(article.sourceId) || [],
    );

    if (!matchedCategoryId) continue;

    await prisma.article.update({
      where: { id: article.id },
      data: { categoryId: matchedCategoryId },
    });
    updated += 1;
  }

  await logAgentScan({
    status: "ARTICLE_CATEGORY_BACKFILL_FINISHED",
    executionTimeMs: 0,
    errorLog: `Backfill finished. scanned=${articles.length}, updated=${updated}, matchedSources=${categoriesBySource.size}.`,
  });

  return {
    ok: true,
    scanned: articles.length,
    updated,
    matchedSources: categoriesBySource.size,
  };
});
