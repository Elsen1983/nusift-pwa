import { createError, getHeader } from "h3";
import { secretsMatch } from "../../utils/secure-secret";
import { processArticleDiscoveryHeadlessQueue } from "../../utils/news-pipeline/article-discovery-headless-queue";
import { isBrowserFallbackEnabled } from "../../utils/news-pipeline/article-discovery-browser";
import { persistStageBatchTelemetry } from "../../utils/news-pipeline/stage-telemetry-server";
import { StageBatchTelemetryTracker } from "../../utils/news-pipeline/stage-telemetry";

const asBoundedInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.trunc(parsed)))
    : fallback;
};

export default defineEventHandler(async (event) => {
  const expectedSecret = process.env.CRON_SECRET || process.env.NUXT_CRON_SECRET;
  const authorization = getHeader(event, "authorization");
  const secretHeader = getHeader(event, "x-cron-secret");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const providedSecret = secretHeader || bearerToken;
  if (!secretsMatch(providedSecret, expectedSecret)) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }
  const body = await readBody(event).catch(() => ({}));
  const orchestrationRunId = typeof body?.orchestrationRunId === "string"
    ? body.orchestrationRunId.trim().slice(0, 100)
    : "";
  if (!orchestrationRunId) {
    throw createError({ statusCode: 400, statusMessage: "Missing orchestrationRunId." });
  }

  const batchSeq = asBoundedInteger(body?.batchSeq, 1, 1, 10_000);
  const remainingBefore = body?.remainingBefore == null
    ? null
    : asBoundedInteger(body.remainingBefore, 0, 0, 1_000_000);
  const sleepMs = asBoundedInteger(body?.sleepMs, 0, 0, 86_400_000);
  const tracker = new StageBatchTelemetryTracker({
    orchestrationRunId,
    stage: "agent2-headless",
    batchSeq,
    batchSizeLimit: 3,
    concurrencyLimit: 1,
  });
  tracker.recordSleep(sleepMs);

  if (!isBrowserFallbackEnabled()) {
    const telemetry = tracker.finalize({
      processed: 0,
      succeeded: 0,
      failedRetryable: 0,
      failedPermanent: 0,
      skipped: 0,
      deferred: 0,
      quarantined: 0,
      claimLost: 0,
      persistenceFailed: 0,
      productivity: {},
      remainingBefore,
      remainingAfter: 0,
      complete: true,
    });
    try {
      await persistStageBatchTelemetry({ pipelineRunId: orchestrationRunId, telemetry });
    } catch {
      console.error("[agent2-headless] Disabled-stage telemetry persistence failed.", {
        orchestrationRunId,
        batchSeq,
      });
    }
    return {
      stage: "agent2-headless" as const,
      processed: 0,
      remaining: 0,
      complete: true,
      skipReason: "browser_disabled" as const,
      telemetry,
    };
  }

  const result = await processArticleDiscoveryHeadlessQueue({
    limit: 3,
    dryRun: false,
    runBrowser: true,
    telemetry: tracker,
  });
  if (result.dryRun) {
    throw createError({ statusCode: 500, statusMessage: "Headless queue ran in dry-run mode." });
  }

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
    remainingBefore,
    remainingAfter: remaining,
    complete,
  });
  try {
    await persistStageBatchTelemetry({ pipelineRunId: orchestrationRunId, telemetry });
  } catch {
    console.error("[agent2-headless] Stage telemetry persistence failed.", {
      orchestrationRunId,
      batchSeq,
    });
  }

  return {
    stage: "agent2-headless" as const,
    processed: result.processed,
    remaining,
    complete,
    deferred: result.deferredRemaining ?? 0,
    nextRetryAt: result.nextRetryAt ?? null,
    telemetry,
  };
});
