import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import {
  resolveActivePipelineTargets,
  runNewsPipeline,
} from "../../utils/news-pipeline/orchestrator";

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

  const result = await runNewsPipeline(sourceIds, categoryIds);
  return { ok: true, result };
});
