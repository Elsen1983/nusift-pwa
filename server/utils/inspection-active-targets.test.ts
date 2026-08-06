import { describe, expect, it, vi } from "vitest";
import { loadInspectionLifecycleArtifacts, resolveInspectionActiveTarget, resolveInspectionActiveTargetIds } from "./inspection-active-targets";

const base = (overrides: Record<string, unknown> = {}) => resolveInspectionActiveTarget({
  targetType: "SOURCE", targetId: "s-1", sourceId: "s-1", parentSourceId: null,
  rssStatus: "NO_RSS_FOUND", parentRssStatus: null, currentFeedProductive: false,
  activeSubscriberCount: 0, isSystemImported: false, nextRetryAt: null, lifecycleArtifacts: [],
  ...overrides,
});

const sourceRow = (id: string, activeSubscriberCount = 0) => ({
  id, rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, nextRetryAt: null, isSystemImported: false,
  _count: { subscribers: activeSubscriberCount },
});
const categoryRow = (id: string, sourceId: string, activeSubscriberCount = 0) => ({
  id, newsSourceId: sourceId, rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, nextRetryAt: null,
  _count: { subscribers: activeSubscriberCount },
  newsSource: { rssStatus: "ACTIVE", currentFeedProductive: false, nextRetryAt: null, isSystemImported: false },
});

