import { getAgent3Progress, runEnrichmentBatch } from "./enrichment-runtime";
import { persistStageBatchTelemetry } from "./stage-telemetry-server";
import { StageBatchTelemetryTracker, type StageBatchTelemetry } from "./stage-telemetry";
import {
  AGENT3_WORKFLOW_BROWSER_MAX_ATTEMPTS,
  AGENT3_WORKFLOW_BROWSER_TIMEOUT_MS,
  AGENT3_WORKFLOW_MAX_ARTICLES_PER_SOURCE,
  STAGE_BATCH_SIZE_LIMIT,
  STAGE_CONCURRENCY_LIMIT,
} from "./daily-pipeline-stage-contract";

export type Agent3WorkflowBatchResult = {
  stage: "agent3";
  processed: number;
  succeeded: number;
  failedRetryable: number;
  deferred: number;
  quarantined: number;
  readyNew: number;
  readyRetry: number;
  retryableNow: number;
  nextRetryAt: string | null;
  remaining: number;
  complete: boolean;
  browserFallbackStats: unknown;
  telemetry: StageBatchTelemetry;
};

export async function runAgent3WorkflowBatch(input: {
  orchestrationRunId: string;
  batchSeq: number;
  remainingBefore: number | null;
  sleepMs: number;
}): Promise<Agent3WorkflowBatchResult> {
  const tracker = new StageBatchTelemetryTracker({
    orchestrationRunId: input.orchestrationRunId,
    stage: "agent3",
    batchSeq: input.batchSeq,
    batchSizeLimit: STAGE_BATCH_SIZE_LIMIT.agent3,
    concurrencyLimit: STAGE_CONCURRENCY_LIMIT.agent3,
  });
  tracker.recordSleep(input.sleepMs);
  const browserFallback = process.env.NUXT_AGENT3_WORKFLOW_BROWSER_FALLBACK !== "false";
  const progressBefore = await getAgent3Progress({
    includeEnriched: false, forceReprocess: false, pipelineRunId: input.orchestrationRunId,
  });
  const browserRecoveryMode = browserFallback && progressBefore.retryableNow === 0 && progressBefore.deferred > 0;
  const result = await runEnrichmentBatch({
    maxArticles: browserRecoveryMode ? AGENT3_WORKFLOW_BROWSER_MAX_ATTEMPTS : STAGE_BATCH_SIZE_LIMIT.agent3,
    includeEnriched: false,
    forceReprocess: false,
    browserFallback,
    browserFallbackMaxAttempts: AGENT3_WORKFLOW_BROWSER_MAX_ATTEMPTS,
    browserTimeoutMs: AGENT3_WORKFLOW_BROWSER_TIMEOUT_MS,
    maxArticlesPerSource: AGENT3_WORKFLOW_MAX_ARTICLES_PER_SOURCE,
    allowBrowserRecoveryDuringHttp403Cooldown: browserRecoveryMode,
    pipelineRunId: input.orchestrationRunId,
    orchestrationRunId: input.orchestrationRunId,
    manifestInvocationKey: `agent3:${input.batchSeq}`,
    telemetry: tracker,
  });
  const progress = await getAgent3Progress({
    includeEnriched: false, forceReprocess: false, pipelineRunId: input.orchestrationRunId,
  });
  const browserRecoveryMadeProgress = browserRecoveryMode && result.articleCount > 0;
  const complete = progress.retryableNow === 0 && !browserRecoveryMadeProgress;
  const byKind = result.persist?.byKind ?? {};
  const interstitialCounts = result.interstitialDispositionCounts ?? {
    deferred: 0, quarantined: 0, readyRetry: 0, nonRetryable: 0,
  };
  const selectedCount = result.selectedCount ?? result.articleCount;
  const failedPermanent = Object.entries(byKind)
    .filter(([kind]) => !["SUCCESS", "SKIPPED", "RETRYABLE_FAILURE", "HEADLESS_REQUIRED", "INTERSTITIAL_OR_CHALLENGE"].includes(kind))
    .reduce((sum, [, count]) => sum + (typeof count === "number" ? count : 0), 0)
    + interstitialCounts.nonRetryable;
  const telemetry = tracker.finalize({
    processed: selectedCount,
    succeeded: result.dispositions?.succeeded ?? (byKind.SUCCESS ?? 0),
    failedRetryable: result.dispositions?.failedRetryable ?? ((byKind.RETRYABLE_FAILURE ?? 0) + interstitialCounts.readyRetry),
    failedPermanent: result.dispositions?.failedPermanent ?? failedPermanent,
    skipped: result.dispositions?.skipped ?? (byKind.SKIPPED ?? 0),
    deferred: result.dispositions?.deferred ?? ((byKind.HEADLESS_REQUIRED ?? 0) + interstitialCounts.deferred),
    quarantined: result.dispositions?.quarantined ?? interstitialCounts.quarantined,
    claimLost: result.dispositions?.claimLost ?? (result.persist?.claimLost ?? 0),
    persistenceFailed: result.dispositions?.persistenceFailed ?? (result.persist?.failed ?? 0),
    productivity: {
      articlesEnriched: result.dispositions?.succeeded ?? (byKind.SUCCESS ?? 0),
      articlesPublishable: result.persist?.madePublishable ?? 0,
    },
    remainingBefore: input.remainingBefore,
    remainingAfter: progress.retryableNow,
    complete,
  });
  try {
    await persistStageBatchTelemetry({ pipelineRunId: input.orchestrationRunId, telemetry });
  } catch {
    console.error("[agent3] Stage telemetry persistence failed.", {
      orchestrationRunId: input.orchestrationRunId,
      batchSeq: input.batchSeq,
    });
  }
  return {
    stage: "agent3",
    processed: selectedCount,
    succeeded: byKind.SUCCESS ?? 0,
    failedRetryable: byKind.RETRYABLE_FAILURE ?? 0,
    deferred: progress.deferred,
    quarantined: progress.quarantined,
    readyNew: progress.readyNew,
    readyRetry: progress.readyRetry,
    retryableNow: progress.retryableNow,
    nextRetryAt: progress.nextRetryAt,
    remaining: browserRecoveryMadeProgress ? Math.max(progress.deferred, 1) : progress.retryableNow,
    complete,
    browserFallbackStats: result.browserFallbackStats ?? null,
    telemetry,
  };
}
