import { prisma } from "../prisma";
import type { PipelineTarget } from "./types";

/**
 * Resolve all source IDs that have at least one active user subscription
 * (source-level or category-level).
 */
export async function resolveUserSourceIds(userId: string) {
  const [sourceSubs, categorySubs] = await Promise.all([
    prisma.userSourceSubscription.findMany({
      where: { userId, isActive: true },
      select: { sourceId: true },
    }),
    prisma.userCategorySubscription.findMany({
      where: { userId, isActive: true },
      select: { category: { select: { newsSourceId: true } } },
    }),
  ]);

  const ids = new Set<string>();
  sourceSubs.forEach((sub) => ids.add(sub.sourceId));
  categorySubs.forEach((sub) => {
    if (sub.category?.newsSourceId) ids.add(sub.category.newsSourceId);
  });

  return [...ids];
}

/**
 * Resolve all source IDs that have at least one active user subscription
 * across all users (source-level or category-level).
 */
export async function resolveActivePipelineSourceIds() {
  const [sourceSubs, categorySubs] = await Promise.all([
    prisma.userSourceSubscription.findMany({
      where: { isActive: true },
      select: { sourceId: true },
    }),
    prisma.userCategorySubscription.findMany({
      where: { isActive: true },
      select: { category: { select: { newsSourceId: true } } },
    }),
  ]);

  const ids = new Set<string>();
  sourceSubs.forEach((sub) => ids.add(sub.sourceId));
  categorySubs.forEach((sub) => {
    if (sub.category?.newsSourceId) ids.add(sub.category.newsSourceId);
  });

  return [...ids];
}

/**
 * Resolve all active pipeline targets (source and category) that have
 * at least one active user subscription.
 */
export async function resolveActivePipelineTargets() {
  const [sourceSubs, categorySubs] = await Promise.all([
    prisma.userSourceSubscription.findMany({
      where: { isActive: true },
      select: { sourceId: true },
    }),
    prisma.userCategorySubscription.findMany({
      where: { isActive: true },
      select: { categoryId: true, category: { select: { newsSourceId: true } } },
    }),
  ]);

  const targets: PipelineTarget[] = [];
  const seen = new Set<string>();

  for (const sub of sourceSubs) {
    const key = `${sub.sourceId}|`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ sourceId: sub.sourceId });
  }

  for (const sub of categorySubs) {
    if (!sub.category?.newsSourceId) continue;
    const key = `${sub.category.newsSourceId}|${sub.categoryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ sourceId: sub.category.newsSourceId, categoryId: sub.categoryId });
  }

  return targets;
}

/**
 * Build pipeline targets from explicit source/category ID lists.
 * Used by targeted pipeline reruns.
 */
export async function hydratePipelineTargets(sourceIds: string[], categoryIds: string[]) {
  const targets: PipelineTarget[] = [];
  const seen = new Set<string>();
  const categories = categoryIds.length
    ? await prisma.sourceCategory.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, newsSourceId: true },
      })
    : [];
  const categoryById = new Map(categories.map((category) => [category.id, category.newsSourceId]));

  for (const sourceId of sourceIds) {
    const key = `${sourceId}|`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ sourceId });
  }

  for (const categoryId of categoryIds) {
    const mappedSourceId = categoryById.get(categoryId);
    if (!mappedSourceId) continue;
    const key = `${mappedSourceId}|${categoryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ sourceId: mappedSourceId, categoryId });
  }

  return targets;
}
