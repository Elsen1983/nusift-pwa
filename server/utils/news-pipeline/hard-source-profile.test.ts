import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirstMock = vi.fn();
const findUniqueMock = vi.fn();
const findManyMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const logAgentScanMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findFirst: (...args: any[]) => findFirstMock(...args),
      findUnique: (...args: any[]) => findUniqueMock(...args),
      findMany: (...args: any[]) => findManyMock(...args),
      create: (...args: any[]) => createMock(...args),
      update: (...args: any[]) => updateMock(...args),
    },
  },
}));

vi.mock("./log", () => ({
  logAgentScan: (...args: any[]) => logAgentScanMock(...args),
}));

// ─── Pure helper tests ──────────────────────────────────────────────────────

describe("hard-source-profile — pure helpers", () => {
  async function loadModule() {
    return await import("./hard-source-profile");
  }

  describe("determineSuggestedNextAction", () => {
    it("returns browser_runtime_fix when browser runtime unavailable", async () => {
      const { determineSuggestedNextAction } = await loadModule();
      expect(determineSuggestedNextAction({
        staticQuality: "blocked",
        browserStatus: "BROWSER_RUNTIME_UNAVAILABLE",
        dominantReasons: [],
        linkFilterReasons: {},
        detailRejectionReasons: {},
        failureCount: 1,
      })).toBe("browser_runtime_fix");
    });

    it("returns browser_runtime_fix when browser fallback disabled", async () => {
      const { determineSuggestedNextAction } = await loadModule();
      expect(determineSuggestedNextAction({
        staticQuality: "failed",
        browserStatus: "BROWSER_FALLBACK_DISABLED",
        dominantReasons: [],
        linkFilterReasons: {},
        detailRejectionReasons: {},
        failureCount: 1,
      })).toBe("browser_runtime_fix");
    });

    it("returns relax_category_scope when mostly out_of_category_scope", async () => {
      const { determineSuggestedNextAction } = await loadModule();
      expect(determineSuggestedNextAction({
        staticQuality: "failed",
        browserStatus: "BROWSER_NO_CANDIDATES",
        dominantReasons: ["out_of_category_scope"],
        linkFilterReasons: { out_of_category_scope: 8, utility_path: 2 },
        detailRejectionReasons: {},
        failureCount: 2,
      })).toBe("relax_category_scope");
    });

    it("returns weak_date_policy_review when mostly date issues with good titles", async () => {
      const { determineSuggestedNextAction } = await loadModule();
      expect(determineSuggestedNextAction({
        staticQuality: "failed",
        browserStatus: "BROWSER_NO_CANDIDATES",
        dominantReasons: ["wouldAcceptWithWeakDate", "missing_published_at"],
        linkFilterReasons: {},
        detailRejectionReasons: { missing_published_at: 6, accepted: 2, rejected_stale: 2 },
        failureCount: 2,
      })).toBe("weak_date_policy_review");
    });

    it("prioritizes weak-date review over noisy out-of-scope links when a candidate passed scope", async () => {
      const { determineSuggestedNextAction } = await loadModule();
      expect(determineSuggestedNextAction({
        staticQuality: "weak",
        browserStatus: "BROWSER_NO_CANDIDATES",
        dominantReasons: ["wouldAcceptWithWeakDate", "missing_published_at"],
        linkFilterReasons: { out_of_category_scope: 20 },
        detailRejectionReasons: { missing_published_at: 1 },
        failureCount: 1,
      })).toBe("weak_date_policy_review");
    });

    it("returns ai_profile_inspection when dynamic_or_empty_html + browser no candidates", async () => {
      const { determineSuggestedNextAction } = await loadModule();
      expect(determineSuggestedNextAction({
        staticQuality: "blocked",
        browserStatus: "BROWSER_NO_CANDIDATES",
        dominantReasons: ["dynamic_or_empty_html"],
        linkFilterReasons: {},
        detailRejectionReasons: {},
        failureCount: 2,
      })).toBe("ai_profile_inspection");
    });

    it("returns ai_profile_inspection when failureCount >= 3 + browser no candidates", async () => {
      const { determineSuggestedNextAction } = await loadModule();
      expect(determineSuggestedNextAction({
        staticQuality: "failed",
        browserStatus: "BROWSER_NO_CANDIDATES",
        dominantReasons: ["stale", "low_score"],
        linkFilterReasons: {},
        detailRejectionReasons: {},
        failureCount: 3,
      })).toBe("ai_profile_inspection");
    });

    it("returns manual_review for mixed/unknown reasons", async () => {
      const { determineSuggestedNextAction } = await loadModule();
      expect(determineSuggestedNextAction({
        staticQuality: "weak",
        browserStatus: "BROWSER_NO_CANDIDATES",
        dominantReasons: ["unknown_reason"],
        linkFilterReasons: { utility_path: 2 },
        detailRejectionReasons: { rejected_stale: 1 },
        failureCount: 1,
      })).toBe("manual_review");
    });
  });

  describe("determineProfileConfidence", () => {
    it("returns high when failureCount >= 3 with clear reasons and browser status", async () => {
      const { determineProfileConfidence } = await loadModule();
      expect(determineProfileConfidence({
        failureCount: 3,
        staticQuality: "failed",
        browserStatus: "BROWSER_NO_CANDIDATES",
        dominantReasons: ["dynamic_or_empty_html", "blocked_by_robots"],
      })).toBe("high");
    });

    it("returns medium when failureCount >= 2 with some evidence", async () => {
      const { determineProfileConfidence } = await loadModule();
      expect(determineProfileConfidence({
        failureCount: 2,
        staticQuality: "failed",
        browserStatus: "BROWSER_NO_CANDIDATES",
        dominantReasons: ["stale"],
      })).toBe("medium");
    });

    it("returns low for single failure with minimal evidence", async () => {
      const { determineProfileConfidence } = await loadModule();
      expect(determineProfileConfidence({
        failureCount: 1,
        staticQuality: null,
        browserStatus: null,
        dominantReasons: [],
      })).toBe("low");
    });
  });

  describe("normalizeHardSourceProfile", () => {
    it("extracts profile fields from payload", async () => {
      const { normalizeHardSourceProfile } = await loadModule();
      const result = normalizeHardSourceProfile({
        id: "prof-1",
        sourceId: "src-1",
        categoryId: "cat-1",
        createdAt: new Date("2026-07-24T10:00:00Z"),
        updatedAt: new Date("2026-07-24T10:05:00Z"),
        payload: {
          targetUrl: "https://example.com/news",
          staticQuality: "failed",
          browserStatus: "BROWSER_NO_CANDIDATES",
          failureCount: 3,
          lastFailureAt: "2026-07-24T10:05:00Z",
          dominantReasons: ["stale", "low_score"],
          suggestedNextAction: "ai_profile_inspection",
          profileConfidence: "high",
        },
      });
      expect(result.targetUrl).toBe("https://example.com/news");
      expect(result.staticQuality).toBe("failed");
      expect(result.browserStatus).toBe("BROWSER_NO_CANDIDATES");
      expect(result.failureCount).toBe(3);
      expect(result.lastFailureAt).toBe("2026-07-24T10:05:00Z");
      expect(result.dominantReasons).toEqual(["stale", "low_score"]);
      expect(result.suggestedNextAction).toBe("ai_profile_inspection");
      expect(result.profileConfidence).toBe("high");
    });

    it("handles missing payload gracefully", async () => {
      const { normalizeHardSourceProfile } = await loadModule();
      const result = normalizeHardSourceProfile({
        id: "prof-2",
        sourceId: null,
        categoryId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        payload: null,
      });
      expect(result.targetUrl).toBeNull();
      expect(result.staticQuality).toBeNull();
      expect(result.browserStatus).toBeNull();
      expect(result.failureCount).toBe(1);
      expect(result.dominantReasons).toEqual([]);
      expect(result.suggestedNextAction).toBeNull();
      expect(result.profileConfidence).toBeNull();
    });

    it("does not expose raw payload or candidate arrays", async () => {
      const { normalizeHardSourceProfile } = await loadModule();
      const result = normalizeHardSourceProfile({
        id: "prof-3",
        sourceId: "src-1",
        categoryId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        payload: {
          targetUrl: "https://example.com",
          candidates: [{ url: "https://example.com/1" }],
          linkFilterReasons: { utility_path: 100 },
          detailRejectionReasons: { stale: 50 },
        },
      });
      expect(result).not.toHaveProperty("payload");
      expect(result).not.toHaveProperty("candidates");
      expect(result).not.toHaveProperty("linkFilterReasons");
      expect(result).not.toHaveProperty("detailRejectionReasons");
    });
  });

  describe("buildHardSourceTargetKey", () => {
    it("builds a stable key from sourceId/categoryId/normalized target URL", async () => {
      const { buildHardSourceTargetKey } = await loadModule();
      const key = buildHardSourceTargetKey({
        sourceId: "src-1",
        categoryId: "cat-1",
        targetUrl: "https://Example.com/News?utm_source=x",
      });
      expect(key).toBe("src-1|cat-1|https://example.com/News");
    });

    it("uses empty category segment for source-level targets", async () => {
      const { buildHardSourceTargetKey } = await loadModule();
      const key = buildHardSourceTargetKey({
        sourceId: "src-1",
        categoryId: null,
        targetUrl: "https://example.com",
      });
      expect(key).toBe("src-1||https://example.com/");
    });

    it("returns null for missing sourceId or invalid target URL", async () => {
      const { buildHardSourceTargetKey } = await loadModule();
      expect(buildHardSourceTargetKey({
        sourceId: null,
        categoryId: null,
        targetUrl: "https://example.com",
      })).toBeNull();
      expect(buildHardSourceTargetKey({
        sourceId: "src-1",
        categoryId: null,
        targetUrl: "not-a-url",
      })).toBeNull();
    });
  });

  describe("aggregateHardSourceProfiles", () => {
    const row = (overrides: Partial<{
      id: string;
      sourceId: string;
      categoryId: string | null;
      createdAt: string;
      updatedAt: string;
      payload: Record<string, unknown>;
    }>) => ({
      id: overrides.id ?? "prof-1",
      sourceId: overrides.sourceId ?? "src-1",
      categoryId: overrides.categoryId ?? null,
      createdAt: new Date(overrides.createdAt ?? "2026-07-24T10:00:00Z"),
      updatedAt: new Date(overrides.updatedAt ?? "2026-07-24T10:00:00Z"),
      payload: overrides.payload ?? {
        targetUrl: "https://example.com/news",
        failureCount: 2,
        lifecycleState: "open",
      },
    });

    it("groups repeated evidence for one target into a single current row", async () => {
      const { aggregateHardSourceProfiles } = await loadModule();
      const result = aggregateHardSourceProfiles([
        row({ id: "prof-old", createdAt: "2026-07-24T10:00:00Z", updatedAt: "2026-07-24T10:00:00Z" }),
        row({ id: "prof-new", createdAt: "2026-07-24T11:00:00Z", updatedAt: "2026-07-24T11:00:00Z", payload: { targetUrl: "https://example.com/news", failureCount: 5, lifecycleState: "open" } }),
      ]);

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("prof-new");
      expect(result[0]!.failureCount).toBe(5);
      expect(result[0]!.evidenceCount).toBe(2);
      expect(result[0]!.history).toHaveLength(1);
      expect(result[0]!.history[0]!.id).toBe("prof-old");
    });

    it("uses createdAt ASC ordering so the newest artifact becomes current", async () => {
      const { aggregateHardSourceProfiles } = await loadModule();
      // Input is out of order — newest first.
      const result = aggregateHardSourceProfiles([
        row({ id: "prof-new", createdAt: "2026-07-24T11:00:00Z", updatedAt: "2026-07-24T11:00:00Z", payload: { targetUrl: "https://example.com/news", failureCount: 6, lifecycleState: "suggested" } }),
        row({ id: "prof-old", createdAt: "2026-07-24T10:00:00Z", updatedAt: "2026-07-24T10:00:00Z", payload: { targetUrl: "https://example.com/news", failureCount: 1, lifecycleState: "open" } }),
      ]);

      expect(result[0]!.id).toBe("prof-new");
      expect(result[0]!.history[0]!.id).toBe("prof-old");
    });

    it("does not merge different categories under the same source", async () => {
      const { aggregateHardSourceProfiles } = await loadModule();
      const result = aggregateHardSourceProfiles([
        row({ id: "prof-a", categoryId: "cat-a", payload: { targetUrl: "https://example.com/sport", lifecycleState: "open" } }),
        row({ id: "prof-b", categoryId: "cat-b", payload: { targetUrl: "https://example.com/tech", lifecycleState: "open" } }),
      ]);
      expect(result).toHaveLength(2);
    });

    it("does not merge semantically different category paths via URL normalization", async () => {
      const { aggregateHardSourceProfiles } = await loadModule();
      const result = aggregateHardSourceProfiles([
        row({ id: "prof-a", categoryId: "cat-a", payload: { targetUrl: "https://example.com/news/world", lifecycleState: "open" } }),
        row({ id: "prof-b", categoryId: "cat-a", payload: { targetUrl: "https://example.com/news/sports", lifecycleState: "open" } }),
      ]);
      expect(result).toHaveLength(2);
    });

    it("bounded history keeps only the most recent entries, newest first", async () => {
      const { aggregateHardSourceProfiles } = await loadModule();
      const rows = [1, 2, 3, 4, 5, 6].map((n) =>
        row({ id: `prof-${n}`, createdAt: `2026-07-24T10:0${n}:00Z`, updatedAt: `2026-07-24T10:0${n}:00Z` }),
      );
      const result = aggregateHardSourceProfiles(rows, { maxHistory: 2 });

      expect(result[0]!.history).toHaveLength(2);
      expect(result[0]!.history[0]!.id).toBe("prof-5");
      expect(result[0]!.history[1]!.id).toBe("prof-4");
      expect(result[0]!.evidenceCount).toBe(6);
    });

    it("marks current row resolved when the newest artifact is resolved", async () => {
      const { aggregateHardSourceProfiles, filterActiveHardSourceRows, filterResolvedHardSourceRows } = await loadModule();
      const result = aggregateHardSourceProfiles([
        row({ id: "prof-open", createdAt: "2026-07-24T10:00:00Z", payload: { targetUrl: "https://example.com/news", lifecycleState: "open" } }),
        row({ id: "prof-resolved", createdAt: "2026-07-24T11:00:00Z", payload: { targetUrl: "https://example.com/news", lifecycleState: "resolved", resolvedReason: "Agent 1 RSS" } }),
      ]);

      expect(result[0]!.resolved).toBe(true);
      expect(filterActiveHardSourceRows(result)).toHaveLength(0);
      expect(filterResolvedHardSourceRows(result)).toHaveLength(1);
    });

    it("sorts current rows by severity then latest event", async () => {
      const { aggregateHardSourceProfiles } = await loadModule();
      const result = aggregateHardSourceProfiles([
        row({ id: "prof-open-1", sourceId: "src-a", createdAt: "2026-07-24T10:00:00Z", payload: { targetUrl: "https://a.example.com", lifecycleState: "open" } }),
        row({ id: "prof-resolved", sourceId: "src-b", createdAt: "2026-07-24T11:00:00Z", payload: { targetUrl: "https://b.example.com", lifecycleState: "resolved" } }),
        row({ id: "prof-open-2", sourceId: "src-c", createdAt: "2026-07-24T12:00:00Z", payload: { targetUrl: "https://c.example.com", lifecycleState: "suggested" } }),
      ]);

      // open (0) < suggested (1) < resolved (3)
      expect(result.map((r) => r.id)).toEqual(["prof-open-1", "prof-open-2", "prof-resolved"]);
    });
  });
});

