import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { buildHardSourceReport } from "../../utils/news-pipeline/hard-source-tracking";

/**
 * GET /api/dev/article-discovery-hard-sources
 *
 * Admin-only. Returns a compact hard-source report derived from recent
 * Agent 2 artifacts. Used by the /audit/admin console to surface
 * AI-inspection candidates (targets where static + browser fallback both
 * failed).
 *
 * No DB schema changes — the report is computed on the fly from existing
 * PipelineArtifact rows.
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  await assertRateLimit(event, "article-discovery-hard-sources", 10, 60 * 1000);

  const query = getQuery(event);
  const scanLimit =
    typeof query.scanLimit === "string"
      ? Math.min(Math.max(Number(query.scanLimit) || 200, 10), 500)
      : undefined;

  const report = await buildHardSourceReport({ scanLimit });

  return { ok: true, report };
});
