export const NOTIFICATION_TELEMETRY_VERSION = 2 as const;

export const NOTIFICATION_COUNTER_KEYS = [
  "usersMatchedSchedule",
  "usersAlreadyNotified",
  "usersWithoutActiveScope",
  "usersWithEmptyFeed",
  "inboxNotificationsCreated",
  "inboxNotificationFailures",
  "usersWithActivePushSubscriptions",
  "pushSubscriptionsAttempted",
  "pushesDelivered",
  "pushesFailed",
  "stalePushSubscriptionsDeactivated",
] as const;

export type NotificationCounterKey = (typeof NOTIFICATION_COUNTER_KEYS)[number];
export type NormalizedNotificationTelemetry = {
  telemetryVersion: number | null;
} & { [K in NotificationCounterKey]: number | null } & {
  usersProcessed: number | null;
  pushesSent: number | null;
  skippedEmpty: number | null;
  lastError: string | null;
};

const asCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1_000_000, Math.round(value)))
    : null;

const asError = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null;

/**
 * New fields are read exactly as persisted. Legacy fields are exposed only as
 * nullable historical values; no missing new counter is inferred as zero.
 */
export function normalizeNotificationTelemetry(value: unknown): NormalizedNotificationTelemetry {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    telemetryVersion: asCount(raw.telemetryVersion),
    usersMatchedSchedule: asCount(raw.usersMatchedSchedule),
    usersAlreadyNotified: asCount(raw.usersAlreadyNotified),
    usersWithoutActiveScope: asCount(raw.usersWithoutActiveScope),
    usersWithEmptyFeed: asCount(raw.usersWithEmptyFeed),
    inboxNotificationsCreated: asCount(raw.inboxNotificationsCreated),
    inboxNotificationFailures: asCount(raw.inboxNotificationFailures),
    usersWithActivePushSubscriptions: asCount(raw.usersWithActivePushSubscriptions),
    pushSubscriptionsAttempted: asCount(raw.pushSubscriptionsAttempted),
    pushesDelivered: asCount(raw.pushesDelivered),
    pushesFailed: asCount(raw.pushesFailed),
    stalePushSubscriptionsDeactivated: asCount(raw.stalePushSubscriptionsDeactivated),
    usersProcessed: asCount(raw.usersProcessed),
    pushesSent: asCount(raw.pushesSent),
    skippedEmpty: asCount(raw.skippedEmpty),
    lastError: asError(raw.lastError),
  };
}
