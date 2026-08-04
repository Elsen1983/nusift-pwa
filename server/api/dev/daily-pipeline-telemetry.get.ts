import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import {
  boundText,
  clampCount,
  clampDuration,
  summarizeStageTimings,
  type StageBatchTelemetry,
} from "../../utils/news-pipeline/stage-telemetry";
import { normalizeAgent3CompletionSummary } from "../../utils/news-pipeline/agent3-completion";

const DAILY_STATUSES = [
  "DAILY_PIPELINE_WORKFLOW_RUNNING",
  "DAILY_PIPELINE_WORKFLOW_COMPLETED",
  "DAILY_PIPELINE_WORKFLOW_FAILED",
  "DAILY_PIPELINE_WORKFLOW_STALE",
] as const;
const STAGES: ReadonlySet<TelemetryStage> = new Set(["agent1", "agent2-static", "agent2-headless", "agent3"]);
const isTelemetryStage = (value: unknown): value is TelemetryStage =>
  typeof value === "string" && STAGES.has(value as TelemetryStage);
const MAX_RUN_ID_LENGTH = 100;
const BATCH_LIMIT = 200;
const MANUAL_LOCK_RECOVERY_AFTER_MS = 45 * 60 * 1000;

type JsonRecord = Record<string, unknown>;
type TelemetryStage = "agent1" | "agent2-static" | "agent2-headless" | "agent3";

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

