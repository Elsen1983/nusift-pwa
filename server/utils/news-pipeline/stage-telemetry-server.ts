import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import {
  boundText,
  type StageBatchTelemetry,
  type TelemetryStage,
} from "./stage-telemetry";

const MAX_ERROR_LENGTH = 500;

const serializeTelemetry = (
  telemetry: StageBatchTelemetry,
): Prisma.InputJsonObject => ({
  schemaVersion: telemetry.schemaVersion,
  artifactKind: telemetry.artifactKind,
  orchestrationRunId: telemetry.orchestrationRunId,
  stage: telemetry.stage,
  batchSeq: telemetry.batchSeq,
  startedAt: telemetry.startedAt,
  finishedAt: telemetry.finishedAt,
  durationMs: telemetry.durationMs,
  processed: telemetry.processed,
  succeeded: telemetry.succeeded,
  failedRetryable: telemetry.failedRetryable,
  failedPermanent: telemetry.failedPermanent,
  skipped: telemetry.skipped,
  deferred: telemetry.deferred,
  quarantined: telemetry.quarantined,
  claimLost: telemetry.claimLost ?? 0,
  persistenceFailed: telemetry.persistenceFailed ?? 0,
  remainingBefore: telemetry.remainingBefore,
  remainingAfter: telemetry.remainingAfter,
  networkRequests: telemetry.networkRequests,
  browserAttempts: telemetry.browserAttempts,
  dbPersistenceOps: telemetry.dbPersistenceOps,
  logicalRequestDurationMs: telemetry.logicalRequestDurationMs,
  securityValidationMs: telemetry.securityValidationMs,
  productivity: telemetry.productivity,
  batchExecutionErrors: telemetry.batchExecutionErrors,
  batchErrorClassification: telemetry.batchErrorClassification,
  batchErrorReason: telemetry.batchErrorReason,
  extractionMs: telemetry.extractionMs,
  browserMs: telemetry.browserMs,
  persistenceMs: telemetry.persistenceMs,
  sleepMs: telemetry.sleepMs,
  batchSizeLimit: telemetry.batchSizeLimit,
  concurrencyLimit: telemetry.concurrencyLimit,
  peakConcurrency: telemetry.peakConcurrency,
  hostCooldownActivations: telemetry.hostCooldownActivations,
  accessDenied403: telemetry.accessDenied403,
  rateLimited403: telemetry.rateLimited403,
  rateLimited429: telemetry.rateLimited429,
  timedOut: telemetry.timedOut,
  noProgressReason: telemetry.noProgressReason,
  complete: telemetry.complete,
});

/**
 * Persist one telemetry artifact. Operation counters (network/browser/timing)
 * are observation-driven; disposition fields are durable outcome counts supplied
 * by the orchestration boundary and must already exclude claim-lost and failed
 * persistence outcomes. The workflow boundary owns best-effort handling.
 */
export async function persistStageBatchTelemetry(input: {
  pipelineRunId: string;
  telemetry: StageBatchTelemetry;
}): Promise<void> {
  await prisma.pipelineArtifact.create({
    data: {
      pipelineRunId: input.pipelineRunId,
      orchestrationRunId: input.telemetry.orchestrationRunId,
      sourceId: null,
      categoryId: null,
      artifactType: "stage_batch_telemetry",
      status: input.telemetry.noProgressReason ? "NO_PROGRESS" : "CAPTURED",
      candidateCount: input.telemetry.processed,
      payload: serializeTelemetry(input.telemetry),
      errorLog: input.telemetry.noProgressReason
        ? boundText(input.telemetry.noProgressReason, MAX_ERROR_LENGTH)
        : null,
    },
  });
}

/** Observation-only lookup/update with unambiguous stage + batch identity. */
export async function attachStageBatchNoProgressReason(input: {
  pipelineRunId: string;
  stage: TelemetryStage;
  batchSeq: number;
  reason: string;
}): Promise<void> {
  try {
    const artifact = await prisma.pipelineArtifact.findFirst({
      where: {
        pipelineRunId: input.pipelineRunId,
        artifactType: "stage_batch_telemetry",
        AND: [
          { payload: { path: ["stage"], equals: input.stage } },
          { payload: { path: ["batchSeq"], equals: input.batchSeq } },
        ],
      },
      select: { id: true, payload: true },
      orderBy: { createdAt: "asc" },
    });
    if (!artifact) return;
    const existingPayload = (artifact.payload as Record<string, unknown>) ?? {};
    await prisma.pipelineArtifact.update({
      where: { id: artifact.id },
      data: {
        status: "NO_PROGRESS",
        errorLog: boundText(input.reason, MAX_ERROR_LENGTH),
        payload: {
          ...existingPayload,
          noProgressReason: boundText(input.reason, 300),
        } satisfies Prisma.InputJsonValue,
      },
    });
  } catch {
    // Intentionally non-fatal: telemetry is observation-only.
  }
}
