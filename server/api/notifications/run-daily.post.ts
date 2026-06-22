import { createError } from "h3";
import { sendDueDailyNotifications } from "../../utils/notification-sender";

export default defineEventHandler(async () => {
  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  const results = await sendDueDailyNotifications(new Date());
  return { ok: true, results };
});
