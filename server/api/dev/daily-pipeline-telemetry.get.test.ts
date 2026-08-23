import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRequireAdminId = vi.fn();
const mockAssertRateLimit = vi.fn();

(globalThis as any).defineEventHandler = (fn: any) => fn;
(globalThis as any).getQuery = (event: any) => event?.query ?? {};

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
}));

vi.mock("../../utils/require-admin", () => ({
  requireAdminId: (...args: any[]) => mockRequireAdminId(...args),
}));

vi.mock("../../utils/rate-limit", () => ({
  assertRateLimit: (...args: any[]) => mockAssertRateLimit(...args),
}));

const mockPipelineRunFindFirst = vi.fn();
const mockPipelineArtifactFindMany = vi.fn();

vi.mock("../../utils/prisma", () => ({
  prisma: {
    pipelineRun: {
      findFirst: (...args: any[]) => mockPipelineRunFindFirst(...args),
    },
    pipelineArtifact: {
      findMany: (...args: any[]) => mockPipelineArtifactFindMany(...args),
    },
  },
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/dev/daily-pipeline-telemetry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireAdminId.mockResolvedValue("admin-1");
    mockAssertRateLimit.mockResolvedValue(undefined);
  });

  async function loadHandler() {
    const mod = await import("./daily-pipeline-telemetry.get");
    return mod.default;
  }

  it("requires admin access", async () => {
    mockRequireAdminId.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    );
    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns null run when no workflow run exists", async () => {
    mockPipelineRunFindFirst.mockResolvedValue(null);
    const handler = await loadHandler();
    const result = await handler({} as any);
    expect(result.ok).toBe(true);
    expect(result.run).toBeNull();
    expect(result.stageTimings).toEqual([]);
    expect(result.batches).toEqual([]);
  });

  it("exposes a local Docker pipeline without enabling workflow lock recovery", async () => {
    mockPipelineRunFindFirst.mockResolvedValue({
      id: "local-run-1",
      status: "LOCAL_DOCKER_PIPELINE_COMPLETED",
      createdAt: "2026-08-21T10:00:00Z",
      updatedAt: "2026-08-21T10:05:00Z",
      finishedAt: "2026-08-21T10:05:00Z",
      summary: {
        kind: "local_docker_pipeline",
        outcomes: [{ stage: "agent3", status: "completed" }],
      },
    });
    mockPipelineArtifactFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    const result = await handler({ query: {} } as any);

    expect(result.run).toMatchObject({
      id: "local-run-1",
      status: "LOCAL_DOCKER_PIPELINE_COMPLETED",
      lockHeartbeatAgeMs: null,
      lockRecoveryEligible: false,
    });
  });

  it("returns the run summary, stage timings, and bounded batch telemetry", async () => {
    mockPipelineRunFindFirst.mockResolvedValue({
      id: "run-1",
      status: "DAILY_PIPELINE_WORKFLOW_COMPLETED_PARTIAL",
      createdAt: "2026-08-01T10:00:00Z",
      finishedAt: "2026-08-01T10:46:00Z",
      summary: {
        kind: "daily_news_pipeline_workflow",
        runOutcome: "COMPLETED_PARTIAL",
        completedStages: ["agent1", "agent2-static", "agent2-headless", "agent3"],
        stageOutcomes: [
          {
            stage: "agent1",
            status: "degraded",
            reason: "bounded no progress",
            batchCount: 6,
            elapsedMs: 1234,
            remaining: 2,
            actionableRemaining: 2,
            nextRetryAt: "2026-08-01T12:00:00.000Z",
          },
          {
            stage: "agent3",
            status: "completed",
            reason: null,
            batchCount: 1,
            elapsedMs: 50,
            remaining: 0,
            actionableRemaining: 0,
            nextRetryAt: null,
          },
        ],
        recovery: {
          schemaVersion: 1,
          headlessClaims: {
            scanned: 4,
            recovered: 1,
            conflicted: 1,
            malformed: 2,
            failed: 0,
            timeBudgetExhausted: false,
          },
          domainLeases: {
            mode: "enforce",
            scanned: 3,
            recovered: 2,
            conflicted: 1,
            malformed: 0,
            failed: 0,
            timeBudgetExhausted: false,
          },
          telemetryPersisted: true,
        },
        stageTimings: [
          {
            stage: "agent1",
            batches: 2,
            processed: 10,
            succeeded: 9,
            durationMs: 240000,
            fetchDurationMs: 230000,
            extractionDurationMs: 0,
            browserDurationMs: 0,
            persistenceDurationMs: 10000,
            sleepDurationMs: 0,
            rateLimited403: 0,
            rateLimited429: 1,
            latestNoProgressReason: null,
            timedOut: 0,
            peakConcurrency: 1,
            batchSizeLimit: 5,
            concurrencyLimit: 1,
          },
          {
            stage: "agent3",
            batches: 3,
            processed: 30,
            succeeded: 28,
            durationMs: 1200000,
            fetchDurationMs: 1100000,
            extractionDurationMs: 50000,
            browserDurationMs: 0,
            persistenceDurationMs: 50000,
            sleepDurationMs: 60000,
            rateLimited: 2,
            timedOut: 1,
            latestNoProgressReason: "agent3 stalled",
            peakConcurrency: 1,
          },
        ],
        notificationsDurationMs: 5000,
      },
    });

    mockPipelineArtifactFindMany.mockResolvedValue([
      {
        id: "batch-1",
        createdAt: "2026-08-01T10:00:10Z",
        status: "CAPTURED",
        candidateCount: 5,
        payload: {
          schemaVersion: 1,
          artifactKind: "stage_batch_telemetry",
          orchestrationRunId: "run-1",
          stage: "agent1",
          batchSeq: 1,
          processed: 5,
          succeeded: 5,
          fetchMs: 110000,
          networkRequests: 5,
          batchSizeLimit: 5,
          concurrencyLimit: 1,
          peakConcurrency: 1,
          noProgressReason: null,
        },
        errorLog: null,
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({ query: {} } as any);

    expect(result.ok).toBe(true);
    expect(result.run).not.toBeNull();
    expect(result.run!.id).toBe("run-1");
    expect(result.run!.status).toBe("DAILY_PIPELINE_WORKFLOW_COMPLETED_PARTIAL");
    expect(result.run!.runOutcome).toBe("COMPLETED_PARTIAL");
    expect(result.run!.stageOutcomes).toEqual([
      expect.objectContaining({
        stage: "agent1",
        status: "degraded",
        reason: "bounded no progress",
        batchCount: 6,
        actionableRemaining: 2,
      }),
      expect.objectContaining({ stage: "agent3", status: "completed" }),
    ]);
    expect(result.run!.recovery).toEqual({
      schemaVersion: 1,
      headlessClaims: {
        scanned: 4,
        recovered: 1,
        conflicted: 1,
        malformed: 2,
        failed: 0,
        timeBudgetExhausted: false,
      },
      domainLeases: {
        mode: "enforce",
        scanned: 3,
        recovered: 2,
        conflicted: 1,
        malformed: 0,
        failed: 0,
        timeBudgetExhausted: false,
      },
      telemetryPersisted: true,
    });
    expect(result.stageTimings).toHaveLength(2);
    expect(result.stageTimings[0]).toMatchObject({ stage: "agent1", durationMs: 240000 });
    expect(result.stageTimings[1]).toMatchObject({ stage: "agent3", durationMs: 1200000 });
    expect(result.run!.notificationsDurationMs).toBe(5000);
    expect(result.latestNoProgressReason).toBe("agent3 stalled");
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]).toMatchObject({
      id: "batch-1",
      processed: 5,
      stage: "agent1",
      batchSeq: 1,
      concurrencyLimit: 1,
      batchSizeLimit: 5,
    });
  });

  it("exposes the completion summary with bounded counts", async () => {
    mockPipelineRunFindFirst.mockResolvedValue({
      id: "run-completion",
      status: "DAILY_PIPELINE_WORKFLOW_COMPLETED",
      createdAt: "2026-08-01T10:00:00Z",
      finishedAt: "2026-08-01T10:42:00Z",
      summary: {
        kind: "daily_news_pipeline_workflow",
        completedStages: ["agent1", "agent2-static", "agent2-headless", "agent3"],
        stageTimings: [],
        notificationsDurationMs: 0,
        completion: {
          completionReason: "current_orchestration_drained",
          currentRunDrained: true,
          globallyComplete: false,
          eligibleNextRun: 175,
          retryableNextRun: 71,
          deferred: 71,
          quarantined: 23,
          nonRetryable: 12,
          nextRetryAt: "2026-08-03T04:00:00.000Z",
        },
      },
    });
    mockPipelineArtifactFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    const result = await handler({ query: {} } as any);

    expect(result.run!.completion).toEqual({
      completionReason: "current_orchestration_drained",
      currentRunDrained: true,
      globallyComplete: false,
      eligibleNextRun: 175,
      retryableNextRun: 71,
      deferred: 71,
      quarantined: 23,
      nonRetryable: 12,
      nextRetryAt: "2026-08-03T04:00:00.000Z",
    });
  });

  it("returns null completion for legacy summaries without the new fields", async () => {
    mockPipelineRunFindFirst.mockResolvedValue({
      id: "run-legacy",
      status: "DAILY_PIPELINE_WORKFLOW_COMPLETED",
      createdAt: "2026-07-01T10:00:00Z",
      finishedAt: "2026-07-01T10:40:00Z",
      summary: {
        kind: "daily_news_pipeline_workflow",
        completedStages: ["agent1", "agent2-static", "agent3"],
        stageTimings: [],
        notificationsDurationMs: 0,
      },
    });
    mockPipelineArtifactFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    const result = await handler({ query: {} } as any);

    expect(result.run!.completion).toBeNull();
  });

  it("passes a runId filter through to the query", async () => {
    mockPipelineRunFindFirst.mockResolvedValue({
      id: "run-42",
      status: "DAILY_PIPELINE_WORKFLOW_FAILED",
      createdAt: "2026-08-01T09:00:00Z",
      finishedAt: null,
      summary: {
        kind: "daily_news_pipeline_workflow",
        completedStages: ["agent1"],
        stageTimings: [],
        error: "agent2-static made no progress: Manual diagnosis required.",
        notificationsDurationMs: 0,
      },
    });
    mockPipelineArtifactFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    const result = await handler({ query: { runId: "run-42" } } as any);

    expect(mockPipelineRunFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-42" }),
      }),
    );
    expect(result.run).not.toBeNull();
    expect(result.run!.id).toBe("run-42");
    expect(result.run!.error).toContain("Manual diagnosis required");
    expect(result.batches).toEqual([]);
  });

  it("builds live stage timings from batch artifacts while the workflow is running", async () => {
    mockPipelineRunFindFirst.mockResolvedValue({
      id: "run-live",
      status: "DAILY_PIPELINE_WORKFLOW_RUNNING",
      createdAt: "2026-08-02T12:00:00Z",
      finishedAt: null,
      summary: {
        kind: "daily_news_pipeline_workflow",
        completedStages: ["agent1", "agent2-static"],
        stageTimings: [],
        notificationsDurationMs: 0,
      },
    });
    mockPipelineArtifactFindMany.mockResolvedValue([
      {
        id: "live-agent3-1",
        createdAt: "2026-08-02T13:02:55Z",
        status: "CAPTURED",
        candidateCount: 5,
        payload: {
          schemaVersion: 1,
          artifactKind: "stage_batch_telemetry",
          orchestrationRunId: "run-live",
          stage: "agent3",
          batchSeq: 1,
          durationMs: 17676,
          processed: 5,
          succeeded: 0,
          failedPermanent: 5,
          networkRequests: 5,
          logicalRequestDurationMs: 1855,
          extractionMs: 1,
          persistenceMs: 3124,
          batchSizeLimit: 10,
          concurrencyLimit: 1,
          peakConcurrency: 1,
          complete: true,
        },
        errorLog: null,
      },
    ]);

    const handler = await loadHandler();
    const result = await handler({ query: {} } as any);

    expect(result.stageTimings).toHaveLength(1);
    expect(result.stageTimings[0]).toMatchObject({
      stage: "agent3",
      batches: 1,
      durationMs: 17676,
      processed: 5,
      failedPermanent: 5,
      logicalRequestDurationMs: 1855,
      persistenceDurationMs: 3124,
    });
  });
});
