import { createError } from "h3";
import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";
import { resolveActivePipelineSourceIds, runNewsPipeline } from "../../utils/news-pipeline/orchestrator";

export default defineEventHandler(async (event) => {
  requireUserId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "run-news-pipeline", 3, 10 * 60 * 1000);

  const body = await readBody(event).catch(() => ({}));
  const activeSourceIds = await resolveActivePipelineSourceIds();
  const sourceIds = Array.isArray(body?.sourceIds)
    ? body.sourceIds.map(String).filter((id: string) => activeSourceIds.includes(id))
    : activeSourceIds;

  const result = await runNewsPipeline(sourceIds);
  return { ok: true, result };
});
