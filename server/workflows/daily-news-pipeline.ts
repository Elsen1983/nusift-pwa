import { FatalError, sleep } from "workflow";
import {
  summarizeStageTimings,
  StageBatchTelemetryTracker,
  type PipelineStageTimingSummary,
  type StageBatchTelemetry,
} from "../utils/news-pipeline/stage-telemetry";
import {
  assessRunProductivity,
  type RunProductivityAssessment,
} from "../utils/news-pipeline/run-productivity";
import type { Agent3CompletionSummary } from "../utils/news-pipeline/agent3-completion";

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

export type StageBatchResult = {
  stage: DailyPipelineStage;
  processed: number;
  remaining: number;
  complete: boolean;
  skipReason?: string | null;
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
// The longest intentional workflow sleep is 30 minutes. Two hours leaves a
// wide safety margin while preventing cancelled/errored runs from blocking the
// daily pipeline for almost an entire day.
const LOCK_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const MAX_BATCHES_BEFORE_YIELD = 20;
const FAIRNESS_YIELD = "1m";
const STAGNANT_BATCHES_BEFORE_BACKOFF = 3;
const STAGNANT_BACKOFF = "30m";
const MAX_STAGNANT_BACKOFFS = 1;
const INTERNAL_RUNNER_TIMEOUT_MS = 240_000;
const STAGE_REASON_MAX_LENGTH = 500;

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

export type DailyPipelineStageOutcomeStatus = "completed" | "degraded" | "failed";
export type DailyPipelineRunOutcome = "COMPLETED" | "COMPLETED_PARTIAL" | "FAILED";

export type DailyPipelineStageOutcome = {
  stage: DailyPipelineStage;
  status: DailyPipelineStageOutcomeStatus;
  reason: string | null;
  batchCount: number;
  elapsedMs: number;
  remaining: number | null;
  actionableRemaining: number | null;
  nextRetryAt: string | null;
};

export function deriveDailyPipelineRunOutcome(
  outcomes: readonly DailyPipelineStageOutcome[],
): DailyPipelineRunOutcome {
  const hasCompletedOrDegraded = outcomes.some(
    (outcome) => outcome.status === "completed" || outcome.status === "degraded",
  );
  if (!hasCompletedOrDegraded) return "FAILED";
  return outcomes.some((outcome) => outcome.status !== "completed")
    ? "COMPLETED_PARTIAL"
    : "COMPLETED";
}

export type DailyPipelineWorkflowResult = {
  orchestrationId: string;
  orchestrationRunId: string | null;
  skipped: boolean;
  completedStages: DailyPipelineStage[];
  runOutcome: DailyPipelineRunOutcome | null;
  stageOutcomes: DailyPipelineStageOutcome[];
  recovery: DailyPipelineRecoverySummary | null;
  notificationsProcessed: number;
  /** Aggregated per-stage timing summary (which stage consumed most runtime). */
  stageTimings: PipelineStageTimingSummary[];
  /**
   * Repair 15 run-level productivity assertion.
   *
   * Independent of `runOutcome`: a COMPLETED_PARTIAL run that produced no
   * articles must not be indistinguishable from one that produced normally.
   * Observation-only — never gates control flow. Null only when the run was
   * skipped before any stage could execute.
   */
  productivity: RunProductivityAssessment | null;
  funnel: { targets: number; truncated: boolean; incomplete: number } | null;
  /** Wall-clock duration of the terminal notification phase in ms. */
  notificationsDurationMs: number;
};

export type RecoveryCounterSummary = {
  scanned: number;
  recovered: number;
  conflicted: number;
  malformed: number;
  failed: number;
  timeBudgetExhausted: boolean;
};

export type DailyPipelineRecoverySummary = {
  schemaVersion: 1;
  headlessClaims: RecoveryCounterSummary;
  domainLeases: RecoveryCounterSummary & { mode: "off" | "shadow" | "enforce" };
  telemetryPersisted: boolean;
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
  _stage: DailyPipelineStage | "recovery",
) {
  const { prisma } = await import("../utils/prisma");
  const updated = await prisma.pipelineRun.updateMany({
    where: { id: orchestrationRunId, status: LOCK_STATUS },
    data: { status: LOCK_STATUS },
  });
  if (updated.count !== 1)
    throw new FatalError("Daily pipeline workflow lock was lost.");
}

export async function runDailyPipelineRecoveryMaintenance(
  orchestrationRunId: string,
): Promise<DailyPipelineRecoverySummary> {
  "use step";

  await heartbeatOrchestration(orchestrationRunId, "recovery");
  const [headlessModule, governorModule, prismaModule] = await Promise.all([
    import("../utils/news-pipeline/article-discovery-headless-recovery"),
    import("../utils/news-pipeline/domain-request-governor"),
    import("../utils/prisma"),
  ]);
  const governorMode = governorModule.parseDomainGovernorMode();
  const headless = await headlessModule.recoverStaleArticleDiscoveryHeadlessProcessing({
    mode: "retry",
    limit: 10,
    timeBudgetMs: 5_000,
  });
  const domain = await governorModule.recoverExpiredDomainLeases({
    mode: governorMode,
    limit: 100,
    timeBudgetMs: 5_000,
  });
  const summary: DailyPipelineRecoverySummary = {
    schemaVersion: 1,
    headlessClaims: {
      scanned: headless.inspected,
      recovered: headless.recovered,
      conflicted: headless.skippedAlreadyChanged,
      malformed: headless.malformed,
      failed: headless.failed,
      timeBudgetExhausted: headless.timeBudgetExhausted,
    },
    domainLeases: {
      mode: governorMode,
      scanned: domain.scanned,
      recovered: domain.recovered,
      conflicted: domain.conflicted,
      malformed: domain.malformed,
      failed: domain.failed,
      timeBudgetExhausted: domain.timeBudgetExhausted,
    },
    telemetryPersisted: false,
  };
  summary.telemetryPersisted = true;
  try {
    await prismaModule.prisma.pipelineArtifact.create({
      data: {
        pipelineRunId: orchestrationRunId,
        artifactType: "stale_claim_recovery_telemetry",
        status: summary.headlessClaims.failed > 0 || summary.domainLeases.failed > 0
          ? "RECOVERY_FAILED"
          : "CAPTURED",
        candidateCount: summary.headlessClaims.recovered + summary.domainLeases.recovered,
        payload: summary,
      },
      select: { id: true },
    });
  } catch {
    summary.telemetryPersisted = false;
    console.error("[daily-pipeline] Recovery telemetry persistence failed.");
  }
  return summary;
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

const internalRunnerConfig = () => {
  const deploymentHost = (
    process.env.NUXT_INTERNAL_BASE_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    ""
  ).trim();
  const secret = process.env.CRON_SECRET || process.env.NUXT_CRON_SECRET;
  if (!deploymentHost || !secret) {
    throw new FatalError("Daily pipeline internal runner is not configured.");
  }
  const baseUrl = deploymentHost.startsWith("http://") || deploymentHost.startsWith("https://")
    ? deploymentHost
    : `https://${deploymentHost}`;
  return { baseUrl: baseUrl.replace(/\/$/, ""), secret };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const boundedStageReason = (value: unknown): string => {
  const raw = value instanceof Error ? value.message : String(value);
  const redacted = raw
    .replace(/https?:\/\/[^\s]+/gi, (candidate) => {
      try {
        const url = new URL(candidate);
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(/\b(authorization|cookie|password|secret|token)=\S+/gi, "$1=[redacted]");
  return redacted.slice(0, STAGE_REASON_MAX_LENGTH);
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const validateStageBatchResult = (
  value: unknown,
  expectedStage: DailyPipelineStage,
): StageBatchResult => {
  const raw = asRecord(value);
  if (
    !raw ||
    raw.stage !== expectedStage ||
    !isNonNegativeInteger(raw.processed) ||
    !isNonNegativeInteger(raw.remaining) ||
    typeof raw.complete !== "boolean" ||
    (raw.skipReason != null && typeof raw.skipReason !== "string") ||
    (raw.nextRetryAt != null &&
      (typeof raw.nextRetryAt !== "string" || !Number.isFinite(Date.parse(raw.nextRetryAt))))
  ) {
    throw new FatalError(
      `Daily pipeline internal runner returned an invalid ${expectedStage} contract.`,
    );
  }
  return value as StageBatchResult;
};

const postInternalRunner = async <T>(
  path: string,
  body: Record<string, unknown>,
  validate?: (value: unknown) => T,
): Promise<T> => {
  const { baseUrl, secret } = internalRunnerConfig();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-cron-secret": secret,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(INTERNAL_RUNNER_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
      throw new Error(
        `Daily pipeline internal runner ${path} timed out after ${INTERNAL_RUNNER_TIMEOUT_MS}ms.`,
      );
    }
    throw error;
  }
  if (!response.ok) {
    const message = `Daily pipeline internal runner ${path} failed with HTTP ${response.status}.`;
    if ([400, 401, 403, 404].includes(response.status)) {
      throw new FatalError(message);
    }
    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(message);
    }
    throw new FatalError(message);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FatalError(
      `Daily pipeline internal runner ${path} returned malformed JSON.`,
    );
  }
  return validate ? validate(payload) : payload as T;
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
        orchestrationRunId,
        manifestInvocationKey: `agent1:${telemetryInput?.batchSeq ?? 1}`,
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
        orchestrationRunId,
        manifestInvocationKey: `agent2-static:${telemetryInput?.batchSeq ?? 1}`,
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
      return await postInternalRunner<StageBatchResult>(
        "/api/internal/run-agent2-headless",
        {
          orchestrationRunId,
          batchSeq: telemetryInput?.batchSeq ?? 1,
          remainingBefore: telemetryInput?.remainingBefore ?? null,
          sleepMs: telemetryInput?.sleepMs ?? 0,
        },
        (value) => validateStageBatchResult(value, "agent2-headless"),
      );
    }

    return await postInternalRunner<StageBatchResult>(
      "/api/internal/run-agent3",
      {
        action: "batch",
        orchestrationRunId,
        batchSeq: telemetryInput?.batchSeq ?? 1,
        remainingBefore: telemetryInput?.remainingBefore ?? null,
        sleepMs: telemetryInput?.sleepMs ?? 0,
      },
      (value) => validateStageBatchResult(value, "agent3"),
    );
  } catch (error) {
    // Preserve a bounded diagnostic artifact even when the stage operation
    // throws before it can produce an authoritative result. This is additive
    // observation-only telemetry; the original error remains authoritative.
    const reason = boundedStageReason(error);
    const batchErrorClassification = error instanceof FatalError
      ? "fatal_internal_runner"
      : /timed out after \d+ms/i.test(reason)
        ? "internal_runner_timeout"
        : "retryable_or_runtime_failure";
    const telemetry = tracker.finalize({
      processed: 0,
      succeeded: 0,
      failedRetryable: 0,
      failedPermanent: 0,
      skipped: 0,
      deferred: 0,
      quarantined: 0,
      batchExecutionErrors: 1,
      batchErrorClassification,
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
  status: DailyPipelineRunOutcome,
  completedStages: DailyPipelineStage[],
  options?: {
    error?: string;
    stageOutcomes?: DailyPipelineStageOutcome[];
    recovery?: DailyPipelineRecoverySummary | null;
    stageTimings?: PipelineStageTimingSummary[];
    notificationsDurationMs?: number;
    completion?: Agent3CompletionSummary | null;
    productivity?: RunProductivityAssessment | null;
    funnel?: { targets: number; truncated: boolean; incomplete: number } | null;
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
        runOutcome: status,
        completedStages,
        stageOutcomes: options?.stageOutcomes ?? [],
        recovery: options?.recovery ?? null,
        stageTimings: options?.stageTimings ?? [],
        notificationsDurationMs: options?.notificationsDurationMs ?? 0,
        // Repair 15: persisted alongside runOutcome, never folded into it.
        // `productivity.productive === false` is the queryable signal for a run
        // that executed truthfully and produced nothing.
        ...(options?.productivity ? { productivity: options.productivity } : {}),
        ...(options?.funnel ? { funnel: options.funnel } : {}),
        ...(options?.completion ? { completion: options.completion } : {}),
        ...(options?.error ? { error: options.error } : {}),
      },
    },
  });
}

async function finalizeRunFunnelsStep(orchestrationRunId: string) {
  "use step";
  try {
    const { finalizeOrchestrationFunnels } =
      await import("../utils/news-pipeline/run-funnel");
    return await finalizeOrchestrationFunnels({ orchestrationRunId });
  } catch {
    return null;
  }
}

/**
 * Compute the Agent 3 completion summary for the just-finished orchestration.
 *
 * The future-run progress query deliberately omits the current pipelineRunId
 * so same-run exclusion never hides eligible/retryable work that only becomes
 * actionable after this orchestration ends. Observation-only: a failure here
 * must never fail the workflow or replace its authoritative status.
 */
export async function finalizeAgent3CompletionStep(
  orchestrationRunId: string,
): Promise<Agent3CompletionSummary | null> {
  "use step";
  try {
    const { summary } = await postInternalRunner<{ summary: Agent3CompletionSummary }>(
      "/api/internal/run-agent3",
      { action: "completion", orchestrationRunId },
    );
    return summary;
  } catch (error) {
    console.error(
      "[daily-pipeline] Agent 3 completion summary failed; run status unchanged.",
      error,
    );
    return null;
  }
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
      runOutcome: null,
      stageOutcomes: [],
      recovery: null,
      notificationsProcessed: 0,
      stageTimings: [],
      notificationsDurationMs: 0,
      // A skipped run never held the lock and executed nothing. That is not an
      // unproductive run — it is an absent one.
      productivity: null,
      funnel: null,
    };
  }

  const completedStages: DailyPipelineStage[] = [];
  const stageOutcomes: DailyPipelineStageOutcome[] = [];
  let recovery: DailyPipelineRecoverySummary | null = null;
  // Durable per-batch telemetry records accumulated across the workflow loop.
  const stageTelemetry: StageBatchTelemetry[] = [];
  try {
    recovery = await runDailyPipelineRecoveryMaintenance(lock.orchestrationRunId);
    for (const stage of DAILY_PIPELINE_STAGES) {
      let previousRemaining: number | null = null;
      let batchesSinceYield = 0;
      let stagnantBatches = 0;
      let stagnantBackoffs = 0;
      let batchSeq = 0;
      // Requested durable sleep before the next batch. This is intentionally
      // the configured delay, not replay-dependent wall-clock suspension time.
      let sleepMsSinceLastBatch = 0;
      let stageFinished = false;

      try {
        while (true) {
          batchSeq += 1;
          const priorRemaining = previousRemaining;
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
          previousRemaining = batch.remaining;
          if (batch.complete) {
            const reason = batch.skipReason
              ? boundedStageReason(batch.skipReason)
              : batch.deferred && batch.nextRetryAt
                ? "only_future_deferred_work_remains"
                : null;
            stageOutcomes.push({
              stage,
              status: "completed",
              reason,
              batchCount: batchSeq,
              elapsedMs: stageTelemetry
                .filter((item) => item.stage === stage)
                .reduce((total, item) => total + item.durationMs + item.sleepMs, 0),
              remaining: batch.remaining,
              actionableRemaining: batch.retryableNow ?? batch.remaining,
              nextRetryAt: batch.nextRetryAt ?? null,
            });
            completedStages.push(stage);
            stageFinished = true;
            break;
          }
          batchesSinceYield += 1;

          const stagnant =
            batch.processed === 0 ||
            (priorRemaining !== null && batch.remaining >= priorRemaining);
          stagnantBatches = stagnant ? stagnantBatches + 1 : 0;

          const waitAction = decideStageLoopWait({
            batchesSinceYield,
            stagnantBatches,
            stagnantBackoffs,
          });
          if (waitAction === "stagnant_backoff") {
            await sleep(STAGNANT_BACKOFF);
            sleepMsSinceLastBatch += 30 * 60 * 1000;
            stagnantBackoffs += 1;
            batchesSinceYield = 0;
            stagnantBatches = 0;
            continue;
          }
          if (waitAction === "fail") {
            const message = boundedStageReason(
              `${stage} made no progress: ` +
              `previousRemaining=${priorRemaining ?? "null"}, ` +
              `currentRemaining=${batch.remaining}, processed=${batch.processed}, ` +
              `readyNew=${batch.readyNew ?? "n/a"}, readyRetry=${batch.readyRetry ?? "n/a"}, ` +
              `retryableNow=${batch.retryableNow ?? batch.remaining}, ` +
              `deferred=${batch.deferred ?? "n/a"}, quarantined=${batch.quarantined ?? "n/a"}, ` +
              `nextRetryAt=${batch.nextRetryAt ?? "null"}. Manual diagnosis required.`,
            );
            if (batch.telemetry) batch.telemetry.noProgressReason = message;
            try {
              await recordStageBatchNoProgress(
                lock.orchestrationRunId,
                stage,
                batchSeq,
                message,
              );
            } catch {
              // Observation-only; the stage outcome below remains authoritative.
            }
            stageOutcomes.push({
              stage,
              status: "degraded",
              reason: message,
              batchCount: batchSeq,
              elapsedMs: stageTelemetry
                .filter((item) => item.stage === stage)
                .reduce((total, item) => total + item.durationMs + item.sleepMs, 0),
              remaining: batch.remaining,
              actionableRemaining: batch.retryableNow ?? batch.remaining,
              nextRetryAt: batch.nextRetryAt ?? null,
            });
            stageFinished = true;
            break;
          }
          if (waitAction === "fairness_yield") {
            await sleep(FAIRNESS_YIELD);
            sleepMsSinceLastBatch += 60 * 1000;
            batchesSinceYield = 0;
          }
        }
      } catch (error) {
        if (!stageFinished) {
          stageOutcomes.push({
            stage,
            status: "failed",
            reason: boundedStageReason(error),
            batchCount: batchSeq,
            elapsedMs: stageTelemetry
              .filter((item) => item.stage === stage)
              .reduce((total, item) => total + item.durationMs + item.sleepMs, 0),
            remaining: previousRemaining,
            actionableRemaining: previousRemaining,
            nextRetryAt: null,
          });
        }
        if (error instanceof FatalError) throw error;
      }
    }

    const stageTimings = summarizeStageTimings(stageTelemetry);
    const runOutcome = deriveDailyPipelineRunOutcome(stageOutcomes);
    // Repair 15: output-based assertion, evaluated independently of the
    // execution-based stage outcomes above. Pure and total — it cannot throw
    // and must never alter runOutcome or stage control flow.
    const productivity = assessRunProductivity({ stageTimings, stageOutcomes });
    const funnel = await finalizeRunFunnelsStep(lock.orchestrationRunId);

    // Completion semantics: the workflow reports COMPLETED when the current
    // orchestration has drained everything actionable inside it. Future-run
    // work (cooldown-expired retries, newly ingested rows) is recorded in the
    // completion summary so the admin UI never implies global completeness.
    const completion = runOutcome === "FAILED"
      ? null
      : await finalizeAgent3CompletionStep(lock.orchestrationRunId);

    // Digest delivery has its own scheduled endpoint. Keeping future delivery
    // sleeps out of this workflow releases the pipeline lock immediately after
    // the terminal processing stage completes.
    const notificationsProcessed = 0;
    const notificationsDurationMs = 0;
    await finishDailyPipeline(
      lock.orchestrationRunId,
      runOutcome,
      completedStages,
      {
        ...(runOutcome === "FAILED"
          ? { error: "No stage reached a completed or degraded outcome." }
          : {}),
        stageOutcomes,
        recovery,
        stageTimings,
        notificationsDurationMs,
        completion,
        productivity,
        funnel,
      },
    );
    return {
      orchestrationId: input.orchestrationId,
      orchestrationRunId: lock.orchestrationRunId,
      skipped: false,
      completedStages,
      runOutcome,
      stageOutcomes,
      recovery,
      notificationsProcessed,
      stageTimings,
      notificationsDurationMs,
      productivity,
      funnel,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Finalization is observation-only. Never replace the original pipeline
    // error with a failure from the diagnostic status update.
    try {
      const failedStageTimings = summarizeStageTimings(stageTelemetry);
      await finishDailyPipeline(
        lock.orchestrationRunId,
        "FAILED",
        completedStages,
        {
          error: message,
          stageOutcomes,
          recovery,
          stageTimings: failedStageTimings,
          notificationsDurationMs: 0,
          // A fatal run still records what it managed to produce before the
          // failure, so partial output is not misread as zero output.
          productivity: assessRunProductivity({
            stageTimings: failedStageTimings,
            stageOutcomes,
          }),
        },
      );
    } catch {
      // The original workflow failure remains authoritative; the durable run
      // may remain RUNNING and is then visible to stale-run recovery.
    }
    throw error;
  }
}
