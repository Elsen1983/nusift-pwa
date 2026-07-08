import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { processHardCaseDiscoveryQueue } from "../../utils/news-pipeline/hard-case-consumer";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (
    process.env.NODE_ENV === "production" &&
    process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true"
  ) {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "run-hard-case-discovery", 3, 10 * 60 * 1000);

  const body = (await readBody<{ limit?: number }>(event).catch(() => null)) as
    | { limit?: number }
    | null;
  const limit = Math.max(1, Math.min(50, Number(body?.limit) || 10));

  const result = await processHardCaseDiscoveryQueue(limit);
  return { ok: true, result };
});
