import webpush from "web-push";
import { createError } from "h3";
import { validateHostname, resolveAndValidate, SSRFError } from "./ssrf-guard";

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

/**
 * Parse and validate a push endpoint URL.
 * Returns the parsed URL on success. Throws createError(400) on failure.
 * Rejects: non-HTTPS, non-parseable, localhost, *.local, *.internal,
 * raw IPs, and hostnames with injection characters.
 */
function parsePushEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid push endpoint URL." });
  }

  if (parsed.protocol !== "https:") {
    throw createError({ statusCode: 400, statusMessage: "Push endpoint must use HTTPS." });
  }

  try {
    validateHostname(parsed.hostname);
  } catch (err) {
    if (err instanceof SSRFError) {
      throw createError({ statusCode: 400, statusMessage: "Invalid push endpoint host." });
    }
    throw err;
  }

  return parsed;
}

/**
 * Full push endpoint validation including DNS resolution + private IP check.
 * Call at subscribe time to reject SSRF attempts before DB write.
 */
export async function validatePushEndpoint(endpoint: string): Promise<void> {
  const parsed = parsePushEndpoint(endpoint);

  try {
    await resolveAndValidate(parsed.hostname);
  } catch (err) {
    if (err instanceof SSRFError) {
      throw createError({ statusCode: 400, statusMessage: "Push endpoint host is not allowed." });
    }
    throw err;
  }
}

/**
 * Lightweight push endpoint check (no DNS resolution).
 * Call before sending to catch obviously-invalid endpoints without the latency
 * of a DNS lookup on every notification send.
 */
export function assertValidPushEndpoint(endpoint: string): void {
  parsePushEndpoint(endpoint);
}

export async function sendPushNotification(
  subscription: PushSubscriptionRecord,
  payload: Record<string, unknown>,
) {
  // Defense-in-depth: validate endpoint before making the outbound request.
  // Lightweight sync check only (no DNS) — full DNS validation ran at subscribe
  // time. This catches obviously-invalid endpoints from DB-poisoned records.
  assertValidPushEndpoint(subscription.endpoint);

  configureWebPush();
  const startedAt = Date.now();
  const endpointHint = subscription.endpoint.slice(-12);
  console.info("[push] sending notification", {
    endpointHint,
    ttl: 30,
    urgency: "high",
    payloadType: (payload as any)?.type,
  });
  return webpush.sendNotification(
    subscription as any,
    JSON.stringify(payload),
    {
      TTL: 30,
      urgency: "high",
    },
  ).finally(() => {
    console.info("[push] sendNotification finished", {
      endpointHint,
      elapsedMs: Date.now() - startedAt,
      payloadType: (payload as any)?.type,
    });
  });
}

export function mapSubscriptionFromBody(body: any): PushSubscriptionRecord {
  if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid push subscription payload.",
    });
  }

  // Sync URL + HTTPS + hostname validation (full async DNS check runs in
  // subscribe.post.ts via validatePushEndpoint before DB write).
  parsePushEndpoint(body.endpoint);

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
