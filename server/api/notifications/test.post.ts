import { createError, readBody, getHeader } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";
import { getNotificationPayload, sendPushNotification } from "../../utils/push";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  const body = await readBody(event);
  const subscription = await prisma.pushSubscription.findFirst({
    where: { userId, isActive: true },
    orderBy: { updatedAt: "desc" },
  });

  if (!subscription) {
    throw createError({ statusCode: 404, statusMessage: "No active push subscription." });
  }

  const payload = getNotificationPayload(
    body?.title || "NuSift test",
    body?.body || "Push delivery is working.",
    body?.url || "/dashboard",
    "BREAKING_SYSTEM",
  );

  await sendPushNotification(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      expirationTime: subscription.expirationTime ? Number(subscription.expirationTime) : null,
    },
    payload,
  );

  await prisma.notification.create({
    data: {
      userId,
      type: "BREAKING_SYSTEM",
      title: payload.title,
      body: payload.body,
      url: payload.url,
      payload: payload as any,
      status: "SENT",
      sentAt: new Date(),
    },
  });

  const unreadCount = await prisma.notification.count({ where: { userId, readAt: null } });

  return { ok: true, unreadCount };
});
