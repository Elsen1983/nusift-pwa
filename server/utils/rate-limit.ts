import { createError, getRequestIP, type H3Event } from "h3";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

// TODO: This in-memory rate limiter resets on every cold start and is shared only
// within a single process instance. In a serverless deployment (Vercel, Netlify,
// Cloudflare Workers) each request may hit a different instance, making this
// ineffective. For production serverless, consider:
//   - Upstash Redis (serverless-friendly, per-request billing)
//   - Vercel's built-in rate limiting (edge middleware)
//   - Cloudflare WAF / Rate Limiting rules
// For a single-server deployment (e.g. VPS), this works as-is.

export function assertRateLimit(
  event: H3Event,
  key: string,
  limit: number,
  windowMs: number,
) {
  const ip = getRequestIP(event) || "unknown-ip";
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  const current = buckets.get(bucketKey);

  if (!current || current.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return;
  }

  current.count += 1;
  if (current.count > limit) {
    throw createError({
      statusCode: 429,
      statusMessage: "Too many requests. Please try again later.",
    });
  }
}