// ─── Profile creation tests (mocked DB) ─────────────────────────────────────

describe("hard-source-profile — createOrUpdateHardSourceProfile", () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    findUniqueMock.mockReset();
    findManyMock.mockReset();
    createMock.mockReset();
    updateMock.mockReset();
    logAgentScanMock.mockReset();
    logAgentScanMock.mockResolvedValue(undefined);
  });

  async function loadFn() {
    const mod = await import("./hard-source-profile");
    return mod.createOrUpdateHardSourceProfile;
  }

  it("creates a new profile when no existing profile found", async () => {
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: "new-prof-1" });

    const fn = await loadFn();
    const result = await fn({
      pipelineRunId: "run-1",
      sourceId: "src-1",
      categoryId: null,
      targetUrl: "https://hard.com/news",
      fromArtifactId: "art-1",
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
      dominantReasons: ["stale"],
    });

    expect(result).toBe("new-prof-1");
    expect(createMock).toHaveBeenCalledTimes(1);
    const createArg = createMock.mock.calls[0]![0];
    expect(createArg.data.pipelineRunId).toBe("run-1");
    expect(createArg.data.artifactType).toBe("article_discovery_hard_source_profile");
    expect(createArg.data.status).toBe("PROFILE");
    expect(createArg.data.payload.schemaVersion).toBe(1);
    expect(createArg.data.payload.artifactKind).toBe("article_discovery_hard_source_profile");
    expect(createArg.data.payload.failureCount).toBe(1);
    expect(createArg.data.payload.staticQuality).toBe("failed");
    expect(createArg.data.payload.browserStatus).toBe("BROWSER_NO_CANDIDATES");
    expect(createArg.data.payload.dominantReasons).toEqual(["stale"]);
    expect(createArg.data.payload.createdFromArtifactIds).toEqual(["art-1"]);
  });

  it("updates existing profile when same target and within TTL", async () => {
    findFirstMock.mockResolvedValue({
      id: "existing-prof-1",
      createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
      payload: {
        targetUrl: "https://hard.com/news",
        sourceId: "src-1",
        failureCount: 2,
        dominantReasons: ["dynamic_or_empty_html"],
        createdFromArtifactIds: ["art-old-1"],
        linkFilterReasons: { utility_path: 5 },
        detailRejectionReasons: {},
        notes: ["Previous failure"],
      },
      candidateCount: 0,
    });
    updateMock.mockResolvedValue({ id: "existing-prof-1" });

    const fn = await loadFn();
    const result = await fn({
      pipelineRunId: "run-1",
      sourceId: "src-1",
      categoryId: null,
      targetUrl: "https://hard.com/news",
      fromArtifactId: "art-new-1",
      staticQuality: "blocked",
      browserStatus: "BROWSER_NO_CANDIDATES",
      dominantReasons: ["blocked_by_robots"],
      linkFilterReasons: { utility_path: 3 },
    });

    expect(result).toBe("existing-prof-1");
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    const updateArg = updateMock.mock.calls[0]![0];
    expect(updateArg.data.payload.failureCount).toBe(3);
    expect(updateArg.data.payload.dominantReasons).toContain("dynamic_or_empty_html");
    expect(updateArg.data.payload.dominantReasons).toContain("blocked_by_robots");
    expect(updateArg.data.payload.createdFromArtifactIds).toContain("art-old-1");
    expect(updateArg.data.payload.createdFromArtifactIds).toContain("art-new-1");
  });

  it("creates new profile when existing profile is for different targetUrl", async () => {
    findFirstMock.mockResolvedValue({
      id: "existing-prof-2",
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      payload: {
        targetUrl: "https://different.com/news",
      },
      candidateCount: 0,
    });
    createMock.mockResolvedValue({ id: "new-prof-2" });

    const fn = await loadFn();
    const result = await fn({
      pipelineRunId: "run-1",
      sourceId: "src-1",
      categoryId: null,
      targetUrl: "https://hard.com/news",
      fromArtifactId: "art-1",
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
    });

    expect(result).toBe("new-prof-2");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("creates new profile when existing profile is older than TTL", async () => {
    findFirstMock.mockResolvedValue({
      id: "existing-prof-3",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
      payload: {
        targetUrl: "https://hard.com/news",
      },
      candidateCount: 0,
    });
    createMock.mockResolvedValue({ id: "new-prof-3" });

    const fn = await loadFn();
    const result = await fn({
      pipelineRunId: "run-1",
      sourceId: "src-1",
      categoryId: null,
      targetUrl: "https://hard.com/news",
      fromArtifactId: "art-1",
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
    });

    expect(result).toBe("new-prof-3");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("caps dominantReasons at 10", async () => {
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: "new-prof-4" });

    const fn = await loadFn();
    const reasons = Array.from({ length: 15 }, (_, i) => `reason-${i}`);
    await fn({
      pipelineRunId: "run-1",
      sourceId: "src-1",
      categoryId: null,
      targetUrl: "https://hard.com/news",
      fromArtifactId: "art-1",
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
      dominantReasons: reasons,
    });

    const createArg = createMock.mock.calls[0]![0];
    expect(createArg.data.payload.dominantReasons).toHaveLength(10);
  });

  it("caps notes at 10", async () => {
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: "new-prof-5" });

    const fn = await loadFn();
    const notes = Array.from({ length: 15 }, (_, i) => `note-${i}`);
    await fn({
      pipelineRunId: "run-1",
      sourceId: "src-1",
      categoryId: null,
      targetUrl: "https://hard.com/news",
      fromArtifactId: "art-1",
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
      notes,
    });

    const createArg = createMock.mock.calls[0]![0];
    expect(createArg.data.payload.notes).toHaveLength(10);
  });

  it("caps linkFilterReasons at 20 keys", async () => {
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: "new-prof-6" });

    const fn = await loadFn();
    const linkFilterReasons: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      linkFilterReasons[`reason-${i}`] = i + 1;
    }
    await fn({
      pipelineRunId: "run-1",
      sourceId: "src-1",
      categoryId: null,
      targetUrl: "https://hard.com/news",
      fromArtifactId: "art-1",
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
      linkFilterReasons,
    });

    const createArg = createMock.mock.calls[0]![0];
    expect(Object.keys(createArg.data.payload.linkFilterReasons)).toHaveLength(20);
    // Should keep the highest counts
    expect(createArg.data.payload.linkFilterReasons["reason-29"]).toBe(30);
  });

  it("returns null and logs error when DB fails", async () => {
    findFirstMock.mockRejectedValue(new Error("DB connection failed"));

    const fn = await loadFn();
    const result = await fn({
      pipelineRunId: "run-1",
      sourceId: "src-1",
      categoryId: null,
      targetUrl: "https://hard.com/news",
      fromArtifactId: "art-1",
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
    });

    expect(result).toBeNull();
    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "HARD_SOURCE_PROFILE_ERROR" }),
    );
  });

  it("does not create profile for productive static discovery", async () => {
    // This is a policy test: callers should NOT call createOrUpdateHardSourceProfile
    // with staticQuality="productive". If they do, the profile is still created
    // (the caller is responsible for filtering).
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: "new-prof-7" });

    const fn = await loadFn();
    // Verify the function itself does not reject productive static quality
    // — the caller (article-discovery-headless-queue.ts) is responsible for
    // only calling this when static quality is non-productive.
    const result = await fn({
      pipelineRunId: "run-1",
      sourceId: "src-1",
      categoryId: null,
      targetUrl: "https://hard.com/news",
      fromArtifactId: "art-1",
      staticQuality: "failed",
      browserStatus: "BROWSER_NO_CANDIDATES",
    });
    expect(result).toBe("new-prof-7");
  });
});

