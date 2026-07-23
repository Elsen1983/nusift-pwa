import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  userSourceSubscription: { findMany: vi.fn() },
  userCategorySubscription: { findMany: vi.fn() },
  sourceCategory: { findMany: vi.fn().mockResolvedValue([]) },
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
}));

vi.mock("./log", () => ({
  logAgentScan: vi.fn().mockResolvedValue(undefined),
}));

const ingestSourceMock = vi.fn();
const persistCandidatesMock = vi.fn();

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

    createPipelineRunMock.mockResolvedValue({ id: "run-1" });
    finalizePipelineRunMock.mockResolvedValue(undefined);
    persistPipelineArtifactMock.mockResolvedValue(undefined);
    persistHardCaseDiscoveryArtifactsMock.mockResolvedValue(0);
    markFeedRunOutcomeMock.mockResolvedValue(undefined);
    runArticleDiscoveryBatchMock.mockResolvedValue(makeA2Result());
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
