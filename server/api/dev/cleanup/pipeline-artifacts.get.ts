import { requireAdminId } from "../../../utils/require-admin";
import { assertRateLimit } from "../../../utils/rate-limit";
import { readBoundedNumber } from "../../../utils/news-pipeline/parse-bounded-number";
import { processPipelineArtifactCleanup } from "../../../utils/news-pipeline/pipeline-artifact-cleanup";

/**
 * GET /api/dev/cleanup/pipeline-artifacts
 *
 * Admin-only. Inspect (dry-run) old pipeline artifact leftovers without
 * deleting. Always runs with dryRun=true regardless of query params.
 *
 * Query params:
 *   - olderThanDays?: number (default 14, clamped 1..365)
 *   - limit?: number (default 200, clamped 1..1000)
 *
 * Rate limited: 10/min (inspection is cheap and safe).
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  await assertRateLimit(event, "cleanup-pipeline-artifacts-inspect", 10, 60 * 1000);

  const query = getQuery(event);
  const olderThanDays = readBoundedNumber(query.olderThanDays, 14, 1, 365);
  const limit = readBoundedNumber(query.limit, 200, 1, 1000);

  const result = await processPipelineArtifactCleanup({
    dryRun: true, // GET always inspects; never deletes
    olderThanDays,
    limit,
  });

  return result;
});