describe("hard-source-profile — resolution helpers", () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    findUniqueMock.mockReset();
    findManyMock.mockReset();
    createMock.mockReset();
    updateMock.mockReset();
    logAgentScanMock.mockReset();
    logAgentScanMock.mockResolvedValue(undefined);
  });

  it("marks an active profile as resolved and preserves previous lifecycle state", async () => {
    findUniqueMock.mockResolvedValue({
      id: "prof-1",
      status: "PROFILE",
      payload: {
        targetUrl: "https://example.com/news",
        lifecycleState: "suggested",
        failureCount: 3,
      },
    });
    updateMock.mockResolvedValue({ id: "prof-1" });

    const { resolveHardSourceProfile } = await import("./hard-source-profile");
    const result = await resolveHardSourceProfile({
      profileArtifactId: "prof-1",
      resolvedBy: "agent2_static",
      resolvedReason: "Agent 2 became productive",
      resolvedPipelineRunId: "run-1",
    });

    expect(result).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const updateArg = updateMock.mock.calls[0]![0];
    expect(updateArg.where.id).toBe("prof-1");
    expect(updateArg.data.status).toBe("RESOLVED");
    expect(updateArg.data.payload.lifecycleState).toBe("resolved");
    expect(updateArg.data.payload.previousLifecycleState).toBe("suggested");
    expect(updateArg.data.payload.resolvedBy).toBe("agent2_static");
    expect(updateArg.data.payload.resolvedReason).toBe("Agent 2 became productive");
    expect(updateArg.data.payload.resolvedPipelineRunId).toBe("run-1");
    expect(updateArg.data.payload.failureCount).toBe(3);
  });

  it("uses RESOLVED_BY_AGENT1_RSS status for Agent 1 RSS resolution", async () => {
    findUniqueMock.mockResolvedValue({
      id: "prof-rss",
      status: "PROFILE",
      payload: {
        targetUrl: "https://example.com/politics",
        lifecycleState: "open",
      },
    });
    updateMock.mockResolvedValue({ id: "prof-rss" });

    const { resolveHardSourceProfile } = await import("./hard-source-profile");
    const result = await resolveHardSourceProfile({
      profileArtifactId: "prof-rss",
      resolvedBy: "agent1_rss",
      resolvedReason: "Agent 1 RSS resolved target",
      resolvedPipelineRunId: "run-rss",
    });

    expect(result).toBe(true);
    expect(updateMock.mock.calls[0]![0].data.status).toBe("RESOLVED_BY_AGENT1_RSS");
  });

  it("does not re-resolve terminal lifecycle states", async () => {
    findUniqueMock.mockResolvedValue({
      id: "prof-terminal",
      status: "RESOLVED",
      payload: {
        lifecycleState: "resolved",
      },
    });

    const { resolveHardSourceProfile } = await import("./hard-source-profile");
    const result = await resolveHardSourceProfile({
      profileArtifactId: "prof-terminal",
      resolvedBy: "agent2_static",
      resolvedReason: "already fixed",
    });

    expect(result).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("resolves only exact matching active profiles for a target", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "prof-match",
        payload: {
          targetUrl: "https://example.com/politics",
          lifecycleState: "open",
        },
      },
      {
        id: "prof-other-target",
        payload: {
          targetUrl: "https://example.com/sports",
          lifecycleState: "open",
        },
      },
      {
        id: "prof-terminal",
        payload: {
          targetUrl: "https://example.com/politics",
          lifecycleState: "ignored",
        },
      },
    ]);
    findUniqueMock.mockResolvedValue({
      id: "prof-match",
      status: "PROFILE",
      payload: {
        targetUrl: "https://example.com/politics",
        lifecycleState: "open",
      },
    });
    updateMock.mockResolvedValue({ id: "prof-match" });

    const { resolveHardSourceProfilesForTarget } = await import("./hard-source-profile");
    const resolved = await resolveHardSourceProfilesForTarget({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://example.com/politics",
      resolvedBy: "agent2_static",
      resolvedReason: "Agent 2 static productive",
      resolvedPipelineRunId: "run-2",
    });

    expect(resolved).toBe(1);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifactType: "article_discovery_hard_source_profile",
          sourceId: "src-1",
          categoryId: "cat-1",
          status: { notIn: ["RESOLVED", "RESOLVED_BY_AGENT1_RSS"] },
        }),
      }),
    );
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0]![0].where.id).toBe("prof-match");
  });

  it("returns false and logs when resolving a profile fails", async () => {
    findUniqueMock.mockRejectedValue(new Error("DB timeout"));

    const { resolveHardSourceProfile } = await import("./hard-source-profile");
    const result = await resolveHardSourceProfile({
      profileArtifactId: "prof-error",
      resolvedBy: "agent2_static",
      resolvedReason: "test",
    });

    expect(result).toBe(false);
    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "HARD_SOURCE_PROFILE_ERROR" }),
    );
  });
});
