import { sendDueDailyNotifications } from "../utils/notification-sender";

export default defineNitroPlugin(() => {
  // Production delivery is owned by the durable terminal-stage workflow.
  // In-memory timers are not reliable across serverless invocations and could
  // send a digest before the current pipeline has finished publishing.
  const enabled = process.env.NODE_ENV !== "production";
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
