/**
 * URL Policy Evaluation Runner & Metrics
 *
 * Deterministic evaluation runner that:
 * - Loads tuning/holdout datasets
 * - Runs production baseline and candidate shadow policies on every URL
 * - Computes metrics separately for each split and each policy version
 * - Produces deterministic JSON output with samples and baseline comparison
 *
 * Side-effect-free: no I/O, no mutations, no artifact writes.
 */

import {
  type UrlEvaluationDataset,
  type UrlEvaluationLabel,
  type UrlPolicyDecision,
  type UrlPolicyDecisionLog,
  type DatasetSplit,
  CURRENT_PRODUCTION_URL_POLICY_VERSION,
  CANDIDATE_URL_POLICY_VERSION,
  evaluateProductionUrlPolicy,
  evaluateCandidateUrlPolicy,
  validateUrlEvaluationDataset,
  validateUrlEvaluationDatasetSplits,
  validateUrlPolicyDatasetMovements,
} from "./url-policy-evaluation";

// ─── Rate Precision ─────────────────────────────────────────────────────────

/** Number of decimal places for rate rounding in report output. */
const RATE_PRECISION = 6;

/**
 * Round a number to a fixed number of decimal places.
 * Uses Math.round to avoid floating-point drift across runs.
 */
function roundRate(value: number, precision: number = RATE_PRECISION): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

/**
 * Safe division that returns 0 when the denominator is 0.
 */
