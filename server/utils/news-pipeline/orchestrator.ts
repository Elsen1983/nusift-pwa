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

export async function runNewsPipeline(sourceIds?: string[]): Promise<PipelineResult> {
  const startedAt = Date.now();
  const sources = sourceIds?.length
    ? await prisma.newsSource.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true },
      })
    : await prisma.newsSource.findMany({
        where: { rssStatus: "ACTIVE" },
        select: { id: true },
      });

  let candidatesFound = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  await logAgentScan({
    status: "PIPELINE_STARTED",
    executionTimeMs: 0,
    errorLog: `Pipeline started for ${sources.length} source(s).`,
  });

  for (const source of sources) {
    try {
      const result = await ingestSource(source.id);
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
    errorLog: `Pipeline finished. sources=${sources.length}, candidates=${candidatesFound}, inserted=${inserted}, skipped=${skipped}, failed=${failed}.`,
  });

  return {
    sourcesScanned: sources.length,
    candidatesFound,
    inserted,
    skipped,
    failed,
  };
}
