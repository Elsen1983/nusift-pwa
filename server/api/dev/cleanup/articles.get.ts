import { requireAdminId } from "../../../utils/require-admin";
import { assertRateLimit } from "../../../utils/rate-limit";
import { readBoundedNumber } from "../../../utils/news-pipeline/parse-bounded-number";
import { processOldArticleRetentionCleanup } from "../../../utils/news-pipeline/article-retention-cleanup";

/**
 * GET /api/dev/cleanup/articles
 *
 * Admin-only. Inspect (dry-run) old, unowned Article rows without deleting.
 * Always runs with dryRun=true regardless of query params.
 *
 * Query params:
 *   - olderThanDays?: number (default 7, clamped 1..365)
 *   - limit?: number (default 100, clamped 1..500)
 *
 * Rate limited: 10/min (inspection is cheap and safe).
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  await assertRateLimit(event, "cleanup-articles-inspect", 10, 60 * 1000);

  const query = getQuery(event);
  const olderThanDays = readBoundedNumber(query.olderThanDays, 7, 1, 365);
  const limit = readBoundedNumber(query.limit, 100, 1, 500);

  const result = await processOldArticleRetentionCleanup({
    dryRun: true, // GET always inspects; never deletes
    olderThanDays,
    limit,
  });

  return result;
});