function safeDivide(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type PolicyEvaluationCounts = {
  evaluated: number;
  accepted: number;
  rejected: number;
  uncertain: number;

  /** Total true articles (expectedAcceptanceClass === "ACCEPTABLE_ARTICLE"). */
  trueArticles: number;
  /** True articles that were accepted by the policy. */
  acceptedTrueArticles: number;
  /** True articles that were rejected by the policy (false reject). */
  rejectedTrueArticles: number;
  /** True articles that received UNCERTAIN. */
  uncertainTrueArticles: number;

  /** Total non-articles (expectedAcceptanceClass === "NON_ARTICLE"). */
  nonArticles: number;
  /** Non-articles that were accepted by the policy (leakage). */
  acceptedNonArticles: number;
  /** Non-articles that were rejected by the policy. */
  rejectedNonArticles: number;
  /** Non-articles that received UNCERTAIN. */
  uncertainNonArticles: number;
};

export type PolicyEvaluationRates = {
  /** Accepted true articles / all accepted URLs. 0 when no URLs accepted. */
  articleAcceptPrecision: number;
  /** Accepted true articles / all true articles. 0 when no true articles. */
  articleAcceptRecall: number;
  /** Rejected true articles / all true articles. 0 when no true articles. */
  falseRejectRate: number;
  /** Accepted non-article URLs / all accepted URLs. 0 when no URLs accepted. */
  nonArticleLeakageRate: number;
  /** UNCERTAIN decisions / all evaluated URLs. */
  uncertainRate: number;
  /** (ACCEPT or REJECT decisions) / all evaluated URLs. */
  policyCoverage: number;
  /** Uncertain true articles / all true articles. */
  uncertainArticleRate: number;
  /** Uncertain non-articles / all non-articles. */
  uncertainNonArticleRate: number;
};

export type EvaluationSampleEntry = {
  url: string;
  decision: UrlPolicyDecision;
  expectedAcceptanceClass: string;
  reasonCode?: string;
};

export type PolicyEvaluationSamples = {
  falseRejectSamples: EvaluationSampleEntry[];
  nonArticleLeakageSamples: EvaluationSampleEntry[];
  uncertainSamples: EvaluationSampleEntry[];
};

export type PolicyEvaluationResult = {
  /** Stable internal report key (e.g. "current-production-v1"). */
  policyKey: string;
  /** Actual policy version string shown to users (candidate versions are bumped with behavior changes). */
  policyVersion: string;
  counts: PolicyEvaluationCounts;
  rates: PolicyEvaluationRates;
  samples: PolicyEvaluationSamples;
};

export type ExtractionMetrics = {
  extractionExpectedCount: number;
  extractionNotExpectedCount: number;
  extractionExpectationCoverage: number;
};

export type SplitEvaluation = {
  policies: Record<string, PolicyEvaluationResult>;
  extractionMetrics?: ExtractionMetrics;
};

export type BaselineComparisonEntry = {
  split: string;
  /** Actual production policy version shown to users. */
  productionPolicyVersion: string;
  /** Actual candidate policy version shown to users. */
  candidatePolicyVersion: string;
  metric: string;
  productionValue: number;
  candidateValue: number;
  delta: number;
};

export type EvaluationReport = {
  datasetVersion: string;
  splits: Record<string, SplitEvaluation>;
  comparison: BaselineComparisonEntry[];
};

// ─── Sample Size Limit ──────────────────────────────────────────────────────

/** Maximum number of samples to include per sample group. */
const MAX_SAMPLES_PER_GROUP = 20;

// ─── Metric Computation ─────────────────────────────────────────────────────

/**
 * Compute evaluation counts, rates, and samples from a list of labelled
 * decision pairs.
 *
 * @param labels - The dataset labels (used for expectedAcceptanceClass).
 * @param decisions - The policy decisions produced by an evaluator.
 * @param policyVersion - The policy version string used as a key.
 * @returns A PolicyEvaluationResult with counts, rates, and samples.
 */
function computeMetrics(
  labels: UrlEvaluationLabel[],
  decisions: UrlPolicyDecisionLog[],
  policyKey: string,
  policyVersion: string,
): PolicyEvaluationResult {
  const counts: PolicyEvaluationCounts = {
    evaluated: 0,
    accepted: 0,
    rejected: 0,
    uncertain: 0,
    trueArticles: 0,
    acceptedTrueArticles: 0,
    rejectedTrueArticles: 0,
    uncertainTrueArticles: 0,
    nonArticles: 0,
    acceptedNonArticles: 0,
    rejectedNonArticles: 0,
    uncertainNonArticles: 0,
  };

  const falseRejectSamples: EvaluationSampleEntry[] = [];
  const nonArticleLeakageSamples: EvaluationSampleEntry[] = [];
  const uncertainSamples: EvaluationSampleEntry[] = [];

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    const decision = decisions[i]!;
    if (!decision) continue;

    counts.evaluated++;
    const isArticle = label.expectedAcceptanceClass === "ACCEPTABLE_ARTICLE";

    if (isArticle) {
      counts.trueArticles++;
    } else {
      counts.nonArticles++;
    }

    switch (decision.decision) {
      case "ACCEPT": {
        counts.accepted++;
        if (isArticle) {
          counts.acceptedTrueArticles++;
        } else {
          counts.acceptedNonArticles++;
          if (nonArticleLeakageSamples.length < MAX_SAMPLES_PER_GROUP) {
            nonArticleLeakageSamples.push({
              url: decision.url,
              decision: "ACCEPT",
              expectedAcceptanceClass: label.expectedAcceptanceClass,
              reasonCode: decision.reasonCode,
            });
          }
        }
        break;
      }
      case "REJECT": {
        counts.rejected++;
        if (isArticle) {
          counts.rejectedTrueArticles++;
          if (falseRejectSamples.length < MAX_SAMPLES_PER_GROUP) {
            falseRejectSamples.push({
              url: decision.url,
              decision: "REJECT",
              expectedAcceptanceClass: label.expectedAcceptanceClass,
              reasonCode: decision.reasonCode,
            });
          }
        } else {
          counts.rejectedNonArticles++;
        }
        break;
      }
      case "UNCERTAIN": {
        counts.uncertain++;
        if (isArticle) {
          counts.uncertainTrueArticles++;
        } else {
          counts.uncertainNonArticles++;
        }
        if (uncertainSamples.length < MAX_SAMPLES_PER_GROUP) {
          uncertainSamples.push({
            url: decision.url,
            decision: "UNCERTAIN",
            expectedAcceptanceClass: label.expectedAcceptanceClass,
            reasonCode: decision.reasonCode,
          });
        }
        break;
      }
    }
  }

  // Sort samples deterministically by URL
  const sortByUrl = (a: EvaluationSampleEntry, b: EvaluationSampleEntry) =>
    a.url.localeCompare(b.url);

  falseRejectSamples.sort(sortByUrl);
  nonArticleLeakageSamples.sort(sortByUrl);
  uncertainSamples.sort(sortByUrl);

  const allAccepted = counts.accepted;
  const allTrueArticles = counts.trueArticles;
  const allNonArticles = counts.nonArticles;
  const allEvaluated = counts.evaluated;

  const rates: PolicyEvaluationRates = {
    articleAcceptPrecision: roundRate(safeDivide(counts.acceptedTrueArticles, allAccepted)),
    articleAcceptRecall: roundRate(safeDivide(counts.acceptedTrueArticles, allTrueArticles)),
    falseRejectRate: roundRate(safeDivide(counts.rejectedTrueArticles, allTrueArticles)),
    nonArticleLeakageRate: roundRate(safeDivide(counts.acceptedNonArticles, allAccepted)),
    uncertainRate: roundRate(safeDivide(counts.uncertain, allEvaluated)),
    policyCoverage: roundRate(safeDivide(counts.accepted + counts.rejected, allEvaluated)),
    uncertainArticleRate: roundRate(safeDivide(counts.uncertainTrueArticles, allTrueArticles)),
    uncertainNonArticleRate: roundRate(safeDivide(counts.uncertainNonArticles, allNonArticles)),
  };

  return {
    policyKey,
    policyVersion,
    counts,
    rates,
    samples: { falseRejectSamples, nonArticleLeakageSamples, uncertainSamples },
  };
}

