import { createError, readBody } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { readBoundedNumber } from "../../utils/news-pipeline/parse-bounded-number";
import { runAgent1Batch } from "../../utils/news-pipeline/orchestrator";
import { resolveAgent2Targets } from "../../utils/news-pipeline/article-discovery";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  // Agent 1 is now intentionally batched, so admins may need several
  // consecutive runs to drain the queue after a large source refresh.
  await assertRateLimit(event, "run-news-pipeline", 20, 10 * 60 * 1000);

  const body = await readBody(event).catch(() => ({}));
  const maxTargets = readBoundedNumber(body?.maxTargets, 5, 1, 50);
  const timeBudgetMs = readBoundedNumber(body?.timeBudgetMs, 240_000, 10_000, 600_000);
  const minRemainingMs = readBoundedNumber(body?.minRemainingMs, 30_000, 5_000, 120_000);

  const sourceIds = Array.isArray(body?.sourceIds)
    ? body.sourceIds.map(String)
    : undefined;
  const categoryIds = Array.isArray(body?.categoryIds)
    ? body.categoryIds.map(String)
    : undefined;

  // Agent 1 only — does NOT trigger Agent 2
  const batchResult = await runAgent1Batch({
    sourceIds,
    categoryIds,
    maxTargets,
    timeBudgetMs,
    minRemainingMs,
  });

  // Compute Agent 2 eligible count after A1 run.
  let agent2EligibleAfterRun: number | null = null;
  let agent2EligibleAfterRunError: string | null = null;
  try {
    const a2Input = sourceIds || categoryIds ? { sourceIds, categoryIds } : undefined;
    const { targets: a2Targets } = await resolveAgent2Targets(a2Input);
    agent2EligibleAfterRun = a2Targets.length;
  } catch (err: any) {
    agent2EligibleAfterRunError = String(err?.message || err).slice(0, 200);
  }

  return {
    ok: true,
    agent: "A1",
    pipelineRunId: batchResult.pipelineRunId,
    targetsResolved: batchResult.targetsResolved,
    processed: batchResult.processed,
    deferred: batchResult.deferred,
    remainingEligible: batchResult.remainingEligible,
    stoppedReason: batchResult.stoppedReason,
    durationMs: batchResult.durationMs,
    candidates: batchResult.result.candidates,
    inserted: batchResult.result.inserted,
    skipped: batchResult.result.skipped,
    failed: batchResult.result.failed,
    artifacts: batchResult.result.artifactCount,
    agent2EligibleAfterRun,
    agent2EligibleAfterRunError,
  };
});
