import webpush from "web-push";
import { createError } from "h3";

export type NotificationSlot = "MORNING" | "NOON" | "EVENING";
export type NotificationType = "DAILY_DIGEST" | "BREAKING_SYSTEM";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  expirationTime?: number | null;
}

export function configureWebPush() {
  const config = useRuntimeConfig();
  const publicKey = config.public.vapidPublicKey;
  const privateKey = config.vapidPrivateKey;
  const subject = config.vapidSubject;

  if (!publicKey || !privateKey) {
    throw createError({
      statusCode: 500,
      statusMessage: "VAPID keys are not configured.",
    });
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { publicKey, privateKey, subject };
}

export async function sendPushNotification(
  subscription: PushSubscriptionRecord,
  payload: Record<string, unknown>,
) {
  configureWebPush();
  return webpush.sendNotification(subscription as any, JSON.stringify(payload));
}

export function mapSubscriptionFromBody(body: any): PushSubscriptionRecord {
  if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid push subscription payload.",
    });
  }

  return {
    endpoint: body.endpoint,
    keys: {
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    },
    expirationTime:
      typeof body.expirationTime === "number" ? body.expirationTime : null,
  };
}

export function getNotificationPayload(
  title: string,
  body: string,
  url: string,
  type: NotificationType,
  extra: Record<string, unknown> = {},
) {
  return {
    title,
    body,
    url,
    type,
    ...extra,
  };
}
