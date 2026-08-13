/**
 * Full local Docker pipeline runner.
 *
 * This intentionally calls the same Agent 1/2/3 stage services and shared
 * production limits as the daily workflow. It drains actionable local work
 * without durable workflow sleeps, so publisher cooldowns remain deferred
 * instead of making a developer wait for them.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { prisma } from "../../server/utils/prisma";
import { runAgent1Batch } from "../../server/utils/news-pipeline/orchestrator";
import { runArticleDiscoveryBatch } from "../../server/utils/news-pipeline/article-discovery";
import { runAgent2HeadlessWorkflowBatch } from "../../server/utils/news-pipeline/agent2-headless-workflow-batch";
import { runAgent3WorkflowBatch } from "../../server/utils/news-pipeline/agent3-workflow-batch";
import {
  DAILY_PIPELINE_STAGES,
  STAGE_BATCH_SIZE_LIMIT,
  STAGE_CONCURRENCY_LIMIT,
  STAGE_MIN_REMAINING_MS,
  STAGE_TIME_BUDGET_MS,
  type DailyPipelineStage,
} from "../../server/utils/news-pipeline/daily-pipeline-stage-contract";
import { persistStageBatchTelemetry } from "../../server/utils/news-pipeline/stage-telemetry-server";
import { StageBatchTelemetryTracker, type StageBatchTelemetry } from "../../server/utils/news-pipeline/stage-telemetry";

type LocalStageResult = {
  stage: DailyPipelineStage;
  processed: number;
  remaining: number;
  complete: boolean;
  deferred?: number;
  nextRetryAt?: string | null;
  browserFallbackStats?: unknown;
  telemetry: StageBatchTelemetry;
};

type LocalStageOutcome = {
  stage: DailyPipelineStage;
  status: "completed" | "degraded" | "failed";
  batches: number;
  processed: number;
  remaining: number | null;
  deferred: number;
  nextRetryAt: string | null;
  reason: string | null;
};

type LocalAgent3Summary = {
  articleCount: number;
  persisted: number;
  persistFailed: number;
  durationMs: number;
  byKind: Record<string, number>;
  browserFallbackStats: {
    enabled: boolean;
    attempted: number;
    succeeded: number;
    failed: number;
    runtimeUnavailable: number;
    rateLimited: number;
    stoppedReason: null;
  };
  optionsUsed: {
    browserFallback: boolean;
    browserFallbackMaxAttempts: number;
    browserTimeoutMs: number;
    includeEnriched: boolean;
    forceReprocess: boolean;
    maxArticles: number;
    maxArticlesPerSource: number;
  };
};

const parseArgs = () => {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match?.[1] && match[2] !== undefined) args.set(match[1], match[2]);
  }
  return args;
};

const readBoundedInteger = (args: Map<string, string>, key: string, fallback: number, min: number, max: number) => {
  const value = Number(args.get(key));
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
};

const assertLocalDatabase = () => {
  if (process.env.NUSIFT_LOCAL_DOCKER_PIPELINE !== "true") {
    throw new Error("Local Docker pipeline guard is not enabled.");
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required.");
  let hostname = "";
  try {
    hostname = new URL(raw).hostname.toLowerCase();
  } catch {
    throw new Error("DATABASE_URL is invalid.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);
  if (!localHosts.has(hostname)) {
    throw new Error(`Refusing non-local DATABASE_URL host: ${hostname || "unknown"}.`);
  }
};

const persistTelemetryBestEffort = async (pipelineRunId: string, telemetry: StageBatchTelemetry) => {
  try {
    await persistStageBatchTelemetry({ pipelineRunId, telemetry });
  } catch {
    console.error("[local-pipeline] Stage telemetry persistence failed.", {
      stage: telemetry.stage,
      batchSeq: telemetry.batchSeq,
    });
  }
};

const readCount = (value: unknown): number => (
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
);

const aggregateLocalAgent3Summary = (batches: readonly LocalStageResult[]): LocalAgent3Summary | null => {
  if (batches.length === 0) return null;
  const byKind: {
    SUCCESS: number;
    RETRYABLE_FAILURE: number;
    TERMINAL_FAILURE: number;
    SKIPPED: number;
    DEFERRED: number;
    QUARANTINED: number;
  } = {
    SUCCESS: 0,
    RETRYABLE_FAILURE: 0,
    TERMINAL_FAILURE: 0,
    SKIPPED: 0,
    DEFERRED: 0,
    QUARANTINED: 0,
  };
  const browser = {
    enabled: process.env.NUXT_AGENT3_WORKFLOW_BROWSER_FALLBACK !== "false",
    attempted: 0,
    succeeded: 0,
    failed: 0,
    runtimeUnavailable: 0,
    rateLimited: 0,
    stoppedReason: null,
  };
  let articleCount = 0;
  let persisted = 0;
  let persistFailed = 0;
  let durationMs = 0;
  for (const batch of batches) {
    const telemetry = batch.telemetry;
    articleCount += telemetry.processed;
    persisted += Math.max(0, telemetry.processed - (telemetry.claimLost ?? 0) - (telemetry.persistenceFailed ?? 0));
    persistFailed += telemetry.persistenceFailed ?? 0;
    durationMs += telemetry.durationMs;
    byKind.SUCCESS += telemetry.succeeded;
    byKind.RETRYABLE_FAILURE += telemetry.failedRetryable;
    byKind.TERMINAL_FAILURE += telemetry.failedPermanent;
    byKind.SKIPPED += telemetry.skipped;
    byKind.DEFERRED += telemetry.deferred;
    byKind.QUARANTINED += telemetry.quarantined;
    const stats = batch.browserFallbackStats;
    if (stats && typeof stats === "object" && !Array.isArray(stats)) {
      const value = stats as Record<string, unknown>;
      browser.attempted += readCount(value.attempted);
      browser.succeeded += readCount(value.succeeded);
      browser.failed += readCount(value.failed);
      browser.runtimeUnavailable += readCount(value.runtimeUnavailable);
      browser.rateLimited += readCount(value.rateLimited);
    }
  }
  return {
    articleCount,
    persisted,
    persistFailed,
    durationMs,
    byKind,
    browserFallbackStats: browser,
    optionsUsed: {
      browserFallback: process.env.NUXT_AGENT3_WORKFLOW_BROWSER_FALLBACK !== "false",
      browserFallbackMaxAttempts: 2,
      browserTimeoutMs: 25_000,
      includeEnriched: false,
      forceReprocess: false,
      maxArticles: STAGE_BATCH_SIZE_LIMIT.agent3,
      maxArticlesPerSource: 2,
    },
  };
};

const runStaticStage = async (
  pipelineRunId: string,
  stage: "agent1" | "agent2-static",
  batchSeq: number,
  remainingBefore: number | null,
): Promise<LocalStageResult> => {
  const tracker = new StageBatchTelemetryTracker({
    orchestrationRunId: pipelineRunId,
    stage,
    batchSeq,
    batchSizeLimit: STAGE_BATCH_SIZE_LIMIT[stage],
    concurrencyLimit: STAGE_CONCURRENCY_LIMIT[stage],
  });
  if (stage === "agent1") {
    const result = await runAgent1Batch({
      maxTargets: STAGE_BATCH_SIZE_LIMIT.agent1,
      timeBudgetMs: STAGE_TIME_BUDGET_MS,
      minRemainingMs: STAGE_MIN_REMAINING_MS,
      telemetry: tracker,
      orchestrationRunId: pipelineRunId,
      manifestInvocationKey: `agent1:${batchSeq}`,
    });
    const telemetry = tracker.finalize({
      processed: result.selectedTargets,
      ...result.targetDispositions,
      productivity: result.productivity,
      remainingBefore,
      remainingAfter: result.remainingEligible,
      complete: result.remainingEligible === 0,
    });
    await persistTelemetryBestEffort(pipelineRunId, telemetry);
    return { stage, processed: result.processed, remaining: result.remainingEligible, complete: result.remainingEligible === 0, deferred: result.deferred, telemetry };
  }

  const result = await runArticleDiscoveryBatch({
    maxTargets: STAGE_BATCH_SIZE_LIMIT["agent2-static"],
    timeBudgetMs: STAGE_TIME_BUDGET_MS,
    minRemainingMs: STAGE_MIN_REMAINING_MS,
    telemetry: tracker,
    orchestrationRunId: pipelineRunId,
    manifestInvocationKey: `agent2-static:${batchSeq}`,
  });
  const telemetry = tracker.finalize({
    processed: result.selectedTargets,
    ...result.targetDispositions,
    productivity: result.productivity,
    remainingBefore,
    remainingAfter: result.remainingEligible,
    complete: result.remainingEligible === 0,
  });
  await persistTelemetryBestEffort(pipelineRunId, telemetry);
  return { stage, processed: result.processed, remaining: result.remainingEligible, complete: result.remainingEligible === 0, deferred: result.deferred, telemetry };
};

const runStage = async (
  pipelineRunId: string,
  stage: DailyPipelineStage,
  batchSeq: number,
  remainingBefore: number | null,
): Promise<LocalStageResult> => {
  if (stage === "agent1" || stage === "agent2-static") {
    return runStaticStage(pipelineRunId, stage, batchSeq, remainingBefore);
  }
  if (stage === "agent2-headless") {
    return runAgent2HeadlessWorkflowBatch({
      orchestrationRunId: pipelineRunId,
      batchSeq,
      remainingBefore,
      sleepMs: 0,
    });
  }
  return runAgent3WorkflowBatch({
    orchestrationRunId: pipelineRunId,
    batchSeq,
    remainingBefore,
    sleepMs: 0,
  });
};

const runStageToCurrentCompletion = async (
  pipelineRunId: string,
  stage: DailyPipelineStage,
  maxBatches: number,
  onBatch?: (batch: LocalStageResult) => void,
): Promise<LocalStageOutcome> => {
  let previousRemaining: number | null = null;
  let totalProcessed = 0;
  let lastDeferred = 0;
  let lastRetryAt: string | null = null;
  for (let batchSeq = 1; batchSeq <= maxBatches; batchSeq += 1) {
    const batch = await runStage(pipelineRunId, stage, batchSeq, previousRemaining);
    onBatch?.(batch);
    totalProcessed += batch.processed;
    lastDeferred = batch.deferred ?? 0;
    lastRetryAt = batch.nextRetryAt ?? null;
    if (batch.complete) {
      return { stage, status: "completed", batches: batchSeq, processed: totalProcessed, remaining: batch.remaining, deferred: lastDeferred, nextRetryAt: lastRetryAt, reason: null };
    }
    if (batch.processed === 0 || (previousRemaining !== null && batch.remaining >= previousRemaining)) {
      return {
        stage,
        status: "degraded",
        batches: batchSeq,
        processed: totalProcessed,
        remaining: batch.remaining,
        deferred: lastDeferred,
        nextRetryAt: lastRetryAt,
        reason: "No immediate progress. Deferred and cooldown work remains for a future run.",
      };
    }
    previousRemaining = batch.remaining;
  }
  return {
    stage,
    status: "degraded",
    batches: maxBatches,
    processed: totalProcessed,
    remaining: previousRemaining,
    deferred: lastDeferred,
    nextRetryAt: lastRetryAt,
    reason: `Safety ceiling reached after ${maxBatches} batches.`,
  };
};

const args = parseArgs();
const maxBatchesPerStage = readBoundedInteger(args, "maxBatchesPerStage", 1_000, 1, 10_000);

assertLocalDatabase();
const orchestrationId = randomUUID();
const pipelineRun = await prisma.pipelineRun.create({
  data: {
    status: "LOCAL_DOCKER_PIPELINE_RUNNING",
    summary: {
      kind: "local_docker_pipeline",
      orchestrationId,
      startedAt: new Date().toISOString(),
      contract: "daily-pipeline-stage-contract-v1",
      notifications: "disabled_local_sandbox",
    },
  },
  select: { id: true },
});

const outcomes: LocalStageOutcome[] = [];
const agent3Batches: LocalStageResult[] = [];
try {
  for (const stage of DAILY_PIPELINE_STAGES) {
    try {
      outcomes.push(await runStageToCurrentCompletion(
        pipelineRun.id,
        stage,
        maxBatchesPerStage,
        stage === "agent3" ? (batch) => agent3Batches.push(batch) : undefined,
      ));
    } catch (error) {
      outcomes.push({
        stage,
        status: "failed",
        batches: 0,
        processed: 0,
        remaining: null,
        deferred: 0,
        nextRetryAt: null,
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
  }
  const status = outcomes.some((outcome) => outcome.status === "failed")
    ? "LOCAL_DOCKER_PIPELINE_COMPLETED_PARTIAL"
    : outcomes.some((outcome) => outcome.status === "degraded")
      ? "LOCAL_DOCKER_PIPELINE_COMPLETED_PARTIAL"
      : "LOCAL_DOCKER_PIPELINE_COMPLETED";
  const agent3Summary = aggregateLocalAgent3Summary(agent3Batches);
  if (agent3Summary) {
    await prisma.pipelineArtifact.create({
      data: {
        pipelineRunId: pipelineRun.id,
        orchestrationRunId: pipelineRun.id,
        sourceId: null,
        categoryId: null,
        artifactType: "agent3_orchestration_summary",
        status: "CAPTURED",
        candidateCount: agent3Summary.articleCount,
        payload: {
          schemaVersion: 1,
          stage: "agent3",
          runKind: "local_docker_pipeline",
          batchCount: agent3Batches.length,
          enrichmentSummary: agent3Summary,
        },
        errorLog: null,
      },
    });
  }
  await prisma.pipelineRun.update({
    where: { id: pipelineRun.id },
    data: {
      status,
      finishedAt: new Date(),
      summary: {
        kind: "local_docker_pipeline",
        orchestrationId,
        contract: "daily-pipeline-stage-contract-v1",
        notifications: "disabled_local_sandbox",
        outcomes,
        agent3Summary,
      },
    },
  });
  console.log(JSON.stringify({ ok: true, pipelineRunId: pipelineRun.id, status, outcomes }, null, 2));
} finally {
  await prisma.$disconnect();
}
