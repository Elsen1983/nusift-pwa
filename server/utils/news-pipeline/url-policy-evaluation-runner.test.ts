import { describe, it, expect } from "vitest";
import {
  createTuningDataset,
  createHoldoutDataset,
  evaluateProductionUrlPolicy,
  evaluateCandidateUrlPolicy,
  CURRENT_PRODUCTION_URL_POLICY_VERSION,
  CANDIDATE_URL_POLICY_VERSION,
  URL_EVALUATION_DATASET_VERSION,
} from "./url-policy-evaluation";
import {
  runUrlPolicyEvaluation,
  type EvaluationReport,
  type PolicyEvaluationCounts,
  type PolicyEvaluationRates,
  type EvaluationSampleEntry,
  type BaselineComparisonEntry,
} from "./url-policy-evaluation-runner";

import { classifyArticleUrl } from "./article-url-policy";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal dataset with known labels for deterministic metric testing.
 */
function makeTestDataset(
  labels: Array<{
    url: string;
    expectedAcceptanceClass: "ACCEPTABLE_ARTICLE" | "NON_ARTICLE";
    shouldAccept: boolean;
    extractionExpected?: boolean;
  }>,
  split: "tuning" | "holdout" = "tuning",
) {
  const labelledAt = "2026-07-30T00:00:00.000Z";
  return {
    datasetVersion: URL_EVALUATION_DATASET_VERSION,
    split,
    labels: labels.map((l, i) => ({
      url: l.url,
      expectedType: l.expectedAcceptanceClass === "ACCEPTABLE_ARTICLE" ? "ARTICLE" as const : "OTHER" as const,
      expectedAcceptanceClass: l.expectedAcceptanceClass,
      shouldAccept: l.shouldAccept,
      extractionExpected: l.extractionExpected,
      labelVersion: 1,
      labelledAt,
      labelledBy: "test-runner",
      discoveryMethod: "MANUAL" as const,
      sourceId: `test-source-${i}`,
    })),
  };
}

// ─── Full Dataset Evaluation ────────────────────────────────────────────────

