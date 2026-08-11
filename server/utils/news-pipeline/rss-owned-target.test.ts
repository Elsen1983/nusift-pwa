import { describe, expect, it, vi } from "vitest";
import {
  RSS_OWNED_NON_PRODUCTIVE_ESCALATION_THRESHOLD,
  RSS_OWNED_TRUSTED_PROVENANCES,
  evaluateRssOwnedTargetForAgent2,
  isRssOwnedTarget,
  rssOwnedSkipReason,
} from "./rss-owned-target";

const trustedFeed = {
  rssStatus: "ACTIVE",
  rssFeedUrl: "https://feeds.example.com/category/news",
  feedProvenance: "USER_SUBMITTED",
};

describe("isRssOwnedTarget", () => {
  it("requires ACTIVE status, an active feed URL, and trusted provenance", () => {
    expect(isRssOwnedTarget(trustedFeed)).toBe(true);
    expect(isRssOwnedTarget({ ...trustedFeed, rssStatus: "FAILED" })).toBe(false);
    expect(isRssOwnedTarget({ ...trustedFeed, rssFeedUrl: null })).toBe(false);
    expect(isRssOwnedTarget({ ...trustedFeed, feedProvenance: "SYSTEM_DISCOVERED" })).toBe(false);
    expect(isRssOwnedTarget({ ...trustedFeed, feedProvenance: null })).toBe(false);
  });

  it("trusts USER_SUBMITTED and ADMIN_CONFIRMED provenance", () => {
    expect(RSS_OWNED_TRUSTED_PROVENANCES.has("USER_SUBMITTED")).toBe(true);
    expect(RSS_OWNED_TRUSTED_PROVENANCES.has("ADMIN_CONFIRMED")).toBe(true);
    expect(RSS_OWNED_TRUSTED_PROVENANCES.has("SYSTEM_DISCOVERED")).toBe(false);
    expect(isRssOwnedTarget({ ...trustedFeed, feedProvenance: "ADMIN_CONFIRMED" })).toBe(true);
  });
});

describe("evaluateRssOwnedTargetForAgent2", () => {
  it("valid user-submitted category RSS skips Agent 2 while productive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
    try {
      const result = evaluateRssOwnedTargetForAgent2({
        ...trustedFeed,
        currentFeedProductive: true,
        lastProductiveAt: new Date("2026-08-10T11:00:00.000Z"),
        consecutiveNonProductiveRuns: 0,
      });
      expect(result.rssOwned).toBe(true);
      expect(result.eligibleForAgent2).toBe(false);
      expect(result.reason).toBe("rss_owned_productive");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a single temporary feed failure preserves RSS ownership (no immediate escalation)", () => {
    const result = evaluateRssOwnedTargetForAgent2({
      rssStatus: "FAILED",
      rssFeedUrl: trustedFeed.rssFeedUrl,
      feedProvenance: "USER_SUBMITTED",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
    });
    expect(result.rssOwned).toBe(true);
    expect(result.eligibleForAgent2).toBe(false);
    expect(result.reason).toBe("rss_owned_waiting_evidence");
  });

  it("repeatedly non-productive under the documented threshold stays owned", () => {
    const result = evaluateRssOwnedTargetForAgent2({
      ...trustedFeed,
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: RSS_OWNED_NON_PRODUCTIVE_ESCALATION_THRESHOLD - 1,
    });
    expect(result.eligibleForAgent2).toBe(false);
    expect(result.reason).toBe("rss_owned_waiting_evidence");
  });

  it("repeatedly non-productive at the documented threshold escalates to Agent 2", () => {
    const result = evaluateRssOwnedTargetForAgent2({
      ...trustedFeed,
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: RSS_OWNED_NON_PRODUCTIVE_ESCALATION_THRESHOLD,
    });
    expect(result.eligibleForAgent2).toBe(true);
    expect(result.reason).toBe("rss_owned_repeatedly_non_productive");
  });

  it("a single invalid-feed run remains below the Agent 2 fallback threshold", () => {
    const result = evaluateRssOwnedTargetForAgent2({
      rssStatus: "FAILED",
      rssFeedUrl: trustedFeed.rssFeedUrl,
      feedProvenance: "ADMIN_CONFIRMED",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 1,
    });
    expect(result.eligibleForAgent2).toBe(false);
    expect(result.reason).toBe("rss_owned_waiting_evidence");
  });

  it("permanently unreachable feed escalates", () => {
    const result = evaluateRssOwnedTargetForAgent2({
      rssStatus: "DOMAIN_DEAD",
      rssFeedUrl: trustedFeed.rssFeedUrl,
      feedProvenance: "USER_SUBMITTED",
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
    });
    expect(result.eligibleForAgent2).toBe(true);
    expect(result.reason).toBe("rss_owned_invalid_feed");
  });

  it("category scope mismatch allows escalation", () => {
    const result = evaluateRssOwnedTargetForAgent2({
      ...trustedFeed,
      currentFeedProductive: true,
      consecutiveNonProductiveRuns: 0,
      scopeMatches: false,
    });
    expect(result.eligibleForAgent2).toBe(true);
    expect(result.reason).toBe("rss_owned_scope_mismatch");
  });

  it("non-RSS-owned targets are always eligible for Agent 2", () => {
    const result = evaluateRssOwnedTargetForAgent2({
      rssStatus: "NO_RSS_FOUND",
      rssFeedUrl: null,
      feedProvenance: null,
      currentFeedProductive: false,
      consecutiveNonProductiveRuns: 0,
    });
    expect(result.rssOwned).toBe(false);
    expect(result.eligibleForAgent2).toBe(true);
    expect(result.reason).toBe("not_rss_owned");
  });

  it("system-discovered feeds without a productivity timestamp remain eligible", () => {
    // SYSTEM_DISCOVERED provenance is not trusted RSS ownership — the normal
    // ACTIVE rules apply (productive → skip, non-productive ≥ 2 → eligible).
    const result = evaluateRssOwnedTargetForAgent2({
      rssStatus: "ACTIVE",
      rssFeedUrl: "https://feeds.example.com/rss",
      feedProvenance: "SYSTEM_DISCOVERED",
      currentFeedProductive: true,
      consecutiveNonProductiveRuns: 0,
    });
    expect(result.rssOwned).toBe(false);
    expect(result.eligibleForAgent2).toBe(true);
  });
});

describe("rssOwnedSkipReason", () => {
  it("maps non-eligible RSS-owned evaluations to skip reasons", () => {
    expect(
      rssOwnedSkipReason({
        rssOwned: true,
        eligibleForAgent2: false,
        reason: "rss_owned_productive",
      }),
    ).toBe("rss_owned_productive");
    expect(
      rssOwnedSkipReason({
        rssOwned: true,
        eligibleForAgent2: false,
        reason: "rss_owned_waiting_evidence",
      }),
    ).toBe("rss_owned_waiting_evidence");
  });

  it("returns null for eligible targets", () => {
    expect(
      rssOwnedSkipReason({ rssOwned: true, eligibleForAgent2: true, reason: "rss_owned_scope_mismatch" }),
    ).toBeNull();
    expect(
      rssOwnedSkipReason({ rssOwned: false, eligibleForAgent2: true, reason: "not_rss_owned" }),
    ).toBeNull();
  });
});
