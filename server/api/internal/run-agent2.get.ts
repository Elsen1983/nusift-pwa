import { createError, getHeader, getQuery } from "h3";
import { runArticleDiscoveryBatch } from "../../utils/news-pipeline/article-discovery";
import { readBoundedNumber } from "../../utils/news-pipeline/parse-bounded-number";

export default defineEventHandler(async (event) => {
  const expectedSecret = process.env.CRON_SECRET || process.env.NUXT_CRON_SECRET;
  if (!expectedSecret) {
    throw createError({ statusCode: 500, statusMessage: "Cron endpoint not configured." });
  }

  const authHeader = getHeader(event, "authorization");
  const secretHeader = getHeader(event, "x-cron-secret");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const providedSecret = secretHeader || bearerToken;

  if (!providedSecret || providedSecret !== expectedSecret) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }

  const query = getQuery(event);
  const maxTargets = readBoundedNumber(query.maxTargets, 5, 1, 50);
  const timeBudgetMs = readBoundedNumber(query.timeBudgetMs, 240_000, 10_000, 600_000);
  const minRemainingMs = readBoundedNumber(query.minRemainingMs, 30_000, 5_000, 120_000);

  const result = await runArticleDiscoveryBatch({ maxTargets, timeBudgetMs, minRemainingMs });

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
    artifacts: result.result.artifactCount,
  };
});
