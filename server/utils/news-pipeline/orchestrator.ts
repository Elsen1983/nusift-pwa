import { prisma } from "../prisma";
import {
  createPipelineRun,
  finalizePipelineRun,
  persistHardCaseDiscoveryArtifacts,
  persistPipelineArtifact,
} from "./artifacts";
import { logAgentScan } from "./log";
import { ingestSource, persistCandidates } from "./ingest";
import { markFeedRunOutcome } from "./feed-productivity";
import { runArticleDiscoveryBatch } from "./article-discovery";
import {
  resolveActivePipelineTargets,
  hydratePipelineTargets,
} from "./targets";
import type { PipelineResult } from "./types";

export async function runNewsPipeline(
  sourceIds?: string[],
  categoryIds?: string[],
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const hasTargetFilters =
    (sourceIds && sourceIds.length > 0) || (categoryIds && categoryIds.length > 0);
  const resolvedTargets = hasTargetFilters
    ? await hydratePipelineTargets(sourceIds || [], categoryIds || [])
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
      const hardCaseArtifactCount = await persistHardCaseDiscoveryArtifacts({
        pipelineRunId: pipelineRun.id,
        result,
      });
      artifactCount += hardCaseArtifactCount;
      if (hardCaseArtifactCount > 0) {
        await logAgentScan({
          sourceId: target.sourceId,
          categoryId: target.categoryId || undefined,
          status: "HARD_CASE_DISCOVERY_QUEUED",
          executionTimeMs: 0,
          errorLog: `Queued ${hardCaseArtifactCount} hard-case discovery target(s) for later headless processing. runId=${pipelineRun.id}.`,
        });
      }
      const persisted = await persistCandidates(result.candidates);
      inserted += persisted.inserted;
      skipped += persisted.skipped;
      failed += persisted.failed + result.failed;
      await markFeedRunOutcome({
        sourceId: target.sourceId,
        categoryId: target.categoryId || undefined,
        feedUrl: result.feedUrl || null,
        productive: persisted.inserted > 0 || persisted.enriched > 0,
        shouldTrackFeedProductivity:
          Boolean(result.feedUrl) && result.feedFormat !== "html_fallback",
      });
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

  // ── Agent 2: web discovery for eligible no-RSS / not-productive targets ──
  // Runs after Agent 1 completes. Failures are isolated so they never
  // break the Agent 1 pipeline result.
  // Target-aware: a targeted Agent 1 rerun only triggers Agent 2 for the
  // same scope, preventing a broad global scan.
  try {
    await runArticleDiscoveryBatch(
      hasTargetFilters ? { sourceIds: sourceIds || [], categoryIds: categoryIds || [] } : undefined,
    );
  } catch (error: any) {
    await logAgentScan({
      status: "ARTICLE_DISCOVERY_FAILED",
      executionTimeMs: 0,
      errorLog: `Agent 2 orchestration skipped: ${error?.message || String(error)}`,
    }).catch(() => {});
  }

  return result;
}

