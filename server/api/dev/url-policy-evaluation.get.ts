/**
 * GET /api/dev/url-policy-evaluation
 *
 * Read-only admin endpoint that exposes the latest URL policy evaluation
 * report: dataset info, metrics by split and policy, baseline comparison,
 * and sample decisions.
 *
 * Requires admin access. Does not mutate any records.
 */

import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { createTuningDataset, createHoldoutDataset } from "../../utils/news-pipeline/url-policy-evaluation";
import { runUrlPolicyEvaluation } from "../../utils/news-pipeline/url-policy-evaluation-runner";
import { getRecentUrlPolicyDecisions } from "../../utils/news-pipeline/url-policy-decision-observer";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "url-policy-evaluation", 10, 60 * 1000);

  const query = getQuery(event);
  const includeRecentDecisions = query.recentDecisions === "true";

  // ── Run evaluation report ───────────────────────────────────────────
  const report = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());

  // ── Optionally include recent persisted decisions ───────────────────
  let recentDecisions = null;
  if (includeRecentDecisions) {
    recentDecisions = {
      all: await getRecentUrlPolicyDecisions({
        limit: 40,
      }),
    };
  }

  return {
    ok: true,
    report,
    recentDecisions,
  };
});
