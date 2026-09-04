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

import { getHeader, getCookie, getRequestIP, createError } from "h3";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
const SECRET_AUTHENTICATED_INTERNAL_POSTS = new Set([
  "/api/internal/run-agent2-headless",
  "/api/internal/run-agent3",
]);
const SELF_HOSTED_WORKFLOW_POSTS = new Set([
  "/.well-known/workflow/v1/flow",
  "/.well-known/workflow/v1/step",
]);
const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

export default defineEventHandler((event) => {
  const method = event.method;
  if (!STATE_CHANGING_METHODS.has(method)) return;

  // These server-to-server workflow calls cannot carry browser CSRF evidence.
  // Each exact endpoint rejects the request unless CRON_SECRET is valid.
  const pathname = getRequestURL(event).pathname;
  if (method === "POST" && SECRET_AUTHENTICATED_INTERNAL_POSTS.has(pathname)) return;

  // The self-hosted Postgres worker executes Workflow SDK jobs through these
  // local HTTP routes. Never extend this exception to tunnel or LAN traffic.
  if (
    method === "POST"
    && process.env.NUSIFT_SELF_HOSTED === "true"
    && SELF_HOSTED_WORKFLOW_POSTS.has(pathname)
    && LOOPBACK_ADDRESSES.has(getRequestIP(event) || "")
  ) return;

  const config = useRuntimeConfig();
  const appUrl: string = config.public.appUrl || "http://localhost:3000";
  const isProduction = process.env.NODE_ENV === "production";

  // Build allowed origins list from the configured app URL
  const allowedOrigins = new Set<string>([appUrl]);
  // In development, also allow common localhost variants
  if (!isProduction && (appUrl.includes("localhost") || appUrl.includes("127.0.0.1"))) {
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