describe("canonical inspection active-target resolver", () => {
  it.each([
    [{ activeSubscriberCount: 1 }, "ACTIVE_SUBSCRIBER"],
    [{ isSystemImported: true }, "SYSTEM_TARGET"],
    [{ currentFeedProductive: true }, "ACTIVE_RECOVERY"],
    [{ nextRetryAt: new Date(Date.now() + 60_000) }, "DEFERRED_RETRY"],
    [{ lifecycleArtifacts: [{ id: "a", createdAt: new Date(), artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "failed" } }] }, "ACTIVE_RECOVERY"],
  ])("resolves active reason %s", (overrides, reason) => {
    expect(base(overrides as Record<string, unknown>).activeReason).toBe(reason);
    expect(base(overrides as Record<string, unknown>).active).toBe(true);
  });

  it("keeps an unsubscribed non-actionable target inactive", () => {
    expect(base()).toMatchObject({ active: false, activeReason: "NONE", activityState: "INACTIVE" });
  });

  it("terminal source and terminal parent dominate stale evidence", () => {
    const stale = [{ id: "old", createdAt: new Date("2026-01-01"), artifactType: "article_discovery_headless_required", status: "BROWSER_NO_CANDIDATES", payload: {} }];
    expect(base({ rssStatus: "FAILED", lifecycleArtifacts: stale })).toMatchObject({ active: false, activityState: "FAILED" });
    expect(base({ targetType: "CATEGORY", targetId: "c-1", parentSourceId: "s-1", parentRssStatus: "DOMAIN_DEAD", lifecycleArtifacts: stale })).toMatchObject({ active: false, activityState: "DOMAIN_DEAD" });
  });

  it("newer resolved evidence supersedes older retry evidence", () => {
    const result = base({ lifecycleArtifacts: [
      { id: "new", createdAt: new Date("2026-08-02"), artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { lifecycleState: "resolved", quality: "productive" } },
      { id: "old", createdAt: new Date("2026-08-01"), artifactType: "article_discovery_headless_required", status: "BROWSER_NO_CANDIDATES", payload: {} },
    ] });
    expect(["rss_owned", "static_productive", "resolved"]).toContain(result.lifecycleState);
    expect(result.activityState).toBe("ACTIVE_AND_PRODUCTIVE");
  });

  it("does not let 500 categories starve SOURCE resolution", async () => {
    const sourceFindMany = vi.fn().mockResolvedValue([sourceRow("late-source", 1)]);
    const categoryFindMany = vi.fn().mockRejectedValue(new Error("categories must not be queried in SOURCE mode"));
    const result = await resolveInspectionActiveTargetIds({
      newsSource: { findMany: sourceFindMany }, sourceCategory: { findMany: categoryFindMany }, pipelineArtifact: { findMany: vi.fn().mockResolvedValue([]) },
    }, 500, "SOURCE", "source-filter");
    expect(sourceFindMany).toHaveBeenCalledOnce();
    expect(categoryFindMany).not.toHaveBeenCalled();
    expect(result.sourceIds).toEqual(["late-source"]);
    expect(result.categoryIds).toEqual([]);
    expect(result.categoryScanned).toBe(0);
    expect(result.targetType).toBe("SOURCE");
  });

  it("does not let 500 sources starve CATEGORY resolution", async () => {
    const sourceFindMany = vi.fn().mockRejectedValue(new Error("sources must not be queried in CATEGORY mode"));
    const categoryFindMany = vi.fn().mockResolvedValue([categoryRow("late-category", "parent-source", 1)]);
    const result = await resolveInspectionActiveTargetIds({
      newsSource: { findMany: sourceFindMany }, sourceCategory: { findMany: categoryFindMany }, pipelineArtifact: { findMany: vi.fn().mockResolvedValue([]) },
    }, 500, "CATEGORY", "category-filter");
    expect(sourceFindMany).not.toHaveBeenCalled();
    expect(categoryFindMany).toHaveBeenCalledOnce();
    expect(result.categoryIds).toEqual(["late-category"]);
    expect(result.sourceScanned).toBe(0);
  });

  it("reports independent truncation without combined target starvation", async () => {
    const sources = Array.from({ length: 501 }, (_, index) => sourceRow(`s-${index}`, index === 500 ? 1 : 0));
    const categories = Array.from({ length: 501 }, (_, index) => categoryRow(`c-${index}`, `s-${index}`, index === 500 ? 1 : 0));
    const result = await resolveInspectionActiveTargetIds({
      newsSource: { findMany: vi.fn().mockResolvedValue(sources) },
      sourceCategory: { findMany: vi.fn().mockResolvedValue(categories) },
      pipelineArtifact: { findMany: vi.fn().mockResolvedValue([]) },
    }, 500, "ALL", "all-filter");
    expect(result.sourceTruncated).toBe(true);
    expect(result.categoryTruncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.sourceScanned).toBe(500);
    expect(result.categoryScanned).toBe(500);
    expect(result.targets.filter((target) => target.targetType === "SOURCE")).toHaveLength(500);
    expect(result.targets.filter((target) => target.targetType === "CATEGORY")).toHaveLength(500);
  });

  it("bounds lifecycle evidence independently per target (legacy findMany fallback)", async () => {
    const artifactFindMany = vi.fn().mockImplementation(async (args: any) => Array.from({ length: args.take }, (_, index) => ({
      id: `${args.where.sourceId ?? args.where.categoryId}-${index}`,
      createdAt: new Date(2026, 0, 1 + index), artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "failed" },
    })));
    const targets = [
      { ...base({ targetId: "noisy", activeSubscriberCount: 1 }), lifecycleArtifacts: [] },
      { ...base({ targetId: "quiet", activeSubscriberCount: 1 }), lifecycleArtifacts: [] },
    ];
    const evidence = await loadInspectionLifecycleArtifacts({ pipelineArtifact: { findMany: artifactFindMany } }, targets, 3);
    expect(artifactFindMany).toHaveBeenCalledTimes(2);
    expect(evidence.byTarget.get("SOURCE:noisy")).toHaveLength(3);
    expect(evidence.byTarget.get("SOURCE:quiet")).toHaveLength(3);
    expect(evidence.truncatedTargetKeys).toEqual(["SOURCE:noisy", "SOURCE:quiet"]);
  });

  it("loads lifecycle evidence for 1,000 targets in a bounded number of batched queries", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const targets = Array.from({ length: 1_000 }, (_, index) => ({
      ...base({ targetType: "SOURCE" as const, targetId: `s-${index}` }),
      lifecycleArtifacts: [],
    }));
    const evidence = await loadInspectionLifecycleArtifacts({ $queryRaw: queryRaw }, targets, 100);
    // 1,000 source targets are chunked at 500 IDs → exactly 2 round trips.
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(evidence.byTarget.size).toBe(0);
    expect(evidence.truncated).toBe(false);
  });

  it("partitions batched evidence per target so noisy evidence never displaces quiet targets", async () => {
    const rows = [
      ...Array.from({ length: 40 }, (_, index) => ({ id: `noisy-${index}`, createdAt: new Date(2026, 7, 1, 0, index), sourceId: "noisy", categoryId: null, artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "failed" } })),
      ...Array.from({ length: 3 }, (_, index) => ({ id: `quiet-${index}`, createdAt: new Date(2026, 7, 2, 0, index), sourceId: "quiet", categoryId: null, artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "productive" } })),
    ];
    const queryRaw = vi.fn().mockResolvedValue(rows);
    const targets = [
      { ...base({ targetId: "noisy" }), lifecycleArtifacts: [] },
      { ...base({ targetId: "quiet" }), lifecycleArtifacts: [] },
    ];
    const evidence = await loadInspectionLifecycleArtifacts({ $queryRaw: queryRaw }, targets, 5);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(evidence.byTarget.get("SOURCE:noisy")).toHaveLength(5);
    expect(evidence.byTarget.get("SOURCE:quiet")).toHaveLength(3);
    expect(evidence.truncatedTargetKeys).toEqual(["SOURCE:noisy"]);
  });

  it("keeps source-owned and category-owned evidence in separate partitions", async () => {
    const rows = [
      { id: "source-owned", createdAt: new Date("2026-08-01"), sourceId: "s-1", categoryId: null, artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "productive" } },
      { id: "category-owned", createdAt: new Date("2026-08-02"), sourceId: null, categoryId: "c-1", artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "failed" } },
      { id: "ambig-owned", createdAt: new Date("2026-08-03"), sourceId: "s-1", categoryId: "c-1", artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "failed" } },
    ];
    const queryRaw = vi.fn().mockResolvedValue(rows);
    const sourceTarget = { ...base({ targetType: "SOURCE" as const, targetId: "s-1" }), lifecycleArtifacts: [] };
    const categoryTarget = { ...base({ targetType: "CATEGORY" as const, targetId: "c-1", parentSourceId: "s-1", parentRssStatus: "ACTIVE" }), lifecycleArtifacts: [] };
    const evidence = await loadInspectionLifecycleArtifacts({ $queryRaw: queryRaw }, [sourceTarget, categoryTarget], 10);
    expect(evidence.byTarget.get("SOURCE:s-1")?.map((row) => row.id)).toEqual(["source-owned"]);
    expect(evidence.byTarget.get("CATEGORY:c-1")?.map((row) => row.id)).toEqual(["category-owned", "ambig-owned"]);
    expect(evidence.byTarget.get("CATEGORY:c-1")?.some((row) => row.id === "source-owned")).toBe(false);
  });

  it("deduplicates category rows returned by multiple source-chunk queries", async () => {
    // 1,000 source targets plus one parent source exceed the 500-ID chunk
    // size, so chunk-pair queries re-return the same category-owned rows. The
    // loader must dedupe them before applying the per-target bound.
    const targets: any[] = [
      ...Array.from({ length: 1_000 }, (_, index) => ({ ...base({ targetType: "SOURCE" as const, targetId: `s-${index}` }), lifecycleArtifacts: [] })),
      { ...base({ targetType: "CATEGORY" as const, targetId: "c-1", parentSourceId: "s-parent" }), lifecycleArtifacts: [] },
    ];
    const categoryRows = [
      { id: "cat-1", createdAt: new Date("2026-08-02"), sourceId: null, categoryId: "c-1", artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "productive" } },
      { id: "cat-2", createdAt: new Date("2026-08-01"), sourceId: null, categoryId: "c-1", artifactType: "article_discovery_headless_required", status: "BROWSER_NO_CANDIDATES", payload: {} },
    ];
    const queryRaw = vi.fn().mockResolvedValue(categoryRows);
    const evidence = await loadInspectionLifecycleArtifacts({ $queryRaw: queryRaw }, targets, 100);
    // 1001 source IDs → 3 source chunks × 1 category chunk → 3 round trips.
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(evidence.byTarget.get("CATEGORY:c-1")?.map((row) => row.id)).toEqual(["cat-1", "cat-2"]);
    expect(evidence.byTarget.get("CATEGORY:c-1")).toHaveLength(2);
    expect(evidence.truncated).toBe(false);
  });

  it("ranks newest resolved evidence above older retry evidence in batched mode", async () => {
    const rows = [
      { id: "old", createdAt: new Date("2026-08-01"), sourceId: "s-1", categoryId: null, artifactType: "article_discovery_headless_required", status: "BROWSER_NO_CANDIDATES", payload: {} },
      { id: "new", createdAt: new Date("2026-08-02"), sourceId: "s-1", categoryId: null, artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { lifecycleState: "resolved", quality: "productive" } },
    ];
    const queryRaw = vi.fn().mockResolvedValue(rows);
    const target = { ...base({ targetId: "s-1", lifecycleArtifacts: [] }) };
    const evidence = await loadInspectionLifecycleArtifacts({ $queryRaw: queryRaw }, [target], 10);
    const resolved = resolveInspectionActiveTarget({ ...target, lifecycleArtifacts: evidence.byTarget.get("SOURCE:s-1") ?? [] });
    expect(["rss_owned", "static_productive", "resolved"]).toContain(resolved.lifecycleState);
    expect(resolved.activityState).toBe("ACTIVE_AND_PRODUCTIVE");
  });
});

