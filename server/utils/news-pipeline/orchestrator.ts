import { prisma } from "../prisma";
import {
  createPipelineRun,
  finalizePipelineRun,
  persistAgent1TargetOutcomeArtifact,
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

export type RunNewsPipelineOptions = {
  /**
   * When true, run Agent 2 article discovery batch after Agent 1 completes.
   * Default: false. Admin/cron endpoints run Agent 1 only by default.
   * User-facing flows also run A1 only; Agent 2 picks up eligible targets
   * on the next scheduled batch.
   */
  runAgent2Afterwards?: boolean;
};

export async function runNewsPipeline(
  sourceIds?: string[],
  categoryIds?: string[],
  options?: RunNewsPipelineOptions,
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
      await persistAgent1TargetOutcomeArtifact({
        pipelineRunId: pipelineRun.id,
        result,
        persisted,
      });
      artifactCount += 1;
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
  // Only runs when explicitly requested via runAgent2Afterwards option.
  // No user-facing flow currently passes true. Agent 2 picks up eligible
  // targets on the next scheduled cron batch.
  if (options?.runAgent2Afterwards) {
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
  }

  return result;
}
