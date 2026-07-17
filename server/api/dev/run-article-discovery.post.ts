import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { runArticleDiscoveryBatch } from "../../utils/news-pipeline/article-discovery";

/**
 * Dev trigger for the Agent 2 web discovery batch.
 *
 * Agent 2 targets sources/categories where RSS is missing or not yet
 * proving productive. It scans the source/category page itself and turns
 * discovered article links into article candidates in the same persistence
 * shape used by the rest of the pipeline.
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

  const result = await runArticleDiscoveryBatch({ sourceIds, categoryIds });

  return {
    ok: true,
    pipelineRunId: result.pipelineRunId,
    targets: result.targets.length,
    sourcesScanned: result.result.sourcesScanned,
    candidatesFound: result.result.candidatesFound,
    inserted: result.result.inserted,
    skipped: result.result.skipped,
    failed: result.result.failed,
    artifactCount: result.result.artifactCount || 0,
  };
});
