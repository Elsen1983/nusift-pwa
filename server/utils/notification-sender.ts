import { prisma } from "./prisma";
import {
  buildUserFeedPublicationWhere,
  isEffectivelyPublishableArticle,
} from "./news-pipeline/publication-gate";
import { getNotificationPayload, sendPushNotification } from "./push";
import { buildSubscriptionArticleScope, getSubscriptionScope } from "./subscription-scope";
import { dailyDigestDedupeKey, isUniqueConstraintConflict } from "./notification-idempotency";
import { appendBoundedDiagnostic, boundedDiagnostic } from "./notification-diagnostics";

const slotHours: Record<"MORNING" | "NOON" | "EVENING", number[]> = {
  MORNING: [6, 11],
  NOON: [12, 16],
  EVENING: [18, 22],
};

export type DailyNotificationSlot = keyof typeof slotHours;

function isWithinSlot(slot: DailyNotificationSlot, now = new Date()) {
  const hour = now.getUTCHours();
  const [start, end] = slotHours[slot];
  return hour >= start! && hour <= end!;
}

/**
 * Version 2 notification telemetry. Counters describe separate stages:
 * - recipient counters describe schedule/scope/feed selection;
 * - inbox counters describe Notification row persistence;
 * - push counters describe individual browser endpoints and never change the
 *   persisted inbox lifecycle status.
 */
export type DailyNotificationRunStats = {
  telemetryVersion: 2;
  usersMatchedSchedule: number;
  usersAlreadyNotified: number;
  usersWithoutActiveScope: number;
  usersWithEmptyFeed: number;
  inboxNotificationsCreated: number;
  inboxNotificationFailures: number;
  usersWithActivePushSubscriptions: number;
  pushSubscriptionsAttempted: number;
  pushesDelivered: number;
  pushesFailed: number;
  stalePushSubscriptionsDeactivated: number;
  lastError: string | null;
  /** @deprecated Persisted workflow readers only. Not used for new semantics. */
  usersProcessed: number;
  /** @deprecated Persisted workflow readers only. Equivalent to pushesDelivered in old runs. */
  pushesSent: number;
  /** @deprecated Persisted workflow readers only. Equivalent to usersWithEmptyFeed in old runs. */
  skippedEmpty: number;
};

export type DailyNotificationRunResult = {
  results: Array<{ userId: string; sent: number }>;
  stats: DailyNotificationRunStats;
};

/** Only a proven provider invalidation may deactivate a subscription. */
export function isPermanentPushFailure(error: unknown): boolean {
  const candidate = error as { statusCode?: unknown; status?: unknown } | null;
  const statusCode = Number(candidate?.statusCode ?? candidate?.status);
  return statusCode === 404 || statusCode === 410;
}

function pushFailureDiagnostic(error: unknown): string {
  const candidate = error as { statusCode?: unknown; status?: unknown } | null;
  const statusCode = Number(candidate?.statusCode ?? candidate?.status);
  return Number.isFinite(statusCode) && statusCode > 0
    ? `push delivery failed (provider status ${Math.round(statusCode)})`
    : "push delivery failed (transient or unspecified error)";
}

function emptyStats(): DailyNotificationRunStats {
  return {
    telemetryVersion: 2,
    usersMatchedSchedule: 0,
    usersAlreadyNotified: 0,
    usersWithoutActiveScope: 0,
    usersWithEmptyFeed: 0,
    inboxNotificationsCreated: 0,
    inboxNotificationFailures: 0,
    usersWithActivePushSubscriptions: 0,
    pushSubscriptionsAttempted: 0,
    pushesDelivered: 0,
    pushesFailed: 0,
    stalePushSubscriptionsDeactivated: 0,
    lastError: null,
    // Compatibility aliases are deliberately derived only for the current
    // in-memory result. Legacy artifacts are never reconstructed from them.
    usersProcessed: 0,
    pushesSent: 0,
    skippedEmpty: 0,
  };
}

