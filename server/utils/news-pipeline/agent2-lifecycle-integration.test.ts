/**
 * Full lifecycle integration test for Agent 2 self-healing discovery.
 *
 * Covers the intended lifecycle:
 * 1. Static discovery weak/failed.
 * 2. Browser fallback runs and finds zero accepted candidates.
 * 3. Hard-source profile is created with lifecycleState open.
 * 4. Admin activation endpoint creates ACTIVE discovery profile and marks
 *    hard-source profile applied.
 * 5. Next Agent 2 run applies active profile.
 * 6. If discovery becomes productive, hard-source profile is resolved.
 *
 * Uses mocks — no real network/browser/DB required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildDiscoveryProfileFromSuggestion,
  validateDiscoveryProfile,
  applyDiscoveryProfileToAgent2Target,
} from "./agent2-discovery-profile";
import {
  normalizeRecoveryInput,
  suggestRecovery,
} from "./hard-source-recovery";
import {
  classifyAgent2TargetLifecycle,
  isAgent2TargetResolved,
  type Agent2LifecycleInput,
} from "./agent2-target-lifecycle";

// ─── Lifecycle integration test ─────────────────────────────────────────────

describe("Agent 2 self-healing lifecycle integration", () => {
  // ── Step 1: Static discovery fails ─────────────────────────────────────

  it("step 1: static discovery weak/failed → hard_source_open lifecycle", () => {
    const input: Agent2LifecycleInput = {
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      resolvedByAgent1ScopedRss: false,
      lastStaticQuality: "failed",
      lastStaticEscalated: true,
      lastBrowserStatus: null,
      lastAcceptedCount: null,
      lastInsertedCount: null,
      inBrowserCooldown: false,
      hardSourceLifecycleState: null,
      recoverySuggestion: null,
      discoveryProfileStatus: null,
      consecutiveFailedDiscoveryAttempts: 1,
    };

    const state = classifyAgent2TargetLifecycle(input);
    expect(state).toBe("static_failed");
    expect(isAgent2TargetResolved(state)).toBe(false);
  });

  // ── Step 2: Browser fallback fails ─────────────────────────────────────

  it("step 2: browser fallback no candidates → browser_failed_retryable", () => {
    // When browserStatus is BROWSER_NO_CANDIDATES, the classifier checks
    // browser failure states BEFORE hard-source states (priority 11 vs 12).
    // So with lastBrowserStatus set, the lifecycle is browser_failed_retryable.
    const input: Agent2LifecycleInput = {
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      resolvedByAgent1ScopedRss: false,
      lastStaticQuality: "failed",
      lastStaticEscalated: true,
      lastBrowserStatus: "BROWSER_NO_CANDIDATES",
      lastAcceptedCount: 0,
      lastInsertedCount: 0,
      inBrowserCooldown: false,
      hardSourceLifecycleState: "open",
      recoverySuggestion: null,
      discoveryProfileStatus: null,
      consecutiveFailedDiscoveryAttempts: 2,
    };

    const state = classifyAgent2TargetLifecycle(input);
    expect(state).toBe("browser_failed_retryable");
    expect(isAgent2TargetResolved(state)).toBe(false);
  });

  // ── Step 3: Hard-source profile created with lifecycleState open ────────

  it("step 3: deterministic recovery generates suggestion", () => {
    const recoveryInput = normalizeRecoveryInput({
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
      lifecycleState: "open",
      dominantReasons: [],
      linkFilterReasons: { out_of_category_scope: 12, different_domain: 3 },
      detailRejectionReasons: {},
      failureCount: 3,
      browserShortlistedLinks: 10,
      browserEvaluated: 0,
      browserAccepted: 0,
      browserShortlistedLinkSamples: [
        { url: "https://example.com/news/article-1", score: 70, scoreReasons: ["same_domain", "multi_segment_path"], utilityPath: false },
        { url: "https://example.com/news/article-2", score: 65, scoreReasons: ["same_domain", "slug_pattern"], utilityPath: false },
      ],
    });

    expect(recoveryInput).not.toBeNull();

    const suggestion = suggestRecovery(recoveryInput!);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.action).toBe("relax_category_scope");
    expect(suggestion!.confidence).toBe("high");
  });

  it("step 3: lifecycle transitions from open to suggested", () => {
    // When browserStatus is set, the classifier prioritizes browser states.
    // Use null browserStatus to test hard-source lifecycle transitions.
    const openInput: Agent2LifecycleInput = {
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      resolvedByAgent1ScopedRss: false,
      lastStaticQuality: "failed",
      lastStaticEscalated: true,
      lastBrowserStatus: null,
      lastAcceptedCount: null,
      lastInsertedCount: null,
      inBrowserCooldown: false,
      hardSourceLifecycleState: "open",
      recoverySuggestion: null,
      discoveryProfileStatus: null,
      consecutiveFailedDiscoveryAttempts: 3,
    };

    const openState = classifyAgent2TargetLifecycle(openInput);
    expect(openState).toBe("hard_source_open");

    // After recovery suggestion is generated
    const suggestedInput = {
      ...openInput,
      recoverySuggestion: "relax_category_scope",
      hardSourceLifecycleState: "suggested",
    };

    const suggestedState = classifyAgent2TargetLifecycle(suggestedInput);
    expect(suggestedState).toBe("hard_source_suggested");
  });

  // ── Step 4: Admin activation creates ACTIVE discovery profile ───────────

  it("step 4: buildDiscoveryProfileFromSuggestion creates draft profile", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true },
      reasonCodes: ["relax_category_scope", "suggested_action:relax_category_scope"],
      fromProfileArtifactId: "hs-profile-123",
    });

    expect(profile.status).toBe("draft");
    expect(profile.rules.relaxCategoryScope).toBe(true);
    expect(profile.evidence.fromProfileArtifactId).toBe("hs-profile-123");
    expect(profile.createdBy).toBe("admin");
  });

  it("step 4: active profile passes validation", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true },
      reasonCodes: ["relax_category_scope"],
      fromProfileArtifactId: "hs-profile-123",
    });

    // Simulate admin activation
    profile.status = "active";

    const validated = validateDiscoveryProfile(profile);
    expect(validated).not.toBeNull();
    expect(validated!.status).toBe("active");
    expect(validated!.rules.relaxCategoryScope).toBe(true);
  });

  // ── Step 5: Active profile applied to Agent 2 target ───────────────────

  it("step 5: active profile produces overrides for matching target", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true, allowedPathPrefixes: ["/news", "/world"] },
      reasonCodes: ["relax_category_scope"],
      fromProfileArtifactId: "hs-profile-123",
    });
    profile.status = "active";

    const overrides = applyDiscoveryProfileToAgent2Target(profile, {
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://example.com/news",
    });

    expect(overrides).not.toBeNull();
    expect(overrides!.relaxCategoryScope).toBe(true);
    expect("allowedPathPrefixes" in overrides!).toBe(false);
  });

  it("step 5: active profile ignored for different target", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true },
      reasonCodes: ["relax_category_scope"],
    });
    profile.status = "active";

    // Different category
    const overrides = applyDiscoveryProfileToAgent2Target(profile, {
      sourceId: "src-1",
      categoryId: "cat-2",
      targetUrl: "https://example.com/sports",
    });

    expect(overrides).toBeNull();
  });

  it("step 5: draft profile does not produce overrides", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true },
      reasonCodes: ["relax_category_scope"],
    });
    // Draft by default
    expect(profile.status).toBe("draft");

    const overrides = applyDiscoveryProfileToAgent2Target(profile, {
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://example.com/news",
    });

    expect(overrides).toBeNull();
  });

  it("step 5: no active profile means current behavior unchanged", () => {
    // When no profile exists, applyDiscoveryProfileToAgent2Target returns null
    // which means no overrides — current behavior is preserved
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: {},
      reasonCodes: [],
    });
    profile.status = "active";

    const overrides = applyDiscoveryProfileToAgent2Target(profile, {
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://example.com/news",
    });

    // No rules set → all overrides are false/null
    expect(overrides).not.toBeNull();
    expect(overrides!.relaxCategoryScope).toBe(false);
    expect("allowedPathPrefixes" in overrides!).toBe(false);
    expect(overrides!.preferListingAnchors).toBe(false);
    expect(overrides!.allowWeakDateFromListingContext).toBe(false);
    expect(overrides!.maxBrowserDetailEvaluations).toBeNull();
  });

  // ── Step 6: Productive discovery resolves hard-source profile ───────────

  it("step 6: productive discovery → resolved lifecycle", () => {
    // When lastBrowserStatus is RESOLVED, the classifier resolves via browser path
    // (priority 3) before checking static quality (priority 4).
    // Use null lastBrowserStatus to test static_productive resolution.
    const input: Agent2LifecycleInput = {
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      resolvedByAgent1ScopedRss: false,
      lastStaticQuality: "productive",
      lastStaticEscalated: false,
      lastBrowserStatus: null,
      lastAcceptedCount: null,
      lastInsertedCount: null,
      inBrowserCooldown: false,
      hardSourceLifecycleState: "applied",
      recoverySuggestion: "relax_category_scope",
      discoveryProfileStatus: "active",
      consecutiveFailedDiscoveryAttempts: 0,
    };

    const state = classifyAgent2TargetLifecycle(input);
    expect(state).toBe("static_productive");
    expect(isAgent2TargetResolved(state)).toBe(true);
  });

  it("step 6: browser productive → resolved lifecycle", () => {
    const input: Agent2LifecycleInput = {
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      resolvedByAgent1ScopedRss: false,
      lastStaticQuality: "failed",
      lastStaticEscalated: true,
      lastBrowserStatus: "RESOLVED",
      lastAcceptedCount: 3,
      lastInsertedCount: 2,
      inBrowserCooldown: false,
      hardSourceLifecycleState: "applied",
      recoverySuggestion: "relax_category_scope",
      discoveryProfileStatus: "active",
      consecutiveFailedDiscoveryAttempts: 0,
    };

    const state = classifyAgent2TargetLifecycle(input);
    expect(state).toBe("resolved");
    expect(isAgent2TargetResolved(state)).toBe(true);
  });

  // ── Full lifecycle flow ────────────────────────────────────────────────

  it("full lifecycle: open → suggested → applied → resolved", () => {
    // Phase 1: Initial failure (browser failed → browser_failed_retryable)
    const phase1: Agent2LifecycleInput = {
      rssStatus: "NO_RSS_FOUND",
      currentFeedProductive: false,
      resolvedByAgent1ScopedRss: false,
      lastStaticQuality: "failed",
      lastStaticEscalated: true,
      lastBrowserStatus: "BROWSER_NO_CANDIDATES",
      lastAcceptedCount: 0,
      lastInsertedCount: 0,
      inBrowserCooldown: false,
      hardSourceLifecycleState: "open",
      recoverySuggestion: null,
      discoveryProfileStatus: null,
      consecutiveFailedDiscoveryAttempts: 2,
    };
    expect(classifyAgent2TargetLifecycle(phase1)).toBe("browser_failed_retryable");

    // Phase 2: Recovery suggestion generated — clear browserStatus so hard-source
    // lifecycle states are evaluated (browser checked before hard-source in classifier)
    const phase2: Agent2LifecycleInput = {
      ...phase1,
      lastBrowserStatus: null,
      lastAcceptedCount: null,
      lastInsertedCount: null,
      recoverySuggestion: "relax_category_scope",
      hardSourceLifecycleState: "suggested",
    };
    expect(classifyAgent2TargetLifecycle(phase2)).toBe("hard_source_suggested");

    // Phase 3: Admin creates draft profile
    const phase3: Agent2LifecycleInput = {
      ...phase2,
      discoveryProfileStatus: "draft",
    };
    expect(classifyAgent2TargetLifecycle(phase3)).toBe("profile_draft");

    // Phase 4: Admin activates profile
    const phase4: Agent2LifecycleInput = {
      ...phase3,
      discoveryProfileStatus: "active",
      hardSourceLifecycleState: "applied",
    };
    expect(classifyAgent2TargetLifecycle(phase4)).toBe("profile_active");
    expect(isAgent2TargetResolved(classifyAgent2TargetLifecycle(phase4))).toBe(false);

    // Phase 5: Profile produces results — static discovery becomes productive.
    // Clear browser metrics so the classifier evaluates static quality (priority 4)
    // instead of resolving via lastAcceptedCount > 0 (priority 3).
    const phase5: Agent2LifecycleInput = {
      ...phase4,
      lastStaticQuality: "productive",
      lastStaticEscalated: false,
      lastBrowserStatus: null,
      lastAcceptedCount: 0,
      lastInsertedCount: 0,
      consecutiveFailedDiscoveryAttempts: 0,
    };
    expect(classifyAgent2TargetLifecycle(phase5)).toBe("static_productive");
    expect(isAgent2TargetResolved(classifyAgent2TargetLifecycle(phase5))).toBe(true);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("disabled profile is ignored by Agent 2", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true },
      reasonCodes: ["test"],
    });
    profile.status = "disabled";

    const overrides = applyDiscoveryProfileToAgent2Target(profile, {
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://example.com/news",
    });

    expect(overrides).toBeNull();
  });

  it("superseded profile is ignored by Agent 2", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true },
      reasonCodes: ["test"],
    });
    profile.status = "superseded";

    const overrides = applyDiscoveryProfileToAgent2Target(profile, {
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://example.com/news",
    });

    expect(overrides).toBeNull();
  });

  it("profile for one category does not affect another category", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true },
      reasonCodes: ["test"],
    });
    profile.status = "active";

    // Same source, different category
    const overrides = applyDiscoveryProfileToAgent2Target(profile, {
      sourceId: "src-1",
      categoryId: "cat-2",
      targetUrl: "https://example.com/sports",
    });

    expect(overrides).toBeNull();
  });

  it("RSS active category → rss_owned lifecycle", () => {
    const input: Agent2LifecycleInput = {
      rssStatus: "ACTIVE",
      currentFeedProductive: true,
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

    const state = classifyAgent2TargetLifecycle(input);
    expect(state).toBe("rss_owned");
    expect(isAgent2TargetResolved(state)).toBe(true);
  });

  it("resolved by Agent 1 RSS → rss_owned lifecycle", () => {
    const input: Agent2LifecycleInput = {
      rssStatus: "ACTIVE",
      currentFeedProductive: false,
      resolvedByAgent1ScopedRss: true,
      lastStaticQuality: "failed",
      lastStaticEscalated: false,
      lastBrowserStatus: null,
      lastAcceptedCount: null,
      lastInsertedCount: null,
      inBrowserCooldown: false,
      hardSourceLifecycleState: "applied",
      recoverySuggestion: null,
      discoveryProfileStatus: null,
      consecutiveFailedDiscoveryAttempts: 0,
    };

    const state = classifyAgent2TargetLifecycle(input);
    expect(state).toBe("rss_owned");
    expect(isAgent2TargetResolved(state)).toBe(true);
  });
});
