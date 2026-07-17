import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import {
  isFallbackFeedItemRelevantToCategory,
  matchCategoryIdForUrl,
} from "../../utils/news-pipeline/ingest";
import { logAgentScan } from "../../utils/news-pipeline/log";
import { resolveActivePipelineTargets } from "../../utils/news-pipeline/targets";

const ENRICH_WINDOW_DAYS = 7;

const formatCategoryTag = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (/^[a-z]{2,4}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  return trimmed
    .split(/[\s/-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (
    process.env.NODE_ENV === "production" &&
    process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true"
  ) {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "enrich-existing-articles", 3, 10 * 60 * 1000);

  const activeTargets = await resolveActivePipelineTargets();
  const categoryTargets = activeTargets.filter((target) => target.categoryId);
  if (categoryTargets.length === 0) {
    return { ok: true, scanned: 0, updated: 0, tagged: 0, matchedCategories: 0 };
  }

  const categoryIds = [...new Set(categoryTargets.map((target) => target.categoryId!))];
  const sourceIds = [...new Set(categoryTargets.map((target) => target.sourceId))];

  await logAgentScan({
    status: "ARTICLE_ENRICHMENT_STARTED",
    executionTimeMs: 0,
    errorLog: `Article enrichment started for ${categoryIds.length} active category target(s) across ${sourceIds.length} source(s).`,
  });

  const cutoff = new Date(Date.now() - ENRICH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [categories, articles] = await Promise.all([
    prisma.sourceCategory.findMany({
      where: { id: { in: categoryIds } },
      select: {
        id: true,
        newsSourceId: true,
        pathUrl: true,
        name: true,
      },
    }),
    prisma.article.findMany({
      where: {
        sourceId: { in: sourceIds },
        date: { gte: cutoff },
        OR: [{ categoryId: null }, { tags: { equals: [] } }],
      },
      select: {
        id: true,
        sourceId: true,
        canonicalUrl: true,
        title: true,
        bodyText: true,
        categoryId: true,
        tags: true,
      },
      orderBy: [{ date: "desc" }, { id: "desc" }],
    }),
  ]);

  const categoriesBySource = new Map<
    string,
    Array<{ id: string; pathUrl: string; name: string; normalizedPath: string }>
  >();

  for (const category of categories) {
    const existing = categoriesBySource.get(category.newsSourceId) || [];
    existing.push({
      id: category.id,
      pathUrl: category.pathUrl,
      name: category.name,
      normalizedPath: new URL(category.pathUrl).pathname.replace(/\/+$/, "").toLowerCase() || "/",
    });
    categoriesBySource.set(category.newsSourceId, existing);
  }

  let updated = 0;
  let tagged = 0;

  for (const article of articles) {
    const candidateCategories = categoriesBySource.get(article.sourceId) || [];
    if (candidateCategories.length === 0) continue;

    const matchedByPath = matchCategoryIdForUrl(article.canonicalUrl || "", candidateCategories);
    let matchedCategory =
      candidateCategories.find((category) => category.id === matchedByPath) || null;

    if (!matchedCategory) {
      matchedCategory =
        candidateCategories.find((category) =>
          isFallbackFeedItemRelevantToCategory(category.pathUrl, {
            title: article.title,
            description: article.bodyText,
            categories: article.tags,
          }),
        ) || null;
    }

    if (!matchedCategory) continue;

    const nextTag =
      !article.tags || article.tags.length === 0 ? formatCategoryTag(matchedCategory.name) : "";
    const nextData = {
      ...(article.categoryId ? {} : { categoryId: matchedCategory.id }),
      ...(nextTag ? { tags: [nextTag] } : {}),
    };

    if (Object.keys(nextData).length === 0) continue;

    await prisma.article.update({
      where: { id: article.id },
      data: nextData,
    });

    updated += article.categoryId ? 0 : 1;
    tagged += nextTag ? 1 : 0;
  }

  await logAgentScan({
    status: "ARTICLE_ENRICHMENT_FINISHED",
    executionTimeMs: 0,
    errorLog: `Article enrichment finished. scanned=${articles.length}, updated=${updated}, tagged=${tagged}, matchedCategories=${categories.length}.`,
  });

  return {
    ok: true,
    scanned: articles.length,
    updated,
    tagged,
    matchedCategories: categories.length,
  };
});
