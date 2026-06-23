import { prisma } from "./prisma";
import { getNotificationPayload, sendPushNotification } from "./push";

const slotHours: Record<"MORNING" | "NOON" | "EVENING", number[]> = {
  MORNING: [6, 11],
  NOON: [12, 16],
  EVENING: [18, 22],
};

function isWithinSlot(slot: "MORNING" | "NOON" | "EVENING", now = new Date()) {
  const hour = now.getHours();
  const [start, end] = slotHours[slot];
  return hour >= start! && hour <= end!;
}

export async function sendDueDailyNotifications(now = new Date()) {
  const users = await prisma.user.findMany({
    where: {
      notificationScheduleSlot: {
        in: ["MORNING", "NOON", "EVENING"],
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
    },
  });

  const results: Array<{ userId: string; sent: number }> = [];

  for (const user of users) {
    if (!isWithinSlot(user.notificationScheduleSlot, now)) continue;

    const alreadySentToday = await prisma.notification.findFirst({
      where: {
        userId: user.id,
        type: "DAILY_DIGEST",
        createdAt: {
          gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        },
      },
      select: { id: true },
    });

    if (alreadySentToday) continue;

    const articleCount = await prisma.article.count({
      where: { createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    });

    const title = "NuSift daily update";
    const body =
      articleCount > 0
        ? `${articleCount} new articles are ready in your feed.`
        : "Your daily news update is ready.";
    const url = "/dashboard";
    const payload = getNotificationPayload(title, body, url, "DAILY_DIGEST", {
      articleCount,
      slot: user.notificationScheduleSlot,
      sentAt: now.toISOString(),
    });

    let sentCount = 0;
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
        sentCount += 1;
      } catch (error: any) {
        await prisma.pushSubscription.update({
          where: { endpoint: sub.endpoint },
          data: { isActive: false, lastSeenAt: new Date() },
        }).catch(() => null);
      }
    }

    await prisma.notification.create({
      data: {
        userId: user.id,
        type: "DAILY_DIGEST",
        title,
        body,
        url,
        payload: payload as any,
        status: sentCount > 0 ? "SENT" : "FAILED",
        sentAt: sentCount > 0 ? new Date() : null,
      },
    });

    results.push({ userId: user.id, sent: sentCount });
  }

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
    {
      sentAt: new Date().toISOString(),
    },
  );

  for (const user of users) {
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
      } catch {
        await prisma.pushSubscription.update({
          where: { endpoint: sub.endpoint },
          data: { isActive: false, lastSeenAt: new Date() },
        }).catch(() => null);
      }
    }

    await prisma.notification.create({
      data: {
        userId: user.id,
        type: "BREAKING_SYSTEM",
        title: input.title,
        body: input.body,
        url: input.url || "/dashboard",
        payload: payload as any,
        status: "SENT",
        sentAt: new Date(),
      },
    });
  }
}
