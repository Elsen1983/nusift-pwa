import { FatalError, sleep } from "workflow";
import {
  summarizeStageTimings,
  StageBatchTelemetryTracker,
  type PipelineStageTimingSummary,
  type StageBatchTelemetry,
} from "../utils/news-pipeline/stage-telemetry";

/**
 * Step wrapper for attaching a no-progress reason to the failed batch's
 * telemetry artifact. DB writes in a durable workflow must live inside steps
 * so they are not re-executed on replay; this keeps the workflow body pure.
 */
async function recordStageBatchNoProgress(
  orchestrationRunId: string,
  stage: DailyPipelineStage,
  batchSeq: number,
  reason: string,
) {
  "use step";
  const { attachStageBatchNoProgressReason } =
    await import("../utils/news-pipeline/stage-telemetry-server");
  await attachStageBatchNoProgressReason({
    pipelineRunId: orchestrationRunId,
    stage,
    batchSeq,
    reason,
  });
}
export const DAILY_PIPELINE_STAGES = [
  "agent1",
  "agent2-static",
  "agent2-headless",
  "agent3",
] as const;

export type DailyPipelineStage = (typeof DAILY_PIPELINE_STAGES)[number];

type StageBatchResult = {
  stage: DailyPipelineStage;
  processed: number;
  remaining: number;
  complete: boolean;
  succeeded?: number;
  failedRetryable?: number;
  deferred?: number;
  quarantined?: number;
  readyNew?: number;
  readyRetry?: number;
  retryableNow?: number;
  nextRetryAt?: string | null;
  /** Durable per-batch telemetry record (always present in production runs). */
  telemetry?: StageBatchTelemetry;
};

const LOCK_STATUS = "DAILY_PIPELINE_WORKFLOW_RUNNING";
const LOCK_STALE_AFTER_MS = 22 * 60 * 60 * 1000;
const MAX_BATCHES_BEFORE_YIELD = 20;
const FAIRNESS_YIELD = "1m";
const STAGNANT_BATCHES_BEFORE_BACKOFF = 3;
const STAGNANT_BACKOFF = "30m";
const MAX_STAGNANT_BACKOFFS = 1;

/** Phase 1 is serial; these are measured active-operation limits, not batch sizes. */
const STAGE_CONCURRENCY_LIMIT: Record<DailyPipelineStage, number> = {
  agent1: 1,
  "agent2-static": 1,
  "agent2-headless": 1,
  agent3: 1,
};

/** Bounded work selected per stage batch; kept separate from active concurrency. */
const STAGE_BATCH_SIZE_LIMIT: Record<DailyPipelineStage, number> = {
  agent1: 5,
  "agent2-static": 5,
  "agent2-headless": 3,
  agent3: 10,
};

export type DailyPipelineWorkflowInput = {
  orchestrationId: string;
  triggeredAt: string;
};

export type DailyPipelineWorkflowResult = {
  orchestrationId: string;
  orchestrationRunId: string | null;
  skipped: boolean;
  completedStages: DailyPipelineStage[];
  notificationsProcessed: number;
  /** Aggregated per-stage timing summary (which stage consumed most runtime). */
  stageTimings: PipelineStageTimingSummary[];
  /** Wall-clock duration of the terminal notification phase in ms. */
  notificationsDurationMs: number;
};

export function decideStageLoopWait(input: {
  batchesSinceYield: number;
  stagnantBatches: number;
  stagnantBackoffs: number;
}): "fairness_yield" | "stagnant_backoff" | "fail" | null {
  if (input.stagnantBatches >= STAGNANT_BATCHES_BEFORE_BACKOFF) {
    return input.stagnantBackoffs >= MAX_STAGNANT_BACKOFFS
      ? "fail"
      : "stagnant_backoff";
  }
  if (input.batchesSinceYield >= MAX_BATCHES_BEFORE_YIELD)
    return "fairness_yield";
  return null;
}

