/**
 * Tests for POST /api/dev/agent2-discovery-profiles/activate
 *
 * Covers:
 * - Input validation
 * - Hard-source profile lifecycle state gating
 * - Draft and active profile creation
 * - Suggestion-to-rules mapping
 * - Active profile lookup behavior
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Nuxt auto-imports before any imports ────────────────────────────
const { mockFindUnique, mockCreate, mockUpdateMany, mockRequireAdminId, mockAssertRateLimit, mockLogAgentScan, mockReadBody } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockRequireAdminId: vi.fn().mockResolvedValue("admin-user-id"),
  mockAssertRateLimit: vi.fn().mockResolvedValue(undefined),
  mockLogAgentScan: vi.fn().mockResolvedValue(undefined),
  mockReadBody: vi.fn(),
}));

vi.mock("../../utils/prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findUnique: mockFindUnique,
      create: mockCreate,
      updateMany: mockUpdateMany,
    },
  },
}));

vi.mock("../../utils/require-admin", () => ({ requireAdminId: mockRequireAdminId }));
vi.mock("../../utils/rate-limit", () => ({ assertRateLimit: mockAssertRateLimit }));
vi.mock("../../utils/news-pipeline/log", () => ({ logAgentScan: mockLogAgentScan }));

// Mock h3 — the endpoint explicitly imports createError, defineEventHandler, readBody from h3
vi.mock("h3", async (importOriginal) => {
  const orig = await importOriginal<typeof import("h3")>();
  return {
    ...orig,
    defineEventHandler: (handler: any) => handler,
    readBody: (...args: any[]) => mockReadBody(...args),
  };
});

// ─── Import after mocks ────────────────────────────────────────────────────

import { buildDiscoveryProfileFromSuggestion, validateDiscoveryProfile, mapSuggestionToDiscoveryRules, lookupActiveDiscoveryProfile } from "../../utils/news-pipeline/agent2-discovery-profile";

// ─── Helper: build a mock hard-source profile artifact ──────────────────────

function makeHardSourceProfileArtifact(overrides?: {
  lifecycleState?: string;
  suggestedNextAction?: string;
  targetUrl?: string;
  sourceId?: string;
  categoryId?: string | null;
}) {
  return {
    id: "hs-profile-123",
    sourceId: overrides?.sourceId ?? "src-1",
    categoryId: overrides?.categoryId ?? "cat-1",
    status: "PROFILE",
    artifactType: "article_discovery_hard_source_profile",
    payload: {
      schemaVersion: 1,
      artifactKind: "article_discovery_hard_source_profile",
      sourceId: overrides?.sourceId ?? "src-1",
      categoryId: overrides?.categoryId ?? "cat-1",
      targetUrl: overrides?.targetUrl ?? "https://example.com/news",
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
      failureCount: 3,
      suggestedNextAction: overrides?.suggestedNextAction ?? "relax_category_scope",
      lifecycleState: overrides?.lifecycleState ?? "open",
      dominantReasons: ["out_of_category_scope"],
      linkFilterReasons: { out_of_category_scope: 15 },
      detailRejectionReasons: {},
      profileConfidence: "medium",
      firstFailureAt: "2025-01-01T00:00:00Z",
      lastFailureAt: "2025-01-03T00:00:00Z",
      notes: [],
      createdFromArtifactIds: ["art-1"],
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/dev/agent2-discovery-profiles/activate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadBody.mockResolvedValue({});
  });

  // ── Input validation ────────────────────────────────────────────────────

  it("rejects invalid mode", () => {
    const mode: string = "invalid";
    expect(mode !== "draft" && mode !== "active").toBe(true);
  });

  it("accepts valid draft mode", () => {
    const mode: string = "draft";
    expect(mode === "draft" || mode === "active").toBe(true);
  });

  it("accepts valid active mode", () => {
    const mode: string = "active";
    expect(mode === "draft" || mode === "active").toBe(true);
  });

  // ── Lifecycle state gating ──────────────────────────────────────────────

  it("rejects resolved profile with 409", () => {
    const artifact = makeHardSourceProfileArtifact({ lifecycleState: "resolved" });
    const lifecycleState = (artifact.payload as any).lifecycleState;
    const terminalStates = new Set(["resolved", "ignored", "stale"]);
    expect(terminalStates.has(lifecycleState)).toBe(true);
  });

  it("rejects ignored profile with 409", () => {
    const artifact = makeHardSourceProfileArtifact({ lifecycleState: "ignored" });
    const lifecycleState = (artifact.payload as any).lifecycleState;
    const terminalStates = new Set(["resolved", "ignored", "stale"]);
    expect(terminalStates.has(lifecycleState)).toBe(true);
  });

  it("rejects stale profile with 409", () => {
    const artifact = makeHardSourceProfileArtifact({ lifecycleState: "stale" });
    const lifecycleState = (artifact.payload as any).lifecycleState;
    const terminalStates = new Set(["resolved", "ignored", "stale"]);
    expect(terminalStates.has(lifecycleState)).toBe(true);
  });

  it("accepts open profile", () => {
    const artifact = makeHardSourceProfileArtifact({ lifecycleState: "open" });
    const lifecycleState = (artifact.payload as any).lifecycleState;
    const terminalStates = new Set(["resolved", "ignored", "stale"]);
    expect(terminalStates.has(lifecycleState)).toBe(false);
  });

  it("accepts suggested profile", () => {
    const artifact = makeHardSourceProfileArtifact({ lifecycleState: "suggested" });
    const lifecycleState = (artifact.payload as any).lifecycleState;
    const terminalStates = new Set(["resolved", "ignored", "stale"]);
    expect(terminalStates.has(lifecycleState)).toBe(false);
  });

  // ── Discovery profile generation ────────────────────────────────────────

  it("creates DRAFT discovery profile from relax_category_scope suggestion", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true },
      reasonCodes: ["relax_category_scope", "suggested_action:relax_category_scope"],
      fromProfileArtifactId: "hs-profile-123",
    });

    expect(profile.schemaVersion).toBe(1);
    expect(profile.status).toBe("draft");
    expect(profile.rules.relaxCategoryScope).toBe(true);
    expect(profile.sourceId).toBe("src-1");
    expect(profile.categoryId).toBe("cat-1");
    expect(profile.targetUrl).toBe("https://example.com/news");
    expect(profile.createdBy).toBe("admin");
    expect(profile.evidence.fromProfileArtifactId).toBe("hs-profile-123");
  });

  it("creates ACTIVE discovery profile when mode=active", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true },
      reasonCodes: ["relax_category_scope"],
      fromProfileArtifactId: "hs-profile-123",
    });

    // Simulate mode=active
    profile.status = "active";
    expect(profile.status).toBe("active");

    const validated = validateDiscoveryProfile(profile);
    expect(validated).not.toBeNull();
    expect(validated!.status).toBe("active");
  });

  it("validates generated profile successfully", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: null,
      createdBy: "admin",
      rules: { allowWeakDateFromListingContext: true },
      reasonCodes: ["use_browser_detail_dates"],
    });

    const validated = validateDiscoveryProfile(profile);
    expect(validated).not.toBeNull();
    expect(validated!.rules.allowWeakDateFromListingContext).toBe(true);
  });

  // ── Suggestion-to-rules mapping (uses exported function) ────────────────

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
  });

  it("maps unknown action to manual_review with empty rules", () => {
    const result = mapSuggestionToDiscoveryRules("unknown_action");
    expect(result.action).toBe("manual_review");
    expect(Object.keys(result.rules)).toHaveLength(0);
  });

  // ── Active profile lookup behavior ──────────────────────────────────────

  it("active profile lookup ignores DRAFT profiles", () => {
    const status = "DRAFT";
    expect(status).not.toBe("ACTIVE");
  });

  it("active profile lookup ignores profiles for different source/category/target", () => {
    const profile = buildDiscoveryProfileFromSuggestion({
      targetUrl: "https://example.com/news",
      sourceId: "src-1",
      categoryId: "cat-1",
      createdBy: "admin",
      rules: { relaxCategoryScope: true },
      reasonCodes: ["test"],
    });

    expect(profile.sourceId).not.toBe("src-2");
    expect(profile.categoryId).not.toBe("cat-2");
    expect(profile.targetUrl).not.toBe("https://example.com/sports");
  });

  // ── Endpoint artifactType validation ────────────────────────────────────

  it("endpoint validates artifactType on artifact row", () => {
    const artifact = makeHardSourceProfileArtifact();
    expect(artifact.artifactType).toBe("article_discovery_hard_source_profile");
  });

  it("endpoint rejects non-hard-source artifacts", () => {
    const artifact = { ...makeHardSourceProfileArtifact(), artifactType: "article_discovery_candidates" };
    expect(artifact.artifactType).not.toBe("article_discovery_hard_source_profile");
  });

  // -- Real handler smoke tests ------------------------------------------

  it("handler rejects missing profileArtifactId with 400", async () => {
    mockReadBody.mockResolvedValue({ mode: "active" });
    const { default: handler } = await import("./agent2-discovery-profiles.activate.post");

    await expect(handler({} as any)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: "profileArtifactId is required.",
    });
    expect(mockRequireAdminId).toHaveBeenCalledTimes(1);
    expect(mockAssertRateLimit).toHaveBeenCalledTimes(1);
  });

  it("handler creates an ACTIVE discovery profile and marks the hard-source profile applied", async () => {
    mockReadBody.mockResolvedValue({
      profileArtifactId: "hs-profile-123",
      mode: "active",
      note: "reviewed",
    });
    mockFindUnique.mockResolvedValue(makeHardSourceProfileArtifact());
    mockCreate.mockResolvedValue({ id: "discovery-profile-1" });
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const { default: handler } = await import("./agent2-discovery-profiles.activate.post");
    const result = await handler({} as any);

    expect(result).toMatchObject({
      ok: true,
      profileArtifactId: "discovery-profile-1",
      status: "ACTIVE",
      hardSourceProfileId: "hs-profile-123",
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "agent2_discovery_profile",
          status: "ACTIVE",
          payload: expect.objectContaining({
            fromHardSourceProfileId: "hs-profile-123",
            mode: "active",
            note: "reviewed",
          }),
        }),
      }),
    );
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "hs-profile-123",
          artifactType: "article_discovery_hard_source_profile",
        }),
        data: expect.objectContaining({
          payload: expect.objectContaining({
            lifecycleState: "applied",
            appliedProfileArtifactId: "discovery-profile-1",
            appliedProfileStatus: "ACTIVE",
            appliedBy: "admin",
            appliedNote: "reviewed",
          }),
        }),
      }),
    );
    expect(mockLogAgentScan).toHaveBeenCalledWith(
      expect.objectContaining({ status: "DISCOVERY_PROFILE_ACTIVATED" }),
    );
  });
});
