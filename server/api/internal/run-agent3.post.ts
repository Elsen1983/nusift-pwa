import { createError, getHeader } from "h3";
import { secretsMatch } from "../../utils/secure-secret";
import { runEnrichmentBatch, getAgent3Progress } from "../../utils/news-pipeline/enrichment-runtime";
import { computeAgent3CompletionSummaryForRun } from "../../utils/news-pipeline/agent3-completion";
import { persistStageBatchTelemetry } from "../../utils/news-pipeline/stage-telemetry-server";
import { StageBatchTelemetryTracker } from "../../utils/news-pipeline/stage-telemetry";

const authenticate = (event: Parameters<typeof getHeader>[0]) => {
  const expected = process.env.CRON_SECRET || process.env.NUXT_CRON_SECRET;
  const authorization = getHeader(event, "authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const provided = getHeader(event, "x-cron-secret") || bearer;
  if (!secretsMatch(provided, expected)) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }
};

const boundedInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.trunc(parsed)))
    : fallback;
};

const WORKFLOW_BROWSER_MAX_ATTEMPTS = 2;
const WORKFLOW_BROWSER_TIMEOUT_MS = 25_000;
const WORKFLOW_MAX_ARTICLES_PER_SOURCE = 2;

export default defineEventHandler(async (event) => {
  authenticate(event);
  const body = await readBody(event).catch(() => ({}));
  const orchestrationRunId = typeof body?.orchestrationRunId === "string"
    ? body.orchestrationRunId.trim().slice(0, 100)
    : "";
  if (!orchestrationRunId) {
    throw createError({ statusCode: 400, statusMessage: "Missing orchestrationRunId." });
  }

  if (body?.action === "completion") {
    const { summary } = await computeAgent3CompletionSummaryForRun(getAgent3Progress, {
      currentRunOptions: {
        includeEnriched: false,
        forceReprocess: false,
        pipelineRunId: orchestrationRunId,
      },
      futureRunOptions: {
        includeEnriched: false,
        forceReprocess: false,
      },
    });
    return { action: "completion" as const, summary };
  }

  const batchSeq = boundedInteger(body?.batchSeq, 1, 1, 10_000);
  const remainingBefore = body?.remainingBefore == null
    ? null
    : boundedInteger(body.remainingBefore, 0, 0, 1_000_000);
  const sleepMs = boundedInteger(body?.sleepMs, 0, 0, 86_400_000);
  const tracker = new StageBatchTelemetryTracker({
    orchestrationRunId,
    stage: "agent3",
    batchSeq,
    batchSizeLimit: 10,
    concurrencyLimit: 1,
  });
  tracker.recordSleep(sleepMs);

  // Browser recovery is deliberately bounded. Static extraction remains the
  // default for every article; only browser-eligible failures consume this
  // small per-batch budget. Operators can disable it without a code rollback.
  const browserFallback = process.env.NUXT_AGENT3_WORKFLOW_BROWSER_FALLBACK !== "false";
  const progressBefore = await getAgent3Progress({
    includeEnriched: false,
    forceReprocess: false,
    pipelineRunId: orchestrationRunId,
  });
  // Once normal work is drained, use the browser budget to recover persisted
  // article-level 403 failures without bypassing 429 or host-only cooldowns.
  const browserRecoveryMode =
    browserFallback && progressBefore.retryableNow === 0 && progressBefore.deferred > 0;

  const result = await runEnrichmentBatch({
    maxArticles: browserRecoveryMode ? WORKFLOW_BROWSER_MAX_ATTEMPTS : 10,
    includeEnriched: false,
    forceReprocess: false,
    browserFallback,
    browserFallbackMaxAttempts: WORKFLOW_BROWSER_MAX_ATTEMPTS,
    browserTimeoutMs: WORKFLOW_BROWSER_TIMEOUT_MS,
    maxArticlesPerSource: WORKFLOW_MAX_ARTICLES_PER_SOURCE,
    allowBrowserRecoveryDuringHttp403Cooldown: browserRecoveryMode,
    pipelineRunId: orchestrationRunId,
    telemetry: tracker,
  });
  const progress = await getAgent3Progress({
    includeEnriched: false,
    forceReprocess: false,
    pipelineRunId: orchestrationRunId,
  });
  const browserRecoveryMadeProgress = browserRecoveryMode && result.articleCount > 0;
  const complete = progress.retryableNow === 0 && !browserRecoveryMadeProgress;
  const byKind = result.persist?.byKind ?? {};
  // INTERSTITIAL_OR_CHALLENGE is not inherently permanent: browser recovery
  // may still be possible. These disposition counts are persisted-only and
  // come from the exact per-article retry disposition computed once by the
  // retry policy and counted only after Article/artifact persistence succeeds.
  // DEFERRED → deferred, QUARANTINED → quarantined, READY_RETRY →
  // failedRetryable, NON_RETRYABLE → failedPermanent. Thus NON_RETRYABLE
  // interstitials may legitimately contribute to failedPermanent; every other
  // outcome keeps its byKind semantics and HEADLESS_REQUIRED stays deferred.
  const interstitialCounts = result.interstitialDispositionCounts ?? {
    deferred: 0,
    quarantined: 0,
    readyRetry: 0,
    nonRetryable: 0,
  };
  const selectedCount = result.selectedCount ?? result.articleCount;
  const failedPermanent = Object.entries(byKind)
    .filter(([kind]) => !["SUCCESS", "SKIPPED", "RETRYABLE_FAILURE", "HEADLESS_REQUIRED", "INTERSTITIAL_OR_CHALLENGE"].includes(kind))
    .reduce((sum, [, count]) => sum + (typeof count === "number" ? count : 0), 0)
    + interstitialCounts.nonRetryable;
  // StageBatchTelemetry intentionally combines two authority domains:
  // operation counters are actual-work observations from the tracker, while
  // disposition buckets below come only from runEnrichmentBatch's persisted
  // outcome result. Claim loss and persistence failure therefore remain visible
  // as durable disposition buckets without becoming successes/failures in
  // browserFallbackStats or HTTP evidence.
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
    remainingBefore,
    remainingAfter: progress.retryableNow,
    complete,
  });
  try {
    await persistStageBatchTelemetry({ pipelineRunId: orchestrationRunId, telemetry });
  } catch {
    console.error("[agent3] Stage telemetry persistence failed.", { orchestrationRunId, batchSeq });
  }

  return {
    stage: "agent3" as const,
    processed: selectedCount,
    succeeded: byKind.SUCCESS ?? 0,
    failedRetryable: byKind.RETRYABLE_FAILURE ?? 0,
    deferred: progress.deferred,
    quarantined: progress.quarantined,
    readyNew: progress.readyNew,
    readyRetry: progress.readyRetry,
    retryableNow: progress.retryableNow,
    nextRetryAt: progress.nextRetryAt,
    remaining: browserRecoveryMadeProgress
      ? Math.max(progress.deferred, 1)
      : progress.retryableNow,
    complete,
    browserFallbackStats: result.browserFallbackStats ?? null,
    telemetry,
  };
});
