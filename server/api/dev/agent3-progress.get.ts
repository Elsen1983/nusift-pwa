import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { getAgent3Progress } from "../../utils/news-pipeline/enrichment-runtime";

/**
 * Dev endpoint for Agent 3 enrichment progress.
 *
 * Returns eligible counts, latest run summary, and remaining targets.
 * Read-only — no destructive actions. Admin-only with rate limiting.
 *
 * Query params:
 *  - includeEnriched: "true" to include ENRICHED articles
 *  - forceReprocess: "true" (for mode display, doesn't affect counts)
 *  - sourceIds: comma-separated source IDs
 *  - articleIds: comma-separated numeric article IDs
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "agent3-progress", 10, 60 * 1000);

  const query = getQuery(event);

  const includeEnriched = query.includeEnriched === "true";
  const forceReprocess = query.forceReprocess === "true";

  const sourceIds = typeof query.sourceIds === "string" && query.sourceIds.length > 0
    ? query.sourceIds.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const articleIds = typeof query.articleIds === "string" && query.articleIds.length > 0
    ? query.articleIds.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
    : undefined;

  const progress = await getAgent3Progress({
    includeEnriched,
    forceReprocess,
    sourceIds,
    articleIds,
  });

  return {
    ok: true,
    progress,
  };
});
