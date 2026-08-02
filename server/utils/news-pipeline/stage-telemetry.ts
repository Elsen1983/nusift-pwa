/**
 * Workflow-safe, observation-only telemetry primitives.
 *
 * This module deliberately has no Prisma, database, H3, Nuxt, or other
 * server-only imports. Database persistence lives in stage-telemetry-server.ts.
 *
 * Duration buckets are not required to sum to wall-clock time: operations may
 * overlap once a stage becomes concurrent. In Phase 1 operations are serial
 * and peak concurrency is 0 for empty batches and 1 when a timed operation
 * runs. logicalRequestDurationMs, extractionMs, browserMs, and persistenceMs
 * are mutually exclusive attribution buckets for a given operation; workflow
 * sleep is recorded separately as the configured/requested delay.
 *
 * Counting invariant: every disposition field uses one authoritative unit per
 * stage batch. Agent 1 and Agent 2 count selected targets/queue items; Agent 3
 * counts selected and durably claimed articles. Candidate/link/row metrics
 * live in `productivity`, never in disposition buckets. For authoritative
 * selected work:
 * succeeded + failedRetryable + failedPermanent + skipped + deferred +
 * quarantined + claimLost + persistenceFailed = processed.
 */

export type TelemetryStage = "agent1" | "agent2-static" | "agent2-headless" | "agent3";

export type StageBatchProductivity = {
  candidateArticlesFound?: number;
  articlesInserted?: number;
  articlesSkipped?: number;
  articlePersistenceFailures?: number;
  rawLinks?: number;
  evaluatedCandidates?: number;
  acceptedCandidates?: number;
  rejectedCandidates?: number;
  insertedCandidates?: number;
  skippedCandidates?: number;
  candidatePersistenceFailures?: number;
};

export type StageDispositionCounts = {
  processed: number;
  succeeded: number;
  failedRetryable: number;
  failedPermanent: number;
  skipped: number;
  deferred: number;
  quarantined: number;
  claimLost: number;
  persistenceFailed: number;
};

export const calculateDispositionTotal = (
  counts: Omit<StageDispositionCounts, "processed">,
): number => counts.succeeded + counts.failedRetryable + counts.failedPermanent +
  counts.skipped + counts.deferred + counts.quarantined + counts.claimLost +
  counts.persistenceFailed;

export const validateDispositionReconciliation = (counts: StageDispositionCounts): void => {
  const total = calculateDispositionTotal(counts);
  if (total !== counts.processed) {
    throw new Error(
      `Stage telemetry disposition mismatch: processed=${counts.processed}, buckets=${total}.`,
    );
  }
};

export type StageBatchTelemetry = {
  schemaVersion: 1;
  artifactKind: "stage_batch_telemetry";
  orchestrationRunId: string;
  stage: TelemetryStage;
  batchSeq: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  processed: number;
  succeeded: number;
  failedRetryable: number;
  failedPermanent: number;
  skipped: number;
  deferred: number;
  quarantined: number;
  /** Selected outcomes lost before final persistence; not a processed outcome. */
  claimLost?: number;
  /** Selected outcomes whose final DB persistence failed; not a processed outcome. */
  persistenceFailed?: number;
  remainingBefore: number | null;
  remainingAfter: number | null;
  networkRequests: number;
  browserAttempts: number;
  dbPersistenceOps: number;
  /** Legacy input field only; new telemetry artifacts use logicalRequestDurationMs. */
  fetchMs?: number;
  extractionMs: number;
  browserMs: number;
  persistenceMs: number;
  sleepMs: number;
  batchSizeLimit: number;
  concurrencyLimit: number;
  peakConcurrency: number;
  hostCooldownActivations: number;
  accessDenied403: number;
  rateLimited403: number;
  rateLimited429: number;
  timedOut: number;
  noProgressReason: string | null;
  complete: boolean;
  /** Canonical selected-unit productivity metrics; never part of disposition reconciliation. */
  productivity?: StageBatchProductivity;
  /** A stage invocation error is not an article/target failure disposition. */
  batchExecutionErrors?: number;
  batchErrorClassification?: string | null;
  batchErrorReason?: string | null;
  /** Canonical duration of the complete logical safeFetch invocation. */
  logicalRequestDurationMs?: number;
  /** Pre-transport DNS/SSRF/policy validation duration, when measured. */
  securityValidationMs?: number;
};

