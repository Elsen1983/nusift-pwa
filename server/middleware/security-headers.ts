// server/middleware/security-headers.ts
// Adds standard security response headers to all HTTP responses.
// Content-Security-Policy is tailored to whitelist external resources used by NuSift:
//   - Google Fonts (fonts.googleapis.com, fonts.gstatic.com)
//   - Google OAuth/GSI (accounts.google.com, www.googleapis.com)
//   - Apple Sign-In (appleid.cdn-apple.com)
//   - Resend API (api.resend.com) — server-side only, not in browser CSP

import { setResponseHeader } from "h3";

export default defineEventHandler((event) => {
  // Skip for static assets — they don't need these headers and it reduces overhead
  const path = event.path || "";
  if (path.startsWith("/_nuxt/") || path.includes(".")) return;

  // X-Content-Type-Options — prevents MIME-type sniffing
  setResponseHeader(event, "X-Content-Type-Options", "nosniff");

  // X-Frame-Options — prevents clickjacking (DENY is most restrictive)
  setResponseHeader(event, "X-Frame-Options", "DENY");

  // X-XSS-Protection — legacy XSS filter (still useful for older browsers)
  setResponseHeader(event, "X-XSS-Protection", "1; mode=block");

  // Referrer-Policy — send origin only on cross-origin requests
  setResponseHeader(event, "Referrer-Policy", "strict-origin-when-cross-origin");

  // Permissions-Policy — disable features not used by the app
  setResponseHeader(
    event,
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()"
  );

  // Content-Security-Policy — applied to all responses; browsers only enforce on HTML
  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://appleid.cdn-apple.com"
    : "script-src 'self' 'unsafe-inline' https://accounts.google.com https://appleid.cdn-apple.com";

  const cspDirectives = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://www.googleapis.com https://accounts.google.com",
    "frame-src https://accounts.google.com https://appleid.cdn-apple.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  // Force HTTPS on all sub-resources in production
  if (!isDev) cspDirectives.push("upgrade-insecure-requests");

  setResponseHeader(event, "Content-Security-Policy", cspDirectives.join("; "));
});
