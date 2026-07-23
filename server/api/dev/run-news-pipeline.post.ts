import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { runNewsPipeline } from "../../utils/news-pipeline/orchestrator";
import { resolveActivePipelineTargets } from "../../utils/news-pipeline/targets";
import { resolveAgent2Targets } from "../../utils/news-pipeline/article-discovery";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "run-news-pipeline", 3, 10 * 60 * 1000);

  const body = await readBody(event).catch(() => ({}));
  const activeTargets = await resolveActivePipelineTargets();
  const activeSourceIds = [...new Set(activeTargets.map((target) => target.sourceId))];
  const activeCategoryIds = [
    ...new Set(
      activeTargets
        .map((target) => target.categoryId)
        .filter((categoryId): categoryId is string => Boolean(categoryId)),
    ),
  ];

  const sourceIds = Array.isArray(body?.sourceIds)
    ? body.sourceIds.map(String).filter((id: string) => activeSourceIds.includes(id))
    : undefined;

  const categoryIds = Array.isArray(body?.categoryIds)
    ? body.categoryIds
        .map(String)
        .filter((id: string) => activeCategoryIds.includes(id))
    : undefined;

  // Agent 1 only — does NOT trigger Agent 2
  const startedAt = Date.now();
  const result = await runNewsPipeline(sourceIds, categoryIds);
  const durationMs = Date.now() - startedAt;

  // Compute Agent 2 eligible count after A1 run.
  // Scoped to same target filters when provided.
  let agent2EligibleAfterRun: number | null = null;
  let agent2EligibleAfterRunError: string | null = null;
  try {
    const a2Input = sourceIds || categoryIds ? { sourceIds, categoryIds } : undefined;
    const { targets: a2Targets } = await resolveAgent2Targets(a2Input);
    agent2EligibleAfterRun = a2Targets.length;
  } catch (err: any) {
    agent2EligibleAfterRunError = String(err?.message || err).slice(0, 200);
  }

  return {
    ok: true,
    agent: "A1",
    durationMs,
    targets: result.sourcesScanned,
    candidates: result.candidatesFound,
    inserted: result.inserted,
    skipped: result.skipped,
    failed: result.failed,
    artifacts: result.artifactCount,
    agent2EligibleAfterRun,
    agent2EligibleAfterRunError,
    result,
  };
});
