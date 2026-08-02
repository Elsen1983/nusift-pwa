import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      create: mocks.create,
      findFirst: mocks.findFirst,
      update: mocks.update,
    },
  },
}));

import {
  attachStageBatchNoProgressReason,
  persistStageBatchTelemetry,
} from "./stage-telemetry-server";
import type { StageBatchTelemetry } from "./stage-telemetry";

const makeTelemetry = (
  stage: StageBatchTelemetry["stage"],
  batchSeq: number,
): StageBatchTelemetry => ({
  schemaVersion: 1,
  artifactKind: "stage_batch_telemetry",
  orchestrationRunId: "run-1",
  stage,
  batchSeq,
  startedAt: "2026-08-01T10:00:00.000Z",
  finishedAt: "2026-08-01T10:00:01.000Z",
  durationMs: 1000,
  processed: 1,
  succeeded: 1,
  failedRetryable: 0,
  failedPermanent: 0,
  skipped: 0,
  deferred: 0,
  quarantined: 0,
  claimLost: 0,
  persistenceFailed: 0,
  remainingBefore: 1,
  remainingAfter: 0,
  networkRequests: 1,
  browserAttempts: 0,
  dbPersistenceOps: 1,
  fetchMs: 100,
  extractionMs: 0,
  browserMs: 0,
  persistenceMs: 100,
  sleepMs: 0,
  batchSizeLimit: 5,
  concurrencyLimit: 1,
  peakConcurrency: 1,
  hostCooldownActivations: 0,
  accessDenied403: 0,
  rateLimited403: 0,
  rateLimited429: 0,
  timedOut: 0,
  noProgressReason: null,
  complete: true,
});

describe("stage telemetry server persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ id: "artifact-1" });
  });

  it("persists telemetry with its stage and batch identity", async () => {
    await persistStageBatchTelemetry({
      pipelineRunId: "run-1",
      telemetry: makeTelemetry("agent3", 2),
    });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pipelineRunId: "run-1",
          artifactType: "stage_batch_telemetry",
          payload: expect.objectContaining({ stage: "agent3", batchSeq: 2 }),
        }),
      }),
    );
  });

  it("updates only the requested stage when Agent 1 and Agent 3 share batch 2", async () => {
    const artifacts = [
      {
        id: "agent1-batch-2",
        payload: {
          schemaVersion: 1,
          artifactKind: "stage_batch_telemetry",
          orchestrationRunId: "run-1",
          stage: "agent1",
          batchSeq: 2,
          noProgressReason: null,
        },
      },
      {
        id: "agent3-batch-2",
        payload: {
          schemaVersion: 1,
          artifactKind: "stage_batch_telemetry",
          orchestrationRunId: "run-1",
          stage: "agent3",
          batchSeq: 2,
          noProgressReason: null,
        },
      },
    ];
    mocks.findFirst.mockImplementation(async (args: any) => {
      const stage = args.where.AND[0].payload.equals;
      const batchSeq = args.where.AND[1].payload.equals;
      return (
        artifacts.find(
          (artifact) =>
            artifact.payload.stage === stage &&
            artifact.payload.batchSeq === batchSeq,
        ) ?? null
      );
    });

    await attachStageBatchNoProgressReason({
      pipelineRunId: "run-1",
      stage: "agent3",
      batchSeq: 2,
      reason: "agent3 stalled",
    });

    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          pipelineRunId: "run-1",
          artifactType: "stage_batch_telemetry",
          AND: [
            { payload: { path: ["stage"], equals: "agent3" } },
            { payload: { path: ["batchSeq"], equals: 2 } },
          ],
        }),
      }),
    );
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "agent3-batch-2" },
        data: expect.objectContaining({
          status: "NO_PROGRESS",
          payload: expect.objectContaining({
            noProgressReason: "agent3 stalled",
          }),
        }),
      }),
    );
  });

  it("reports persistence failures to the workflow observation boundary", async () => {
    mocks.create.mockRejectedValue(new Error("telemetry database unavailable"));

    await expect(
      persistStageBatchTelemetry({
        pipelineRunId: "run-1",
        telemetry: makeTelemetry("agent1", 1),
      }),
    ).rejects.toThrow("telemetry database unavailable");
  });
});
