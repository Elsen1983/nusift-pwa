// server/middleware/csrf-guard.ts
// CSRF protection via Origin/Referer header validation.
// Only checks state-changing requests (POST, PUT, DELETE, PATCH).
// Skips requests with no Origin/Referer (SSR, server-to-server, curl).
//
// This works as defense-in-depth on top of SameSite=Lax cookies.
// SameSite=Lax already blocks cross-origin cookies on POST/PUT/DELETE,
// but this adds an additional layer against browser bugs or same-site attacks.

import { getHeader, createError } from "h3";

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

  // No Origin or Referer → likely SSR, server-to-server, or direct API call. Skip.
  if (!origin && !referer) return;

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
