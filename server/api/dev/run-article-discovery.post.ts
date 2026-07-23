import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { runArticleDiscoveryBatch } from "../../utils/news-pipeline/article-discovery";
import { readBoundedNumber } from "../../utils/news-pipeline/parse-bounded-number";

/**
 * Dev trigger for the Agent 2 web discovery batch.
 *
 * Agent 2 targets sources/categories where RSS is missing or not yet
 * proving productive. Supports bounded batch processing with maxTargets,
 * timeBudgetMs, and minRemainingMs parameters.
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (
    process.env.NODE_ENV === "production" &&
    process.env.NUXT_ALLOW_MANUAL_ARTICLE_DISCOVERY_RUN !== "true"
  ) {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "run-article-discovery", 3, 10 * 60 * 1000);

  const body = await readBody(event).catch(() => ({}));
  const sourceIds = Array.isArray(body?.sourceIds)
    ? body.sourceIds.map(String).filter(Boolean)
    : undefined;
  const categoryIds = Array.isArray(body?.categoryIds)
    ? body.categoryIds.map(String).filter(Boolean)
    : undefined;
  const maxTargets = readBoundedNumber(body?.maxTargets, 5, 1, 50);
  const timeBudgetMs = readBoundedNumber(body?.timeBudgetMs, 240_000, 10_000, 600_000);
  const minRemainingMs = readBoundedNumber(body?.minRemainingMs, 30_000, 5_000, 120_000);

  const result = await runArticleDiscoveryBatch({
    sourceIds,
    categoryIds,
    maxTargets,
    timeBudgetMs,
    minRemainingMs,
  });

  return {
    ok: true,
    agent: "A2",
    runId: result.pipelineRunId,
    targetsResolved: result.targets.length,
    processed: result.processed,
    deferred: result.deferred,
    remainingEligible: result.remainingEligible,
    stoppedReason: result.stoppedReason,
    candidates: result.result.candidatesFound,
    inserted: result.result.inserted,
    skipped: result.result.skipped,
    failed: result.result.failed,
    artifacts: result.result.artifactCount || 0,
  };
});
