import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockProcessArtifactCleanup = vi.fn();
const mockProcessArticleCleanup = vi.fn();
const mockLogAgentScan = vi.fn();

vi.mock("./pipeline-artifact-cleanup", () => ({
  processPipelineArtifactCleanup: (...args: any[]) => mockProcessArtifactCleanup(...args),
}));

vi.mock("./article-retention-cleanup", () => ({
  processOldArticleRetentionCleanup: (...args: any[]) => mockProcessArticleCleanup(...args),
}));

vi.mock("./log", () => ({
  logAgentScan: (...args: any[]) => mockLogAgentScan(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-27T12:00:00Z");

function makeArtifactResult(overrides: Record<string, any> = {}) {
  return {
    ok: true,
    dryRun: false,
    olderThanDays: 14,
    cutoff: "2026-07-13T12:00:00.000Z",
    inspected: 5,
    eligibleForDeletion: 2,
    deleted: 2,
    protected: 1,
    skipped: 1,
    limit: 1000,
    durationMs: 10,
    byArtifactType: { rss_candidates: 3, hard_case_discovery_candidate: 2 },
    byStatus: { CAPTURED: 3, FAILED_FINAL: 2 },
    protectedReasons: { active_inflight_status: 1 },
    skippedReasons: { protected: 1 },
    sampleDeletedOrWouldDelete: [],
    ...overrides,
  };
}

function makeArticleResult(overrides: Record<string, any> = {}) {
  return {
    ok: true,
    dryRun: false,
    olderThanDays: 7,
    cutoff: "2026-07-20T12:00:00.000Z",
    inspected: 3,
    eligibleForDeletion: 2,
    deleted: 2,
    protected: 1,
    skipped: 1,
    limit: 500,
    durationMs: 8,
    bySource: [{ sourceId: "src-1", count: 2 }],
    protectedReasons: { bookmark: 1 },
    skippedReasons: { protected: 1 },
    sampleDeletedOrWouldDelete: [],
    ...overrides,
  };
}

async function loadFn() {
  const mod = await import("./maintenance-cleanup-runner");
  return mod.runMaintenanceCleanup;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runMaintenanceCleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLogAgentScan.mockResolvedValue(undefined);
  });

  it("runs pipeline artifact cleanup first, then article cleanup", async () => {
    const callOrder: string[] = [];
    mockProcessArtifactCleanup.mockImplementation(async () => {
      callOrder.push("artifacts");
      return makeArtifactResult({ eligibleForDeletion: 0 });
    });
    mockProcessArticleCleanup.mockImplementation(async () => {
      callOrder.push("articles");
      return makeArticleResult({ eligibleForDeletion: 0 });
    });

    const fn = await loadFn();
    await fn({ now: NOW });

    expect(callOrder).toEqual(["artifacts", "articles"]);
  });

  it("aggregates multiple pipeline artifact batches", async () => {
    let artifactCallCount = 0;
    mockProcessArtifactCleanup.mockImplementation(async () => {
      artifactCallCount++;
      if (artifactCallCount <= 2) {
        return makeArtifactResult({ eligibleForDeletion: 3, deleted: 3 });
      }
      return makeArtifactResult({ eligibleForDeletion: 0, deleted: 0 });
    });
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    const result = await fn({ now: NOW });

    expect(result.pipelineArtifacts.batches).toBe(3);
    expect(result.pipelineArtifacts.deleted).toBe(6);
    expect(result.pipelineArtifacts.inspected).toBe(15);
  });

  it("aggregates multiple article batches", async () => {
    mockProcessArtifactCleanup.mockResolvedValue(
      makeArtifactResult({ eligibleForDeletion: 0 }),
    );

    let articleCallCount = 0;
    mockProcessArticleCleanup.mockImplementation(async () => {
      articleCallCount++;
      if (articleCallCount <= 2) {
        return makeArticleResult({ eligibleForDeletion: 2, deleted: 2 });
      }
      return makeArticleResult({ eligibleForDeletion: 0, deleted: 0 });
    });

    const fn = await loadFn();
    const result = await fn({ now: NOW });

    expect(result.articles.batches).toBe(3);
    expect(result.articles.deleted).toBe(4);
    expect(result.articles.inspected).toBe(9);
  });

  it("stops pipeline artifact loop when eligibleForDeletion === 0", async () => {
    mockProcessArtifactCleanup.mockResolvedValue(
      makeArtifactResult({ eligibleForDeletion: 0 }),
    );
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    const result = await fn({ now: NOW });

    expect(result.pipelineArtifacts.batches).toBe(1);
    expect(result.pipelineArtifacts.stoppedReason).toBe("complete");
  });

  it("stops loop when deleted === 0 but eligibleForDeletion > 0, with no_progress", async () => {
    mockProcessArtifactCleanup.mockResolvedValue(
      makeArtifactResult({ eligibleForDeletion: 5, deleted: 0 }),
    );
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    const result = await fn({ now: NOW });

    expect(result.pipelineArtifacts.batches).toBe(1);
    expect(result.pipelineArtifacts.stoppedReason).toBe("no_progress");
    expect(result.stoppedReason).toBe("no_progress");
  });

  it("stops when time budget remaining <= minRemainingMs", async () => {
    // Simulate a batch that consumes time by using a real delay
    let callCount = 0;
    mockProcessArtifactCleanup.mockImplementation(async () => {
      callCount++;
      // Simulate 30ms of work per batch
      await new Promise((r) => setTimeout(r, 30));
      return makeArtifactResult({ eligibleForDeletion: 10, deleted: 10 });
    });
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    // timeBudgetMs=100, minRemainingMs=50 → should stop after 1-2 batches
    const result = await fn({
      now: NOW,
      timeBudgetMs: 100,
      minRemainingMs: 50,
    });

    // Should have run at least one batch and stopped due to time budget
    expect(result.pipelineArtifacts.batches).toBeGreaterThanOrEqual(1);
    expect(result.stoppedReason).toBe("time_budget");
  });

  it("can disable articles with runArticles=false", async () => {
    mockProcessArtifactCleanup.mockResolvedValue(
      makeArtifactResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    const result = await fn({ now: NOW, runArticles: false });

    expect(result.articles.enabled).toBe(false);
    expect(result.articles.batches).toBe(0);
    expect(result.articles.stoppedReason).toBe("disabled");
    expect(mockProcessArticleCleanup).not.toHaveBeenCalled();
  });

  it("can disable pipeline artifacts with runPipelineArtifacts=false", async () => {
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    const result = await fn({ now: NOW, runPipelineArtifacts: false });

    expect(result.pipelineArtifacts.enabled).toBe(false);
    expect(result.pipelineArtifacts.batches).toBe(0);
    expect(result.pipelineArtifacts.stoppedReason).toBe("disabled");
    expect(mockProcessArtifactCleanup).not.toHaveBeenCalled();
  });

  it("merges byStatus and byArtifactType counts across batches", async () => {
    let callCount = 0;
    mockProcessArtifactCleanup.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeArtifactResult({
          eligibleForDeletion: 2,
          deleted: 2,
          byStatus: { CAPTURED: 3, FAILED: 1 },
          byArtifactType: { rss_candidates: 4 },
        });
      }
      return makeArtifactResult({
        eligibleForDeletion: 0,
        byStatus: { CAPTURED: 2, FAILED_FINAL: 1 },
        byArtifactType: { rss_candidates: 1, hard_case_discovery_candidate: 2 },
      });
    });
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    const result = await fn({ now: NOW });

    expect(result.pipelineArtifacts.byStatus).toEqual({
      CAPTURED: 5,
      FAILED: 1,
      FAILED_FINAL: 1,
    });
    expect(result.pipelineArtifacts.byArtifactType).toEqual({
      rss_candidates: 5,
      hard_case_discovery_candidate: 2,
    });
  });

  it("merges protectedReasons and skippedReasons across batches", async () => {
    let callCount = 0;
    mockProcessArtifactCleanup.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeArtifactResult({
          eligibleForDeletion: 2,
          deleted: 2,
          protectedReasons: { active_inflight_status: 1 },
          skippedReasons: { protected: 1 },
        });
      }
      return makeArtifactResult({
        eligibleForDeletion: 0,
        protectedReasons: { hard_source_profile_unresolved: 2 },
        skippedReasons: { protected: 2, unhandled_status_conservative_skip: 1 },
      });
    });
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    const result = await fn({ now: NOW });

    expect(result.pipelineArtifacts.protectedReasons).toEqual({
      active_inflight_status: 1,
      hard_source_profile_unresolved: 2,
    });
    expect(result.pipelineArtifacts.skippedReasons).toEqual({
      protected: 3,
      unhandled_status_conservative_skip: 1,
    });
  });

  it("aggregates article bySource and returns top 10", async () => {
    mockProcessArtifactCleanup.mockResolvedValue(
      makeArtifactResult({ eligibleForDeletion: 0 }),
    );

    let callCount = 0;
    mockProcessArticleCleanup.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeArticleResult({
          eligibleForDeletion: 2,
          deleted: 2,
          bySource: [
            { sourceId: "src-1", count: 5 },
            { sourceId: "src-2", count: 3 },
          ],
        });
      }
      return makeArticleResult({
        eligibleForDeletion: 0,
        bySource: [
          { sourceId: "src-1", count: 2 },
          { sourceId: "src-3", count: 4 },
        ],
      });
    });

    const fn = await loadFn();
    const result = await fn({ now: NOW });

    expect(result.articles.bySource).toEqual([
      { sourceId: "src-1", count: 7 },
      { sourceId: "src-3", count: 4 },
      { sourceId: "src-2", count: 3 },
    ]);
  });

  it("handles utility error by recording errors, stoppedReason=error, and fail-fast (skips articles)", async () => {
    mockProcessArtifactCleanup.mockRejectedValue(new Error("DB connection lost"));
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    const result = await fn({ now: NOW });

    expect(result.stoppedReason).toBe("error");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      phase: "pipelineArtifacts",
      message: "DB connection lost",
    });
    expect(result.pipelineArtifacts.stoppedReason).toBe("error");
    // Fail-fast: articles phase is skipped when artifact phase errors
    expect(mockProcessArticleCleanup).not.toHaveBeenCalled();
    expect(result.articles.batches).toBe(0);
    expect(result.articles.stoppedReason).toBe("skipped_after_error");
  });

  it("logs MAINTENANCE_CLEANUP_STARTED and MAINTENANCE_CLEANUP_FINISHED", async () => {
    mockProcessArtifactCleanup.mockResolvedValue(
      makeArtifactResult({ eligibleForDeletion: 0 }),
    );
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    await fn({ now: NOW });

    expect(mockLogAgentScan).toHaveBeenCalledWith(
      expect.objectContaining({ status: "MAINTENANCE_CLEANUP_STARTED" }),
    );
    expect(mockLogAgentScan).toHaveBeenCalledWith(
      expect.objectContaining({ status: "MAINTENANCE_CLEANUP_FINISHED" }),
    );
  });

  it("logs MAINTENANCE_CLEANUP_FAILED when errors occur", async () => {
    mockProcessArtifactCleanup.mockRejectedValue(new Error("boom"));
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    await fn({ now: NOW });

    expect(mockLogAgentScan).toHaveBeenCalledWith(
      expect.objectContaining({ status: "MAINTENANCE_CLEANUP_FAILED" }),
    );
  });

  it("passes correct params to processPipelineArtifactCleanup", async () => {
    mockProcessArtifactCleanup.mockResolvedValue(
      makeArtifactResult({ eligibleForDeletion: 0 }),
    );
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    await fn({
      now: NOW,
      artifactOlderThanDays: 21,
      artifactBatchLimit: 800,
    });

    expect(mockProcessArtifactCleanup).toHaveBeenCalledWith({
      dryRun: false,
      olderThanDays: 21,
      limit: 800,
      now: NOW,
    });
  });

  it("passes correct params to processOldArticleRetentionCleanup", async () => {
    mockProcessArtifactCleanup.mockResolvedValue(
      makeArtifactResult({ eligibleForDeletion: 0 }),
    );
    mockProcessArticleCleanup.mockResolvedValue(
      makeArticleResult({ eligibleForDeletion: 0 }),
    );

    const fn = await loadFn();
    await fn({
      now: NOW,
      articleOlderThanDays: 10,
      articleBatchLimit: 300,
    });

    expect(mockProcessArticleCleanup).toHaveBeenCalledWith({
      dryRun: false,
      olderThanDays: 10,
      limit: 300,
      now: NOW,
    });
  });
});
