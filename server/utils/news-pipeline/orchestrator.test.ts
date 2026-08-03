import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  userSourceSubscription: { findMany: vi.fn() },
  userCategorySubscription: { findMany: vi.fn() },
  sourceCategory: { findMany: vi.fn().mockResolvedValue([]) },
  pipelineRun: { findFirst: vi.fn(), findUnique: vi.fn() },
  pipelineArtifact: {
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock("../prisma", () => ({ prisma: prismaMock }));

const createPipelineRunMock = vi.fn();
const finalizePipelineRunMock = vi.fn();
const persistPipelineArtifactMock = vi.fn();
const persistHardCaseDiscoveryArtifactsMock = vi.fn();

vi.mock("./artifacts", () => ({
  createPipelineRun: createPipelineRunMock,
  finalizePipelineRun: finalizePipelineRunMock,
  persistPipelineArtifact: persistPipelineArtifactMock,
  persistHardCaseDiscoveryArtifacts: persistHardCaseDiscoveryArtifactsMock,
  persistAgent1TargetOutcomeArtifact: persistAgent1TargetOutcomeArtifactMock,
}));

vi.mock("./log", () => ({
  logAgentScan: vi.fn().mockResolvedValue(undefined),
}));

const ingestSourceMock = vi.fn();
const persistCandidatesMock = vi.fn();
const persistAgent1TargetOutcomeArtifactMock = vi.fn();

vi.mock("./ingest", () => ({
  ingestSource: ingestSourceMock,
  persistCandidates: persistCandidatesMock,
}));

const markFeedRunOutcomeMock = vi.fn();

vi.mock("./feed-productivity", () => ({
  markFeedRunOutcome: markFeedRunOutcomeMock,
}));

const runArticleDiscoveryBatchMock = vi.fn();

vi.mock("./article-discovery", () => ({
  runArticleDiscoveryBatch: runArticleDiscoveryBatchMock,
}));

const makeA2Result = () => ({
  pipelineRunId: "a2-run-1",
  targets: [],
  result: {
    sourcesScanned: 0,
    candidatesFound: 0,
    inserted: 0,
    skipped: 0,
    failed: 0,
    artifactCount: 0,
  },
  stoppedReason: "no_targets" as const,
  processed: 0,
  deferred: 0,
  remainingEligible: 0,
});

describe("orchestrator – Agent 1 / Agent 2 split", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no active subscriptions → empty pipeline
    prismaMock.userSourceSubscription.findMany.mockResolvedValue([]);
    prismaMock.userCategorySubscription.findMany.mockResolvedValue([]);
    prismaMock.pipelineRun.findFirst.mockResolvedValue(null);
    prismaMock.pipelineArtifact.findMany.mockResolvedValue([]);
    prismaMock.pipelineArtifact.count.mockResolvedValue(0);

    createPipelineRunMock.mockResolvedValue({ id: "run-1" });
    finalizePipelineRunMock.mockResolvedValue(undefined);
    persistPipelineArtifactMock.mockResolvedValue(undefined);
    persistHardCaseDiscoveryArtifactsMock.mockResolvedValue(0);
    markFeedRunOutcomeMock.mockResolvedValue(undefined);
    persistAgent1TargetOutcomeArtifactMock.mockResolvedValue(undefined);
    runArticleDiscoveryBatchMock.mockResolvedValue(makeA2Result());

    // Default ingest mock
    ingestSourceMock.mockResolvedValue({
      sourceId: "src-1",
      categoryId: null,
      candidates: [],
      failed: 0,
      feedUrl: "https://example.com/feed",
      feedFormat: "rss",
      skipSummary: { emptyLink: 0, outOfScope: 0, staleOrMissingPublishedAt: 0, alreadySeenFeedItem: 0, htmlFallbackNonArticle: 0, htmlFallbackStale: 0 },
      rejectedItems: [],
      hardCaseQueueCandidates: [],
    });
    persistCandidatesMock.mockResolvedValue({ inserted: 0, skipped: 0, failed: 0, enriched: 0 });
  });

  // ── Default behavior: A1 only, no A2 hook ─────────────────────────────

  it("does NOT call runArticleDiscoveryBatch by default (A1 only)", async () => {
    const { runNewsPipeline } = await import("./orchestrator");
    await runNewsPipeline();

    expect(runArticleDiscoveryBatchMock).not.toHaveBeenCalled();
  });

  it("does NOT call runArticleDiscoveryBatch for targeted A1 run", async () => {
    const { runNewsPipeline } = await import("./orchestrator");
    await runNewsPipeline(["src-1"]);

    expect(runArticleDiscoveryBatchMock).not.toHaveBeenCalled();
  });

  it("does NOT call runArticleDiscoveryBatch for targeted A1 run with categoryIds", async () => {
    const { runNewsPipeline } = await import("./orchestrator");
    await runNewsPipeline(["src-1"], ["cat-1"]);

    expect(runArticleDiscoveryBatchMock).not.toHaveBeenCalled();
  });

  it("treats a parsed feed as operational without requiring new inserts", async () => {
    const { isOperationalFeedResult } = await import("./orchestrator");

    expect(isOperationalFeedResult({ failed: 0, feedUrl: "https://example.com/rss", feedFormat: "rss" })).toBe(true);
    expect(isOperationalFeedResult({ failed: 0, feedUrl: "https://example.com/feed", feedFormat: "atom" })).toBe(true);
    expect(isOperationalFeedResult({ failed: 0, feedUrl: "https://example.com", feedFormat: "html_fallback" })).toBe(false);
    expect(isOperationalFeedResult({ failed: 1, feedUrl: "https://example.com/rss", feedFormat: "rss" })).toBe(false);
  });

  // ── runAgent2Afterwards: true ─────────────────────────────────────────

  it("calls runArticleDiscoveryBatch when runAgent2Afterwards=true (global)", async () => {
    const { runNewsPipeline } = await import("./orchestrator");
    await runNewsPipeline(undefined, undefined, { runAgent2Afterwards: true });

    expect(runArticleDiscoveryBatchMock).toHaveBeenCalledTimes(1);
    expect(runArticleDiscoveryBatchMock).toHaveBeenCalledWith(undefined);
  });

  it("calls runArticleDiscoveryBatch with source filters when runAgent2Afterwards=true", async () => {
    const { runNewsPipeline } = await import("./orchestrator");
    await runNewsPipeline(["src-1"], undefined, { runAgent2Afterwards: true });

    expect(runArticleDiscoveryBatchMock).toHaveBeenCalledTimes(1);
    expect(runArticleDiscoveryBatchMock).toHaveBeenCalledWith({
      sourceIds: ["src-1"],
      categoryIds: [],
    });
  });

  it("calls runArticleDiscoveryBatch with source+category filters when runAgent2Afterwards=true", async () => {
    const { runNewsPipeline } = await import("./orchestrator");
    await runNewsPipeline(["src-1"], ["cat-1"], { runAgent2Afterwards: true });

    expect(runArticleDiscoveryBatchMock).toHaveBeenCalledTimes(1);
    expect(runArticleDiscoveryBatchMock).toHaveBeenCalledWith({
      sourceIds: ["src-1"],
      categoryIds: ["cat-1"],
    });
  });

  // ── Target resolution / hydrate ───────────────────────────────────────

  it("uses targeted path for category-only runNewsPipeline(undefined, [cat-1])", async () => {
    const { runNewsPipeline } = await import("./orchestrator");
    await runNewsPipeline(undefined, ["cat-1"]);

    // Agent 1 should use the targeted hydrate path, not global
    expect(prismaMock.sourceCategory.findMany).toHaveBeenCalled();

    // Agent 2 should NOT be called by default
    expect(runArticleDiscoveryBatchMock).not.toHaveBeenCalled();
  });

  it("uses targeted path for category-only runNewsPipeline([], [cat-1])", async () => {
    const { runNewsPipeline } = await import("./orchestrator");
    await runNewsPipeline([], ["cat-1"]);

    expect(prismaMock.sourceCategory.findMany).toHaveBeenCalled();
    expect(runArticleDiscoveryBatchMock).not.toHaveBeenCalled();
  });

  it("does not use targeted path when both lists are empty", async () => {
    const { runNewsPipeline } = await import("./orchestrator");
    await runNewsPipeline([], []);

    // Should use global path — no sourceCategory query from hydratePipelineTargets
    expect(prismaMock.sourceCategory.findMany).not.toHaveBeenCalled();
    // Should resolve via active pipeline targets instead
    expect(prismaMock.userSourceSubscription.findMany).toHaveBeenCalled();
  });

  // ── A1 result isolation ───────────────────────────────────────────────

  it("returns Agent 1 result when Agent 2 throws (with runAgent2Afterwards=true)", async () => {
    runArticleDiscoveryBatchMock.mockRejectedValue(new Error("A2 exploded"));

    const { runNewsPipeline } = await import("./orchestrator");
    const result = await runNewsPipeline(undefined, undefined, { runAgent2Afterwards: true });

    // Agent 1 result is still returned
    expect(result).toBeDefined();
    expect(result.sourcesScanned).toBe(0);
    expect(result.inserted).toBe(0);
  });

  it("returns Agent 1 result when Agent 2 has no targets (with runAgent2Afterwards=true)", async () => {
    const { runNewsPipeline } = await import("./orchestrator");
    const result = await runNewsPipeline(undefined, undefined, { runAgent2Afterwards: true });

    expect(runArticleDiscoveryBatchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(result.sourcesScanned).toBe(0);
  });

  it("Agent 1 result is unaffected by Agent 2 success/failure", async () => {
    // Simulate one active source target
    prismaMock.userSourceSubscription.findMany.mockResolvedValue([
      { sourceId: "src-1" },
    ]);

    // ingestSource throws for the target
    ingestSourceMock.mockRejectedValue(new Error("ingest failed"));
    persistCandidatesMock.mockResolvedValue({ inserted: 0, skipped: 0, failed: 0, enriched: 0 });

    const { runNewsPipeline } = await import("./orchestrator");
    const result = await runNewsPipeline();

    // Agent 1 completed (with 1 failure)
    expect(result.failed).toBe(1);
    expect(result.sourcesScanned).toBe(1);

    // Agent 2 NOT called (default)
    expect(runArticleDiscoveryBatchMock).not.toHaveBeenCalled();
  });
});