export async function acquireDailyPipelineLock(
  input: DailyPipelineWorkflowInput,
) {
  "use step";

  const { prisma } = await import("../utils/prisma");
  return prisma.$transaction(async (tx) => {
    // PostgreSQL returns void here, which Prisma's driver adapter cannot decode.
    await tx.$queryRaw<Array<{ lock: string }>>`
      SELECT pg_advisory_xact_lock(734821, 120026)::text AS lock
    `;
    const staleBefore = new Date(Date.now() - LOCK_STALE_AFTER_MS);
    const active = await tx.pipelineRun.findFirst({
      where: { status: LOCK_STATUS, updatedAt: { gte: staleBefore } },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
    });

    if (active)
      return { acquired: false as const, orchestrationRunId: active.id };

    await tx.pipelineRun.updateMany({
      where: { status: LOCK_STATUS, updatedAt: { lt: staleBefore } },
      data: { status: "DAILY_PIPELINE_WORKFLOW_STALE", finishedAt: new Date() },
    });

    const run = await tx.pipelineRun.create({
      data: {
        status: LOCK_STATUS,
        summary: {
          kind: "daily_news_pipeline_workflow",
          orchestrationId: input.orchestrationId,
          triggeredAt: input.triggeredAt,
          stages: DAILY_PIPELINE_STAGES,
        },
      },
      select: { id: true },
    });

    return { acquired: true as const, orchestrationRunId: run.id };
  });
}

async function heartbeatOrchestration(
  orchestrationRunId: string,
  stage: DailyPipelineStage,
) {
  const { prisma } = await import("../utils/prisma");
  const updated = await prisma.pipelineRun.updateMany({
    where: { id: orchestrationRunId, status: LOCK_STATUS },
    data: { status: LOCK_STATUS },
  });
  if (updated.count !== 1)
    throw new FatalError("Daily pipeline workflow lock was lost.");
}

/**
 * Optional per-batch telemetry context passed from the workflow loop into the
 * step so each batch record carries the batch sequence number, the remaining
 * actionable count observed before the batch, and any explicit sleep/yield
 * that preceded it.
 */
export type StageBatchTelemetryInput = {
  batchSeq: number;
  remainingBefore: number | null;
  sleepMs: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
};

