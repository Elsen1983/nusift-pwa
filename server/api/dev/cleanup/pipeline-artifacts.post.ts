import { createError } from "h3";
import { requireAdminId } from "../../../utils/require-admin";
import { assertRateLimit } from "../../../utils/rate-limit";
import { readBoundedNumber } from "../../../utils/news-pipeline/parse-bounded-number";
import { processPipelineArtifactCleanup } from "../../../utils/news-pipeline/pipeline-artifact-cleanup";

/**
 * POST /api/dev/cleanup/pipeline-artifacts
 *
 * Admin-only. Run the pipeline artifact cleanup.
 *
 * Body:
 *   - dryRun?: boolean (default true; must be explicitly false to delete)
 *   - olderThanDays?: number (default 14, clamped 1..365)
 *   - limit?: number (default 200, clamped 1..1000)
 *
 * Production policy:
 *   - dryRun=true (or omitted) is always allowed.
 *   - dryRun=false (real deletion) is blocked in production unless
 *     NUXT_ALLOW_PRODUCTION_CLEANUP_RUN === "true".
 *
 * Rate limited: 3 / 10 min.
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  const body = await readBody(event).catch(() => ({}));
  const dryRun = body?.dryRun === false ? false : true;

  // Production guard: dryRun=true always allowed; dryRun=false requires env flag.
  if (process.env.NODE_ENV === "production" && dryRun === false) {
    if (process.env.NUXT_ALLOW_PRODUCTION_CLEANUP_RUN !== "true") {
      throw createError({
        statusCode: 403,
        statusMessage: "Production cleanup deletion is disabled.",
      });
    }
  }

  await assertRateLimit(event, "cleanup-pipeline-artifacts-run", 3, 10 * 60 * 1000);

  const olderThanDays = readBoundedNumber(body?.olderThanDays, 14, 1, 365);
  const limit = readBoundedNumber(body?.limit, 200, 1, 1000);

  const result = await processPipelineArtifactCleanup({
    dryRun,
    olderThanDays,
    limit,
  });

  return result;
});
