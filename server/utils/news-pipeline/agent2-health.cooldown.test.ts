import { describe, expect, it } from "vitest";

/**
 * Pure unit tests for deriveCooldownState — the active-vs-historical
 * cooldown derivation used by the Agent 2 health report. No DB access.
 */
describe("agent2-health — deriveCooldownState", () => {
  const NOW = Date.parse("2026-07-24T12:00:00Z");

  async function load() {
    const mod = await import("./agent2-health");
    return mod.deriveCooldownState;
  }

  it("marks a cooldown active when retry-after is in the future", async () => {
    const deriveCooldownState = await load();
    const result = deriveCooldownState({
      browserCooldownUntil: "2026-07-24T13:00:00Z",
      browserRateLimitedAt: "2026-07-24T11:00:00Z",
      browserRetryAfterAt: "2026-07-24T13:00:00Z",
      browserRateLimitReason: "http_429",
      lastBrowserCooldownSkipAt: "2026-07-24T11:30:00Z",
      nowMs: NOW,
    });

    expect(result.cooldownActive).toBe(true);
    expect(result.cooldownReason).toBe("HTTP 429 rate limit");
    expect(result.cooldownStartedAt).toBe("2026-07-24T11:00:00.000Z");
    expect(result.retryAfter).toBe("2026-07-24T13:00:00.000Z");
    expect(result.lastHistoricalCooldownAt).toBeNull();
  });

  it("treats an expired cooldown as historical, not active", async () => {
    const deriveCooldownState = await load();
    const result = deriveCooldownState({
      browserCooldownUntil: "2026-07-24T10:00:00Z", // expired
      browserRateLimitedAt: "2026-07-24T09:00:00Z",
      browserRetryAfterAt: "2026-07-24T10:00:00Z", // expired
      browserRateLimitReason: "http_429",
      lastBrowserCooldownSkipAt: "2026-07-24T09:30:00Z",
      nowMs: NOW,
    });

    expect(result.cooldownActive).toBe(false);
    expect(result.cooldownReason).toBeNull();
    expect(result.retryAfter).toBeNull();
    // The most recent historical cooldown evidence is surfaced.
    expect(result.lastHistoricalCooldownAt).toBe("2026-07-24T09:30:00.000Z");
  });

  it("derives reason from browserCooldownUntil when no explicit 429 reason", async () => {
    const deriveCooldownState = await load();
    const result = deriveCooldownState({
      browserCooldownUntil: "2026-07-24T13:00:00Z",
      browserRateLimitedAt: "2026-07-24T11:00:00Z",
      browserRetryAfterAt: null,
      browserRateLimitReason: null,
      lastBrowserCooldownSkipAt: null,
      nowMs: NOW,
    });

    expect(result.cooldownActive).toBe(true);
    expect(result.cooldownReason).toBe("Browser cooldown");
    expect(result.retryAfter).toBe("2026-07-24T13:00:00.000Z");
  });

  it("returns no cooldown state when no evidence exists", async () => {
    const deriveCooldownState = await load();
    const result = deriveCooldownState({
      browserCooldownUntil: null,
      browserRateLimitedAt: null,
      browserRetryAfterAt: null,
      browserRateLimitReason: null,
      lastBrowserCooldownSkipAt: null,
      nowMs: NOW,
    });

    expect(result.cooldownActive).toBe(false);
    expect(result.cooldownReason).toBeNull();
    expect(result.cooldownStartedAt).toBeNull();
    expect(result.retryAfter).toBeNull();
    expect(result.lastHistoricalCooldownAt).toBeNull();
  });

  it("historical evidence alone (no retry-after) never shows as active", async () => {
    const deriveCooldownState = await load();
    const result = deriveCooldownState({
      browserCooldownUntil: null,
      browserRateLimitedAt: "2026-07-24T09:00:00Z",
      browserRetryAfterAt: null,
      browserRateLimitReason: "http_429",
      lastBrowserCooldownSkipAt: "2026-07-24T09:30:00Z",
      nowMs: NOW,
    });

    expect(result.cooldownActive).toBe(false);
    expect(result.retryAfter).toBeNull();
    expect(result.lastHistoricalCooldownAt).toBe("2026-07-24T09:30:00.000Z");
  });

  it("resolved target with old 429 evidence has no active cooldown", async () => {
    const deriveCooldownState = await load();
    // Simulates a resolved target whose only 429 evidence is days old.
    const result = deriveCooldownState({
      browserCooldownUntil: "2026-07-20T10:00:00Z",
      browserRateLimitedAt: "2026-07-20T09:00:00Z",
      browserRetryAfterAt: "2026-07-20T10:00:00Z",
      browserRateLimitReason: "http_429",
      lastBrowserCooldownSkipAt: "2026-07-20T09:30:00Z",
      nowMs: NOW,
    });

    expect(result.cooldownActive).toBe(false);
    expect(result.retryAfter).toBeNull();
    expect(result.cooldownReason).toBeNull();
    expect(result.lastHistoricalCooldownAt).toBe("2026-07-20T09:30:00.000Z");
  });
});
