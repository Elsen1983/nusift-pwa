import { sendDueDailyNotifications } from "../utils/notification-sender";

export default defineNitroPlugin(() => {
  const enabled = process.env.NUXT_ENABLE_NOTIFICATION_CRON === "true" || process.env.NODE_ENV !== "production";
  if (!enabled) return;

  const intervalMs = 15 * 60 * 1000;

  const run = async () => {
    try {
      await sendDueDailyNotifications(new Date());
    } catch (error) {
      console.warn("[notifications] cron run failed", error);
    }
  };

  void run();
  setInterval(run, intervalMs);
});
