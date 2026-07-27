import { createError } from "h3";
import { requireAdminId } from "../../../utils/require-admin";
import { assertRateLimit } from "../../../utils/rate-limit";
import { readBoundedNumber } from "../../../utils/news-pipeline/parse-bounded-number";
import { processOldArticleRetentionCleanup } from "../../../utils/news-pipeline/article-retention-cleanup";

/**
 * POST /api/dev/cleanup/articles
 *
 * Admin-only. Run the old, unowned Article retention cleanup.
 *
 * Body:
 *   - dryRun?: boolean (default true; must be explicitly false to delete)
 *   - olderThanDays?: number (default 7, clamped 1..365)
 *   - limit?: number (default 100, clamped 1..500)
 *
 * Production policy:
 *   - dryRun=true (or omitted) is always allowed.
 *   - dryRun=false (real deletion) is blocked in production unless
 *     NUXT_ALLOW_PRODUCTION_CLEANUP_RUN === "true".
 *
 * Rate limited: 3 / 10 min (destructive even with dryRun default, to keep
 * manual admin usage deliberate).
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  const body = await readBody(event).catch(() => ({}));
  // dryRun defaults to true for safety. Only an explicit `false` triggers
  // real deletion.
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

  await assertRateLimit(event, "cleanup-articles-run", 3, 10 * 60 * 1000);

  const olderThanDays = readBoundedNumber(body?.olderThanDays, 7, 1, 365);
  const limit = readBoundedNumber(body?.limit, 100, 1, 500);

  const result = await processOldArticleRetentionCleanup({
    dryRun,
    olderThanDays,
    limit,
  });

  return result;
});
