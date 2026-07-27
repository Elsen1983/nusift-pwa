import { describe, it, expect } from "vitest";
import {
  suggestRecovery,
  normalizeRecoveryInput,
  type HardSourceRecoveryInput,
} from "./hard-source-recovery";

describe("hard-source-recovery", () => {
  describe("normalizeRecoveryInput", () => {
    it("returns null for non-object input", () => {
      expect(normalizeRecoveryInput(null)).toBeNull();
      expect(normalizeRecoveryInput(undefined)).toBeNull();
      expect(normalizeRecoveryInput("string")).toBeNull();
      expect(normalizeRecoveryInput(42)).toBeNull();
    });

    it("returns null when both staticQuality and browserStatus are null/missing", () => {
      expect(normalizeRecoveryInput({})).toBeNull();
      expect(normalizeRecoveryInput({ staticQuality: null, browserStatus: null })).toBeNull();
    });

    it("normalizes valid input with staticQuality", () => {
      const result = normalizeRecoveryInput({
        staticQuality: "failed",
        browserStatus: null,
        failureCount: 2,
      });
      expect(result).not.toBeNull();
      expect(result!.staticQuality).toBe("failed");
      expect(result!.browserStatus).toBeNull();
      expect(result!.failureCount).toBe(2);
    });

    it("normalizes valid input with browserStatus", () => {
      const result = normalizeRecoveryInput({
        staticQuality: null,
        browserStatus: "BROWSER_NO_CANDIDATES",
        failureCount: 1,
      });
      expect(result).not.toBeNull();
      expect(result!.browserStatus).toBe("BROWSER_NO_CANDIDATES");
    });

    it("rejects unknown staticQuality values", () => {
      const result = normalizeRecoveryInput({
        staticQuality: "unknown_quality",
        browserStatus: "BROWSER_NO_CANDIDATES",
      });
      expect(result).not.toBeNull();
      expect(result!.staticQuality).toBeNull();
    });
  });

  describe("suggestRecovery", () => {
    const baseInput: HardSourceRecoveryInput = {
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
      dominantReasons: [],
      linkFilterReasons: {},
      detailRejectionReasons: {},
      failureCount: 1,
    };

    it("returns null for resolved lifecycle state", () => {
      expect(suggestRecovery({ ...baseInput, lifecycleState: "resolved" })).toBeNull();
    });

    it("returns null for ignored lifecycle state", () => {
      expect(suggestRecovery({ ...baseInput, lifecycleState: "ignored" })).toBeNull();
    });

    it("returns null for stale lifecycle state", () => {
      expect(suggestRecovery({ ...baseInput, lifecycleState: "stale" })).toBeNull();
    });

    it("suggests needs_ai_inspection for BROWSER_RUNTIME_UNAVAILABLE", () => {
      const result = suggestRecovery({ ...baseInput, browserStatus: "BROWSER_RUNTIME_UNAVAILABLE" });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("needs_ai_inspection");
      expect(result!.confidence).toBe("low");
      expect(result!.reasons[0]).toContain("runtime unavailable");
    });

    it("suggests needs_ai_inspection for BROWSER_FALLBACK_DISABLED", () => {
      const result = suggestRecovery({ ...baseInput, browserStatus: "BROWSER_FALLBACK_DISABLED" });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("needs_ai_inspection");
      expect(result!.confidence).toBe("low");
    });

    it("suggests respect_cooldown when rate-limit rejections dominate", () => {
      const result = suggestRecovery({
        ...baseInput,
        detailRejectionReasons: { rate_limited: 8, accepted: 2 },
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("respect_cooldown");
      expect(result!.confidence).toBe("high");
    });

    it("suggests relax_category_scope when out_of_category_scope dominates with article-like links", () => {
      const result = suggestRecovery({
        ...baseInput,
        linkFilterReasons: { out_of_category_scope: 8, utility_path: 2 },
        browserShortlistedLinkSamples: [
          { url: "https://example.com/sports/2026/07/27/story", score: 70, scoreReasons: ["same_domain"], utilityPath: false },
        ],
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("relax_category_scope");
      expect(result!.confidence).toBe("high");
      expect(result!.proposedProfilePatch).toBeDefined();
      expect(result!.proposedProfilePatch!.relaxCategoryScope).toBe(true);
    });

    it("suggests use_browser_detail_dates when date issues dominate with good titles", () => {
      const result = suggestRecovery({
        ...baseInput,
        dominantReasons: ["wouldAcceptWithWeakDate"],
        detailRejectionReasons: { missing_published_at: 6, accepted: 2, rejected_stale: 2 },
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("use_browser_detail_dates");
      expect(result!.confidence).toBe("medium");
      expect(result!.proposedProfilePatch!.allowWeakDateFromListingContext).toBe(true);
    });

    it("suggests prefer_listing_links when browser evaluated 0 but shortlisted > 0 with listing paths", () => {
      const result = suggestRecovery({
        ...baseInput,
        browserEvaluated: 0,
        browserShortlistedLinks: 10,
        linkFilterReasons: { listing_page: 5, utility_path: 3, out_of_category_scope: 2 },
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("prefer_listing_links");
      expect(result!.confidence).toBe("medium");
    });

    it("suggests needs_ai_inspection when dynamic_or_empty_html + browser no candidates", () => {
      const result = suggestRecovery({
        ...baseInput,
        dominantReasons: ["dynamic_or_empty_html"],
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("needs_ai_inspection");
      expect(result!.confidence).toBe("medium");
    });

    it("suggests needs_ai_inspection when failureCount >= 3", () => {
      const result = suggestRecovery({ ...baseInput, failureCount: 3 });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("needs_ai_inspection");
      expect(result!.confidence).toBe("medium");
    });

    it("suggests needs_ai_inspection with high confidence when failureCount >= 5", () => {
      const result = suggestRecovery({ ...baseInput, failureCount: 5 });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("needs_ai_inspection");
      expect(result!.confidence).toBe("high");
    });

    it("suggests mark_unsupported when failureCount >= 5 with static failed", () => {
      const result = suggestRecovery({
        ...baseInput,
        failureCount: 5,
        browserStatus: null,
        detailRejectionReasons: { unknown_reason: 10 },
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("mark_unsupported");
      expect(result!.confidence).toBe("low");
    });

    it("returns null for insufficient evidence (low failure count, no clear pattern)", () => {
      const result = suggestRecovery({
        staticQuality: "weak",
        browserStatus: null,
        dominantReasons: ["low_score"],
        linkFilterReasons: { utility_path: 1 },
        detailRejectionReasons: {},
        failureCount: 1,
      });
      expect(result).toBeNull();
    });

    it("suggests increase_browser_detail_limit when detail_limit stopped reason", () => {
      const result = suggestRecovery({
        ...baseInput,
        browserDetailEvaluationStoppedReason: "detail_limit",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("increase_browser_detail_limit");
      expect(result!.confidence).toBe("low");
      expect(result!.proposedProfilePatch!.maxBrowserDetailEvaluations).toBe(20);
    });
  });
});