describe("runUrlPolicyEvaluation — full datasets", () => {
  it("evaluates tuning dataset and returns deterministic output", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    expect(report.datasetVersion).toBe(URL_EVALUATION_DATASET_VERSION);
    expect(report.splits).toHaveProperty("tuning");
    expect(report.splits.tuning).toBeDefined();
  });

  it("evaluates both tuning and holdout datasets", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    expect(report.splits).toHaveProperty("tuning");
    expect(report.splits).toHaveProperty("holdout");
  });

  it("reports production and candidate policies for each split", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const tuning = report.splits.tuning!;
    expect(tuning.policies).toHaveProperty("current-production-v1");
    expect(tuning.policies).toHaveProperty("candidate-v1");
  });

  it("production evaluator never returns UNCERTAIN in any split", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    for (const splitKey of ["tuning", "holdout"]) {
      const split = report.splits[splitKey];
      const prodCounts = split!.policies["current-production-v1"]!.counts;
      expect(prodCounts.uncertain).toBe(0);
    }
  });

  it("candidate evaluator has UNCERTAIN decisions in tuning", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const candCounts = report.splits.tuning!.policies["candidate-v1"]!.counts;
    expect(candCounts.uncertain).toBeGreaterThan(0);
  });

  it("has extraction metrics in each split", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    for (const splitKey of ["tuning", "holdout"]) {
      const split = report.splits[splitKey];
      expect(split!.extractionMetrics).toBeDefined();
      expect(split!.extractionMetrics!.extractionExpectedCount).toBeGreaterThanOrEqual(0);
      expect(split!.extractionMetrics!.extractionNotExpectedCount).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Metric Calculations ────────────────────────────────────────────────────

describe("metric calculations", () => {
  it("articleAcceptPrecision = acceptedTrueArticles / all accepted URLs", () => {
    // 4 true articles accepted, 1 non-article accepted = 5 accepted total
    const dataset = makeTestDataset([
      { url: "https://example.com/article1", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
      { url: "https://example.com/article2", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
      { url: "https://example.com/article3", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
      { url: "https://example.com/article4", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
      { url: "https://example.com/leakage", expectedAcceptanceClass: "NON_ARTICLE", shouldAccept: false },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    // Precision = 4/5 = 0.8
    expect(prod.rates.articleAcceptPrecision).toBe(0.8);
  });

  it("articleAcceptPrecision is 0 when no URLs accepted", () => {
    // Use only URLs that are definitely rejected (e.g., all non-article, all rejected)
    const dataset = makeTestDataset([
      { url: "https://example.com/login", expectedAcceptanceClass: "NON_ARTICLE", shouldAccept: false },
      { url: "https://example.com/terms", expectedAcceptanceClass: "NON_ARTICLE", shouldAccept: false },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    // Production rejects non-article URLs → no ACCEPT → precision = 0
    expect(prod.rates.articleAcceptPrecision).toBe(0);
  });

  it("articleAcceptRecall = acceptedTrueArticles / all true articles", () => {
    // 3 true articles total, 2 accepted, 1 rejected
    const dataset = makeTestDataset([
      { url: "https://www.bbc.com/news/articles/c1234567890o", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
      { url: "https://www.rte.ie/news/business/2026/0729/1585607-ubs-quarterly-results/", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
      // This URL is a true article but gets rejected by production (radio clip with topic structure)
      { url: "https://www.rte.ie/radio/clips/11809297", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    // classifyArticleUrl rejects radio clips → the 3rd URL is REJECTed
    // All 3 are true articles, 2 accepted: recall = 2/3 ≈ 0.666667
    expect(prod.rates.articleAcceptRecall).toBeGreaterThan(0.66);
    expect(prod.rates.articleAcceptRecall).toBeLessThan(0.67);
  });

  it("articleAcceptRecall is 0 when no true articles", () => {
    const dataset = makeTestDataset([
      { url: "https://example.com/login", expectedAcceptanceClass: "NON_ARTICLE", shouldAccept: false },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    expect(prod.rates.articleAcceptRecall).toBe(0);
  });

  it("falseRejectRate = rejectedTrueArticles / all true articles", () => {
    // 3 true articles total, 1 rejected
    const dataset = makeTestDataset([
      { url: "https://www.bbc.com/news/articles/c1234567890o", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
      { url: "https://www.rte.ie/news/business/2026/0729/1585607-ubs-quarterly-results/", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
      { url: "https://www.rte.ie/radio/clips/11809297", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    // 1 rejected (radio clip) / 3 true articles
    expect(prod.rates.falseRejectRate).toBeGreaterThan(0.33);
    expect(prod.rates.falseRejectRate).toBeLessThan(0.34);
  });

  it("nonArticleLeakageRate denominator is all accepted URLs", () => {
    // 2 accepted true articles, 1 accepted non-article = 3 accepted total
    // Leakage rate = 1/3 ≈ 0.333333
    const dataset = makeTestDataset([
      { url: "https://www.bbc.com/news/articles/c1234567890o", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
      { url: "https://www.rte.ie/news/business/2026/0729/1585607-ubs-quarterly-results/", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true },
      // gallery URL is accepted by production: has numeric_id + deep_path that outweigh weak gallery negative
      { url: "https://example.com/gallery/12345678/some-photo-album", expectedAcceptanceClass: "NON_ARTICLE", shouldAccept: false },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    // Production ACCEPTs the gallery URL (numeric_id + deep_path override weak negative)
    // So accepted = 3, acceptedNonArticles = 1
    expect(prod.counts.accepted).toBe(3);
    expect(prod.counts.acceptedNonArticles).toBe(1);
    expect(prod.rates.nonArticleLeakageRate).toBeGreaterThan(0.33);
    expect(prod.rates.nonArticleLeakageRate).toBeLessThan(0.34);
  });

  it("nonArticleLeakageRate is 0 when no URLs accepted", () => {
    const dataset = makeTestDataset([
      { url: "https://example.com/login", expectedAcceptanceClass: "NON_ARTICLE", shouldAccept: false },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    expect(prod.rates.nonArticleLeakageRate).toBe(0);
  });

  it("uncertainRate = UNCERTAIN decisions / all evaluated URLs", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    const expectedRate = cand.counts.uncertain / cand.counts.evaluated;
    expect(cand.rates.uncertainRate).toBeCloseTo(expectedRate, 6);
  });

  it("policyCoverage = (ACCEPT + REJECT) / all evaluated URLs", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    const covered = cand.counts.accepted + cand.counts.rejected;
    const expectedCoverage = covered / cand.counts.evaluated;
    expect(cand.rates.policyCoverage).toBeCloseTo(expectedCoverage, 6);
  });

  it("production policyCoverage is always 1 (no UNCERTAIN)", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    for (const splitKey of ["tuning", "holdout"]) {
      const prod = report.splits[splitKey]!.policies["current-production-v1"]!;
      expect(prod.rates.policyCoverage).toBe(1);
    }
  });

  it("uncertainArticleRate = uncertainTrueArticles / all true articles", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    const expectedRate = cand.counts.trueArticles > 0
      ? cand.counts.uncertainTrueArticles / cand.counts.trueArticles
      : 0;
    expect(cand.rates.uncertainArticleRate).toBeCloseTo(expectedRate, 6);
  });

  it("uncertainNonArticleRate = uncertainNonArticles / all non-articles", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    const expectedRate = cand.counts.nonArticles > 0
      ? cand.counts.uncertainNonArticles / cand.counts.nonArticles
      : 0;
    expect(cand.rates.uncertainNonArticleRate).toBeCloseTo(expectedRate, 6);
  });

  it("uncertainArticleRate is 0 when no true articles", () => {
    const dataset = makeTestDataset([
      { url: "https://example.com/login", expectedAcceptanceClass: "NON_ARTICLE", shouldAccept: false },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    expect(cand.rates.uncertainArticleRate).toBe(0);
  });
});

// ─── Tuning and Holdout Reported Separately ────────────────────────────────

describe("tuning and holdout reported separately", () => {
  it("tuning counts are different from holdout counts", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    const tuningProd = report.splits.tuning!.policies["current-production-v1"]!;
    const holdoutProd = report.splits.holdout!.policies["current-production-v1"]!;
    expect(tuningProd.counts.evaluated).not.toBe(holdoutProd.counts.evaluated);
  });

  it("each split has its own extraction metrics", () => {
    const tuning = createTuningDataset();
    const holdout = createHoldoutDataset();
    const report = runUrlPolicyEvaluation(tuning, holdout);
    const tuningExt = report.splits.tuning!.extractionMetrics!;
    const holdoutExt = report.splits.holdout!.extractionMetrics!;
    expect(tuningExt.extractionExpectedCount).toBe(tuning.labels.filter((label) => label.extractionExpected).length);
    expect(holdoutExt.extractionExpectedCount).toBe(holdout.labels.filter((label) => label.extractionExpected).length);
  });
});

// ─── Production and Candidate Reported Separately ──────────────────────────

describe("production and candidate reported separately", () => {
  it("production and candidate have different uncertain counts", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    expect(prod.counts.uncertain).toBe(0);
    expect(cand.counts.uncertain).toBeGreaterThan(0);
  });

  it("production and candidate have different policy versions", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    // The policy versions aren't in the report output directly, but the
    // counts reflect the different behavior
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    // Same evaluated count
    expect(prod.counts.evaluated).toBe(cand.counts.evaluated);
    // Different uncertain count
    expect(prod.counts.uncertain).not.toBe(cand.counts.uncertain);
  });
});

// ─── Deterministic Output ───────────────────────────────────────────────────

describe("deterministic output", () => {
  it("same dataset produces same report (calling twice)", () => {
    const report1 = runUrlPolicyEvaluation(createTuningDataset());
    const report2 = runUrlPolicyEvaluation(createTuningDataset());
    expect(JSON.stringify(report1)).toBe(JSON.stringify(report2));
  });

  it("same datasets produce same report (calling twice)", () => {
    const report1 = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    const report2 = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    expect(JSON.stringify(report1)).toBe(JSON.stringify(report2));
  });

  it("split ordering is stable (tuning before holdout)", () => {
    const report = runUrlPolicyEvaluation(createHoldoutDataset(), createTuningDataset());
    const keys = Object.keys(report.splits);
    expect(keys[0]).toBe("tuning");
    expect(keys[1]).toBe("holdout");
  });

  it("comparison entries are in stable metric order", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const metrics = report.comparison.map((e) => e.metric);
    expect(metrics).toEqual([
      "articleAcceptPrecision",
      "articleAcceptRecall",
      "falseRejectRate",
      "nonArticleLeakageRate",
      "uncertainRate",
      "policyCoverage",
      "uncertainArticleRate",
      "uncertainNonArticleRate",
    ]);
  });

  it("samples are sorted by URL", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    const samples = cand.samples.uncertainSamples;
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.url.localeCompare(samples[i - 1]!.url)).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Rate Precision ─────────────────────────────────────────────────────────

describe("rate precision", () => {
  it("rates are rounded to 6 decimal places", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    for (const [key, value] of Object.entries(prod.rates)) {
      const str = String(value);
      // Allow integer values (0, 1) to not have decimal places
      if (value !== 0 && value !== 1) {
        const decimalPart = str.includes(".") ? str.split(".")[1]! : "";
        expect(decimalPart.length).toBeLessThanOrEqual(6);
      }
    }
  });
});

// ─── Raw Counts Preserved Next to Rates ─────────────────────────────────────

describe("raw counts preserved next to rates", () => {
  it("counts includes all required fields", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    const c = prod.counts;
    expect(c).toHaveProperty("evaluated");
    expect(c).toHaveProperty("accepted");
    expect(c).toHaveProperty("rejected");
    expect(c).toHaveProperty("uncertain");
    expect(c).toHaveProperty("trueArticles");
    expect(c).toHaveProperty("acceptedTrueArticles");
    expect(c).toHaveProperty("rejectedTrueArticles");
    expect(c).toHaveProperty("uncertainTrueArticles");
    expect(c).toHaveProperty("nonArticles");
    expect(c).toHaveProperty("acceptedNonArticles");
    expect(c).toHaveProperty("rejectedNonArticles");
    expect(c).toHaveProperty("uncertainNonArticles");
    expect(typeof c.evaluated).toBe("number");
    expect(typeof c.accepted).toBe("number");
    expect(typeof c.rejected).toBe("number");
  });

  it("rate calculations are consistent with raw counts", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    const c = prod.counts;
    const r = prod.rates;

    // Verify a few key relationships
    expect(c.evaluated).toBe(c.accepted + c.rejected + c.uncertain);
    expect(c.trueArticles).toBe(c.acceptedTrueArticles + c.rejectedTrueArticles + c.uncertainTrueArticles);
    expect(c.nonArticles).toBe(c.acceptedNonArticles + c.rejectedNonArticles + c.uncertainNonArticles);
  });
});

// ─── Extraction Metrics Separated ───────────────────────────────────────────

describe("extraction metrics separated from URL classification", () => {
  it("extraction metrics are in a separate section", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const split = report.splits.tuning!;
    // extractionMetrics is separate from policies
    expect(split.extractionMetrics).toBeDefined();
    expect(split.policies).not.toHaveProperty("extractionMetrics");
  });

  it("extraction metrics include expected, not-expected, and coverage", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const ext = report.splits.tuning!.extractionMetrics!;
    expect(ext).toHaveProperty("extractionExpectedCount");
    expect(ext).toHaveProperty("extractionNotExpectedCount");
    expect(ext).toHaveProperty("extractionExpectationCoverage");
  });

  it("extractionExpectationCoverage is (expected / (expected + not-expected))", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const ext = report.splits.tuning!.extractionMetrics!;
    const total = ext.extractionExpectedCount + ext.extractionNotExpectedCount;
    const expectedCoverage = total > 0 ? ext.extractionExpectedCount / total : 0;
    expect(ext.extractionExpectationCoverage).toBeCloseTo(expectedCoverage, 6);
  });

  it("extraction does not alter URL policy metrics", () => {
    const dataset = makeTestDataset([
      { url: "https://www.bbc.com/news/articles/c1234567890o", expectedAcceptanceClass: "ACCEPTABLE_ARTICLE", shouldAccept: true, extractionExpected: true },
      { url: "https://example.com/login", expectedAcceptanceClass: "NON_ARTICLE", shouldAccept: false, extractionExpected: false },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    const ext = report.splits.tuning!.extractionMetrics!;

    // URL policy metrics are based on ACCEPT/REJECT/UNCERTAIN, not extractionExpected
    expect(prod.counts.evaluated).toBe(2);
    expect(ext.extractionExpectedCount).toBe(1);
    expect(ext.extractionNotExpectedCount).toBe(1);
  });
});

// ─── Samples ────────────────────────────────────────────────────────────────

describe("samples are deterministic", () => {
  it("has falseRejectSamples array", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    expect(Array.isArray(prod.samples.falseRejectSamples)).toBe(true);
  });

  it("has nonArticleLeakageSamples array", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    expect(Array.isArray(prod.samples.nonArticleLeakageSamples)).toBe(true);
  });

  it("candidate has uncertainSamples", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    expect(Array.isArray(cand.samples.uncertainSamples)).toBe(true);
    expect(cand.samples.uncertainSamples.length).toBeGreaterThan(0);
  });

  it("uncertain samples have url, decision, expectedAcceptanceClass", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    for (const sample of cand.samples.uncertainSamples) {
      expect(sample).toHaveProperty("url");
      expect(sample).toHaveProperty("decision");
      expect(sample).toHaveProperty("expectedAcceptanceClass");
      expect(sample.decision).toBe("UNCERTAIN");
    }
  });

  it("false reject samples have url, decision, and expectedAcceptanceClass", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    for (const sample of prod.samples.falseRejectSamples) {
      expect(sample).toHaveProperty("url");
      expect(sample).toHaveProperty("decision");
      expect(sample).toHaveProperty("expectedAcceptanceClass");
      expect(sample.decision).toBe("REJECT");
      expect(sample.expectedAcceptanceClass).toBe("ACCEPTABLE_ARTICLE");
    }
  });

  it("non-article leakage samples have url, decision, and expectedAcceptanceClass", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    for (const sample of prod.samples.nonArticleLeakageSamples) {
      expect(sample).toHaveProperty("url");
      expect(sample).toHaveProperty("decision");
      expect(sample).toHaveProperty("expectedAcceptanceClass");
      expect(sample.decision).toBe("ACCEPT");
      expect(sample.expectedAcceptanceClass).toBe("NON_ARTICLE");
    }
  });

  it("samples are deterministic (same between runs)", () => {
    const report1 = runUrlPolicyEvaluation(createTuningDataset());
    const report2 = runUrlPolicyEvaluation(createTuningDataset());
    const s1 = report1.splits.tuning!.policies["current-production-v1"]!.samples;
    const s2 = report2.splits.tuning!.policies["current-production-v1"]!.samples;
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
  });

  it("sample evidence is small (no full HTML or large fragments)", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    for (const sample of cand.samples.uncertainSamples) {
      expect(typeof sample.url).toBe("string");
      expect(sample.url.length).toBeLessThan(500);
      expect(sample.decision).toBe("UNCERTAIN");
      expect(sample.expectedAcceptanceClass.length).toBeLessThan(50);
    }
  });
});

// ─── Baseline Comparison ────────────────────────────────────────────────────

describe("baseline comparison", () => {
  it("includes comparison entries for each split", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    expect(report.comparison.length).toBeGreaterThan(0);
  });

  it("each comparison entry has required fields", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    for (const entry of report.comparison) {
      expect(entry).toHaveProperty("split");
      expect(entry).toHaveProperty("productionPolicyVersion");
      expect(entry).toHaveProperty("candidatePolicyVersion");
      expect(entry).toHaveProperty("metric");
      expect(entry).toHaveProperty("productionValue");
      expect(entry).toHaveProperty("candidateValue");
      expect(entry).toHaveProperty("delta");
    }
  });

  it("delta equals candidateValue - productionValue", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    for (const entry of report.comparison) {
      expect(entry.delta).toBeCloseTo(entry.candidateValue - entry.productionValue, 6);
    }
  });

  it("comparison includes uncertainRate delta (production vs candidate)", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const uncertainEntry = report.comparison.find(
      (e) => e.metric === "uncertainRate" && e.split === "tuning",
    );
    expect(uncertainEntry).toBeDefined();
    // Production has 0 uncertain, candidate has > 0 uncertain
    expect(uncertainEntry!.productionValue).toBe(0);
    expect(uncertainEntry!.candidateValue).toBeGreaterThan(0);
  });

  it("each split has comparison entries for all metrics", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    const expectedMetricCount = 8; // All COMPARISON_METRICS
    const tuningEntries = report.comparison.filter((e) => e.split === "tuning");
    const holdoutEntries = report.comparison.filter((e) => e.split === "holdout");
    expect(tuningEntries.length).toBe(expectedMetricCount);
    expect(holdoutEntries.length).toBe(expectedMetricCount);
  });
});

// ─── UNCERTAIN Handling ─────────────────────────────────────────────────────

describe("UNCERTAIN handling in metrics", () => {
  it("UNCERTAIN does not count as automatic false decision", () => {
    // Candidate policy can return UNCERTAIN for the gallery URL.
    // This should not count as falseReject (it's not REJECT) and
    // should not count as nonArticleLeakage (it's not ACCEPT).
    const dataset = makeTestDataset([
      { url: "https://example.com/gallery/12345678/some-photo-album", expectedAcceptanceClass: "NON_ARTICLE", shouldAccept: false },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    // Candidate returns UNCERTAIN for this URL
    expect(cand.counts.uncertain).toBe(1);
    expect(cand.counts.accepted).toBe(0);
    expect(cand.counts.rejected).toBe(0);
    // UNCERTAIN does not count toward precision/recall
    expect(cand.rates.articleAcceptPrecision).toBe(0);
    expect(cand.rates.nonArticleLeakageRate).toBe(0);
  });

  it("UNCERTAIN lowers policyCoverage", () => {
    const dataset = makeTestDataset([
      { url: "https://example.com/gallery/12345678/some-photo-album", expectedAcceptanceClass: "NON_ARTICLE", shouldAccept: false },
    ]);
    const report = runUrlPolicyEvaluation(dataset);
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    // 1 evaluated, 1 uncertain → coverage = 0
    expect(cand.rates.policyCoverage).toBe(0);
  });

  it("UNCERTAIN is reported in uncertainArticleRate and uncertainNonArticleRate", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    const uncertainTrue = cand.counts.uncertainTrueArticles;
    const uncertainNon = cand.counts.uncertainNonArticles;
    const totalUncertain = cand.counts.uncertain;

    expect(uncertainTrue + uncertainNon).toBe(totalUncertain);
  });
});

// ─── Object Key Structure Stability ─────────────────────────────────────────

describe("stable object key structure for snapshot tests", () => {
  it("report has deterministic top-level keys", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    expect(Object.keys(report).sort()).toEqual(["comparison", "datasetVersion", "splits"]);
  });

  it("split has deterministic keys", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const split = report.splits.tuning!;
    expect(Object.keys(split).sort()).toEqual(["extractionMetrics", "policies"]);
  });

  it("policy result has deterministic keys", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const prod = report.splits.tuning!.policies["current-production-v1"]!;
    expect(Object.keys(prod).sort()).toEqual(["counts", "policyKey", "policyVersion", "rates", "samples"]);
  });

  it("policy result exposes the ACTUAL policy version separately from the stable report key", () => {
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const tuning = report.splits.tuning!;

    // Stable internal keys are preserved for snapshot compatibility.
    expect(tuning.policies["current-production-v1"]!.policyKey).toBe("current-production-v1");
    expect(tuning.policies["candidate-v1"]!.policyKey).toBe("candidate-v1");

    // User-facing labels must use the real policy versions.
    expect(tuning.policies["current-production-v1"]!.policyVersion).toBe(
      CURRENT_PRODUCTION_URL_POLICY_VERSION,
    );
    expect(tuning.policies["candidate-v1"]!.policyVersion).toBe(
      CANDIDATE_URL_POLICY_VERSION,
    );

    // Comparison entries carry both real versions.
    for (const entry of report.comparison) {
      expect(entry.productionPolicyVersion).toBe(CURRENT_PRODUCTION_URL_POLICY_VERSION);
      expect(entry.candidatePolicyVersion).toBe(CANDIDATE_URL_POLICY_VERSION);
    }
  });

  it("regression: changing CANDIDATE_URL_POLICY_VERSION changes user-facing output without changing the stable report key", () => {
    // The user-facing policyVersion is derived from the actual version constant.
    const report = runUrlPolicyEvaluation(createTuningDataset());
    const json = JSON.stringify(report);

    // The real candidate version string appears in the user-facing output.
    expect(json).toContain(CANDIDATE_URL_POLICY_VERSION);

    // The stable internal report key is preserved for snapshot compatibility.
    expect(report.splits.tuning!.policies["candidate-v1"]!.policyKey).toBe("candidate-v1");
    expect(report.splits.tuning!.policies["candidate-v1"]!.policyVersion).toBe(
      CANDIDATE_URL_POLICY_VERSION,
    );

    // The version string must be independent from the stable key: if the
    // candidate version were bumped, the report key would remain "candidate-v1".
    const cand = report.splits.tuning!.policies["candidate-v1"]!;
    expect(cand.policyVersion).not.toBe("candidate-v1");
    expect(cand.policyKey).toBe("candidate-v1");
    expect(report.comparison[0]!.candidatePolicyVersion).toBe(CANDIDATE_URL_POLICY_VERSION);
  });

  it("no wall-clock duration in snapshot-compared output", () => {
    const json = JSON.stringify(runUrlPolicyEvaluation(createTuningDataset()));
    // No ISO dates or timestamps should be in the output (createdAt from
    // the evaluators is not propagated to the report — only stable fields)
    expect(json).not.toContain("createdAt");
    expect(json).not.toContain("duration");
  });
});