export async function runDailyPipelineStageBatch(
  orchestrationRunId: string,
  stage: DailyPipelineStage,
  telemetryInput?: StageBatchTelemetryInput,
): Promise<StageBatchResult> {
  "use step";

  await heartbeatOrchestration(orchestrationRunId, stage);

  const tracker = new StageBatchTelemetryTracker({
    orchestrationRunId,
    stage,
    batchSeq: telemetryInput?.batchSeq ?? 1,
    batchSizeLimit: STAGE_BATCH_SIZE_LIMIT[stage],
    concurrencyLimit: STAGE_CONCURRENCY_LIMIT[stage],
    now: telemetryInput?.now,
  });
  tracker.recordSleep(telemetryInput?.sleepMs ?? 0);
  const { persistStageBatchTelemetry } =
    await import("../utils/news-pipeline/stage-telemetry-server");

  const persistTelemetryBestEffort = async (
    telemetry: StageBatchTelemetry,
  ): Promise<void> => {
    try {
      await persistStageBatchTelemetry({
        pipelineRunId: orchestrationRunId,
        telemetry,
      });
    } catch {
      // Telemetry is observation-only. Keep diagnostics bounded and never
      // replace the authoritative stage result or error.
      console.error("[daily-pipeline] Stage telemetry persistence failed.", {
        stage: telemetry.stage,
        batchSeq: telemetry.batchSeq,
      });
    }
  };

  try {
    if (stage === "agent1") {
      const { runAgent1Batch } =
        await import("../utils/news-pipeline/orchestrator");
      const result = await runAgent1Batch({
        maxTargets: 5,
        timeBudgetMs: 240_000,
        minRemainingMs: 30_000,
        telemetry: tracker,
      });
      const complete = result.remainingEligible === 0;
      // Target dispositions are authoritative. Article insertion/skips remain
      // productivity metrics and never affect target-level reconciliation.
      const dispositions = result.targetDispositions;
      const telemetry = tracker.finalize({
        processed: result.selectedTargets,
        succeeded: dispositions.succeeded,
        failedRetryable: dispositions.failedRetryable,
        failedPermanent: dispositions.failedPermanent,
        skipped: dispositions.skipped,
        deferred: dispositions.deferred,
        quarantined: dispositions.quarantined,
        persistenceFailed: dispositions.persistenceFailed,
        productivity: result.productivity,
        remainingBefore: telemetryInput?.remainingBefore ?? null,
        remainingAfter: result.remainingEligible,
        complete,
      });
      await persistTelemetryBestEffort(telemetry);
      return {
        stage,
        processed: result.processed,
        remaining: result.remainingEligible,
        complete,
        telemetry,
      };
    }

    if (stage === "agent2-static") {
      const { runArticleDiscoveryBatch } =
        await import("../utils/news-pipeline/article-discovery");
      const result = await runArticleDiscoveryBatch({
        maxTargets: 5,
        timeBudgetMs: 240_000,
        minRemainingMs: 30_000,
        telemetry: tracker,
      });
      const complete = result.remainingEligible === 0;
      const dispositions = result.targetDispositions;
      const telemetry = tracker.finalize({
        processed: result.selectedTargets,
        succeeded: dispositions.succeeded,
        failedRetryable: dispositions.failedRetryable,
        failedPermanent: dispositions.failedPermanent,
        skipped: dispositions.skipped,
        deferred: dispositions.deferred,
        quarantined: dispositions.quarantined,
        persistenceFailed: dispositions.persistenceFailed,
        productivity: result.productivity,
        remainingBefore: telemetryInput?.remainingBefore ?? null,
        remainingAfter: result.remainingEligible,
        complete,
      });
      await persistTelemetryBestEffort(telemetry);
      return {
        stage,
        processed: result.processed,
        remaining: result.remainingEligible,
        complete,
        telemetry,
      };
    }

    if (stage === "agent2-headless") {
      const { processArticleDiscoveryHeadlessQueue } =
        await import("../utils/news-pipeline/article-discovery-headless-queue");
      const { isBrowserFallbackEnabled } =
        await import("../utils/news-pipeline/article-discovery-browser");
      if (!isBrowserFallbackEnabled()) {
        // The stage-level catch below records the failed batch once, preserving
        // the original fatal error without creating duplicate artifacts.
        throw new FatalError(
          "Agent 2 browser fallback is disabled. Set NUXT_ENABLE_AGENT2_BROWSER_FALLBACK=true.",
        );
      }
      const result = await processArticleDiscoveryHeadlessQueue({
        limit: 3,
        dryRun: false,
        runBrowser: true,
        telemetry: tracker,
      });
      if (result.dryRun)
        throw new FatalError(
          "Agent 2 headless workflow unexpectedly ran in dry-run mode.",
        );

      const processed = result.processed;
      const remaining = result.remainingEligible ?? 0;
      const complete = remaining === 0;
      const dispositions = result.targetDispositions;
      const telemetry = tracker.finalize({
        processed: result.selectedQueueItems,
        succeeded: dispositions.succeeded,
        failedRetryable: dispositions.failedRetryable,
        failedPermanent: dispositions.failedPermanent,
        skipped: dispositions.skipped,
        deferred: dispositions.deferred,
        quarantined: dispositions.quarantined,
        claimLost: dispositions.claimLost,
        persistenceFailed: dispositions.persistenceFailed,
        productivity: result.productivity,
        remainingBefore: telemetryInput?.remainingBefore ?? null,
        remainingAfter: remaining,
        complete,
      });
      await persistTelemetryBestEffort(telemetry);
      return { stage, processed, remaining, complete, telemetry };
    }

    const { getAgent3Progress, runEnrichmentBatch } =
      await import("../utils/news-pipeline/enrichment-runtime");
    const result = await runEnrichmentBatch({
      maxArticles: 10,
      includeEnriched: false,
      forceReprocess: false,
      browserFallback: false,
      pipelineRunId: orchestrationRunId,
      telemetry: tracker,
    });
    const progress = await getAgent3Progress({
      includeEnriched: false,
      forceReprocess: false,
      pipelineRunId: orchestrationRunId,
    });
    const complete = progress.retryableNow === 0;
    const byKind = result.persist?.byKind ?? {};
    const failedPermanent = Object.entries(byKind)
      .filter(
        ([kind]) =>
          ![
            "SUCCESS",
            "SKIPPED",
            "RETRYABLE_FAILURE",
            "HEADLESS_REQUIRED",
          ].includes(kind),
      )
      .reduce(
        (sum, [, count]) => sum + (typeof count === "number" ? count : 0),
        0,
      );
    // `byKind` is authoritative for outcomes that were durably persisted.
    // Claim losses and persistence failures are selected-work dispositions, not
    // extra article outcomes; keep them in dedicated telemetry fields so the
    // reconciliation is: outcome groups + claimLost + persistenceFailed = processed.
    const telemetry = tracker.finalize({
      processed: result.articleCount,
      succeeded: byKind.SUCCESS ?? 0,
      failedRetryable: byKind.RETRYABLE_FAILURE ?? 0,
      failedPermanent,
      skipped: byKind.SKIPPED ?? 0,
      deferred: byKind.HEADLESS_REQUIRED ?? 0,
      quarantined: 0,
      claimLost: result.persist?.claimLost ?? 0,
      persistenceFailed: result.persist?.failed ?? 0,
      remainingBefore: telemetryInput?.remainingBefore ?? null,
      remainingAfter: progress.retryableNow,
      complete,
    });
    await persistTelemetryBestEffort(telemetry);
    return {
      stage,
      processed: result.articleCount,
      succeeded: result.persist?.byKind?.SUCCESS ?? 0,
      failedRetryable: result.persist?.byKind?.RETRYABLE_FAILURE ?? 0,
      deferred: progress.deferred,
      quarantined: progress.quarantined,
      readyNew: progress.readyNew,
      readyRetry: progress.readyRetry,
      retryableNow: progress.retryableNow,
      nextRetryAt: progress.nextRetryAt,
      remaining: progress.retryableNow,
      complete,
      telemetry,
    };
  } catch (error) {
    // Preserve a bounded diagnostic artifact even when the stage operation
    // throws before it can produce an authoritative result. This is additive
    // observation-only telemetry; the original error remains authoritative.
    const reason = error instanceof Error ? error.message : String(error);
    const telemetry = tracker.finalize({
      processed: 0,
      succeeded: 0,
      failedRetryable: 0,
      failedPermanent: 0,
      skipped: 0,
      deferred: 0,
      quarantined: 0,
      batchExecutionErrors: 1,
      batchErrorClassification: "unclassified",
      batchErrorReason: reason,
      remainingBefore: telemetryInput?.remainingBefore ?? null,
      remainingAfter: telemetryInput?.remainingBefore ?? null,
      complete: false,
      noProgressReason: reason,
    });
    await persistTelemetryBestEffort(telemetry);
    throw error;
  }
}

