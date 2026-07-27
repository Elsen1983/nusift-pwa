/**
 * GET /api/dev/agent2-health
 *
 * Admin-only. Returns compact health summaries for all Agent 2 targets.
 * Each target gets a health status (healthy/weak/blocked/unsupported/unknown),
 * a score (0-100), lifecycle state, and recommended action.
 *
 * Read-only — no DB writes. Computes health from existing PipelineArtifact
 * rows, RSS state, and hard-source profile data.
 */

import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { buildAgent2HealthReport } from "../../utils/news-pipeline/agent2-health";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "agent2-health", 10, 60 * 1000);

  const query = getQuery(event);
  const scanLimit = typeof query.scanLimit === "string"
    ? Math.min(Math.max(parseInt(query.scanLimit, 10) || 300, 10), 500)
    : 300;

  const targets = await buildAgent2HealthReport({ scanLimit });

  return {
    ok: true,
    targets,
    total: targets.length,
    generatedAt: new Date().toISOString(),
  };
});
