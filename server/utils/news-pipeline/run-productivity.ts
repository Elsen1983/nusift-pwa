import type { PipelineStageTimingSummary, StageBatchProductivity, TelemetryStage } from "./stage-telemetry";

export const RUN_PRODUCTIVITY_SCHEMA_VERSION = 2 as const;

export type ProductivityEvidenceStatus = "available" | "stage_absent" | "metric_unreported";
export type RunProductivityVerdict = "productive" | "unproductive" | "unknown";
export type RunProductivityBoundary =
  | "no_stage_executed"
  | "no_targets_processed"
  | "no_candidates_found"
  | "candidates_not_inserted"
  | "evidence_incomplete"
  | "produced_output";

export type ProductivityMetric = {
  value: number | null;
  status: ProductivityEvidenceStatus;
};

export type RunProductivityAssessment = {
  schemaVersion: typeof RUN_PRODUCTIVITY_SCHEMA_VERSION;
  verdict: RunProductivityVerdict;
  /** Compatibility field: null means the verdict is not provable. */
  productive: boolean | null;
  evidenceComplete: boolean;
  articlesInserted: number | null;
  articlesEnriched: number | null;
  articlesPublishable: number | null;
  candidatesFound: number | null;
  targetsProcessed: number | null;
  availability: {
    articlesInserted: ProductivityEvidenceStatus;
    articlesEnriched: ProductivityEvidenceStatus;
    articlesPublishable: ProductivityEvidenceStatus;
    candidatesFound: ProductivityEvidenceStatus;
    targetsProcessed: ProductivityEvidenceStatus;
  };
  deepestProductiveBoundary: "none" | "inserted" | "enriched" | "publishable";
  lostAtBoundary: RunProductivityBoundary;
  stagesExecuted: TelemetryStage[];
};

export type RunProductivityStageOutcomeInput = {
  stage: string;
  status: "completed" | "degraded" | "failed";
};

const DISCOVERY_STAGES = ["agent1", "agent2-static", "agent2-headless"] as const;

const safeCount = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const aggregateMetric = (input: {
  relevantStages: readonly TelemetryStage[];
  executed: ReadonlySet<TelemetryStage>;
  summaries: ReadonlyMap<TelemetryStage, PipelineStageTimingSummary>;
  pick: (summary: PipelineStageTimingSummary) => unknown;
}): ProductivityMetric => {
  const activeStages = input.relevantStages.filter((stage) => input.executed.has(stage));
  if (activeStages.length === 0) return { value: 0, status: "stage_absent" };

  let total = 0;
  for (const stage of activeStages) {
    const summary = input.summaries.get(stage);
    if (!summary) return { value: null, status: "metric_unreported" };
    const count = safeCount(input.pick(summary));
    if (count === null) return { value: null, status: "metric_unreported" };
    total += count;
  }
  return { value: total, status: "available" };
};

const outputMetric = (
  stage: TelemetryStage,
  key: keyof StageBatchProductivity,
  executed: ReadonlySet<TelemetryStage>,
  summaries: ReadonlyMap<TelemetryStage, PipelineStageTimingSummary>,
  fallback?: (summary: PipelineStageTimingSummary) => unknown,
): ProductivityMetric => aggregateMetric({
  relevantStages: [stage],
  executed,
  summaries,
  pick: (summary) => hasOwn(summary.productivity, key)
    ? summary.productivity[key]
    : fallback
      ? fallback(summary)
      : undefined,
});

