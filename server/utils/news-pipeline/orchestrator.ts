import { prisma } from "../prisma";
import { logAgentScan } from "./log";
import { ingestSource, persistCandidates } from "./ingest";
import type { PipelineResult } from "./types";

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

export async function runNewsPipeline(sourceIds?: string[]): Promise<PipelineResult> {
  const startedAt = Date.now();
  const resolvedSourceIds =
    sourceIds && sourceIds.length > 0 ? sourceIds : await resolveActivePipelineSourceIds();

  let candidatesFound = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  await logAgentScan({
    status: "PIPELINE_STARTED",
    executionTimeMs: 0,
    errorLog: `Pipeline started for ${resolvedSourceIds.length} source(s).`,
  });

  for (const sourceId of resolvedSourceIds) {
    try {
      const result = await ingestSource(sourceId);
      candidatesFound += result.candidates.length;
      const persisted = await persistCandidates(result.candidates);
      inserted += persisted.inserted;
      skipped += persisted.skipped;
      failed += persisted.failed + result.failed;
    } catch {
      failed += 1;
    }
  }

  await logAgentScan({
    status: "PIPELINE_FINISHED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Pipeline finished. sources=${resolvedSourceIds.length}, candidates=${candidatesFound}, inserted=${inserted}, skipped=${skipped}, failed=${failed}.`,
  });

  return {
    sourcesScanned: resolvedSourceIds.length,
    candidatesFound,
    inserted,
    skipped,
    failed,
  };
}