/**
 * Core daily-digest sender. The interruption boundary is deliberately
 * inbox-first: after the Notification row is persisted, a process stop before
 * push delivery is safe from duplicate digest creation because the existing
 * per-user/day deduplication sees that row. Browser push remains at-most-once
 * workflow behavior, not exactly-once delivery.
 */
export async function sendDueDailyNotificationsInternal(
  now = new Date(),
  requestedSlots?: DailyNotificationSlot[],
): Promise<DailyNotificationRunResult> {
  const selectedSlots = requestedSlots?.length ? new Set(requestedSlots) : null;
  const users = await prisma.user.findMany({
    where: {
      notificationScheduleSlot: {
        in: requestedSlots?.length ? requestedSlots : ["MORNING", "NOON", "EVENING"],
      },
    },
    select: {
      id: true,
      email: true,
      notificationScheduleSlot: true,
      allowBreakingNotifications: true,
      pushSubscriptions: {
        where: { isActive: true },
        select: { endpoint: true, p256dh: true, auth: true, expirationTime: true },
      },
      sourceSubscriptions: {
        where: { isActive: true },
        select: { sourceId: true },
      },
      categorySubscriptions: {
        where: { isActive: true },
        select: {
          categoryId: true,
          category: {
            select: { pathUrl: true },
          },
        },
      },
    },
  });

  const results: Array<{ userId: string; sent: number }> = [];
  const stats = emptyStats();
  for (const user of users) {
    if (selectedSlots
      ? !selectedSlots.has(user.notificationScheduleSlot as DailyNotificationSlot)
      : !isWithinSlot(user.notificationScheduleSlot as DailyNotificationSlot, now)) {
      continue;
    }

    stats.usersMatchedSchedule += 1;

    const alreadySentToday = await prisma.notification.findFirst({
      where: {
        userId: user.id,
        type: "DAILY_DIGEST",
        createdAt: {
          gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
        },
      },
      select: { id: true },
    });

    if (alreadySentToday) {
      stats.usersAlreadyNotified += 1;
      continue;
    }

    const scope = getSubscriptionScope(user.sourceSubscriptions, user.categorySubscriptions);
    const subscriptionPredicates = buildSubscriptionArticleScope(scope);
    if (subscriptionPredicates.length === 0) {
      stats.usersWithoutActiveScope += 1;
      continue;
    }

    const publicationWhere = {
      ...buildUserFeedPublicationWhere(),
      publicationReadyAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      OR: subscriptionPredicates,
    };
    const pageSize = 500;
    let articleCount = 0;
    let cursor: number | undefined;
    while (true) {
      const page = await prisma.article.findMany({
        where: publicationWhere,
        select: { id: true, title: true, canonicalUrl: true, bodyText: true },
        orderBy: { id: "asc" },
        take: pageSize,
        ...(cursor === undefined ? {} : { skip: 1, cursor: { id: cursor } }),
      });
      articleCount += page.filter(isEffectivelyPublishableArticle).length;
      if (page.length < pageSize) break;
      cursor = page[page.length - 1]!.id;
    }

    if (articleCount === 0) {
      stats.usersWithEmptyFeed += 1;
      continue;
    }

    const title = "NuSift daily update";
    const body = `${articleCount} new articles are ready in your feed.`;
    const url = "/dashboard";
    const payload = getNotificationPayload(title, body, url, "DAILY_DIGEST", {
      articleCount,
      slot: user.notificationScheduleSlot,
      sentAt: now.toISOString(),
    });
    const activeSubscriptionCount = user.pushSubscriptions.length;

    // Critical ordering boundary: persist the inbox row before touching any
    // browser endpoint. A persistence error prevents all push attempts.
    const dedupeKey = dailyDigestDedupeKey(user.id, now);
    let notification: { id?: string };
    try {
      notification = await prisma.notification.create({
        data: {
          userId: user.id,
          type: "DAILY_DIGEST",
          title,
          body,
          url,
          payload: {
            ...payload,
            pushDelivery: {
              status: activeSubscriptionCount > 0 ? "pending" : "unavailable",
              activeSubscriptions: activeSubscriptionCount,
              subscriptionsAttempted: 0,
              delivered: 0,
              failed: 0,
              permanentFailures: 0,
              transientFailures: 0,
            },
          } as any,
          status: "SENT",
          sentAt: new Date(),
          errorLog: null,
          dedupeKey,
        },
      });
      stats.inboxNotificationsCreated += 1;
    } catch (error) {
      // The unique key is the concurrency authority. Another invocation may
      // have claimed this digest after the optimization lookup above.
      if (isUniqueConstraintConflict(error)) {
        stats.usersAlreadyNotified += 1;
        continue;
      }
      stats.inboxNotificationFailures += 1;
      stats.lastError = appendBoundedDiagnostic(stats.lastError, "inbox notification persistence failed");
      // Never send push for a digest that was not durably persisted.
      continue;
    }

    if (activeSubscriptionCount > 0) {
      stats.usersWithActivePushSubscriptions += 1;
    }

    let sentCount = 0;
    let permanentFailures = 0;
    let transientFailures = 0;
    let pushDiagnostic: string | null = null;
    for (const sub of user.pushSubscriptions) {
      stats.pushSubscriptionsAttempted += 1;
      try {
        await sendPushNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
            expirationTime: sub.expirationTime ? Number(sub.expirationTime) : null,
          },
          payload,
        );
        sentCount += 1;
        stats.pushesDelivered += 1;
      } catch (error) {
        stats.pushesFailed += 1;
        const providerDiagnostic = pushFailureDiagnostic(error);
        pushDiagnostic = appendBoundedDiagnostic(pushDiagnostic, providerDiagnostic);
        if (isPermanentPushFailure(error)) {
          permanentFailures += 1;
          try {
            await prisma.pushSubscription.update({
              where: { endpoint: sub.endpoint },
              data: { isActive: false, lastSeenAt: new Date() },
            });
            stats.stalePushSubscriptionsDeactivated += 1;
          } catch {
            const deactivationDiagnostic = "push subscription deactivation persistence failed";
            pushDiagnostic = appendBoundedDiagnostic(pushDiagnostic, deactivationDiagnostic);
            stats.lastError = appendBoundedDiagnostic(stats.lastError, deactivationDiagnostic);
          }
        } else {
          transientFailures += 1;
        }
        stats.lastError = appendBoundedDiagnostic(stats.lastError, providerDiagnostic);
      }
    }

    // Best-effort evidence update. Failure here never invalidates the inbox row.
    const pushDelivery = {
      status: activeSubscriptionCount === 0
        ? "unavailable"
        : sentCount === activeSubscriptionCount
          ? "delivered"
          : sentCount > 0
            ? "partial_failure"
            : "failed",
      activeSubscriptions: activeSubscriptionCount,
      subscriptionsAttempted: activeSubscriptionCount,
      delivered: sentCount,
      failed: activeSubscriptionCount - sentCount,
      permanentFailures,
      transientFailures,
      ...(pushDiagnostic ? { diagnostic: boundedDiagnostic(pushDiagnostic) } : {}),
    };
    if (notification?.id) {
      try {
        await prisma.notification.update({
          where: { id: notification.id },
          data: {
            payload: { ...payload, pushDelivery } as any,
            errorLog: pushDiagnostic ? boundedDiagnostic(pushDiagnostic) : null,
          },
        });
      } catch {
        stats.lastError = appendBoundedDiagnostic(stats.lastError, "push delivery evidence persistence failed");
      }
    } else if (activeSubscriptionCount > 0) {
      stats.lastError = appendBoundedDiagnostic(stats.lastError, "push delivery evidence persistence unavailable");
    }

    results.push({ userId: user.id, sent: sentCount });
  }

  // Deprecated aliases are retained only so old non-durable callers remain
  // source-compatible. New workflow writes use the explicit fields below.
  stats.usersProcessed = stats.inboxNotificationsCreated;
  stats.pushesSent = stats.pushesDelivered;
  stats.skippedEmpty = stats.usersWithEmptyFeed;

  return { results, stats };
}