// ─── Extraction Metrics ─────────────────────────────────────────────────────

/**
 * Compute extraction metrics from a dataset.
 * Reported in a separate section, never combined with URL policy metrics.
 */
function computeExtractionMetrics(labels: UrlEvaluationLabel[]): ExtractionMetrics {
  let extractionExpectedCount = 0;
  let extractionNotExpectedCount = 0;

  for (const label of labels) {
    if (label.extractionExpected === true) {
      extractionExpectedCount++;
    } else if (label.extractionExpected === false) {
      extractionNotExpectedCount++;
    }
    // undefined → not counted
  }

  const total = extractionExpectedCount + extractionNotExpectedCount;
  const extractionExpectationCoverage = roundRate(safeDivide(extractionExpectedCount, total));

  return {
    extractionExpectedCount,
    extractionNotExpectedCount,
    extractionExpectationCoverage,
  };
}

// ─── Baseline Comparison ───────────────────────────────────────────────────

/**
 * Metric names used in comparison output, in stable order.
 */
const COMPARISON_METRICS: Array<keyof PolicyEvaluationRates> = [
  "articleAcceptPrecision",
  "articleAcceptRecall",
  "falseRejectRate",
  "nonArticleLeakageRate",
  "uncertainRate",
  "policyCoverage",
  "uncertainArticleRate",
  "uncertainNonArticleRate",
];

/**
 * Compute baseline comparison entries between production and candidate
 * policies for a given split.
 */
function computeComparison(
  split: DatasetSplit,
  prodResult: PolicyEvaluationResult,
  candResult: PolicyEvaluationResult,
): BaselineComparisonEntry[] {
  const entries: BaselineComparisonEntry[] = [];

  for (const metric of COMPARISON_METRICS) {
    const productionValue = prodResult.rates[metric];
    const candidateValue = candResult.rates[metric];
    entries.push({
      split,
      productionPolicyVersion: CURRENT_PRODUCTION_URL_POLICY_VERSION,
      candidatePolicyVersion: CANDIDATE_URL_POLICY_VERSION,
      metric,
      productionValue,
      candidateValue,
      delta: roundRate(candidateValue - productionValue),
    });
  }

  return entries;
}

