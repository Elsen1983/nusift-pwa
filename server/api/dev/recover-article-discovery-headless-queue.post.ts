import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { recoverStaleArticleDiscoveryHeadlessProcessing } from "../../utils/news-pipeline/article-discovery-headless-queue";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "headless-recovery", 5, 10 * 60 * 1000);

  const body = await readBody(event).catch(() => ({}));
  const olderThanMinutes = typeof body?.olderThanMinutes === "number" ? body.olderThanMinutes : undefined;
  const limit = typeof body?.limit === "number" ? body.limit : undefined;
  const mode = body?.mode === "fail" ? "fail" : "retry";

  const result = await recoverStaleArticleDiscoveryHeadlessProcessing({
    olderThanMinutes,
    limit,
    mode,
  });

  return { ok: true, result };
});
