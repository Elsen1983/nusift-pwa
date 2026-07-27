import { createError, getHeader, getQuery } from "h3";
import { runMaintenanceCleanup } from "../../utils/news-pipeline/maintenance-cleanup-runner";
import { readBoundedNumber } from "../../utils/news-pipeline/parse-bounded-number";

/**
 * GET /api/internal/cleanup-maintenance
 *
 * Cron endpoint for bounded, time-budgeted maintenance cleanup.
 * Protected by CRON_SECRET (not admin cookie/session auth).
 *
 * Runs real cleanup with dryRun=false. Safety comes from:
 *   - CRON_SECRET auth
 *   - bounded per-batch limits (existing cleanup utilities)
 *   - total time budget with minRemainingMs safety margin
 *   - existing cleanup protections (active artifacts, user-owned articles)
 *
 * Query params (all optional, clamped to safe ranges):
 *   - articleOlderThanDays (default 7, 1..365)
 *   - articleBatchLimit (default 500, 1..1000)
 *   - artifactOlderThanDays (default 14, 1..365)
 *   - artifactBatchLimit (default 1000, 1..2000)
 *   - timeBudgetMs (default 45000, 5000..120000)
 *   - minRemainingMs (default 5000, 1000..30000)
 *   - runArticles ("false" to disable, default true)
 *   - runPipelineArtifacts ("false" to disable, default true)
 */
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

  const articleOlderThanDays = readBoundedNumber(query.articleOlderThanDays, 7, 1, 365);
  const articleBatchLimit = readBoundedNumber(query.articleBatchLimit, 500, 1, 1000);
  const artifactOlderThanDays = readBoundedNumber(query.artifactOlderThanDays, 14, 1, 365);
  const artifactBatchLimit = readBoundedNumber(query.artifactBatchLimit, 1000, 1, 2000);
  const timeBudgetMs = readBoundedNumber(query.timeBudgetMs, 45_000, 5_000, 120_000);
  const minRemainingMs = readBoundedNumber(query.minRemainingMs, 5_000, 1_000, 30_000);

  // Boolean parsing: "false" disables, "true" enables, missing defaults to true.
  const runArticlesRaw = typeof query.runArticles === "string" ? query.runArticles.trim().toLowerCase() : "";
  const runArticles = runArticlesRaw === "false" ? false : true;

  const runPipelineArtifactsRaw = typeof query.runPipelineArtifacts === "string"
    ? query.runPipelineArtifacts.trim().toLowerCase()
    : "";
  const runPipelineArtifacts = runPipelineArtifactsRaw === "false" ? false : true;

  const result = await runMaintenanceCleanup({
    articleOlderThanDays,
    articleBatchLimit,
    artifactOlderThanDays,
    artifactBatchLimit,
    timeBudgetMs,
    minRemainingMs,
    runArticles,
    runPipelineArtifacts,
  });

  return result;
});
