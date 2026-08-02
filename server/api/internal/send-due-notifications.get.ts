import { createError, getHeader } from "h3";
import { sendDueDailyNotifications } from "../../utils/notification-sender";

export default defineEventHandler(async (event) => {
  const expectedSecret = process.env.CRON_SECRET || process.env.NUXT_CRON_SECRET;
  if (!expectedSecret) {
    throw createError({ statusCode: 500, statusMessage: "Cron endpoint not configured." });
  }

  const authorization = getHeader(event, "authorization");
  const secretHeader = getHeader(event, "x-cron-secret");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const providedSecret = secretHeader || bearerToken;
  if (!providedSecret || providedSecret !== expectedSecret) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }

  const startedAt = new Date();
  const results = await sendDueDailyNotifications(startedAt);
  return {
    ok: true,
    usersProcessed: results.length,
    pushesSent: results.reduce((sum, result) => sum + result.sent, 0),
    processedAt: startedAt.toISOString(),
  };
});