export type PipelineStageTimingSummary = {
  stage: TelemetryStage;
  batches: number;
  processed: number;
  succeeded: number;
  failedRetryable: number;
  failedPermanent: number;
  skipped: number;
  deferred: number;
  quarantined: number;
  claimLost?: number;
  persistenceFailed?: number;
  durationMs: number;
  fetchDurationMs: number;
  extractionDurationMs: number;
  browserDurationMs: number;
  persistenceDurationMs: number;
  sleepDurationMs: number;
  remainingBefore: number | null;
  remainingAfter: number | null;
  latestNoProgressReason: string | null;
  accessDenied403: number;
  rateLimited403: number;
  rateLimited429: number;
  timedOut: number;
  peakConcurrency: number;
  batchSizeLimit: number;
  concurrencyLimit: number;
  productivity: StageBatchProductivity;
  batchExecutionErrors: number;
  batchErrorClassification: string | null;
  batchErrorReason: string | null;
  logicalRequestDurationMs: number;
  securityValidationMs: number;
};

export type StageBatchProbeKind = "fetch" | "logicalRequest" | "extraction" | "browser" | "persistence";

export interface StageBatchProbe {
  recordFetch(ms: number): void;
  recordLogicalRequestDuration(ms: number): void;
  recordExtraction(ms: number): void;
  recordBrowser(ms: number): void;
  recordPersistence(ms: number): void;
  recordSleep(ms: number): void;
  recordNetworkRequest(count?: number): void;
  recordBrowserAttempt(): void;
  recordDbOperation(): void;
  recordAccessDenied403(): void;
  recordRateLimited(status: 403 | 429): void;
  recordTimeout(): void;
  recordHostCooldown(): void;
  observeConcurrency(active: number): void;
  /** Start an operation at a shared boundary; the returned function closes it in finally. */
  beginOperation(kind: StageBatchProbeKind): () => void;
  /** Canonical safeFetch boundary; one invocation is one logical request. */
  beginLogicalRequest(): () => void;
  timed<T>(kind: StageBatchProbeKind, fn: () => Promise<T>): Promise<T>;
}

const MAX_COUNT = 1_000_000;
/** One batch or workflow stage cannot legitimately report more than 24h of one bucket. */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_REASON_LENGTH = 300;

export const clampCount = (value: number): number =>
  Math.max(0, Math.min(Math.round(Number.isFinite(value) ? value : 0), MAX_COUNT));

export const clampDuration = (value: number): number =>
  Math.max(0, Math.min(Math.round(Number.isFinite(value) ? value : 0), MAX_DURATION_MS));

export const boundText = (value: string | null | undefined, max: number): string | null => {
  if (value == null) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max);
};

const noop = (): void => {};

export const createNoopStageBatchProbe = (): StageBatchProbe => ({
  recordFetch: noop,
  recordLogicalRequestDuration: noop,
  recordExtraction: noop,
  recordBrowser: noop,
  recordPersistence: noop,
  recordSleep: noop,
  recordNetworkRequest: noop,
  recordBrowserAttempt: noop,
  recordDbOperation: noop,
  recordAccessDenied403: noop,
  recordRateLimited: noop,
  recordTimeout: noop,
  recordHostCooldown: noop,
  observeConcurrency: noop,
  beginOperation: () => noop,
  beginLogicalRequest: () => noop,
  async timed<T>(_kind: StageBatchProbeKind, fn: () => Promise<T>): Promise<T> { return fn(); },
});

export type StageBatchTelemetryTrackerOptions = {
  orchestrationRunId: string;
  stage: TelemetryStage;
  batchSeq: number;
  batchSizeLimit: number;
  /** Actual active-operation limit. Phase 1 is serial, so this is 1. */
  concurrencyLimit: number;
  now?: () => number;
};