export function assessRunProductivity(input: {
  stageTimings: readonly PipelineStageTimingSummary[];
  stageOutcomes?: readonly RunProductivityStageOutcomeInput[];
}): RunProductivityAssessment {
  const timings = Array.isArray(input?.stageTimings) ? input.stageTimings.filter(Boolean) : [];
  const summaries = new Map<TelemetryStage, PipelineStageTimingSummary>();
  for (const summary of timings) summaries.set(summary.stage, summary);

  const explicitlyReportedOutcomes = Array.isArray(input?.stageOutcomes);
  const executed = new Set<TelemetryStage>(
    explicitlyReportedOutcomes
      ? input.stageOutcomes!.map((outcome) => outcome.stage as TelemetryStage)
      : timings.map((summary) => summary.stage),
  );

  const targetsProcessed = aggregateMetric({
    relevantStages: DISCOVERY_STAGES,
    executed,
    summaries,
    pick: (summary) => summary.processed,
  });
  const candidatesFound = aggregateMetric({
    relevantStages: DISCOVERY_STAGES,
    executed,
    summaries,
    pick: (summary) => summary.stage === "agent1"
      ? summary.productivity.candidateArticlesFound
      : summary.productivity.acceptedCandidates,
  });
  const articlesInserted = aggregateMetric({
    relevantStages: DISCOVERY_STAGES,
    executed,
    summaries,
    pick: (summary) => summary.stage === "agent1"
      ? summary.productivity.articlesInserted
      : summary.productivity.insertedCandidates,
  });
  const articlesEnriched = outputMetric(
    "agent3",
    "articlesEnriched",
    executed,
    summaries,
    (summary) => summary.succeeded,
  );
  const articlesPublishable = outputMetric(
    "agent3",
    "articlesPublishable",
    executed,
    summaries,
  );

  const outputMetrics = [articlesInserted, articlesEnriched, articlesPublishable];
  const hasOutput = outputMetrics.some((metric) => metric.value !== null && metric.value > 0);
  const outputEvidenceComplete = outputMetrics.every((metric) => metric.value !== null);
  const verdict: RunProductivityVerdict = hasOutput
    ? "productive"
    : outputEvidenceComplete
      ? "unproductive"
      : "unknown";
  const evidenceComplete = [
    targetsProcessed,
    candidatesFound,
    articlesInserted,
    articlesEnriched,
    articlesPublishable,
  ].every((metric) => metric.value !== null);

  const stagesExecuted = [...executed];
  const lostAtBoundary: RunProductivityBoundary = verdict === "productive"
    ? "produced_output"
    : stagesExecuted.length === 0
      ? "no_stage_executed"
      : !evidenceComplete
        ? "evidence_incomplete"
        : targetsProcessed.value === 0
          ? "no_targets_processed"
          : candidatesFound.value === 0
            ? "no_candidates_found"
            : "candidates_not_inserted";

  const deepestProductiveBoundary = (articlesPublishable.value ?? 0) > 0
    ? "publishable"
    : (articlesEnriched.value ?? 0) > 0
      ? "enriched"
      : (articlesInserted.value ?? 0) > 0
        ? "inserted"
        : "none";

  return {
    schemaVersion: RUN_PRODUCTIVITY_SCHEMA_VERSION,
    verdict,
    productive: verdict === "unknown" ? null : verdict === "productive",
    evidenceComplete,
    articlesInserted: articlesInserted.value,
    articlesEnriched: articlesEnriched.value,
    articlesPublishable: articlesPublishable.value,
    candidatesFound: candidatesFound.value,
    targetsProcessed: targetsProcessed.value,
    availability: {
      articlesInserted: articlesInserted.status,
      articlesEnriched: articlesEnriched.status,
      articlesPublishable: articlesPublishable.status,
      candidatesFound: candidatesFound.status,
      targetsProcessed: targetsProcessed.status,
    },
    deepestProductiveBoundary,
    lostAtBoundary,
    stagesExecuted,
  };
}

export type PersistedRunProductivity = Pick<
  RunProductivityAssessment,
  "verdict" | "productive" | "evidenceComplete" | "lostAtBoundary" |
  "articlesInserted" | "articlesEnriched" | "articlesPublishable"
>;

export function readPersistedRunProductivity(summary: unknown): PersistedRunProductivity | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const block = (summary as Record<string, unknown>).productivity;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const record = block as Record<string, unknown>;
  const verdict = record.verdict;
  if (!(["productive", "unproductive", "unknown"] as unknown[]).includes(verdict)) return null;
  return {
    verdict: verdict as RunProductivityVerdict,
    productive: typeof record.productive === "boolean" ? record.productive : null,
    evidenceComplete: record.evidenceComplete === true,
    lostAtBoundary: typeof record.lostAtBoundary === "string"
      ? record.lostAtBoundary as RunProductivityBoundary
      : "evidence_incomplete",
    articlesInserted: safeCount(record.articlesInserted),
    articlesEnriched: safeCount(record.articlesEnriched),
    articlesPublishable: safeCount(record.articlesPublishable),
  };
}

export function countConsecutiveUnproductiveRuns(
  runsNewestFirst: readonly { summary: unknown }[],
): number {
  let streak = 0;
  for (const run of runsNewestFirst ?? []) {
    const productivity = readPersistedRunProductivity(run?.summary);
    if (!productivity || productivity.verdict !== "unproductive" || !productivity.evidenceComplete) break;
    streak += 1;
  }
  return streak;
}
