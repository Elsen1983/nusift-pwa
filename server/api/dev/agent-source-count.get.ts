import { createError } from "h3";
import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";
import { resolveUserSourceIds } from "../../utils/news-pipeline/orchestrator";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "agent-source-count", 10, 60 * 1000);

  const sourceIds = await resolveUserSourceIds(userId);
  return { ok: true, count: sourceIds.length };
});