const numberOr = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const dateMs = (value: Date | string | null): number | null => {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const PRODUCTIVITY_KEYS = [
  "candidateArticlesFound", "articlesInserted", "articlesSkipped", "articlePersistenceFailures",
  "rawLinks", "evaluatedCandidates", "acceptedCandidates", "rejectedCandidates",
  "insertedCandidates", "skippedCandidates", "candidatePersistenceFailures",
] as const;

const normalizeProductivity = (value: unknown): Record<string, number> => {
  const raw = asRecord(value);
  return Object.fromEntries(
    PRODUCTIVITY_KEYS
      .filter((key) => raw?.[key] !== undefined)
      .map((key) => [key, clampCount(numberOr(raw?.[key]))]),
  );
};

const normalizeStageTiming = (value: unknown): JsonRecord | null => {
  const raw = asRecord(value);
  if (!raw) return null;
  const stage = isTelemetryStage(raw.stage) ? raw.stage : null;
  if (!stage) return null;
  return {
    stage,
    batches: clampCount(numberOr(raw.batches)),
    processed: clampCount(numberOr(raw.processed)),
    succeeded: clampCount(numberOr(raw.succeeded)),
    failedRetryable: clampCount(numberOr(raw.failedRetryable)),
    failedPermanent: clampCount(numberOr(raw.failedPermanent)),
    skipped: clampCount(numberOr(raw.skipped)),
    deferred: clampCount(numberOr(raw.deferred)),
    quarantined: clampCount(numberOr(raw.quarantined)),
    claimLost: clampCount(numberOr(raw.claimLost)),
    persistenceFailed: clampCount(numberOr(raw.persistenceFailed)),
    durationMs: clampDuration(numberOr(raw.durationMs)),
    /** Canonical logical safeFetch duration; legacy fetchDurationMs remains a read fallback. */
    logicalRequestDurationMs: clampDuration(numberOr(raw.logicalRequestDurationMs, numberOr(raw.fetchDurationMs))),
    fetchDurationMs: clampDuration(numberOr(raw.fetchDurationMs, numberOr(raw.logicalRequestDurationMs))),
    extractionDurationMs: clampDuration(numberOr(raw.extractionDurationMs)),
    browserDurationMs: clampDuration(numberOr(raw.browserDurationMs)),
    persistenceDurationMs: clampDuration(numberOr(raw.persistenceDurationMs)),
    sleepDurationMs: clampDuration(numberOr(raw.sleepDurationMs)),
    remainingBefore: raw.remainingBefore == null ? null : clampCount(numberOr(raw.remainingBefore)),
    remainingAfter: raw.remainingAfter == null ? null : clampCount(numberOr(raw.remainingAfter)),
    latestNoProgressReason: typeof raw.latestNoProgressReason === "string"
      ? boundText(raw.latestNoProgressReason, 300)
      : null,
    accessDenied403: clampCount(numberOr(raw.accessDenied403)),
    rateLimited403: clampCount(numberOr(raw.rateLimited403)),
    rateLimited429: clampCount(numberOr(raw.rateLimited429)),
    timedOut: clampCount(numberOr(raw.timedOut)),
    peakConcurrency: clampCount(numberOr(raw.peakConcurrency)),
    batchSizeLimit: clampCount(numberOr(raw.batchSizeLimit)),
    concurrencyLimit: clampCount(numberOr(raw.concurrencyLimit)),
    productivity: normalizeProductivity(raw.productivity),
    batchExecutionErrors: clampCount(numberOr(raw.batchExecutionErrors)),
    batchErrorClassification: typeof raw.batchErrorClassification === "string"
      ? boundText(raw.batchErrorClassification, 80)
      : null,
    batchErrorReason: typeof raw.batchErrorReason === "string"
      ? boundText(raw.batchErrorReason, 300)
      : null,
  };
};

const normalizeBatch = (artifact: {
  id: string;
  createdAt: Date;
  status: string;
  candidateCount: number;
  payload: unknown;
  errorLog: string | null;
}, runId: string) => {
  const raw = asRecord(artifact.payload);
  if (!raw) return null;
  const stage = isTelemetryStage(raw.stage) ? raw.stage : null;
  const batchSeq = numberOr(raw.batchSeq, -1);
  if (
    raw?.schemaVersion !== 1 ||
    raw?.artifactKind !== "stage_batch_telemetry" ||
    raw?.orchestrationRunId !== runId ||
    !stage ||
    batchSeq < 1
  ) return null;

  const result: Record<string, unknown> = {
    id: artifact.id,
    createdAt: artifact.createdAt,
    status: boundText(artifact.status, 80) ?? "UNKNOWN",
    stage,
    batchSeq: clampCount(batchSeq),
    durationMs: clampDuration(numberOr(raw?.durationMs)),
    processed: clampCount(numberOr(raw?.processed, artifact.candidateCount)),
    succeeded: clampCount(numberOr(raw?.succeeded)),
    failedRetryable: clampCount(numberOr(raw?.failedRetryable)),
    failedPermanent: clampCount(numberOr(raw?.failedPermanent)),
    skipped: clampCount(numberOr(raw?.skipped)),
    deferred: clampCount(numberOr(raw?.deferred)),
    quarantined: clampCount(numberOr(raw?.quarantined)),
    claimLost: clampCount(numberOr(raw?.claimLost)),
    persistenceFailed: clampCount(numberOr(raw?.persistenceFailed)),
    remainingBefore: raw?.remainingBefore == null ? null : clampCount(numberOr(raw.remainingBefore)),
    remainingAfter: raw?.remainingAfter == null ? null : clampCount(numberOr(raw.remainingAfter)),
    networkRequests: clampCount(numberOr(raw?.networkRequests)),
    browserAttempts: clampCount(numberOr(raw?.browserAttempts)),
    dbPersistenceOps: clampCount(numberOr(raw?.dbPersistenceOps)),
    /** Canonical logical safeFetch duration; fetchMs is legacy-only input. */
    logicalRequestDurationMs: clampDuration(
      numberOr(raw?.logicalRequestDurationMs, numberOr(raw?.fetchMs)),
    ),
    fetchMs: clampDuration(numberOr(raw?.fetchMs)),
    extractionMs: clampDuration(numberOr(raw?.extractionMs)),
    browserMs: clampDuration(numberOr(raw?.browserMs)),
    persistenceMs: clampDuration(numberOr(raw?.persistenceMs)),
    sleepMs: clampDuration(numberOr(raw?.sleepMs)),
    batchSizeLimit: clampCount(numberOr(raw?.batchSizeLimit)),
    concurrencyLimit: clampCount(numberOr(raw?.concurrencyLimit)),
    peakConcurrency: clampCount(numberOr(raw?.peakConcurrency)),
    rateLimited403: clampCount(numberOr(raw?.rateLimited403)),
    rateLimited429: clampCount(numberOr(raw?.rateLimited429)),
    timedOut: clampCount(numberOr(raw?.timedOut)),
    accessDenied403: clampCount(numberOr(raw?.accessDenied403)),
    noProgressReason: typeof raw?.noProgressReason === "string"
      ? boundText(raw.noProgressReason, 300)
      : null,
    errorLog: boundText(artifact.errorLog, 500),
    complete: raw?.complete === true,
    productivity: normalizeProductivity(raw?.productivity),
    batchExecutionErrors: clampCount(numberOr(raw?.batchExecutionErrors)),
    batchErrorClassification: typeof raw?.batchErrorClassification === "string"
      ? boundText(raw.batchErrorClassification, 80)
      : null,
    batchErrorReason: typeof raw?.batchErrorReason === "string"
      ? boundText(raw.batchErrorReason, 300)
      : null,
  } satisfies Partial<StageBatchTelemetry> & Record<string, unknown>;
  return result;
};

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "daily-pipeline-telemetry", 10, 60 * 1000);

  const query = getQuery(event);
  const rawRunId = typeof query.runId === "string" ? query.runId.trim() : "";
  if (rawRunId.length > MAX_RUN_ID_LENGTH || (rawRunId && !/^[A-Za-z0-9_-]+$/.test(rawRunId))) {
    throw createError({ statusCode: 400, statusMessage: "Invalid runId." });
  }
  const runId = rawRunId || undefined;

  const latestRun = await prisma.pipelineRun.findFirst({
    where: runId
      ? { id: runId, status: { in: [...DAILY_STATUSES] } }
      : { status: { in: [...DAILY_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, createdAt: true, updatedAt: true, finishedAt: true, summary: true },
  });

  if (!latestRun) return { ok: true, run: null, stageTimings: [], batches: [], pagination: { truncated: false, totalReturned: 0, limit: BATCH_LIMIT } };

  const summary = asRecord(latestRun.summary);
  if (summary?.kind !== "daily_news_pipeline_workflow") {
    // A selected PipelineRun must never be exposed merely because its id was known.
    return { ok: true, run: null, stageTimings: [], batches: [], pagination: { truncated: false, totalReturned: 0, limit: BATCH_LIMIT } };
  }

  const durableStageTimings = Array.isArray(summary.stageTimings)
    ? summary.stageTimings.map(normalizeStageTiming).filter((item): item is JsonRecord => item !== null)
    : [];

  const artifacts = await prisma.pipelineArtifact.findMany({
    where: { pipelineRunId: latestRun.id, artifactType: "stage_batch_telemetry" },
    // Newest-first keeps the latest no-progress diagnostic in the bounded
    // response. The UI presents batches in chronological order below.
    orderBy: { createdAt: "desc" },
    take: BATCH_LIMIT + 1,
    select: { id: true, createdAt: true, status: true, candidateCount: true, payload: true, errorLog: true },
  });
  const truncated = artifacts.length > BATCH_LIMIT;
  const batches = artifacts
    .slice(0, BATCH_LIMIT)
    .map((artifact) => normalizeBatch(artifact, latestRun.id))
    .filter((item): item is JsonRecord => item !== null)
    .reverse();

  // RUNNING workflows do not have their final summary yet. Build a bounded
  // live summary from the already persisted batch artifacts so the admin panel
  // remains useful while the workflow is active.
  const liveStageTimings = summarizeStageTimings(
    batches as unknown as StageBatchTelemetry[],
  ).map(normalizeStageTiming).filter((item): item is JsonRecord => item !== null);
  const stageTimings = durableStageTimings.length > 0
    ? durableStageTimings
    : liveStageTimings;

  // The durable stage summary is not subject to the 200-artifact page limit,
  // so it is the source of truth for the latest no-progress reason. A failed
  // stage step may have no returned batch telemetry; in that unavoidable case
  // use the bounded workflow error as the diagnostic fallback.
  const summaryNoProgressReason = stageTimings
    .slice()
    .reverse()
    .map((stage) => typeof stage.latestNoProgressReason === "string" ? stage.latestNoProgressReason : null)
    .find((reason): reason is string => reason !== null) ?? null;
  const workflowError = typeof summary.error === "string"
    ? boundText(summary.error, 300)
    : null;
  const latestNoProgressReason = summaryNoProgressReason
    ?? (workflowError && /made no progress/i.test(workflowError) ? workflowError : null);
  const createdAtMs = dateMs(latestRun.createdAt);
  const updatedAtMs = dateMs(latestRun.updatedAt);
  const finishedAtMs = dateMs(latestRun.finishedAt);
  const workflowDurationMs = createdAtMs == null
    ? 0
    : clampDuration(Math.max(0, (finishedAtMs ?? Date.now()) - createdAtMs));

  return {
    ok: true,
    run: {
      id: latestRun.id,
      status: latestRun.status,
      createdAt: latestRun.createdAt,
      updatedAt: latestRun.updatedAt,
      finishedAt: latestRun.finishedAt,
      lockHeartbeatAgeMs: latestRun.status === "DAILY_PIPELINE_WORKFLOW_RUNNING" && updatedAtMs != null
        ? clampDuration(Math.max(0, Date.now() - updatedAtMs))
        : null,
      lockRecoveryEligible: latestRun.status === "DAILY_PIPELINE_WORKFLOW_RUNNING" &&
        updatedAtMs != null && Date.now() - updatedAtMs >= MANUAL_LOCK_RECOVERY_AFTER_MS,
      completedStages: Array.isArray(summary.completedStages)
        ? summary.completedStages.filter((stage): stage is TelemetryStage => isTelemetryStage(stage))
        : [],
      error: typeof summary.error === "string" ? boundText(summary.error, 1000) : null,
      workflowDurationMs,
      notificationsDurationMs: clampDuration(numberOr(summary.notificationsDurationMs)),
      // Completion semantics: bounded, deterministic fields explaining why a
      // COMPLETED workflow can still leave future-run Agent 3 work. Legacy
      // summaries without the new fields yield null ("not available").
      completion: normalizeAgent3CompletionSummary(summary.completion),
    },
    stageTimings,
    batches,
    latestNoProgressReason,
    pagination: { truncated, totalReturned: batches.length, limit: BATCH_LIMIT },
  };
});
