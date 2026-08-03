import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  artifactCount: vi.fn(),
  artifactCreate: vi.fn(),
  artifactFindFirst: vi.fn(),
  artifactUpdate: vi.fn(),
  agent1: vi.fn(),
  agent2: vi.fn(),
  headless: vi.fn(),
  browserEnabled: vi.fn(),
  agent3: vi.fn(),
  agent3Progress: vi.fn(),
  completionForRun: vi.fn(),
}));

vi.mock("../utils/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    pipelineRun: { updateMany: mocks.updateMany },
    pipelineArtifact: {
      create: mocks.artifactCreate,
      count: mocks.artifactCount,
      findFirst: mocks.artifactFindFirst,
      update: mocks.artifactUpdate,
    },
  },
}));
vi.mock("../utils/news-pipeline/orchestrator", () => ({
  runAgent1Batch: mocks.agent1,
}));
vi.mock("../utils/news-pipeline/article-discovery", () => ({
  runArticleDiscoveryBatch: mocks.agent2,
}));
vi.mock("../utils/news-pipeline/article-discovery-headless-queue", () => ({
  processArticleDiscoveryHeadlessQueue: mocks.headless,
}));
vi.mock("../utils/news-pipeline/article-discovery-browser", () => ({
  isBrowserFallbackEnabled: mocks.browserEnabled,
}));
vi.mock("../utils/news-pipeline/enrichment-runtime", () => ({
  runEnrichmentBatch: mocks.agent3,
  getAgent3Progress: mocks.agent3Progress,
}));
vi.mock("../utils/news-pipeline/agent3-completion", () => ({
  computeAgent3CompletionSummaryForRun: mocks.completionForRun,
}));
vi.mock("../utils/notification-sender", () => ({
  sendDueDailyNotifications: vi.fn(),
}));

import {
  acquireDailyPipelineLock,
  DAILY_PIPELINE_STAGES,
  decideStageLoopWait,
  runDailyPipelineStageBatch,
} from "./daily-news-pipeline";

