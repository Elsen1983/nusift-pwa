import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";
import { mapSubscriptionFromBody, validatePushEndpoint } from "../../utils/push";
import { createError, readBody, getHeader } from "h3";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
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

  await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    update: {
      userId,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      expirationTime,
      isActive: true,
      lastSeenAt: new Date(),
      userAgent: getHeader(event, "user-agent") || null,
      platform: /iphone|ipad|ipod/i.test(getHeader(event, "user-agent") || "")
        ? "ios"
        : /android/i.test(getHeader(event, "user-agent") || "")
          ? "android"
          : "web",
    },
    create: {
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      expirationTime,
      isActive: true,
      lastSeenAt: new Date(),
      userAgent: getHeader(event, "user-agent") || null,
      platform: /iphone|ipad|ipod/i.test(getHeader(event, "user-agent") || "")
        ? "ios"
        : /android/i.test(getHeader(event, "user-agent") || "")
          ? "android"
          : "web",
    },
  });

  return { ok: true };
});
