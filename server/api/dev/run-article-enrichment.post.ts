import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { runEnrichmentBatch } from "../../utils/news-pipeline/enrichment-runtime";

/**
 * Dev trigger for the Agent 2 article enrichment batch (Phase 1).
 *
 * Runs the controlled stub extractor end-to-end: select eligible articles →
 * build canonical outcomes → persist row summary + artifacts. No real HTTP
 * extraction or headless browser is invoked yet (Phase 2/3).
 *
 * Gating matches the other dev triggers:
 *  - admin session required
 *  - rate-limited (3 / 10 min)
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

  await assertRateLimit(event, "run-article-enrichment", 3, 10 * 60 * 1000);

  const result = await runEnrichmentBatch();

  return {
    ok: true,
    pipelineRunId: result.pipelineRunId,
    articleCount: result.articleCount,
    persisted: result.persist.persisted,
    failed: result.persist.failed,
    byKind: result.persist.byKind,
    artifactCount: result.persist.artifactIds.length,
  };
});
