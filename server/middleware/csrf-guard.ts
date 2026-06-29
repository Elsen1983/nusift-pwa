// server/middleware/csrf-guard.ts
// CSRF protection via Origin/Referer header validation.
// Only checks state-changing requests (POST, PUT, DELETE, PATCH).
//
// When Origin/Referer is present → validates against allowed origins.
// When both are absent → requires a valid auth_token cookie.
//   SSR authenticated requests carry the cookie, so they pass.
//   Cross-origin POST attacks cannot carry SameSite=Lax cookies, so they are
//   blocked by the browser regardless. Requiring the cookie here closes the
//   gap where an attacker strips headers to bypass origin validation.
//
// This works as defense-in-depth on top of SameSite=Lax cookies.

import { getHeader, getCookie, createError } from "h3";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export default defineEventHandler((event) => {
  const method = event.method;
  if (!STATE_CHANGING_METHODS.has(method)) return;

  const config = useRuntimeConfig();
  const appUrl: string = config.public.appUrl || "http://localhost:3000";

  // Build allowed origins list from the configured app URL
  const allowedOrigins = new Set<string>([appUrl]);
  // In development, also allow common localhost variants
  if (appUrl.includes("localhost") || appUrl.includes("127.0.0.1")) {
    allowedOrigins.add("http://localhost:3000");
    allowedOrigins.add("http://localhost:3001");
    allowedOrigins.add("http://127.0.0.1:3000");
  }

  const origin = getHeader(event, "origin");
  const referer = getHeader(event, "referer");

  if (!origin && !referer) {
    // No Origin/Referer: allow only if the request carries a valid session cookie.
    // SSR authenticated requests include the cookie; cross-origin POST attacks
    // cannot (SameSite=Lax). Unauthenticated POSTs (login, register) are
    // client-side SPA actions and always send Origin from the browser.
    const token = getCookie(event, "auth_token");
    if (!token) {
      throw createError({ statusCode: 403, statusMessage: "Missing request origin." });
    }
    return;
  }

  const sourceUrl = origin || referer;
  if (!sourceUrl) return;

  let sourceOrigin: string;
  try {
    sourceOrigin = new URL(sourceUrl).origin;
  } catch {
    throw createError({ statusCode: 403, statusMessage: "Invalid request origin." });
  }

  if (!allowedOrigins.has(sourceOrigin)) {
    console.warn(`[CSRF Guard] Rejected ${method} from untrusted origin: ${sourceOrigin}`);
    throw createError({ statusCode: 403, statusMessage: "Request origin not allowed." });
  }
});
