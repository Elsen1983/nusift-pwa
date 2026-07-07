import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";
import { mapSubscriptionFromBody, validatePushEndpoint } from "../../utils/push";
import { createError, readBody, getHeader } from "h3";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  const body = await readBody(event);
  const subscription = mapSubscriptionFromBody(body);

  // Full SSRF validation: hostname format + DNS resolution + private IP check
  await validatePushEndpoint(subscription.endpoint);

  const expirationTime =
    typeof subscription.expirationTime === "number"
      ? BigInt(subscription.expirationTime)
      : null;

  if (!process.env.NUXT_VAPID_PRIVATE_KEY || !process.env.NUXT_PUBLIC_VAPID_PUBLIC_KEY) {
    throw createError({ statusCode: 500, statusMessage: "Push is not configured." });
  }

  const userAgent = getHeader(event, "user-agent") || null;
  const platform = /iphone|ipad|ipod/i.test(userAgent || "")
    ? "ios"
    : /android/i.test(userAgent || "")
      ? "android"
      : "web";
  const existingSubscription = await prisma.pushSubscription.findUnique({
    where: { endpoint: subscription.endpoint },
    select: { id: true, userId: true },
  });

  if (existingSubscription && existingSubscription.userId !== userId) {
    throw createError({
      statusCode: 409,
      statusMessage: "Push subscription already belongs to another user.",
    });
  }

  if (existingSubscription) {
    await prisma.pushSubscription.update({
      where: { id: existingSubscription.id },
      data: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        expirationTime,
        isActive: true,
        lastSeenAt: new Date(),
        userAgent,
        platform,
      },
    });
  } else {
    await prisma.pushSubscription.create({
      data: {
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        expirationTime,
        isActive: true,
        lastSeenAt: new Date(),
        userAgent,
        platform,
      },
    });
  }

  return { ok: true };
});