// ─── Policy Keys ────────────────────────────────────────────────────────────

/** Stable policy key for the production baseline. */
const PRODUCTION_POLICY_KEY = "current-production-v1";
/** Stable policy key for the candidate policy. */
const CANDIDATE_POLICY_KEY = "candidate-v1";

// ─── Main Runner ────────────────────────────────────────────────────────────

/**
 * Run the full URL policy evaluation for all given datasets.
 *
 * Side-effect-free: no I/O, no mutations, no artifact writes.
 * Returns deterministic JSON-serializable output.
 *
 * @param datasets - One or more UrlEvaluationDatasets (tuning, holdout, etc.).
 * @returns An EvaluationReport with per-split metrics and baseline comparison.
 */
export function runUrlPolicyEvaluation(
  ...datasets: UrlEvaluationDataset[]
): EvaluationReport {
  const datasetVersion = datasets.length > 0 ? datasets[0]!.datasetVersion : "";
  const validationErrors = datasets.flatMap((dataset) => validateUrlEvaluationDataset(dataset).errors);
  const splitErrors = validateUrlEvaluationDatasetSplits(datasets);
  const movementErrors = datasets.some((dataset) => dataset.split === "tuning") && datasets.some((dataset) => dataset.split === "holdout")
    ? validateUrlPolicyDatasetMovements(datasets)
    : [];
  if (validationErrors.length > 0 || splitErrors.length > 0 || movementErrors.length > 0) {
    const details = [
      ...validationErrors.map((error) => `${error.field}: ${error.message}`),
      ...splitErrors,
      ...movementErrors,
    ].join("; ");
    throw new Error(`Invalid URL policy evaluation dataset: ${details}`);
  }
  const splits: Record<string, SplitEvaluation> = {};
  const comparison: BaselineComparisonEntry[] = [];

  // Stable split ordering: tuning first, holdout second, then any extras.
  const sortedDatasets = [...datasets].sort((a, b) => {
    const order: Record<string, number> = { tuning: 0, holdout: 1 };
    return (order[a.split] ?? 99) - (order[b.split] ?? 99);
  });

  for (const dataset of sortedDatasets) {
    const splitKey = dataset.split;
    const labels = dataset.labels;
    const policies: Record<string, PolicyEvaluationResult> = {};

    // A. Evaluate all URLs with production baseline policy
    const prodDecisions: UrlPolicyDecisionLog[] = labels.map((label) =>
      evaluateProductionUrlPolicy({
        url: label.url,
        candidateEvidence: label.candidateEvidence,
      }),
    );
    const prodResult = computeMetrics(
      labels,
      prodDecisions,
      PRODUCTION_POLICY_KEY,
      CURRENT_PRODUCTION_URL_POLICY_VERSION,
    );
    policies[PRODUCTION_POLICY_KEY] = prodResult;

    // B. Evaluate all URLs with candidate shadow policy
    const candDecisions: UrlPolicyDecisionLog[] = labels.map((label) =>
      evaluateCandidateUrlPolicy({
        url: label.url,
        candidateEvidence: label.candidateEvidence,
      }),
    );
    const candResult = computeMetrics(
      labels,
      candDecisions,
      CANDIDATE_POLICY_KEY,
      CANDIDATE_URL_POLICY_VERSION,
    );
    policies[CANDIDATE_POLICY_KEY] = candResult;

    // Extraction metrics
    const extractionMetrics = computeExtractionMetrics(labels);

    // Baseline comparison
    const splitComparison = computeComparison(dataset.split, prodResult, candResult);
    comparison.push(...splitComparison);

    splits[splitKey] = {
      policies,
      extractionMetrics,
    };
  }

  return {
    datasetVersion,
    splits,
    comparison,
  };
}