async function finishDailyPipeline(
  orchestrationRunId: string,
  status: "COMPLETED" | "FAILED",
  completedStages: DailyPipelineStage[],
  options?: {
    error?: string;
    stageTimings?: PipelineStageTimingSummary[];
    notificationsDurationMs?: number;
  },
) {
  "use step";
  const { prisma } = await import("../utils/prisma");
  await prisma.pipelineRun.updateMany({
    where: { id: orchestrationRunId, status: LOCK_STATUS },
    data: {
      status: `DAILY_PIPELINE_WORKFLOW_${status}`,
      finishedAt: new Date(),
      summary: {
        kind: "daily_news_pipeline_workflow",
        completedStages,
        stageTimings: options?.stageTimings ?? [],
        notificationsDurationMs: options?.notificationsDurationMs ?? 0,
        ...(options?.error ? { error: options.error } : {}),
      },
    },
  });
}

export async function runDailyNewsPipelineWorkflow(
  input: DailyPipelineWorkflowInput,
): Promise<DailyPipelineWorkflowResult> {
  "use workflow";

  const lock = await acquireDailyPipelineLock(input);
  if (!lock.acquired) {
    return {
      orchestrationId: input.orchestrationId,
      orchestrationRunId: lock.orchestrationRunId,
      skipped: true,
      completedStages: [],
      notificationsProcessed: 0,
      stageTimings: [],
      notificationsDurationMs: 0,
    };
  }

  const completedStages: DailyPipelineStage[] = [];
  // Durable per-batch telemetry records accumulated across the workflow loop.
  const stageTelemetry: StageBatchTelemetry[] = [];
  try {
    for (const stage of DAILY_PIPELINE_STAGES) {
      let previousRemaining: number | null = null;
      let batchesSinceYield = 0;
      let stagnantBatches = 0;
      let stagnantBackoffs = 0;
      let batchSeq = 0;
      // Requested durable sleep before the next batch. This is intentionally
      // the configured delay, not replay-dependent wall-clock suspension time.
      let sleepMsSinceLastBatch = 0;

      while (true) {
        batchSeq += 1;
        const batch = await runDailyPipelineStageBatch(
          lock.orchestrationRunId,
          stage,
          {
            batchSeq,
            remainingBefore: previousRemaining,
            sleepMs: sleepMsSinceLastBatch,
          },
        );
        sleepMsSinceLastBatch = 0;
        if (batch.telemetry) stageTelemetry.push(batch.telemetry);
        if (batch.complete) break;
        batchesSinceYield += 1;

        const priorRemaining = previousRemaining;
        const stagnant =
          batch.processed === 0 ||
          (priorRemaining !== null && batch.remaining >= priorRemaining);
        stagnantBatches = stagnant ? stagnantBatches + 1 : 0;
        previousRemaining = batch.remaining;

        const waitAction = decideStageLoopWait({
          batchesSinceYield,
          stagnantBatches,
          stagnantBackoffs,
        });
        if (waitAction === "fail" || waitAction === "stagnant_backoff") {
          if (stage !== "agent3" && waitAction === "stagnant_backoff") {
            await sleep(STAGNANT_BACKOFF);
            sleepMsSinceLastBatch += 30 * 60 * 1000;
            stagnantBackoffs += 1;
            batchesSinceYield = 0;
            stagnantBatches = 0;
            continue;
          }
          const message =
            `${stage} made no progress: ` +
            `previousRemaining=${priorRemaining ?? "null"}, ` +
            `currentRemaining=${batch.remaining}, processed=${batch.processed}, ` +
            `readyNew=${batch.readyNew ?? "n/a"}, readyRetry=${batch.readyRetry ?? "n/a"}, ` +
            `retryableNow=${batch.retryableNow ?? batch.remaining}, ` +
            `deferred=${batch.deferred ?? "n/a"}, quarantined=${batch.quarantined ?? "n/a"}, ` +
            `nextRetryAt=${batch.nextRetryAt ?? "null"}. Manual diagnosis required.`;
          // Keep the in-memory summary truthful as well as updating the
          // durable artifact. The attach step is non-fatal, but the summary
          // must still retain the reason when the workflow rethrows.
          if (batch.telemetry) batch.telemetry.noProgressReason = message;
          await recordStageBatchNoProgress(
            lock.orchestrationRunId,
            stage,
            batchSeq,
            message,
          );
          throw new FatalError(message);
        }
        if (waitAction === "fairness_yield") {
          await sleep(FAIRNESS_YIELD);
          sleepMsSinceLastBatch += 60 * 1000;
          batchesSinceYield = 0;
        }
      }
      completedStages.push(stage);
    }

    const stageTimings = summarizeStageTimings(stageTelemetry);

    // Digest delivery has its own scheduled endpoint. Keeping future delivery
    // sleeps out of this workflow releases the pipeline lock immediately after
    // the terminal processing stage completes.
    const notificationsProcessed = 0;
    const notificationsDurationMs = 0;
    await finishDailyPipeline(
      lock.orchestrationRunId,
      "COMPLETED",
      completedStages,
      {
        stageTimings,
        notificationsDurationMs,
      },
    );
    return {
      orchestrationId: input.orchestrationId,
      orchestrationRunId: lock.orchestrationRunId,
      skipped: false,
      completedStages,
      notificationsProcessed,
      stageTimings,
      notificationsDurationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Finalization is observation-only. Never replace the original pipeline
    // error with a failure from the diagnostic status update.
    try {
      await finishDailyPipeline(
        lock.orchestrationRunId,
        "FAILED",
        completedStages,
        {
          error: message,
          stageTimings: summarizeStageTimings(stageTelemetry),
          notificationsDurationMs: 0,
        },
      );
    } catch {
      // The original workflow failure remains authoritative; the durable run
      // may remain RUNNING and is then visible to stale-run recovery.
    }
    throw error;
  }
}
