import { createError, getRequestIP, type H3Event } from "h3";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

// ---------------------------------------------------------------------------
// Upstash Redis – serverless-safe, cross-instance rate limiting
// ---------------------------------------------------------------------------
// When UPSTASH_REDIS_REST_URL is set, every request is counted in a shared
// Redis store so limits hold across all serverless instances.  When the env
// var is missing (local dev, CI) we fall back to a process-local in-memory
// Map with a loud warning in production.
// ---------------------------------------------------------------------------

type Bucket = { count: number; resetAt: number };
const memoryBuckets = new Map<string, Bucket>();
let productionWarned = false;

// ---- Lazy Upstash initialisation -----------------------------------------

let redis: Redis | null = null;
let upstashReady = false;
let upstashInitFailed = false;

function ensureRedis() {
  if (upstashReady || upstashInitFailed) return;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url) {
    upstashInitFailed = true;
    return;
  }

  try {
    redis = new Redis({ url, token: token ?? "" });
    upstashReady = true;
  } catch (err) {
    console.error("[rate-limit] Failed to initialise Upstash Redis:", err);
    upstashInitFailed = true;
  }
}

// ---- Limiter cache (one Ratelimit instance per unique config) ------------

const limiterCache = new Map<string, Ratelimit>();

function getLimiter(
  key: string,
  limit: number,
  windowMs: number,
): Ratelimit | null {
  const cacheKey = `${key}:${limit}:${windowMs}`;
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;

  if (!redis) return null;

  try {
    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`),
      analytics: false,
      prefix: "nusift:rl",
    });
    limiterCache.set(cacheKey, limiter);
    return limiter;
  } catch (err) {
    console.error("[rate-limit] Failed to create Ratelimit instance:", err);
    return null;
  }
}

// ---- Public API -----------------------------------------------------------

/**
 * Assert that the current request is within the rate limit.
 *
 * - In production with `UPSTASH_REDIS_REST_URL` configured → shared Redis
 *   counter, effective across all serverless instances.
 * - Otherwise → process-local in-memory counter (dev/CI only).
 *
 * Throws an HTTP 429 error when the limit is exceeded.
 */
export async function assertRateLimit(
  event: H3Event,
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const ip = getRequestIP(event) || "unknown-ip";
  const identifier = `${key}:${ip}`;

  // --- Production path: Upstash Redis ---
  ensureRedis();

  if (upstashReady && redis) {
    const limiter = getLimiter(key, limit, windowMs);
    if (limiter) {
      const { success } = await limiter.limit(identifier);
      if (!success) {
        throwRateLimitError();
      }
      return;
    }
    // If limiter creation failed, fall through to in-memory as last resort
  }

  // --- Fallback path: in-memory (single-instance only) ---
  if (process.env.NODE_ENV === "production" && !productionWarned) {
    productionWarned = true;
    console.warn(
      "[rate-limit] ⚠ No Upstash Redis configured – falling back to in-memory rate limiter. " +
        "This is NOT cross-instance safe. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN " +
        "for production serverless deployments.",
    );
  }

  const now = Date.now();
  const current = memoryBuckets.get(identifier);

  if (!current || current.resetAt <= now) {
    memoryBuckets.set(identifier, { count: 1, resetAt: now + windowMs });
    return;
  }

  current.count += 1;
  if (current.count > limit) {
    throwRateLimitError();
  }
}

// ---- Internal helpers -----------------------------------------------------

function throwRateLimitError(): never {
  throw createError({
    statusCode: 429,
    statusMessage: "Too many requests. Please try again later.",
  });
}

// ---- Test-only helpers ----------------------------------------------------

/**
 * Reset all internal state. Only for use in tests.
 * @internal
 */
export function _resetRateLimiterForTests() {
  memoryBuckets.clear();
  limiterCache.clear();
  redis = null;
  upstashReady = false;
  upstashInitFailed = false;
  productionWarned = false;
}

/**
 * Returns whether the Upstash Redis backend is active.
 * @internal
 */
export function _isUsingUpstash(): boolean {
  return upstashReady;
}
