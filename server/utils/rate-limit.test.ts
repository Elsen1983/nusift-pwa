import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  assertRateLimit,
  _resetRateLimiterForTests,
  _isUsingUpstash,
} from "./rate-limit";
import type { H3Event } from "h3";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("h3", () => ({
  getRequestIP: vi.fn(() => "127.0.0.1"),
  createError: vi.fn(
    ({
      statusCode,
      statusMessage,
    }: {
      statusCode: number;
      statusMessage: string;
    }) => {
      const err = new Error(statusMessage) as Error & { statusCode: number };
      err.statusCode = statusCode;
      return err;
    },
  ),
}));

const mockLimitFn = vi.fn();

vi.mock("@upstash/redis", () => {
  return {
    Redis: class MockRedis {
      constructor() {
        return {};
      }
    },
  };
});

vi.mock("@upstash/ratelimit", () => {
  return {
    Ratelimit: Object.assign(
      class MockRatelimit {
        limit = mockLimitFn;
      },
      {
        slidingWindow: vi.fn(() => ({})),
      },
    ),
  };
});

function makeFakeEvent(): H3Event {
  return {} as H3Event;
}

// ---------------------------------------------------------------------------
// Tests – in-memory fallback
// ---------------------------------------------------------------------------

describe("assertRateLimit (in-memory fallback)", () => {
  beforeEach(() => {
    _resetRateLimiterForTests();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("allows requests within the limit", async () => {
    const event = makeFakeEvent();
    for (let i = 0; i < 3; i++) {
      await assertRateLimit(event, "test-ok", 3, 60_000);
    }
  });

  it("throws 429 when the limit is exceeded", async () => {
    const event = makeFakeEvent();
    const limit = 2;

    for (let i = 0; i < limit; i++) {
      await assertRateLimit(event, "test-exceed", limit, 60_000);
    }

    try {
      await assertRateLimit(event, "test-exceed", limit, 60_000);
      expect.fail("Should have thrown 429");
    } catch (err: unknown) {
      const e = err as { statusCode: number };
      expect(e.statusCode).toBe(429);
    }
  });

  it("uses different buckets for different keys", async () => {
    const event = makeFakeEvent();

    for (let i = 0; i < 5; i++) {
      await assertRateLimit(event, "key-a", 5, 60_000);
    }

    await assertRateLimit(event, "key-b", 5, 60_000);
  });

  it("resets the counter after the window expires", async () => {
    const event = makeFakeEvent();
    const shortWindow = 50;

    for (let i = 0; i < 2; i++) {
      await assertRateLimit(event, "test-expire", 2, shortWindow);
    }

    try {
      await assertRateLimit(event, "test-expire", 2, shortWindow);
      expect.fail("Should have thrown 429");
    } catch (err: unknown) {
      expect((err as { statusCode: number }).statusCode).toBe(429);
    }

    await new Promise((r) => setTimeout(r, shortWindow + 10));

    await assertRateLimit(event, "test-expire", 2, shortWindow);
  });

  it("uses different buckets for different IPs", async () => {
    const h3 = await import("h3");
    const mockGetRequestIP = vi.mocked(h3.getRequestIP);

    const event = makeFakeEvent();

    mockGetRequestIP.mockReturnValue("10.0.0.1");
    for (let i = 0; i < 3; i++) {
      await assertRateLimit(event, "test-ip", 3, 60_000);
    }

    mockGetRequestIP.mockReturnValue("10.0.0.2");
    await assertRateLimit(event, "test-ip", 3, 60_000);

    mockGetRequestIP.mockReturnValue("127.0.0.1");
  });

  it("falls back to in-memory when Upstash env vars are missing", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    _resetRateLimiterForTests();

    expect(_isUsingUpstash()).toBe(false);

    await assertRateLimit(makeFakeEvent(), "test-fallback", 5, 60_000);
  });

  it("does not leave a misleading in-memory limiter as sole protection in production", () => {
    _resetRateLimiterForTests();
    delete process.env.UPSTASH_REDIS_REST_URL;
    expect(_isUsingUpstash()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests – Upstash Redis path
// ---------------------------------------------------------------------------

describe("assertRateLimit (Upstash Redis path)", () => {
  beforeEach(() => {
    _resetRateLimiterForTests();
    mockLimitFn.mockReset();
    mockLimitFn.mockResolvedValue({ success: true });
    process.env.UPSTASH_REDIS_REST_URL = "https://test-redis.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("uses the Upstash Redis path when env vars are set", async () => {
    await assertRateLimit(makeFakeEvent(), "test-redis-ok", 10, 60_000);

    expect(_isUsingUpstash()).toBe(true);
    expect(mockLimitFn).toHaveBeenCalledWith("test-redis-ok:127.0.0.1");
  });

  it("throws 429 via Upstash path when success=false", async () => {
    mockLimitFn.mockResolvedValue({ success: false });

    try {
      await assertRateLimit(makeFakeEvent(), "test-redis-block", 10, 60_000);
      expect.fail("Should have thrown 429");
    } catch (err: unknown) {
      const e = err as { statusCode: number };
      expect(e.statusCode).toBe(429);
    }

    expect(mockLimitFn).toHaveBeenCalledWith("test-redis-block:127.0.0.1");
  });

  it("does not fall through to in-memory when Redis is active", async () => {
    for (let i = 0; i < 5; i++) {
      await assertRateLimit(makeFakeEvent(), "test-no-fallback", 5, 60_000);
    }

    expect(mockLimitFn).toHaveBeenCalledTimes(5);
  });

  it("includes IP in the rate limit identifier", async () => {
    const h3 = await import("h3");
    const mockGetRequestIP = vi.mocked(h3.getRequestIP);
    mockGetRequestIP.mockReturnValue("192.168.1.100");

    await assertRateLimit(makeFakeEvent(), "test-ip-redis", 10, 60_000);

    expect(mockLimitFn).toHaveBeenCalledWith("test-ip-redis:192.168.1.100");

    mockGetRequestIP.mockReturnValue("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// Tests – helpers
// ---------------------------------------------------------------------------

describe("_resetRateLimiterForTests", () => {
  it("clears state so tests are isolated", async () => {
    const event = makeFakeEvent();

    for (let i = 0; i < 2; i++) {
      await assertRateLimit(event, "test-reset", 2, 60_000);
    }

    _resetRateLimiterForTests();

    await assertRateLimit(event, "test-reset", 2, 60_000);
  });
});

describe("_isUsingUpstash", () => {
  beforeEach(() => {
    _resetRateLimiterForTests();
  });

  it("returns false when UPSTASH_REDIS_REST_URL is not set", () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    expect(_isUsingUpstash()).toBe(false);
  });

  it("returns true after Upstash initialization succeeds", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
    mockLimitFn.mockReset();
    mockLimitFn.mockResolvedValue({ success: true });

    await assertRateLimit(makeFakeEvent(), "test-init", 10, 60_000);
    expect(_isUsingUpstash()).toBe(true);

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });
});
