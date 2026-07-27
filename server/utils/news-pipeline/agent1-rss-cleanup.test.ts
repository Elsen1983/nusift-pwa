import { describe, it, expect, vi, beforeEach } from "vitest";

const findManyMock = vi.fn();
const updateMock = vi.fn();
const logAgentScanMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findMany: (...args: any[]) => findManyMock(...args),
      update: (...args: any[]) => updateMock(...args),
    },
  },
}));

vi.mock("./log", () => ({
  logAgentScan: (...args: any[]) => logAgentScanMock(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const makeHeadlessMarker = (overrides: Record<string, unknown> = {}) => ({
  id: (overrides.id as string) ?? "art-1",
  status: (overrides.status as string) ?? "PENDING_HEADLESS",
  payload: {
    targetUrl: "https://telex.hu/rovat/eletmod",
    sourceId: "src-1",
    ...(overrides.payload as Record<string, unknown> ?? {}),
  },
});

const makeProfile = (overrides: Record<string, unknown> = {}) => ({
  id: (overrides.id as string) ?? "prof-1",
  status: (overrides.status as string) ?? "PROFILE",
  payload: {
    targetUrl: "https://telex.hu/rovat/eletmod",
    sourceId: "src-1",
    suggestedNextAction: "ai_profile_inspection",
    ...(overrides.payload as Record<string, unknown> ?? {}),
  },
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("resolveHeadlessMarkersByAgent1Rss", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    updateMock.mockReset();
    logAgentScanMock.mockReset();
    logAgentScanMock.mockResolvedValue(undefined);
    updateMock.mockResolvedValue({ id: "updated" });
  });

  async function loadFn() {
    const mod = await import("./agent1-rss-cleanup");
    return mod.resolveHeadlessMarkersByAgent1Rss;
  }

  it("resolves matching headless markers when sourceId, categoryId, and targetUrl match", async () => {
    findManyMock.mockImplementation(async (args: any) => {
      if (args.where.artifactType === "article_discovery_headless_required") {
        return [makeHeadlessMarker({ id: "art-1", status: "PENDING_HEADLESS" })];
      }
      return []; // profiles
    });

    const fn = await loadFn();
    const result = await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    expect(result.resolvedMarkerCount).toBe(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "art-1" },
        data: expect.objectContaining({
          status: "RESOLVED_BY_AGENT1_RSS",
        }),
      }),
    );
  });

  it("does not resolve markers with different categoryId", async () => {
    // findMany is called with categoryId in where, so it only returns matching categoryId.
    // If Prisma returns no results, nothing is resolved.
    findManyMock.mockResolvedValue([]);

    const fn = await loadFn();
    const result = await fn({
      sourceId: "src-1",
      categoryId: "cat-different",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    expect(result.resolvedMarkerCount).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not resolve markers with different targetUrl (payload inspection)", async () => {
    findManyMock.mockResolvedValue([
      makeHeadlessMarker({
        id: "art-1",
        status: "PENDING_HEADLESS",
        payload: { targetUrl: "https://telex.hu/rovat/belfold" },
      }),
    ]);

    const fn = await loadFn();
    const result = await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    expect(result.resolvedMarkerCount).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not resolve source-level artifacts (categoryId is part of DB query filter)", async () => {
    // Source-level artifacts would have categoryId=null. Our query filters by categoryId,
    // so they won't be returned.
    findManyMock.mockResolvedValue([]);

    const fn = await loadFn();
    const result = await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    expect(result.resolvedMarkerCount).toBe(0);
  });

  it("preserves existing payload fields when resolving markers", async () => {
    findManyMock.mockResolvedValue([
      makeHeadlessMarker({
        id: "art-1",
        status: "BROWSER_NO_CANDIDATES",
        payload: {
          targetUrl: "https://telex.hu/rovat/eletmod",
          quality: "weak",
          browserAccepted: 0,
          escalationReasons: ["low_acceptance_rate"],
        },
      }),
    ]);

    const fn = await loadFn();
    await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    const updatePayload = updateMock.mock.calls[0]![0].data.payload;
    // Preserved fields
    expect(updatePayload.quality).toBe("weak");
    expect(updatePayload.browserAccepted).toBe(0);
    expect(updatePayload.escalationReasons).toEqual(["low_acceptance_rate"]);
    expect(updatePayload.targetUrl).toBe("https://telex.hu/rovat/eletmod");
    // Appended resolution metadata
    expect(updatePayload.resolvedBy).toBe("agent1_scoped_rss");
    expect(updatePayload.resolvedAt).toBeTruthy();
    expect(updatePayload.resolvedRssFeedUrl).toBe("https://telex.hu/rss/eletmod");
    expect(updatePayload.resolvedSourceUrl).toBe("https://telex.hu/rovat/eletmod");
    expect(updatePayload.previousStatus).toBe("BROWSER_NO_CANDIDATES");
  });

  it("appends resolution metadata with pipelineRunId when provided", async () => {
    findManyMock.mockResolvedValue([
      makeHeadlessMarker({ id: "art-1" }),
    ]);

    const fn = await loadFn();
    await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
      pipelineRunId: "run-42",
    });

    const updatePayload = updateMock.mock.calls[0]![0].data.payload;
    expect(updatePayload.resolvedPipelineRunId).toBe("run-42");
  });

  it("sets resolvedPipelineRunId to null when not provided", async () => {
    findManyMock.mockResolvedValue([
      makeHeadlessMarker({ id: "art-1" }),
    ]);

    const fn = await loadFn();
    await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    const updatePayload = updateMock.mock.calls[0]![0].data.payload;
    expect(updatePayload.resolvedPipelineRunId).toBeNull();
  });

  it("resolves all resolvable statuses (PENDING_HEADLESS, BROWSER_NO_CANDIDATES, etc.)", async () => {
    const statuses = [
      "PENDING_HEADLESS",
      "BROWSER_NO_CANDIDATES",
      "BROWSER_RUNTIME_UNAVAILABLE",
      "BROWSER_FALLBACK_DISABLED",
      "BROWSER_COOLDOWN_DEFERRED",
      "HEADLESS_PROCESSING",
      "HEADLESS_PROCESSING_STALE",
    ];

    for (const status of statuses) {
      findManyMock.mockImplementation(async (args: any) => {
        if (args.where.artifactType === "article_discovery_headless_required") {
          return [makeHeadlessMarker({ id: `art-${status}`, status })];
        }
        return []; // profiles
      });
      updateMock.mockClear();

      const fn = await loadFn();
      const result = await fn({
        sourceId: "src-1",
        categoryId: "cat-1",
        targetUrl: "https://telex.hu/rovat/eletmod",
        rssFeedUrl: "https://telex.hu/rss/eletmod",
      });

      expect(result.resolvedMarkerCount).toBe(1);
      expect(updateMock).toHaveBeenCalledTimes(1);
    }
  });

  it("resolves matching hard-source profiles", async () => {
    // First call: headless markers, second call: profiles
    findManyMock.mockImplementation(async (args: any) => {
      if (args.where.artifactType === "article_discovery_headless_required") {
        return [makeHeadlessMarker({ id: "art-1" })];
      }
      if (args.where.artifactType === "article_discovery_hard_source_profile") {
        return [makeProfile({ id: "prof-1" })];
      }
      return [];
    });

    const fn = await loadFn();
    const result = await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    expect(result.resolvedMarkerCount).toBe(1);
    expect(result.resolvedProfileCount).toBe(1);
    // Both marker and profile updates
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it("profile resolution preserves existing payload and appends metadata", async () => {
    findManyMock.mockImplementation(async (args: any) => {
      if (args.where.artifactType === "article_discovery_headless_required") {
        return [];
      }
      if (args.where.artifactType === "article_discovery_hard_source_profile") {
        return [makeProfile({
          id: "prof-1",
          status: "PROFILE",
          payload: {
            targetUrl: "https://telex.hu/rovat/eletmod",
            suggestedNextAction: "ai_profile_inspection",
            failureCount: 3,
            dominantReasons: ["out_of_category_scope"],
          },
        })];
      }
      return [];
    });

    const fn = await loadFn();
    const result = await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    expect(result.resolvedProfileCount).toBe(1);
    const profileUpdate = updateMock.mock.calls.find(
      (call: any) => call[0].where.id === "prof-1",
    );
    expect(profileUpdate).toBeTruthy();
    const payload = profileUpdate![0].data.payload;
    expect(payload.status).toBeUndefined(); // status is on the outer data, not payload
    expect(profileUpdate![0].data.status).toBe("RESOLVED_BY_AGENT1_RSS");
    expect(payload.resolvedBy).toBe("agent1_scoped_rss");
    expect(payload.previousSuggestedNextAction).toBe("ai_profile_inspection");
    expect(payload.failureCount).toBe(3);
    expect(payload.dominantReasons).toEqual(["out_of_category_scope"]);
  });

  it("skips profiles already resolved (RESOLVED_BY_AGENT1_RSS)", async () => {
    findManyMock.mockImplementation(async (args: any) => {
      if (args.where.artifactType === "article_discovery_headless_required") {
        return [];
      }
      if (args.where.artifactType === "article_discovery_hard_source_profile") {
        return [makeProfile({
          id: "prof-1",
          status: "RESOLVED_BY_AGENT1_RSS",
        })];
      }
      return [];
    });

    const fn = await loadFn();
    const result = await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    expect(result.resolvedProfileCount).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("cleanup failure is non-fatal and returns zero counts", async () => {
    findManyMock.mockRejectedValue(new Error("DB connection failed"));

    const fn = await loadFn();
    const result = await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    expect(result.resolvedMarkerCount).toBe(0);
    expect(result.resolvedProfileCount).toBe(0);
    // Logs the failure
    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "A1_CATEGORY_HEADLESS_MARKERS_RESOLVE_FAILED",
      }),
    );
  });

  it("individual marker update failure is non-fatal (continues to next marker)", async () => {
    findManyMock.mockImplementation(async (args: any) => {
      if (args.where.artifactType === "article_discovery_headless_required") {
        return [
          makeHeadlessMarker({ id: "art-1", status: "PENDING_HEADLESS" }),
          makeHeadlessMarker({ id: "art-2", status: "BROWSER_NO_CANDIDATES" }),
        ];
      }
      return [];
    });
    updateMock.mockImplementation(async (args: any) => {
      if (args.where.id === "art-1") throw new Error("update failed");
      return { id: args.where.id };
    });

    const fn = await loadFn();
    const result = await fn({
      sourceId: "src-1",
      categoryId: "cat-1",
      targetUrl: "https://telex.hu/rovat/eletmod",
      rssFeedUrl: "https://telex.hu/rss/eletmod",
    });

    // First marker failed, second succeeded
    expect(result.resolvedMarkerCount).toBe(1);
    expect(updateMock).toHaveBeenCalledTimes(2);
  });
});
