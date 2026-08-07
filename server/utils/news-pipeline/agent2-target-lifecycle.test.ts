import { describe, it, expect } from "vitest";
import {
  classifyAgent2TargetLifecycle,
  isAgent2TargetActionable,
  isAgent2TargetResolved,
  isAgent2TargetRetryable,
  summarizeAgent2TargetLifecycle,
  type Agent2LifecycleInput,
} from "./agent2-target-lifecycle";

describe("agent2-target-lifecycle", () => {
  const baseInput: Agent2LifecycleInput = {
    rssStatus: "NO_RSS_FOUND",
    currentFeedProductive: false,
    resolvedByAgent1ScopedRss: false,
    lastStaticQuality: null,
    lastStaticEscalated: false,
    lastBrowserStatus: null,
    lastAcceptedCount: null,
    lastInsertedCount: null,
    inBrowserCooldown: false,
    hardSourceLifecycleState: null,
    recoverySuggestion: null,
    discoveryProfileStatus: null,
    consecutiveFailedDiscoveryAttempts: 0,
  };

  describe("classifyAgent2TargetLifecycle", () => {
    it("returns rss_owned when resolved by Agent 1 scoped RSS", () => {
      expect(classifyAgent2TargetLifecycle({ ...baseInput, resolvedByAgent1ScopedRss: true })).toBe("rss_owned");
    });

    it("returns rss_owned when RSS active and productive", () => {
      expect(classifyAgent2TargetLifecycle({ ...baseInput, rssStatus: "ACTIVE", currentFeedProductive: true })).toBe("rss_owned");
    });

    it("returns resolved when browser accepted candidates and inserted > 0", () => {
      expect(classifyAgent2TargetLifecycle({
        ...baseInput,
        lastBrowserStatus: "RESOLVED",
        lastAcceptedCount: 5,
        lastInsertedCount: 3,
      })).toBe("resolved");
    });

    it("returns browser_productive when browser accepted but inserted = 0", () => {
      expect(classifyAgent2TargetLifecycle({
        ...baseInput,
        lastBrowserStatus: "RESOLVED",
        lastAcceptedCount: 2,
        lastInsertedCount: 0,
      })).toBe("browser_productive");
    });

    it("returns static_productive when static quality is productive", () => {
      expect(classifyAgent2TargetLifecycle({ ...baseInput, lastStaticQuality: "productive" })).toBe("static_productive");
    });

    it("returns profile_active when discovery profile is active", () => {
      expect(classifyAgent2TargetLifecycle({ ...baseInput, discoveryProfileStatus: "active" })).toBe("profile_active");
    });

    it("returns profile_draft when discovery profile is draft", () => {
      expect(classifyAgent2TargetLifecycle({ ...baseInput, discoveryProfileStatus: "draft" })).toBe("profile_draft");
    });

    it("returns cooldown when in browser cooldown", () => {
      expect(classifyAgent2TargetLifecycle({ ...baseInput, inBrowserCooldown: true })).toBe("cooldown");
    });

    it("keeps partial browser success in cooldown until retry is allowed", () => {
      expect(classifyAgent2TargetLifecycle({
        ...baseInput,
        lastBrowserStatus: "PENDING_HEADLESS",
        lastAcceptedCount: 1,
        lastInsertedCount: 1,
        inBrowserCooldown: true,
      })).toBe("cooldown");
    });

    it("returns browser_pending when headless status is PENDING_HEADLESS", () => {
      expect(classifyAgent2TargetLifecycle({ ...baseInput, lastBrowserStatus: "PENDING_HEADLESS" })).toBe("browser_pending");
    });

    it("returns browser_failed_retryable when browser status is BROWSER_NO_CANDIDATES", () => {
      expect(classifyAgent2TargetLifecycle({ ...baseInput, lastBrowserStatus: "BROWSER_NO_CANDIDATES" })).toBe("browser_failed_retryable");
    });

    it("returns browser_failed_terminal when browser status is BROWSER_FALLBACK_DISABLED", () => {
      expect(classifyAgent2TargetLifecycle({ ...baseInput, lastBrowserStatus: "BROWSER_FALLBACK_DISABLED" })).toBe("browser_failed_terminal");
    });

    it("returns hard_source_suggested when hard-source profile has recovery suggestion", () => {
      expect(classifyAgent2TargetLifecycle({
        ...baseInput,
        hardSourceLifecycleState: "open",
        recoverySuggestion: "relax_category_scope",
      })).toBe("hard_source_suggested");
    });

    it("returns hard_source_open when hard-source profile is open without suggestion", () => {
      expect(classifyAgent2TargetLifecycle({
        ...baseInput,
        hardSourceLifecycleState: "open",
      })).toBe("hard_source_open");
    });

    it("returns static_failed when static quality is failed", () => {
      expect(classifyAgent2TargetLifecycle({ ...baseInput, lastStaticQuality: "failed" })).toBe("static_failed");
    });

    it("returns static_pending when no artifacts exist yet", () => {
      expect(classifyAgent2TargetLifecycle(baseInput)).toBe("static_pending");
    });
  });

  describe("isAgent2TargetActionable", () => {
    it("marks static_pending as actionable", () => {
      expect(isAgent2TargetActionable("static_pending")).toBe(true);
    });

    it("marks static_failed as actionable", () => {
      expect(isAgent2TargetActionable("static_failed")).toBe(true);
    });

    it("marks browser_pending as actionable", () => {
      expect(isAgent2TargetActionable("browser_pending")).toBe(true);
    });

    it("marks hard_source_open as actionable", () => {
      expect(isAgent2TargetActionable("hard_source_open")).toBe(true);
    });

    it("does not mark resolved as actionable", () => {
      expect(isAgent2TargetActionable("resolved")).toBe(false);
    });

    it("does not mark rss_owned as actionable", () => {
      expect(isAgent2TargetActionable("rss_owned")).toBe(false);
    });

    it("does not mark ignored as actionable", () => {
      expect(isAgent2TargetActionable("ignored")).toBe(false);
    });
  });

  describe("isAgent2TargetResolved", () => {
    it("marks rss_owned as resolved", () => {
      expect(isAgent2TargetResolved("rss_owned")).toBe(true);
    });

    it("marks static_productive as resolved", () => {
      expect(isAgent2TargetResolved("static_productive")).toBe(true);
    });

    it("marks browser_productive as resolved", () => {
      expect(isAgent2TargetResolved("browser_productive")).toBe(true);
    });

    it("marks resolved as resolved", () => {
      expect(isAgent2TargetResolved("resolved")).toBe(true);
    });

    it("does not mark static_failed as resolved", () => {
      expect(isAgent2TargetResolved("static_failed")).toBe(false);
    });
  });

  describe("isAgent2TargetRetryable", () => {
    it("marks static_failed as retryable", () => {
      expect(isAgent2TargetRetryable("static_failed")).toBe(true);
    });

    it("marks browser_failed_retryable as retryable", () => {
      expect(isAgent2TargetRetryable("browser_failed_retryable")).toBe(true);
    });

    it("marks cooldown as retryable", () => {
      expect(isAgent2TargetRetryable("cooldown")).toBe(true);
    });

    it("does not mark browser_failed_terminal as retryable", () => {
      expect(isAgent2TargetRetryable("browser_failed_terminal")).toBe(false);
    });
  });

  describe("summarizeAgent2TargetLifecycle", () => {
    it("returns complete summary for RSS active source", () => {
      const summary = summarizeAgent2TargetLifecycle({
        ...baseInput,
        rssStatus: "ACTIVE",
        currentFeedProductive: true,
      });
      expect(summary.state).toBe("rss_owned");
      expect(summary.actionable).toBe(false);
      expect(summary.resolved).toBe(true);
      expect(summary.retryable).toBe(false);
    });

    it("returns complete summary for hard-source with suggestion", () => {
      const summary = summarizeAgent2TargetLifecycle({
        ...baseInput,
        hardSourceLifecycleState: "open",
        recoverySuggestion: "relax_category_scope",
      });
      expect(summary.state).toBe("hard_source_suggested");
      expect(summary.actionable).toBe(true);
      expect(summary.resolved).toBe(false);
      expect(summary.retryable).toBe(true);
    });
  });
});
