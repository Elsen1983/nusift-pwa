import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { runEnrichmentBatch, getAgent3Progress } from "../../utils/news-pipeline/enrichment-runtime";

/**
 * Dev trigger for the Agent 3 article enrichment batch (Phase 3).
 *
 * Runs the real HTTP extractor end-to-end: select eligible articles →
 * extract content → build canonical outcomes → persist row summary + artifacts.
 * When browserFallback is enabled, rejected articles are retried with a
 * headless browser (Playwright + @sparticuz/chromium) for JS-rendered content.
 *
 * Supports reprocessing options via request body:
 *  - maxArticles: limit batch size
 *  - includeEnriched: re-process already ENRICHED articles
 *  - forceReprocess: overwrite existing bodyText when materially better
 *  - articleIds: filter to specific articles (debug)
 *  - sourceIds: filter to specific sources
 *  - browserFallback: enable browser fallback for rejected articles
 *  - browserFallbackMaxAttempts: max browser attempts per batch (default 3, clamp 0..10)
 *  - browserTimeoutMs: timeout per browser attempt (default 25000, clamp 5000..45000)
 *  - maxArticlesPerSource: max articles from one source per batch (default 5, clamp 1..25)
 *
 * Gating matches the other dev triggers:
 *  - admin session required
 *  - rate-limited (3/10 min prod, 60/10 min dev)
 *  - disabled in production unless NUXT_ALLOW_MANUAL_NOTIFICATION_RUN=true
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (
    process.env.NODE_ENV === "production" &&
    process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true"
  ) {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  const isProduction = process.env.NODE_ENV === "production";
  // Agent 3 backlog catch-up requires repeated bounded batches in local/dev.
  // Keep production manual runs conservative; local runs can iterate quickly.
  await assertRateLimit(event, "run-article-enrichment", isProduction ? 3 : 60, 10 * 60 * 1000);

  const body = await readBody(event).catch(() => ({}));

  const maxArticles = typeof body?.maxArticles === "number" ? body.maxArticles : undefined;
  const includeEnriched = body?.includeEnriched === true;
  const forceReprocess = body?.forceReprocess === true;
  const articleIds = Array.isArray(body?.articleIds) ? body.articleIds.filter((id: unknown) => typeof id === "number") : undefined;
  const sourceIds = Array.isArray(body?.sourceIds) ? body.sourceIds.filter((id: unknown) => typeof id === "string") : undefined;

  // Phase 3: Browser fallback options
  const browserFallback = body?.browserFallback === true;
  const browserFallbackMaxAttempts = typeof body?.browserFallbackMaxAttempts === "number"
    ? Math.min(Math.max(Math.floor(body.browserFallbackMaxAttempts), 0), 10)
    : undefined;
  const browserTimeoutMs = typeof body?.browserTimeoutMs === "number"
    ? Math.min(Math.max(Math.floor(body.browserTimeoutMs), 5_000), 45_000)
    : undefined;
  const maxArticlesPerSource = typeof body?.maxArticlesPerSource === "number"
    ? Math.min(Math.max(Math.floor(body.maxArticlesPerSource), 1), 25)
    : undefined;

  const runOptions = {
    maxArticles,
    includeEnriched,
    forceReprocess,
    articleIds,
    sourceIds,
    browserFallback,
    browserFallbackMaxAttempts,
    browserTimeoutMs,
    maxArticlesPerSource,
  };

  // Compute progress before run (optional, cheap count queries)
  let progressBefore = null;
  try {
    progressBefore = await getAgent3Progress({ includeEnriched, forceReprocess, sourceIds, articleIds });
  } catch { /* non-fatal */ }

  const result = await runEnrichmentBatch(runOptions);

  // Compute accurate enrichment counts from byKind
  const byKind = result.persist.byKind;
  const successfullyEnriched = byKind.SUCCESS ?? 0;
  const rejected = Object.entries(byKind)
    .filter(([k]) => k !== "SUCCESS" && k !== "SKIPPED")
    .reduce((sum, [, v]) => sum + (v as number), 0);

  // Compute progress after run
  let progressAfter = null;
  try {
    progressAfter = await getAgent3Progress({ includeEnriched, forceReprocess, sourceIds, articleIds });
  } catch { /* non-fatal */ }

  return {
    ok: true,
    pipelineRunId: result.pipelineRunId,
    articleCount: result.articleCount,
    persisted: result.persist.persisted,
    failed: result.persist.failed,
    byKind,
    artifactCount: result.persist.artifactIds.length,
    optionsUsed: result.optionsUsed,
    // Accurate enrichment counts
    successfullyEnriched,
    rejected,
    persistedOutcomes: result.persist.persisted,
    systemPersistFailed: result.persist.failed,    // Browser fallback stats (Phase 3)
    browserFallbackStats: result.browserFallbackStats ?? null,
    // Source cooldowns
    sourceCooldowns: result.sourceCooldowns ?? null,
    // Progress snapshots
    progressBefore,
    progressAfter,
  };
});