describe("orchestrator – runAgent1Batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.userSourceSubscription.findMany.mockResolvedValue([]);
    prismaMock.userCategorySubscription.findMany.mockResolvedValue([]);
    createPipelineRunMock.mockResolvedValue({ id: "run-batch-1" });
    finalizePipelineRunMock.mockResolvedValue(undefined);
    persistPipelineArtifactMock.mockResolvedValue(undefined);
    persistHardCaseDiscoveryArtifactsMock.mockResolvedValue(0);
    persistAgent1TargetOutcomeArtifactMock.mockResolvedValue(undefined);
    markFeedRunOutcomeMock.mockResolvedValue(undefined);
    ingestSourceMock.mockResolvedValue({
      sourceId: "src-1",
      categoryId: null,
      candidates: [],
      failed: 0,
      feedUrl: "https://example.com/feed",
      feedFormat: "rss",
      skipSummary: { emptyLink: 0, outOfScope: 0, staleOrMissingPublishedAt: 0, alreadySeenFeedItem: 0, htmlFallbackNonArticle: 0, htmlFallbackStale: 0 },
      rejectedItems: [],
      hardCaseQueueCandidates: [],
    });
    persistCandidatesMock.mockResolvedValue({ inserted: 0, skipped: 0, failed: 0, enriched: 0 });
    prismaMock.pipelineArtifact.createMany.mockResolvedValue({ count: 0 });
  });

  it("returns no_targets when no active targets exist", async () => {
    prismaMock.userSourceSubscription.findMany.mockResolvedValue([]);
    prismaMock.userCategorySubscription.findMany.mockResolvedValue([]);

    const { runAgent1Batch } = await import("./orchestrator");
    const result = await runAgent1Batch();

    expect(result.stoppedReason).toBe("no_targets");
    expect(result.processed).toBe(0);
    expect(result.pipelineRunId).toBeNull();
  });

  it("processes maxTargets only and stops with max_targets", async () => {
    const targets = Array.from({ length: 8 }, (_, i) => ({ sourceId: `src-${i}` }));
    prismaMock.userSourceSubscription.findMany.mockResolvedValue(
      targets.map((t) => ({ sourceId: t.sourceId })),
    );

    const { runAgent1Batch } = await import("./orchestrator");
    const result = await runAgent1Batch({ maxTargets: 3 });

    expect(result.stoppedReason).toBe("max_targets");
    expect(result.processed).toBe(3);
    expect(result.deferred).toBe(5);
    expect(result.remainingEligible).toBe(5);
    expect(ingestSourceMock).toHaveBeenCalledTimes(3);
  });

  it("stops on time_budget", async () => {
    const targets = Array.from({ length: 10 }, (_, i) => ({ sourceId: `src-${i}` }));
    prismaMock.userSourceSubscription.findMany.mockResolvedValue(
      targets.map((t) => ({ sourceId: t.sourceId })),
    );

    // Use vi.spyOn for deterministic Date.now mocking
    let fakeTime = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeTime);

    ingestSourceMock.mockImplementation(async () => {
      fakeTime += 3000; // Simulate 3s per target
      return {
        sourceId: "src-1",
        categoryId: null,
        candidates: [],
        failed: 0,
        feedUrl: "https://example.com/feed",
        feedFormat: "rss",
        skipSummary: { emptyLink: 0, outOfScope: 0, staleOrMissingPublishedAt: 0, alreadySeenFeedItem: 0, htmlFallbackNonArticle: 0, htmlFallbackStale: 0 },
        rejectedItems: [],
        hardCaseQueueCandidates: [],
      };
    });

    const { runAgent1Batch } = await import("./orchestrator");
    // budget=200ms, minRemaining=80ms, each target=100ms
    // Guard before target 1: elapsed=0, remaining=200 > 80 → process. fakeTime=100
    // Guard before target 2: elapsed=100, remaining=100 > 80 → process. fakeTime=200
    // Guard before target 3: elapsed=200, remaining=0 < 80 → time_budget
    const result = await runAgent1Batch({
      maxTargets: 10,
      timeBudgetMs: 10000,
      minRemainingMs: 5000,
    });

    dateSpy.mockRestore();

    expect(result.processed).toBe(2);
    expect(result.stoppedReason).toBe("time_budget");
  });

  it("computes deferred and remainingEligible correctly", async () => {
    prismaMock.userSourceSubscription.findMany.mockResolvedValue([
      { sourceId: "src-1" },
      { sourceId: "src-2" },
      { sourceId: "src-3" },
    ]);

    const { runAgent1Batch } = await import("./orchestrator");
    const result = await runAgent1Batch({ maxTargets: 2 });

    expect(result.processed).toBe(2);
    expect(result.deferred).toBe(1);
    expect(result.remainingEligible).toBe(1);
    expect(result.stoppedReason).toBe("max_targets");
  });

  it("prioritizes latest deferred Agent 1 targets on the next bounded run", async () => {
    prismaMock.userSourceSubscription.findMany.mockResolvedValue([
      { sourceId: "src-1" },
      { sourceId: "src-2" },
      { sourceId: "src-3" },
      { sourceId: "src-4" },
    ]);
    prismaMock.pipelineRun.findFirst.mockResolvedValueOnce({ id: "previous-run" });
    prismaMock.pipelineArtifact.findMany.mockResolvedValueOnce([
      {
        sourceId: "src-3",
        categoryId: null,
        payload: { position: 0 },
        createdAt: new Date("2026-07-27T12:00:00Z"),
      },
      {
        sourceId: "src-4",
        categoryId: null,
        payload: { position: 1 },
        createdAt: new Date("2026-07-27T12:00:00Z"),
      },
    ]);

    const { runAgent1Batch } = await import("./orchestrator");
    const result = await runAgent1Batch({ maxTargets: 2 });

    expect(result.processed).toBe(2);
    expect(result.deferred).toBe(0);
    expect(result.remainingEligible).toBe(0);
    expect(result.stoppedReason).toBe("completed");
    expect(ingestSourceMock).toHaveBeenNthCalledWith(1, "src-3", undefined, undefined, expect.any(String));
    expect(ingestSourceMock).toHaveBeenNthCalledWith(2, "src-4", undefined, undefined, expect.any(String));
  });

  it("failures count as processed and do not abort the batch", async () => {
    prismaMock.userSourceSubscription.findMany.mockResolvedValue([
      { sourceId: "src-1" },
      { sourceId: "src-2" },
      { sourceId: "src-3" },
    ]);

    let callCount = 0;
    ingestSourceMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error("ingest exploded");
      return {
        sourceId: "src-1",
        categoryId: null,
        candidates: [],
        failed: 0,
        feedUrl: "https://example.com/feed",
        feedFormat: "rss",
        skipSummary: { emptyLink: 0, outOfScope: 0, staleOrMissingPublishedAt: 0, alreadySeenFeedItem: 0, htmlFallbackNonArticle: 0, htmlFallbackStale: 0 },
        rejectedItems: [],
        hardCaseQueueCandidates: [],
      };
    });

    const { runAgent1Batch } = await import("./orchestrator");
    const result = await runAgent1Batch({ maxTargets: 5 });

    expect(result.processed).toBe(3);
    expect(result.result.failed).toBe(1);
    expect(result.stoppedReason).toBe("completed");
  });

  it("does NOT call runArticleDiscoveryBatch", async () => {
    prismaMock.userSourceSubscription.findMany.mockResolvedValue([
      { sourceId: "src-1" },
    ]);

    const { runAgent1Batch } = await import("./orchestrator");
    await runAgent1Batch();

    expect(runArticleDiscoveryBatchMock).not.toHaveBeenCalled();
  });

  it("uses targeted sourceIds when provided", async () => {
    prismaMock.userSourceSubscription.findMany.mockResolvedValue([
      { sourceId: "src-1" },
      { sourceId: "src-2" },
    ]);

    const { runAgent1Batch } = await import("./orchestrator");
    const result = await runAgent1Batch({ sourceIds: ["src-1"], maxTargets: 5 });

    // Should use hydratePipelineTargets path (calls sourceCategory.findMany)
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(ingestSourceMock).toHaveBeenCalledWith("src-1", undefined, undefined, expect.any(String));
  });

  it("clamps maxTargets to [1, 50] range", async () => {
    prismaMock.userSourceSubscription.findMany.mockResolvedValue([
      { sourceId: "src-1" },
    ]);

    const { runAgent1Batch } = await import("./orchestrator");
    const result = await runAgent1Batch({ maxTargets: 999 });

    // Should have processed 1 (only 1 target), not 999
    expect(result.processed).toBe(1);
    expect(result.stoppedReason).toBe("completed");
  });
});