export class StageBatchTelemetryTracker implements StageBatchProbe {
  private readonly orchestrationRunId: string;
  private readonly stage: TelemetryStage;
  private readonly batchSeq: number;
  private readonly batchSizeLimit: number;
  private readonly concurrencyLimit: number;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private durations: Record<StageBatchProbeKind, number> = {
    fetch: 0,
    logicalRequest: 0,
    extraction: 0,
    browser: 0,
    persistence: 0,
  };
  private sleepMs = 0;
  private networkRequests = 0;
  private browserAttempts = 0;
  private dbPersistenceOps = 0;
  private hostCooldownActivations = 0;
  private accessDenied403 = 0;
  private rateLimited403 = 0;
  private rateLimited429 = 0;
  private timedOut = 0;
  private activeOps = 0;
  private peakConcurrency = 0;

  constructor(options: StageBatchTelemetryTrackerOptions) {
    this.orchestrationRunId = options.orchestrationRunId;
    this.stage = options.stage;
    this.batchSeq = clampCount(options.batchSeq);
    this.batchSizeLimit = clampCount(options.batchSizeLimit);
    this.concurrencyLimit = clampCount(options.concurrencyLimit);
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  recordFetch(ms: number): void { this.durations.fetch = clampDuration(this.durations.fetch + clampDuration(ms)); }
  recordLogicalRequestDuration(ms: number): void {
    this.durations.logicalRequest = clampDuration(this.durations.logicalRequest + clampDuration(ms));
  }
  recordExtraction(ms: number): void { this.durations.extraction = clampDuration(this.durations.extraction + clampDuration(ms)); }
  recordBrowser(ms: number): void { this.durations.browser = clampDuration(this.durations.browser + clampDuration(ms)); }
  recordPersistence(ms: number): void { this.durations.persistence = clampDuration(this.durations.persistence + clampDuration(ms)); }
  recordSleep(ms: number): void { this.sleepMs = clampDuration(this.sleepMs + clampDuration(ms)); }

  recordNetworkRequest(count = 1): void { this.networkRequests = clampCount(this.networkRequests + clampCount(count)); }
  recordBrowserAttempt(): void { this.browserAttempts = clampCount(this.browserAttempts + 1); }
  recordDbOperation(): void { this.dbPersistenceOps = clampCount(this.dbPersistenceOps + 1); }
  recordAccessDenied403(): void { this.accessDenied403 = clampCount(this.accessDenied403 + 1); }
  recordRateLimited(status: 403 | 429): void {
    if (status === 403) this.rateLimited403 = clampCount(this.rateLimited403 + 1);
    else this.rateLimited429 = clampCount(this.rateLimited429 + 1);
  }
  recordTimeout(): void { this.timedOut = clampCount(this.timedOut + 1); }
  recordHostCooldown(): void { this.hostCooldownActivations = clampCount(this.hostCooldownActivations + 1); }
  get rateLimitedCount(): number { return this.rateLimited403 + this.rateLimited429; }
  get rateLimited429Count(): number { return this.rateLimited429; }

  observeConcurrency(active: number): void {
    if (!Number.isFinite(active) || active < 0) return;
    this.activeOps = Math.round(active);
    this.peakConcurrency = Math.max(this.peakConcurrency, this.activeOps);
  }

  beginOperation(kind: StageBatchProbeKind): () => void {
    this.activeOps += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.activeOps);
    const started = this.now();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.durations[kind] = clampDuration(this.durations[kind] + (this.now() - started));
      this.activeOps -= 1;
    };
  }

  beginLogicalRequest(): () => void { return this.beginOperation("logicalRequest"); }

  async timed<T>(kind: StageBatchProbeKind, fn: () => Promise<T>): Promise<T> {
    const endOperation = this.beginOperation(kind);
    try {
      return await fn();
    } finally {
      endOperation();
    }
  }

  finalize(input: {
    processed: number;
    succeeded: number;
    failedRetryable: number;
    failedPermanent: number;
    skipped: number;
    deferred: number;
    quarantined: number;
    claimLost?: number;
    persistenceFailed?: number;
    productivity?: StageBatchProductivity;
    batchExecutionErrors?: number;
    batchErrorClassification?: string | null;
    batchErrorReason?: string | null;
    securityValidationMs?: number;
    remainingBefore: number | null;
    remainingAfter: number | null;
    complete: boolean;
    noProgressReason?: string | null;
  }): StageBatchTelemetry {
    const disposition = {
      processed: input.processed,
      succeeded: input.succeeded,
      failedRetryable: input.failedRetryable,
      failedPermanent: input.failedPermanent,
      skipped: input.skipped,
      deferred: input.deferred,
      quarantined: input.quarantined,
      claimLost: input.claimLost ?? 0,
      persistenceFailed: input.persistenceFailed ?? 0,
    };
    for (const [key, value] of Object.entries(disposition)) {
      if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value) || value > MAX_COUNT) {
        throw new Error(`Invalid stage telemetry disposition ${key}.`);
      }
    }
    validateDispositionReconciliation(disposition);

    const finishedAtMs = this.now();
    const record: StageBatchTelemetry = {
      schemaVersion: 1,
      artifactKind: "stage_batch_telemetry",
      orchestrationRunId: this.orchestrationRunId,
      stage: this.stage,
      batchSeq: this.batchSeq,
      startedAt: new Date(this.startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: clampDuration(finishedAtMs - this.startedAtMs),
      processed: clampCount(input.processed),
      succeeded: clampCount(input.succeeded),
      failedRetryable: clampCount(input.failedRetryable),
      failedPermanent: clampCount(input.failedPermanent),
      skipped: clampCount(input.skipped),
      deferred: clampCount(input.deferred),
      quarantined: clampCount(input.quarantined),
      claimLost: clampCount(input.claimLost ?? 0),
      persistenceFailed: clampCount(input.persistenceFailed ?? 0),
      remainingBefore: input.remainingBefore == null ? null : clampCount(input.remainingBefore),
      remainingAfter: input.remainingAfter == null ? null : clampCount(input.remainingAfter),
      networkRequests: this.networkRequests,
      browserAttempts: this.browserAttempts,
      dbPersistenceOps: this.dbPersistenceOps,
      extractionMs: this.durations.extraction,
      browserMs: this.durations.browser,
      persistenceMs: this.durations.persistence,
      sleepMs: this.sleepMs,
      batchSizeLimit: this.batchSizeLimit,
      concurrencyLimit: this.concurrencyLimit,
      peakConcurrency: this.peakConcurrency,
      hostCooldownActivations: this.hostCooldownActivations,
      accessDenied403: this.accessDenied403,
      rateLimited403: this.rateLimited403,
      rateLimited429: this.rateLimited429,
      timedOut: this.timedOut,
      noProgressReason: boundText(input.noProgressReason ?? null, MAX_REASON_LENGTH),
      complete: input.complete,
      productivity: Object.fromEntries(
        Object.entries(input.productivity ?? {}).map(([key, value]) => [key, clampCount(value as number)]),
      ) as StageBatchProductivity,
      batchExecutionErrors: clampCount(input.batchExecutionErrors ?? 0),
      batchErrorClassification: boundText(input.batchErrorClassification ?? null, 80),
      batchErrorReason: boundText(input.batchErrorReason ?? null, MAX_REASON_LENGTH),
      logicalRequestDurationMs: this.durations.logicalRequest,
      securityValidationMs: clampDuration(input.securityValidationMs ?? 0),
      // Deliberately omit legacy fetchMs from newly-created artifacts.
    };
    return record;
  }
}

