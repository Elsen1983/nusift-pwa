import { prisma } from "../prisma";
import {
  createPipelineRun,
  finalizePipelineRun,
  persistPipelineArtifact,
} from "./artifacts";
import { logAgentScan } from "./log";
import { ingestSource, persistCandidates } from "./ingest";
import type { PipelineResult, PipelineTarget } from "./types";

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

export async function runNewsPipeline(
  sourceIds?: string[],
  categoryIds?: string[],
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const resolvedTargets =
    sourceIds && sourceIds.length > 0
      ? await hydratePipelineTargets(sourceIds, categoryIds || [])
      : await resolveActivePipelineTargets();

  let candidatesFound = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let artifactCount = 0;
  const pipelineRun = await createPipelineRun(resolvedTargets.length);

  await logAgentScan({
    status: "PIPELINE_STARTED",
    executionTimeMs: 0,
    errorLog: `Pipeline started for ${resolvedTargets.length} target(s). runId=${pipelineRun.id}.`,
  });

  for (const target of resolvedTargets) {
    try {
      const result = await ingestSource(target.sourceId, target.categoryId || undefined);
      candidatesFound += result.candidates.length;
      await persistPipelineArtifact({
        pipelineRunId: pipelineRun.id,
        result,
      });
      artifactCount += 1;
      const persisted = await persistCandidates(result.candidates);
      inserted += persisted.inserted;
      skipped += persisted.skipped;
      failed += persisted.failed + result.failed;
    } catch {
      failed += 1;
    }
  }

  const result: PipelineResult = {
    sourcesScanned: resolvedTargets.length,
    candidatesFound,
    inserted,
    skipped,
    failed,
    artifactCount,
  };

  await finalizePipelineRun({
    pipelineRunId: pipelineRun.id,
    result,
  });

  await logAgentScan({
    status: "PIPELINE_FINISHED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Pipeline finished. runId=${pipelineRun.id}, targets=${resolvedTargets.length}, candidates=${candidatesFound}, inserted=${inserted}, skipped=${skipped}, failed=${failed}, artifacts=${artifactCount}.`,
  });

  return result;
}

async function hydratePipelineTargets(sourceIds: string[], categoryIds: string[]) {
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
