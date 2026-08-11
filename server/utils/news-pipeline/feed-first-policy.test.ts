import { describe, expect, it } from "vitest";
import {
  FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD,
  FEED_PRODUCTIVE_FRESHNESS_MS,
  shouldRunAgent2Discovery,
} from "./feed-first-policy";

const now = new Date("2026-08-10T12:00:00.000Z");
const productiveAt = new Date(now.getTime() - 60 * 60 * 1000);

const base = {
  targetType: "source" as const,
  rssStatus: "ACTIVE",
  rssFeedUrl: "https://feeds.example.test/rss",
  currentFeedProductive: true,
  lastProductiveAt: productiveAt,
  consecutiveNonProductiveRuns: 0,
};

describe("shouldRunAgent2Discovery", () => {
  it("skips a fresh productive source feed", () => {
    expect(shouldRunAgent2Discovery(base, now)).toMatchObject({
      runAgent2: false,
      reason: "productive_fresh_feed",
      freshness: "fresh",
    });
  });

  it("allows a productive feed after the freshness threshold", () => {
    expect(shouldRunAgent2Discovery({
      ...base,
      lastProductiveAt: new Date(now.getTime() - FEED_PRODUCTIVE_FRESHNESS_MS - 1),
    }, now).reason).toBe("productive_feed_stale");
    expect(shouldRunAgent2Discovery({
      ...base,
      lastProductiveAt: new Date(now.getTime() - FEED_PRODUCTIVE_FRESHNESS_MS - 1),
    }, now).runAgent2).toBe(true);
  });

  it("does not infer freshness when the productive timestamp is missing", () => {
    expect(shouldRunAgent2Discovery({
      ...base,
      lastProductiveAt: null,
    }, now)).toMatchObject({
      runAgent2: true,
      reason: "productive_feed_stale",
      freshness: "unknown",
    });
  });

  it("keeps one transient nonproductive run on Agent 1", () => {
    expect(shouldRunAgent2Discovery({
      ...base,
      currentFeedProductive: false,
      lastProductiveAt: null,
      consecutiveNonProductiveRuns: FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD - 1,
    }, now)).toMatchObject({ runAgent2: false, reason: "nonproductive_below_threshold" });
  });

  it("allows fallback at the exact repeated-nonproductive boundary", () => {
    expect(shouldRunAgent2Discovery({
      ...base,
      currentFeedProductive: false,
      lastProductiveAt: null,
      consecutiveNonProductiveRuns: FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD,
    }, now)).toMatchObject({ runAgent2: true, reason: "repeatedly_nonproductive" });
  });

  it("defers both duplicate feed probing and Agent 2 during active Retry-After", () => {
    expect(shouldRunAgent2Discovery({
      ...base,
      nextRetryAt: new Date(now.getTime() + 60_000),
    }, now)).toMatchObject({ runAgent2: false, reason: "active_feed_rate_limited" });
  });

  it("keeps category scope independent from a productive source feed", () => {
    expect(shouldRunAgent2Discovery({
      ...base,
      targetType: "category",
      scopeMatches: false,
    }, now)).toMatchObject({ runAgent2: true, reason: "category_scope_mismatch" });
    expect(shouldRunAgent2Discovery({
      ...base,
      targetType: "category",
      currentFeedProductive: false,
      lastProductiveAt: null,
      consecutiveNonProductiveRuns: 0,
    }, now)).toMatchObject({ runAgent2: false, reason: "nonproductive_below_threshold" });
  });

  it("allows missing feeds and explicit bounded manual recovery", () => {
    expect(shouldRunAgent2Discovery({
      targetType: "source",
      rssStatus: "NO_RSS_FOUND",
      rssFeedUrl: null,
    }, now).reason).toBe("missing_or_invalid_feed");
    expect(shouldRunAgent2Discovery({ ...base, manualOverride: true }, now).reason).toBe("manual_override");
  });
});