describe("daily news pipeline stage batches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.artifactCount.mockResolvedValue(0);
    mocks.artifactCreate.mockResolvedValue({ id: "telemetry-1" });
    mocks.browserEnabled.mockReturnValue(true);
    mocks.completionForRun.mockResolvedValue({
      summary: {
        completionReason: "globally_complete",
        currentRunDrained: true,
        globallyComplete: true,
        eligibleNextRun: 0,
        retryableNextRun: 0,
        deferred: 0,
        quarantined: 0,
        nonRetryable: 0,
        nextRetryAt: null,
      },
      currentRunProgress: null,
    });
    mocks.transaction.mockImplementation((callback) =>
      callback({
        $queryRaw: mocks.queryRaw,
        pipelineRun: {
          findFirst: mocks.findFirst,
          updateMany: mocks.updateMany,
          create: mocks.create,
        },
      }),
    );
  });

  it("casts the PostgreSQL advisory lock result away from void", async () => {
    mocks.queryRaw.mockResolvedValue([{ lock: "" }]);
    mocks.findFirst.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: "orchestration-1" });

    await expect(
      acquireDailyPipelineLock({
        orchestrationId: "workflow-1",
        triggeredAt: "2026-08-01T12:24:00.000Z",
      }),
    ).resolves.toEqual({
      acquired: true,
      orchestrationRunId: "orchestration-1",
    });

    const sql = mocks.queryRaw.mock.calls[0]![0].join(" ");
    expect(sql).toContain("pg_advisory_xact_lock(734821, 120026)::text");
  });

  it("uses the extensible ordered stage registry", () => {
    expect(DAILY_PIPELINE_STAGES).toEqual([
      "agent1",
      "agent2-static",
      "agent2-headless",
      "agent3",
    ]);
  });

  it("uses a short fairness yield after 20 productive batches", () => {
    expect(
      decideStageLoopWait({
        batchesSinceYield: 20,
        stagnantBatches: 0,
        stagnantBackoffs: 0,
      }),
    ).toBe("fairness_yield");
  });

  it("uses one long backoff for genuine stagnation", () => {
    expect(
      decideStageLoopWait({
        batchesSinceYield: 3,
        stagnantBatches: 3,
        stagnantBackoffs: 0,
      }),
    ).toBe("stagnant_backoff");
  });

  it("fails instead of entering repeated long sleep cycles", () => {
    expect(
      decideStageLoopWait({
        batchesSinceYield: 3,
        stagnantBatches: 3,
        stagnantBackoffs: 1,
      }),
    ).toBe("fail");
  });

  it("runs Agent 1 with the production bounded batch contract", async () => {
    mocks.agent1.mockResolvedValue({
      processed: 5,
      selectedTargets: 7,
      remainingEligible: 2,
      deferred: 2,
      result: { failed: 0, inserted: 5, skipped: 0 },
      targetDispositions: {
        succeeded: 5,
        failedRetryable: 0,
        failedPermanent: 0,
        skipped: 0,
        deferred: 2,
        quarantined: 0,
        persistenceFailed: 0,
      },
      productivity: {
        candidateArticlesFound: 5,
        articlesInserted: 5,
        articlesSkipped: 0,
        articlePersistenceFailures: 0,
      },
    });
    const result = await runDailyPipelineStageBatch(
      "orchestration-1",
      "agent1",
      {
        batchSeq: 3,
        remainingBefore: 7,
        sleepMs: 60_000,
      },
    );
    expect(result).toMatchObject({
      processed: 5,
      remaining: 2,
      complete: false,
      telemetry: {
        stage: "agent1",
        batchSeq: 3,
        batchSizeLimit: 5,
        concurrencyLimit: 1,
        remainingBefore: 7,
        remainingAfter: 2,
        sleepMs: 60_000,
        complete: false,
      },
    });
    expect(mocks.agent1).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTargets: 5,
        timeBudgetMs: 240_000,
        minRemainingMs: 30_000,
      }),
    );
    expect(mocks.agent1.mock.calls[0]![0].telemetry).toBeDefined();
    expect(mocks.artifactCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pipelineRunId: "orchestration-1",
          artifactType: "stage_batch_telemetry",
        }),
      }),
    );
  });

  it("keeps a successful stage authoritative when telemetry persistence fails", async () => {
    mocks.agent1.mockResolvedValue({
      processed: 1,
      selectedTargets: 1,
      remainingEligible: 0,
      deferred: 0,
      result: { failed: 0, inserted: 0, skipped: 0 },
      targetDispositions: {
        succeeded: 1,
        failedRetryable: 0,
        failedPermanent: 0,
        skipped: 0,
        deferred: 0,
        quarantined: 0,
        persistenceFailed: 0,
      },
      productivity: {
        candidateArticlesFound: 0,
        articlesInserted: 0,
        articlesSkipped: 0,
        articlePersistenceFailures: 0,
      },
    });
    mocks.artifactCreate.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      runDailyPipelineStageBatch("orchestration-1", "agent1"),
    ).resolves.toMatchObject({
      processed: 1,
      remaining: 0,
      complete: true,
    });

    expect(mocks.agent1).toHaveBeenCalledTimes(1);
    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[daily-pipeline] Stage telemetry persistence failed.",
      { stage: "agent1", batchSeq: 1 },
    );
    consoleError.mockRestore();
  });

  it("preserves the original stage error when telemetry persistence also fails", async () => {
    const stageError = new Error("authoritative stage failure");
    mocks.agent3.mockRejectedValueOnce(stageError);
    mocks.artifactCreate.mockRejectedValueOnce(
      new Error("telemetry database unavailable"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    let thrown: unknown;
    try {
      await runDailyPipelineStageBatch("orchestration-1", "agent3");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(stageError);
    expect(mocks.agent3).toHaveBeenCalledTimes(1);
    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[daily-pipeline] Stage telemetry persistence failed.",
      { stage: "agent3", batchSeq: 1 },
    );
    consoleError.mockRestore();
  });

  it("runs Agent 2 static discovery with the production bounded batch contract", async () => {
    mocks.agent2.mockResolvedValue({
      processed: 4,
      selectedTargets: 4,
      succeeded: 4,
      remainingEligible: 0,
      deferred: 0,
      result: { failed: 0 },
      targetDispositions: {
        succeeded: 4,
        failedRetryable: 0,
        failedPermanent: 0,
        skipped: 0,
        deferred: 0,
        quarantined: 0,
        claimLost: 0,
        persistenceFailed: 0,
      },
      productivity: {
        rawLinks: 2,
        evaluatedCandidates: 4,
        acceptedCandidates: 4,
        rejectedCandidates: 0,
        insertedCandidates: 4,
        skippedCandidates: 0,
        candidatePersistenceFailures: 0,
      },
    });
    const result = await runDailyPipelineStageBatch(
      "orchestration-1",
      "agent2-static",
    );
    expect(result).toMatchObject({
      processed: 4,
      remaining: 0,
      complete: true,
      telemetry: {
        stage: "agent2-static",
        batchSeq: 1,
        batchSizeLimit: 5,
        concurrencyLimit: 1,
        complete: true,
      },
    });
    expect(mocks.agent2).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTargets: 5,
        timeBudgetMs: 240_000,
        minRemainingMs: 30_000,
      }),
    );
    expect(mocks.agent2.mock.calls[0]![0].telemetry).toBeDefined();
  });

  it("runs the real Agent 2 browser queue in write mode", async () => {
    mocks.headless.mockResolvedValue({
      dryRun: false,
      processed: 3,
      claimed: 3,
      browserAttemptedTargets: 3,
      remainingEligible: 1,
      selectedQueueItems: 3,
      targetDispositions: {
        succeeded: 2,
        failedRetryable: 0,
        failedPermanent: 0,
        skipped: 0,
        deferred: 1,
        quarantined: 0,
        claimLost: 0,
        persistenceFailed: 0,
      },
      productivity: {
        rawLinks: 4,
        evaluatedCandidates: 3,
        acceptedCandidates: 2,
        rejectedCandidates: 1,
        insertedCandidates: 2,
        skippedCandidates: 0,
        candidatePersistenceFailures: 0,
      },
    });
    const result = await runDailyPipelineStageBatch(
      "orchestration-1",
      "agent2-headless",
    );
    expect(result).toMatchObject({
      processed: 3,
      complete: false,
      telemetry: {
        stage: "agent2-headless",
        batchSeq: 1,
        batchSizeLimit: 3,
        concurrencyLimit: 1,
        complete: false,
      },
    });
    expect(mocks.headless).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, dryRun: false, runBrowser: true }),
    );
    expect(mocks.headless.mock.calls[0]![0].telemetry).toBeDefined();
  });

  it("runs Agent 3 without browser fallback, reprocessing, or a daily article cap", async () => {
    mocks.agent3.mockResolvedValue({
      articleCount: 10,
      persist: {
        failed: 0,
        claimLost: 0,
        byKind: {
          SUCCESS: 8,
          RETRYABLE_FAILURE: 2,
          SKIPPED: 0,
          HEADLESS_REQUIRED: 0,
          PAYWALL_BLOCKED: 0,
          CANONICAL_MISMATCH: 0,
          LOW_CONTENT_QUALITY: 0,
          UNSUPPORTED_STRUCTURE: 0,
          HTTP_ACCESS_BLOCKED: 0,
        },
      },
    });
    mocks.agent3Progress.mockResolvedValue({
      retryableNow: 7,
      deferred: 3,
      quarantined: 1,
    });
    const result = await runDailyPipelineStageBatch(
      "orchestration-1",
      "agent3",
    );
    expect(result).toMatchObject({
      processed: 10,
      remaining: 7,
      complete: false,
      telemetry: {
        stage: "agent3",
        batchSeq: 1,
        batchSizeLimit: 10,
        concurrencyLimit: 1,
        succeeded: 8,
        failedRetryable: 2,
        deferred: 0,
        quarantined: 0,
        remainingAfter: 7,
        complete: false,
      },
    });
    expect(mocks.agent3).toHaveBeenCalledWith(
      expect.objectContaining({
        maxArticles: 10,
        includeEnriched: false,
        forceReprocess: false,
        browserFallback: false,
        pipelineRunId: "orchestration-1",
      }),
    );
    expect(mocks.agent3.mock.calls[0]![0].telemetry).toBeDefined();
  });

  it("reconciles Agent 3 outcome buckets without double counting", async () => {
    mocks.agent3.mockResolvedValue({
      articleCount: 7,
      persist: {
        failed: 1,
        claimLost: 1,
        byKind: {
          SUCCESS: 2,
          RETRYABLE_FAILURE: 1,
          HEADLESS_REQUIRED: 1,
          PAYWALL_BLOCKED: 1,
        },
      },
    });
    mocks.agent3Progress.mockResolvedValue({
      retryableNow: 0,
      deferred: 0,
      quarantined: 0,
    });

    const result = await runDailyPipelineStageBatch(
      "orchestration-1",
      "agent3",
    );
    const telemetry = result.telemetry!;
    const groupedTotal =
      telemetry.succeeded +
      telemetry.failedRetryable +
      telemetry.failedPermanent +
      telemetry.skipped +
      telemetry.deferred +
      telemetry.quarantined;

    expect(telemetry).toMatchObject({
      processed: 7,
      succeeded: 2,
      failedRetryable: 1,
      failedPermanent: 1,
      skipped: 0,
      deferred: 1,
      quarantined: 0,
      claimLost: 1,
      persistenceFailed: 1,
    });
    expect(
      groupedTotal + telemetry.claimLost! + telemetry.persistenceFailed!,
    ).toBe(telemetry.processed);
  });

  it("completes Agent 3 when only deferred work remains", async () => {
    mocks.agent3.mockResolvedValue({
      articleCount: 0,
      persist: {
        failed: 0,
        claimLost: 0,
        byKind: {
          SUCCESS: 0,
          RETRYABLE_FAILURE: 0,
          SKIPPED: 0,
          HEADLESS_REQUIRED: 0,
          PAYWALL_BLOCKED: 0,
          CANONICAL_MISMATCH: 0,
          LOW_CONTENT_QUALITY: 0,
          UNSUPPORTED_STRUCTURE: 0,
          HTTP_ACCESS_BLOCKED: 0,
        },
      },
    });
    mocks.agent3Progress.mockResolvedValue({
      readyNew: 0,
      readyRetry: 0,
      retryableNow: 0,
      deferred: 12,
      quarantined: 3,
      nextRetryAt: "2026-08-02T10:00:00.000Z",
    });

    await expect(
      runDailyPipelineStageBatch("orchestration-1", "agent3"),
    ).resolves.toMatchObject({
      remaining: 0,
      deferred: 12,
      quarantined: 3,
      complete: true,
      telemetry: {
        deferred: 0,
        quarantined: 0,
        remainingAfter: 0,
        complete: true,
      },
    });
  });

  it("computes the completion summary with future-run counts (no same-run exclusion)", async () => {
    mocks.completionForRun.mockResolvedValue({
      summary: {
        completionReason: "current_orchestration_drained",
        currentRunDrained: true,
        globallyComplete: false,
        eligibleNextRun: 192,
        retryableNextRun: 175,
        deferred: 71,
        quarantined: 23,
        nonRetryable: 12,
        nextRetryAt: "2026-08-03T04:00:00.000Z",
      },
      currentRunProgress: null,
    });

    // The step is exported for direct testing; it must request the future-run
    // progress query WITHOUT the current orchestration id.
    const { finalizeAgent3CompletionStep } = await import("./daily-news-pipeline");
    const summary = await finalizeAgent3CompletionStep("orchestration-1");

    expect(summary).toMatchObject({
      completionReason: "current_orchestration_drained",
      currentRunDrained: true,
      globallyComplete: false,
      eligibleNextRun: 192,
      retryableNextRun: 175,
    });
    const call = mocks.completionForRun.mock.calls[0]!;
    expect(call[1].currentRunOptions.pipelineRunId).toBe("orchestration-1");
    expect(call[1].futureRunOptions.pipelineRunId).toBeUndefined();
  });
});
