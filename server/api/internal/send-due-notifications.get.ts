import { createError, getHeader } from "h3";
import { sendDueDailyNotificationsInternal } from "../../utils/notification-sender";

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
  const { stats } = await sendDueDailyNotificationsInternal(startedAt);
  return {
    ok: true,
    telemetryVersion: stats.telemetryVersion,
    usersMatchedSchedule: stats.usersMatchedSchedule,
    usersAlreadyNotified: stats.usersAlreadyNotified,
    usersWithoutActiveScope: stats.usersWithoutActiveScope,
    usersWithEmptyFeed: stats.usersWithEmptyFeed,
    inboxNotificationsCreated: stats.inboxNotificationsCreated,
    inboxNotificationFailures: stats.inboxNotificationFailures,
    usersWithActivePushSubscriptions: stats.usersWithActivePushSubscriptions,
    pushSubscriptionsAttempted: stats.pushSubscriptionsAttempted,
    pushesDelivered: stats.pushesDelivered,
    pushesFailed: stats.pushesFailed,
    stalePushSubscriptionsDeactivated: stats.stalePushSubscriptionsDeactivated,
    lastError: stats.lastError,
    processedAt: startedAt.toISOString(),
  };
});
