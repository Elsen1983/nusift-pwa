import { FatalError, sleep } from "workflow";
import { prisma } from "../utils/prisma";
import { runAgent1Batch } from "../utils/news-pipeline/orchestrator";
import { runArticleDiscoveryBatch } from "../utils/news-pipeline/article-discovery";
import { processArticleDiscoveryHeadlessQueue } from "../utils/news-pipeline/article-discovery-headless-queue";
import { isBrowserFallbackEnabled } from "../utils/news-pipeline/article-discovery-browser";
import { getAgent3Progress, runEnrichmentBatch } from "../utils/news-pipeline/enrichment-runtime";
import {
  sendDueDailyNotifications,
  type DailyNotificationSlot,
} from "../utils/notification-sender";

export const DAILY_PIPELINE_STAGES = [
  "agent1",
  "agent2-static",
  "agent2-headless",
  "agent3",
] as const;

export type DailyPipelineStage = typeof DAILY_PIPELINE_STAGES[number];

type StageBatchResult = {
  stage: DailyPipelineStage;
  processed: number;
  remaining: number;
  complete: boolean;
};

const LOCK_STATUS = "DAILY_PIPELINE_WORKFLOW_RUNNING";
const LOCK_STALE_AFTER_MS = 22 * 60 * 60 * 1000;
const MAX_BATCHES_BEFORE_BACKOFF = 20;
const STAGNANT_BATCHES_BEFORE_BACKOFF = 3;
const STAGNANT_BACKOFF = "30m";

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
};

export async function acquireDailyPipelineLock(input: DailyPipelineWorkflowInput) {
  "use step";

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

    if (active) return { acquired: false as const, orchestrationRunId: active.id };

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

async function heartbeatOrchestration(orchestrationRunId: string, stage: DailyPipelineStage) {
  const updated = await prisma.pipelineRun.updateMany({
    where: { id: orchestrationRunId, status: LOCK_STATUS },
    data: { status: LOCK_STATUS },
  });
  if (updated.count !== 1) throw new FatalError("Daily pipeline workflow lock was lost.");
}

export async function runDailyPipelineStageBatch(
  orchestrationRunId: string,
  stage: DailyPipelineStage,
): Promise<StageBatchResult> {
  "use step";

  await heartbeatOrchestration(orchestrationRunId, stage);

  if (stage === "agent1") {
    const result = await runAgent1Batch({
      maxTargets: 5,
      timeBudgetMs: 240_000,
      minRemainingMs: 30_000,
    });
    return { stage, processed: result.processed, remaining: result.remainingEligible, complete: result.remainingEligible === 0 };
  }

  if (stage === "agent2-static") {
    const result = await runArticleDiscoveryBatch({
      maxTargets: 5,
      timeBudgetMs: 240_000,
      minRemainingMs: 30_000,
    });
    return { stage, processed: result.processed, remaining: result.remainingEligible, complete: result.remainingEligible === 0 };
  }

  if (stage === "agent2-headless") {
    if (!isBrowserFallbackEnabled()) {
      throw new FatalError("Agent 2 browser fallback is disabled. Set NUXT_ENABLE_AGENT2_BROWSER_FALLBACK=true.");
    }
    const result = await processArticleDiscoveryHeadlessQueue({ limit: 3, dryRun: false, runBrowser: true });
    if (result.dryRun) throw new FatalError("Agent 2 headless workflow unexpectedly ran in dry-run mode.");

    const attempted = result.browserAttemptedTargets ?? 0;
    const claimed = result.claimed ?? 0;
    const processed = Math.max(attempted, claimed);
    return { stage, processed, remaining: processed >= 3 ? 1 : 0, complete: processed < 3 };
  }

  const result = await runEnrichmentBatch({
    maxArticles: 10,
    includeEnriched: false,
    forceReprocess: false,
    browserFallback: false,
  });
  const progress = await getAgent3Progress({ includeEnriched: false, forceReprocess: false });
  return { stage, processed: result.articleCount, remaining: progress.retryableNow, complete: progress.retryableNow === 0 };
}

async function getDailyNotificationSchedule() {
  "use step";
  const now = new Date();
  const slots: Array<{ slot: DailyNotificationSlot; hour: number }> = [
    { slot: "MORNING", hour: 6 },
    { slot: "NOON", hour: 12 },
    { slot: "EVENING", hour: 18 },
  ];
  return slots.map(({ slot, hour }) => {
    const scheduledAt = new Date(now);
    scheduledAt.setHours(hour, 0, 0, 0);
    return { slot, scheduledAt: scheduledAt.toISOString() };
  });
}

async function sendTerminalStageNotifications(
  orchestrationRunId: string,
  slot: DailyNotificationSlot,
) {
  "use step";
  await heartbeatOrchestration(orchestrationRunId, "agent3");
  const results = await sendDueDailyNotifications(new Date(), [slot]);
  return results.length;
}

async function finishDailyPipeline(
  orchestrationRunId: string,
  status: "COMPLETED" | "FAILED",
  completedStages: DailyPipelineStage[],
  error?: string,
) {
  "use step";
  await prisma.pipelineRun.updateMany({
    where: { id: orchestrationRunId, status: LOCK_STATUS },
    data: {
      status: `DAILY_PIPELINE_WORKFLOW_${status}`,
      finishedAt: new Date(),
      summary: { kind: "daily_news_pipeline_workflow", completedStages, ...(error ? { error } : {}) },
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
    };
  }

  const completedStages: DailyPipelineStage[] = [];
  try {
    for (const stage of DAILY_PIPELINE_STAGES) {
      let previousRemaining: number | null = null;
      let batchesSinceBackoff = 0;
      let stagnantBatches = 0;

      while (true) {
        const batch = await runDailyPipelineStageBatch(lock.orchestrationRunId, stage);
        if (batch.complete) break;
        batchesSinceBackoff += 1;

        const stagnant = batch.processed === 0 ||
          (previousRemaining !== null && batch.remaining >= previousRemaining);
        stagnantBatches = stagnant ? stagnantBatches + 1 : 0;
        previousRemaining = batch.remaining;

        if (
          stagnantBatches >= STAGNANT_BATCHES_BEFORE_BACKOFF ||
          batchesSinceBackoff >= MAX_BATCHES_BEFORE_BACKOFF
        ) {
          await sleep(STAGNANT_BACKOFF);
          batchesSinceBackoff = 0;
          stagnantBatches = 0;
        }
      }
      completedStages.push(stage);
    }

    let notificationsProcessed = 0;
    const notificationSchedule = await getDailyNotificationSchedule();
    for (const notification of notificationSchedule) {
      await sleep(new Date(notification.scheduledAt));
      notificationsProcessed += await sendTerminalStageNotifications(
        lock.orchestrationRunId,
        notification.slot,
      );
    }
    await finishDailyPipeline(lock.orchestrationRunId, "COMPLETED", completedStages);
    return {
      orchestrationId: input.orchestrationId,
      orchestrationRunId: lock.orchestrationRunId,
      skipped: false,
      completedStages,
      notificationsProcessed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishDailyPipeline(lock.orchestrationRunId, "FAILED", completedStages, message);
    throw error;
  }
}