export async function sendDueDailyNotifications(
  now = new Date(),
  requestedSlots?: DailyNotificationSlot[],
): Promise<Array<{ userId: string; sent: number }>> {
  const { results } = await sendDueDailyNotificationsInternal(now, requestedSlots);
  return results;
}

export async function sendBreakingNotification(input: {
  title: string;
  body: string;
  url?: string;
  userId?: string;
}) {
  const where = input.userId
    ? { id: input.userId }
    : { allowBreakingNotifications: true };
  let diagnostics: string | null = null;
  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      pushSubscriptions: {
        where: { isActive: true },
        select: { endpoint: true, p256dh: true, auth: true, expirationTime: true },
      },
    },
  });

  const payload = getNotificationPayload(
    input.title,
    input.body,
    input.url || "/dashboard",
    "BREAKING_SYSTEM",
    { sentAt: new Date().toISOString() },
  );

  for (const user of users) {
    // Keep breaking notifications inbox-first as well: a persistence failure
    // must prevent push, while a later push failure must not invalidate inbox.
    let notification: { id?: string };
    try {
      notification = await prisma.notification.create({
        data: {
          userId: user.id,
          type: "BREAKING_SYSTEM",
          title: input.title,
          body: input.body,
          url: input.url || "/dashboard",
          payload: {
            ...payload,
            pushDelivery: {
              status: user.pushSubscriptions.length > 0 ? "pending" : "unavailable",
              activeSubscriptions: user.pushSubscriptions.length,
              subscriptionsAttempted: 0,
              delivered: 0,
              failed: 0,
            },
          } as any,
          status: "SENT",
          sentAt: new Date(),
          errorLog: null,
        },
      });
    } catch {
      // Do not send a browser push for an inbox notification that was not
      // durably persisted.
      continue;
    }

    let delivered = 0;
    let failed = 0;
    let diagnostic: string | null = null;
    for (const sub of user.pushSubscriptions) {
      try {
        await sendPushNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
            expirationTime: sub.expirationTime ? Number(sub.expirationTime) : null,
          },
          payload,
        );
        delivered += 1;
      } catch (error) {
        failed += 1;
        diagnostic = appendBoundedDiagnostic(diagnostic, pushFailureDiagnostic(error));
        if (isPermanentPushFailure(error)) {
          try {
            await prisma.pushSubscription.update({
              where: { endpoint: sub.endpoint },
              data: { isActive: false, lastSeenAt: new Date() },
            });
          } catch {
            diagnostic = appendBoundedDiagnostic(diagnostic, "push subscription deactivation persistence failed");
          }
        }
      }
    }

    if (notification?.id) {
      try {
        await prisma.notification.update({
          where: { id: notification.id },
          data: {
            payload: {
              ...payload,
              pushDelivery: {
                status: user.pushSubscriptions.length === 0
                  ? "unavailable"
                  : delivered === user.pushSubscriptions.length
                    ? "delivered"
                    : delivered > 0
                      ? "partial_failure"
                      : "failed",
                activeSubscriptions: user.pushSubscriptions.length,
                subscriptionsAttempted: user.pushSubscriptions.length,
                delivered,
                failed,
                ...(diagnostic ? { diagnostic: boundedDiagnostic(diagnostic) } : {}),
              },
            } as any,
            errorLog: diagnostic ? boundedDiagnostic(diagnostic) : null,
          },
        });
      } catch {
        diagnostics = appendBoundedDiagnostic(
          diagnostics,
          "push delivery evidence persistence failed",
        );
        // Evidence is best effort; the already-persisted inbox row remains
        // valid even if its push outcome cannot be recorded.
      }
      if (diagnostic) diagnostics = appendBoundedDiagnostic(diagnostics, diagnostic);
    }
  }

  return { diagnostics };
}
