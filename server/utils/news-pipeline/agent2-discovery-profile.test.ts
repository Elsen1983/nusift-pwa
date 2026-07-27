import { describe, it, expect } from "vitest";
import {
  buildDiscoveryProfileFromSuggestion,
  validateDiscoveryProfile,
  applyDiscoveryProfileToAgent2Target,
  mapSuggestionToDiscoveryRules,
} from "./agent2-discovery-profile";

describe("agent2-discovery-profile", () => {
  describe("buildDiscoveryProfileFromSuggestion", () => {
    it("creates a draft profile with correct fields", () => {
      const profile = buildDiscoveryProfileFromSuggestion({
        targetUrl: "https://example.com/news",
        sourceId: "src-1",
        categoryId: "cat-1",
        createdBy: "deterministic_recovery",
        rules: { relaxCategoryScope: true, allowedPathPrefixes: ["/news", "/sports"] },
        reasonCodes: ["out_of_category_scope"],
        fromProfileArtifactId: "art-1",
      });

      expect(profile.schemaVersion).toBe(1);
      expect(profile.status).toBe("draft");
      expect(profile.targetUrl).toBe("https://example.com/news");
      expect(profile.sourceId).toBe("src-1");
      expect(profile.categoryId).toBe("cat-1");
      expect(profile.createdBy).toBe("deterministic_recovery");
      expect(profile.rules.relaxCategoryScope).toBe(true);
      expect(profile.rules.allowedPathPrefixes).toEqual(["/news", "/sports"]);
      expect(profile.evidence.reasonCodes).toEqual(["out_of_category_scope"]);
      expect(profile.evidence.fromProfileArtifactId).toBe("art-1");
    });

    it("sanitizes rules - caps allowedPathPrefixes at 10", () => {
      const prefixes = Array.from({ length: 15 }, (_, i) => `/path-${i}`);
      const profile = buildDiscoveryProfileFromSuggestion({
        targetUrl: "https://example.com/news",
        sourceId: "src-1",
        categoryId: null,
        createdBy: "admin",
        rules: { allowedPathPrefixes: prefixes },
        reasonCodes: [],
      });
      expect(profile.rules.allowedPathPrefixes).toHaveLength(10);
    });

    it("sanitizes rules - caps reasonCodes at 10", () => {
      const codes = Array.from({ length: 15 }, (_, i) => `reason-${i}`);
      const profile = buildDiscoveryProfileFromSuggestion({
        targetUrl: "https://example.com/news",
        sourceId: "src-1",
        categoryId: null,
        createdBy: "admin",
        rules: {},
        reasonCodes: codes,
      });
      expect(profile.evidence.reasonCodes).toHaveLength(10);
    });
  });

  describe("validateDiscoveryProfile", () => {
    it("returns null for non-object input", () => {
      expect(validateDiscoveryProfile(null)).toBeNull();
      expect(validateDiscoveryProfile("string")).toBeNull();
    });

    it("returns null when required fields are missing", () => {
      expect(validateDiscoveryProfile({ schemaVersion: 1 })).toBeNull();
      expect(validateDiscoveryProfile({ schemaVersion: 1, targetUrl: "https://x.com", sourceId: "s1" })).toBeNull();
    });

    it("returns null for wrong schemaVersion", () => {
      expect(validateDiscoveryProfile({
        schemaVersion: 2,
        targetUrl: "https://x.com",
        sourceId: "s1",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        createdBy: "admin",
        status: "draft",
      })).toBeNull();
    });

    it("returns null for invalid status", () => {
      expect(validateDiscoveryProfile({
        schemaVersion: 1,
        targetUrl: "https://x.com",
        sourceId: "s1",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        createdBy: "admin",
        status: "invalid_status",
      })).toBeNull();
    });

    it("validates a complete profile", () => {
      const profile = validateDiscoveryProfile({
        schemaVersion: 1,
        targetUrl: "https://example.com/news",
        sourceId: "src-1",
        categoryId: "cat-1",
        createdAt: "2026-07-27T00:00:00Z",
        updatedAt: "2026-07-27T00:00:00Z",
        createdBy: "deterministic_recovery",
        status: "active",
        rules: { relaxCategoryScope: true, allowedPathPrefixes: ["/news"] },
        evidence: { reasonCodes: ["out_of_scope"], fromProfileArtifactId: "art-1" },
      });
      expect(profile).not.toBeNull();
      expect(profile!.status).toBe("active");
      expect(profile!.rules.relaxCategoryScope).toBe(true);
    });

    it("handles null categoryId", () => {
      const profile = validateDiscoveryProfile({
        schemaVersion: 1,
        targetUrl: "https://x.com",
        sourceId: "s1",
        categoryId: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        createdBy: "admin",
        status: "draft",
      });
      expect(profile).not.toBeNull();
      expect(profile!.categoryId).toBeNull();
    });
  });

  describe("applyDiscoveryProfileToAgent2Target", () => {
    const target = {
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://example.com/news",
    };

    it("returns null for draft profile", () => {
      const profile = buildDiscoveryProfileFromSuggestion({
        ...target,
        createdBy: "deterministic_recovery",
        rules: { relaxCategoryScope: true },
        reasonCodes: ["test"],
      });
      expect(applyDiscoveryProfileToAgent2Target(profile, target)).toBeNull();
    });

    it("returns overrides for active profile matching target", () => {
      const profile = buildDiscoveryProfileFromSuggestion({
        ...target,
        createdBy: "deterministic_recovery",
        rules: { relaxCategoryScope: true, allowWeakDateFromListingContext: true },
        reasonCodes: ["test"],
      });
      profile.status = "active";

      const overrides = applyDiscoveryProfileToAgent2Target(profile, target);
      expect(overrides).not.toBeNull();
      expect(overrides!.relaxCategoryScope).toBe(true);
      expect(overrides!.allowWeakDateFromListingContext).toBe(true);
    });

    it("returns null for non-matching sourceId", () => {
      const profile = buildDiscoveryProfileFromSuggestion({
        ...target,
        createdBy: "deterministic_recovery",
        rules: { relaxCategoryScope: true },
        reasonCodes: ["test"],
      });
      profile.status = "active";

      expect(applyDiscoveryProfileToAgent2Target(profile, { ...target, sourceId: "src-other" })).toBeNull();
    });

    it("returns null for non-matching categoryId", () => {
      const profile = buildDiscoveryProfileFromSuggestion({
        ...target,
        createdBy: "deterministic_recovery",
        rules: { relaxCategoryScope: true },
        reasonCodes: ["test"],
      });
      profile.status = "active";

      expect(applyDiscoveryProfileToAgent2Target(profile, { ...target, categoryId: "cat-other" })).toBeNull();
    });

    it("returns null for non-matching targetUrl", () => {
      const profile = buildDiscoveryProfileFromSuggestion({
        ...target,
        createdBy: "deterministic_recovery",
        rules: {},
        reasonCodes: ["test"],
      });
      profile.status = "active";

      expect(applyDiscoveryProfileToAgent2Target(profile, { ...target, targetUrl: "https://other.com" })).toBeNull();
    });

    it("returns null for disabled profile", () => {
      const profile = buildDiscoveryProfileFromSuggestion({
        ...target,
        createdBy: "deterministic_recovery",
        rules: { relaxCategoryScope: true },
        reasonCodes: ["test"],
      });
      profile.status = "disabled";

      expect(applyDiscoveryProfileToAgent2Target(profile, target)).toBeNull();
    });

    it("returns null for superseded profile", () => {
      const profile = buildDiscoveryProfileFromSuggestion({
        ...target,
        createdBy: "deterministic_recovery",
        rules: {},
        reasonCodes: ["test"],
      });
      profile.status = "superseded";

      expect(applyDiscoveryProfileToAgent2Target(profile, target)).toBeNull();
    });
  });

  describe("mapSuggestionToDiscoveryRules", () => {
    it("maps relax_category_scope to relaxCategoryScope rule", () => {
      const result = mapSuggestionToDiscoveryRules("relax_category_scope");
      expect(result.action).toBe("relax_category_scope");
      expect(result.rules.relaxCategoryScope).toBe(true);
    });

    it("maps weak_date_policy_review to allowWeakDateFromListingContext rule", () => {
      const result = mapSuggestionToDiscoveryRules("weak_date_policy_review");
      expect(result.action).toBe("use_browser_detail_dates");
      expect(result.rules.allowWeakDateFromListingContext).toBe(true);
    });

    it("maps ai_profile_inspection to needs_ai_inspection without silent discovery rules", () => {
      const result = mapSuggestionToDiscoveryRules("ai_profile_inspection");
      expect(result.action).toBe("needs_ai_inspection");
      expect(Object.keys(result.rules)).toHaveLength(0);
    });

    it("maps browser_runtime_fix to respect_cooldown", () => {
      const result = mapSuggestionToDiscoveryRules("browser_runtime_fix");
      expect(result.action).toBe("respect_cooldown");
      expect(Object.keys(result.rules)).toHaveLength(0);
    });

    it("maps unknown action to manual_review with empty rules", () => {
      const result = mapSuggestionToDiscoveryRules("unknown_action");
      expect(result.action).toBe("manual_review");
      expect(Object.keys(result.rules)).toHaveLength(0);
    });
  });
});
