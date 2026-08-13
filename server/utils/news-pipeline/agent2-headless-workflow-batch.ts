import { processArticleDiscoveryHeadlessQueue } from "./article-discovery-headless-queue";
import { isBrowserFallbackEnabled } from "./article-discovery-browser";
import { persistStageBatchTelemetry } from "./stage-telemetry-server";
import { StageBatchTelemetryTracker, type StageBatchTelemetry } from "./stage-telemetry";
import { STAGE_BATCH_SIZE_LIMIT, STAGE_CONCURRENCY_LIMIT } from "./daily-pipeline-stage-contract";

export type Agent2HeadlessWorkflowBatchResult = {
  stage: "agent2-headless";
  processed: number;
  remaining: number;
  complete: boolean;
  skipReason?: "browser_disabled";
  deferred?: number;
  nextRetryAt?: string | null;
  telemetry: StageBatchTelemetry;
};

export async function runAgent2HeadlessWorkflowBatch(input: {
  orchestrationRunId: string;
  batchSeq: number;
  remainingBefore: number | null;
  sleepMs: number;
}): Promise<Agent2HeadlessWorkflowBatchResult> {
  const tracker = new StageBatchTelemetryTracker({
    orchestrationRunId: input.orchestrationRunId,
    stage: "agent2-headless",
    batchSeq: input.batchSeq,
    batchSizeLimit: STAGE_BATCH_SIZE_LIMIT["agent2-headless"],
    concurrencyLimit: STAGE_CONCURRENCY_LIMIT["agent2-headless"],
  });
  tracker.recordSleep(input.sleepMs);

  if (!isBrowserFallbackEnabled()) {
    const telemetry = tracker.finalize({
      processed: 0, succeeded: 0, failedRetryable: 0, failedPermanent: 0,
      skipped: 0, deferred: 0, quarantined: 0, claimLost: 0, persistenceFailed: 0,
      productivity: {}, remainingBefore: input.remainingBefore, remainingAfter: 0, complete: true,
    });
    try {
      await persistStageBatchTelemetry({ pipelineRunId: input.orchestrationRunId, telemetry });
    } catch {
      console.error("[agent2-headless] Disabled-stage telemetry persistence failed.", {
        orchestrationRunId: input.orchestrationRunId,
        batchSeq: input.batchSeq,
      });
    }
    return { stage: "agent2-headless", processed: 0, remaining: 0, complete: true, skipReason: "browser_disabled", telemetry };
  }

  const result = await processArticleDiscoveryHeadlessQueue({
    limit: STAGE_BATCH_SIZE_LIMIT["agent2-headless"],
    dryRun: false,
    runBrowser: true,
    telemetry: tracker,
    orchestrationRunId: input.orchestrationRunId,
    manifestInvocationKey: `agent2-headless:${input.batchSeq}`,
  });
  if (result.dryRun) throw new Error("Headless queue ran in dry-run mode.");

  const remaining = result.remainingEligible ?? 0;
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
    remainingBefore: input.remainingBefore,
    remainingAfter: remaining,
    complete: remaining === 0,
  });
  try {
    await persistStageBatchTelemetry({ pipelineRunId: input.orchestrationRunId, telemetry });
  } catch {
    console.error("[agent2-headless] Stage telemetry persistence failed.", {
      orchestrationRunId: input.orchestrationRunId,
      batchSeq: input.batchSeq,
    });
  }
  return {
    stage: "agent2-headless",
    processed: result.processed,
    remaining,
    complete: remaining === 0,
    deferred: result.deferredRemaining ?? 0,
    nextRetryAt: result.nextRetryAt ?? null,
    telemetry,
  };
}