const sumCount = (values: number[]): number => clampCount(values.reduce((acc, value) => acc + clampCount(value), 0));
const sumDuration = (values: number[]): number => clampDuration(values.reduce((acc, value) => acc + clampDuration(value), 0));
const sumProductivity = (batches: StageBatchTelemetry[]): StageBatchProductivity => {
  const keys: Array<keyof StageBatchProductivity> = [
    "candidateArticlesFound", "articlesInserted", "articlesSkipped", "articlePersistenceFailures",
    "rawLinks", "evaluatedCandidates", "acceptedCandidates", "rejectedCandidates",
    "insertedCandidates", "skippedCandidates", "candidatePersistenceFailures",
  ];
  return Object.fromEntries(
    keys.filter((key) => batches.some((batch) => batch.productivity?.[key] !== undefined))
      .map((key) => [key, sumCount(batches.map((batch) => batch.productivity?.[key] ?? 0))]),
  ) as StageBatchProductivity;
};

export function summarizeStageTimings(records: StageBatchTelemetry[]): PipelineStageTimingSummary[] {
  const byStage = new Map<TelemetryStage, StageBatchTelemetry[]>();
  for (const record of records) byStage.set(record.stage, [...(byStage.get(record.stage) ?? []), record]);
  return [...byStage.entries()].map(([stage, batches]) => ({
    stage,
    batches: sumCount([batches.length]),
    processed: sumCount(batches.map((b) => b.processed)),
    succeeded: sumCount(batches.map((b) => b.succeeded)),
    failedRetryable: sumCount(batches.map((b) => b.failedRetryable)),
    failedPermanent: sumCount(batches.map((b) => b.failedPermanent)),
    skipped: sumCount(batches.map((b) => b.skipped)),
    deferred: sumCount(batches.map((b) => b.deferred)),
    quarantined: sumCount(batches.map((b) => b.quarantined)),
    claimLost: sumCount(batches.map((b) => b.claimLost ?? 0)),
    persistenceFailed: sumCount(batches.map((b) => b.persistenceFailed ?? 0)),
    durationMs: sumDuration(batches.map((b) => b.durationMs)),
    fetchDurationMs: sumDuration(batches.map((b) => b.logicalRequestDurationMs ?? b.fetchMs ?? 0)),
    extractionDurationMs: sumDuration(batches.map((b) => b.extractionMs)),
    browserDurationMs: sumDuration(batches.map((b) => b.browserMs)),
    persistenceDurationMs: sumDuration(batches.map((b) => b.persistenceMs)),
    sleepDurationMs: sumDuration(batches.map((b) => b.sleepMs)),
    remainingBefore: batches[0]?.remainingBefore ?? null,
    remainingAfter: batches[batches.length - 1]?.remainingAfter ?? null,
    latestNoProgressReason: [...batches].reverse().find((batch) => batch.noProgressReason)?.noProgressReason ?? null,
    accessDenied403: sumCount(batches.map((b) => b.accessDenied403)),
    rateLimited403: sumCount(batches.map((b) => b.rateLimited403)),
    rateLimited429: sumCount(batches.map((b) => b.rateLimited429)),
    timedOut: sumCount(batches.map((b) => b.timedOut)),
    peakConcurrency: Math.max(0, ...batches.map((b) => clampCount(b.peakConcurrency))),
    batchSizeLimit: Math.max(0, ...batches.map((b) => clampCount(b.batchSizeLimit))),
    concurrencyLimit: Math.max(0, ...batches.map((b) => clampCount(b.concurrencyLimit))),
    productivity: sumProductivity(batches),
    batchExecutionErrors: sumCount(batches.map((b) => b.batchExecutionErrors ?? 0)),
    batchErrorClassification: [...batches].reverse().find((batch) => batch.batchErrorClassification)?.batchErrorClassification ?? null,
    batchErrorReason: [...batches].reverse().find((batch) => batch.batchErrorReason)?.batchErrorReason ?? null,
    logicalRequestDurationMs: sumDuration(batches.map((b) => b.logicalRequestDurationMs ?? b.fetchMs ?? 0)),
    securityValidationMs: sumDuration(batches.map((b) => b.securityValidationMs ?? 0)),
  }));
}