describe("parent lifecycle parity for category targets", () => {
  const category = (overrides: Record<string, unknown> = {}) => resolveInspectionActiveTarget({
    targetType: "CATEGORY", targetId: "c-1", sourceId: "s-1", parentSourceId: "s-1",
    rssStatus: "NO_RSS_FOUND", parentRssStatus: "ACTIVE", currentFeedProductive: false,
    activeSubscriberCount: 1, isSystemImported: false, nextRetryAt: null, lifecycleArtifacts: [],
    ...overrides,
  });

  it("terminal parent overrides an active category subscription", () => {
    expect(category({ parentRssStatus: "FAILED" })).toMatchObject({ active: false, activityState: "FAILED" });
    expect(category({ parentRssStatus: "DOMAIN_DEAD" })).toMatchObject({ active: false, activityState: "DOMAIN_DEAD" });
  });

  it("terminal parent overrides stale category retry evidence", () => {
    const stale = [{ id: "old", createdAt: new Date("2026-01-01"), artifactType: "article_discovery_headless_required", status: "BROWSER_NO_CANDIDATES", payload: {} }];
    expect(category({ parentRssStatus: "DOMAIN_DEAD", lifecycleArtifacts: stale })).toMatchObject({ active: false, activityState: "DOMAIN_DEAD" });
  });

  it("resolved parent supersedes stale parent failure evidence", () => {
    const staleParentFailure = [{ id: "parent-old", createdAt: new Date("2026-08-01"), artifactType: "article_discovery_headless_required", status: "BROWSER_NO_CANDIDATES", payload: {} }];
    const freshParentResolution = [{ id: "parent-new", createdAt: new Date("2026-08-02"), artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { lifecycleState: "resolved", quality: "productive" } }];
    const withOnlyStale = category({ parentLifecycleArtifacts: staleParentFailure });
    expect(withOnlyStale.lifecycleState).toBe("browser_failed_retryable");
    const withFresh = category({ parentLifecycleArtifacts: [...staleParentFailure, ...freshParentResolution] });
    expect(["rss_owned", "static_productive", "resolved"]).toContain(withFresh.lifecycleState);
    expect(withFresh.active).toBe(true);
  });

  it("parent resolved by Agent 1 scoped RSS keeps the category an active target", () => {
    const result = category({ activeSubscriberCount: 0, parentCurrentFeedProductive: true, parentLifecycleArtifacts: [] });
    expect(result.lifecycleState).toBe("rss_owned");
    expect(result.active).toBe(true);
    expect(result.activeReason).toBe("ACTIVE_RECOVERY");
  });

  it("category evidence cannot alter the parent lifecycle", () => {
    // The category's own stale evidence must never change a source target's
    // lifecycle when the same source is resolved from its own evidence only.
    const categoryEvidence = [{ id: "cat-old", createdAt: new Date("2026-08-01"), artifactType: "article_discovery_headless_required", status: "BROWSER_NO_CANDIDATES", payload: {} }];
    const sourceTarget = resolveInspectionActiveTarget({
      targetType: "SOURCE", targetId: "s-1", sourceId: "s-1", parentSourceId: null,
      rssStatus: "ACTIVE", parentRssStatus: null, currentFeedProductive: true,
      activeSubscriberCount: 0, isSystemImported: false, nextRetryAt: null,
      lifecycleArtifacts: [{ id: "parent-resolved", createdAt: new Date("2026-08-02"), artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { lifecycleState: "resolved" } }],
      parentLifecycleArtifacts: categoryEvidence,
    });
    expect(["rss_owned", "static_productive", "resolved"]).toContain(sourceTarget.lifecycleState);
    expect(sourceTarget.lifecycleState).not.toBe("browser_failed_retryable");
  });
});
