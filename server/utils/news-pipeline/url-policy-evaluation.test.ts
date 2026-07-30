import { describe, it, expect } from "vitest";
import {
  // Constants
  CURRENT_PRODUCTION_URL_POLICY_VERSION,
  CANDIDATE_URL_POLICY_VERSION,
  URL_EVALUATION_DATASET_VERSION,

  // Centralized acceptance class
  ACCEPTABLE_ARTICLE_TYPES,
  deriveExpectedAcceptanceClass,

  // Dataset validation
  validateUrlEvaluationDataset,

  // Fixtures
  createTuningDataset,
  createHoldoutDataset,

  // Evaluators
  evaluateProductionUrlPolicy,
  evaluateCandidateUrlPolicy,

  // Internal helpers (tested via exports)
  isBorderlineAcceptance,
  isCandidateBorderlineAcceptance,

  // Evidence sanitization
  sanitizeEvidence,
} from "./url-policy-evaluation";
import { runUrlPolicyEvaluation } from "./url-policy-evaluation-runner";

// Also import the original to verify compatibility
import {
  isLikelyArticleUrl as existingIsLikelyArticleUrl,
  classifyArticleUrl,
} from "./article-url-policy";

// ─── Constants ──────────────────────────────────────────────────────────────

describe("policy version constants", () => {
  it("CURRENT_PRODUCTION_URL_POLICY_VERSION is a non-empty string", () => {
    expect(CURRENT_PRODUCTION_URL_POLICY_VERSION).toBeTruthy();
    expect(typeof CURRENT_PRODUCTION_URL_POLICY_VERSION).toBe("string");
  });

  it("CANDIDATE_URL_POLICY_VERSION is a non-empty string", () => {
    expect(CANDIDATE_URL_POLICY_VERSION).toBeTruthy();
    expect(typeof CANDIDATE_URL_POLICY_VERSION).toBe("string");
  });

  it("URL_EVALUATION_DATASET_VERSION is a non-empty string", () => {
    expect(URL_EVALUATION_DATASET_VERSION).toBeTruthy();
    expect(typeof URL_EVALUATION_DATASET_VERSION).toBe("string");
  });

  it("production and candidate versions are distinct", () => {
    expect(CURRENT_PRODUCTION_URL_POLICY_VERSION).not.toBe(CANDIDATE_URL_POLICY_VERSION);
  });
});

// ─── Centralized expectedAcceptanceClass ───────────────────────────────────

describe("ACCEPTABLE_ARTICLE_TYPES", () => {
  it("includes ARTICLE", () => {
    expect(ACCEPTABLE_ARTICLE_TYPES.has("ARTICLE")).toBe(true);
  });

  it("includes LIVEBLOG", () => {
    expect(ACCEPTABLE_ARTICLE_TYPES.has("LIVEBLOG")).toBe(true);
  });

  it("includes PAYWALL_ARTICLE", () => {
    expect(ACCEPTABLE_ARTICLE_TYPES.has("PAYWALL_ARTICLE")).toBe(true);
  });

  it("includes STALE_ARTICLE", () => {
    expect(ACCEPTABLE_ARTICLE_TYPES.has("STALE_ARTICLE")).toBe(true);
  });

  it("excludes LISTING", () => {
    expect(ACCEPTABLE_ARTICLE_TYPES.has("LISTING")).toBe(false);
  });

  it("excludes HOMEPAGE", () => {
    expect(ACCEPTABLE_ARTICLE_TYPES.has("HOMEPAGE")).toBe(false);
  });

  it("excludes MEDIA", () => {
    expect(ACCEPTABLE_ARTICLE_TYPES.has("MEDIA")).toBe(false);
  });

  it("excludes GALLERY", () => {
    expect(ACCEPTABLE_ARTICLE_TYPES.has("GALLERY")).toBe(false);
  });

  it("excludes BAD_CANONICAL", () => {
    expect(ACCEPTABLE_ARTICLE_TYPES.has("BAD_CANONICAL")).toBe(false);
  });

  it("excludes OTHER", () => {
    expect(ACCEPTABLE_ARTICLE_TYPES.has("OTHER")).toBe(false);
  });
});

describe("deriveExpectedAcceptanceClass", () => {
  // ACCEPTABLE_ARTICLE_TYPES → ACCEPTABLE_ARTICLE
  it('returns ACCEPTABLE_ARTICLE for "ARTICLE"', () => {
    expect(deriveExpectedAcceptanceClass("ARTICLE")).toBe("ACCEPTABLE_ARTICLE");
  });

  it('returns ACCEPTABLE_ARTICLE for "LIVEBLOG"', () => {
    expect(deriveExpectedAcceptanceClass("LIVEBLOG")).toBe("ACCEPTABLE_ARTICLE");
  });

  it('returns ACCEPTABLE_ARTICLE for "PAYWALL_ARTICLE"', () => {
    expect(deriveExpectedAcceptanceClass("PAYWALL_ARTICLE")).toBe("ACCEPTABLE_ARTICLE");
  });

  it('returns ACCEPTABLE_ARTICLE for "STALE_ARTICLE"', () => {
    expect(deriveExpectedAcceptanceClass("STALE_ARTICLE")).toBe("ACCEPTABLE_ARTICLE");
  });

  // Non-article types → NON_ARTICLE
  it('returns NON_ARTICLE for "LISTING"', () => {
    expect(deriveExpectedAcceptanceClass("LISTING")).toBe("NON_ARTICLE");
  });

  it('returns NON_ARTICLE for "HOMEPAGE"', () => {
    expect(deriveExpectedAcceptanceClass("HOMEPAGE")).toBe("NON_ARTICLE");
  });

  it('returns NON_ARTICLE for "MEDIA"', () => {
    expect(deriveExpectedAcceptanceClass("MEDIA")).toBe("NON_ARTICLE");
  });

  it('returns NON_ARTICLE for "GALLERY"', () => {
    expect(deriveExpectedAcceptanceClass("GALLERY")).toBe("NON_ARTICLE");
  });

  it('returns NON_ARTICLE for "BAD_CANONICAL"', () => {
    expect(deriveExpectedAcceptanceClass("BAD_CANONICAL")).toBe("NON_ARTICLE");
  });

  it('returns NON_ARTICLE for "OTHER"', () => {
    expect(deriveExpectedAcceptanceClass("OTHER")).toBe("NON_ARTICLE");
  });

  // Override always wins
  it('override ACCEPTABLE_ARTICLE wins for LISTING', () => {
    expect(deriveExpectedAcceptanceClass("LISTING", "ACCEPTABLE_ARTICLE")).toBe("ACCEPTABLE_ARTICLE");
  });

  it('override NON_ARTICLE wins for ARTICLE', () => {
    expect(deriveExpectedAcceptanceClass("ARTICLE", "NON_ARTICLE")).toBe("NON_ARTICLE");
  });

  // Deterministic — same input always produces same output
  it("is deterministic (same input = same output)", () => {
    const inputs: Array<{ type: Parameters<typeof deriveExpectedAcceptanceClass>[0]; override?: Parameters<typeof deriveExpectedAcceptanceClass>[1] }> = [
      { type: "ARTICLE" },
      { type: "LISTING" },
      { type: "MEDIA" },
      { type: "LIVEBLOG", override: "ACCEPTABLE_ARTICLE" },
      { type: "OTHER", override: "NON_ARTICLE" },
    ];
    for (const input of inputs) {
      const first = deriveExpectedAcceptanceClass(input.type, input.override);
      const second = deriveExpectedAcceptanceClass(input.type, input.override);
      expect(first).toBe(second);
    }
  });
});

// ─── Dataset Fixtures ──────────────────────────────────────────────────────

describe("createTuningDataset", () => {
  const dataset = createTuningDataset();

  it("returns a valid dataset object", () => {
    expect(dataset).toBeDefined();
    expect(typeof dataset).toBe("object");
  });

  it("has datasetVersion", () => {
    expect(dataset.datasetVersion).toBe(URL_EVALUATION_DATASET_VERSION);
  });

  it('has split "tuning"', () => {
    expect(dataset.split).toBe("tuning");
  });

  it("has labels array with at least 100 entries", () => {
    expect(Array.isArray(dataset.labels)).toBe(true);
    expect(dataset.labels.length).toBeGreaterThanOrEqual(100);
  });

  it("every label has required fields", () => {
    for (const label of dataset.labels) {
      expect(typeof label.url).toBe("string");
      expect(label.url).toBeTruthy();
      expect(typeof label.expectedType).toBe("string");
      expect(typeof label.expectedAcceptanceClass).toBe("string");
      expect(typeof label.shouldAccept).toBe("boolean");
      expect(typeof label.labelVersion).toBe("number");
      expect(typeof label.labelledAt).toBe("string");
      expect(typeof label.labelledBy).toBe("string");
    }
  });

  it("includes stratified examples", () => {
    const types = dataset.labels.map((l) => l.expectedType);
    expect(types).toContain("ARTICLE");
    expect(types).toContain("LISTING");
    expect(types).toContain("HOMEPAGE");
    expect(types).toContain("MEDIA");
    expect(types).toContain("LIVEBLOG");
    expect(types).toContain("GALLERY");
    expect(types).toContain("PAYWALL_ARTICLE");
    expect(types).toContain("STALE_ARTICLE");
    expect(types).toContain("BAD_CANONICAL");
    expect(types).toContain("OTHER");
  });

  it("includes various discovery methods", () => {
    const methods = dataset.labels.map((l) => l.discoveryMethod).filter(Boolean);
    expect(methods.length).toBeGreaterThan(0);
  });
});

describe("createHoldoutDataset", () => {
  const dataset = createHoldoutDataset();

  it("returns a valid dataset object", () => {
    expect(dataset).toBeDefined();
  });

  it("has datasetVersion", () => {
    expect(dataset.datasetVersion).toBe(URL_EVALUATION_DATASET_VERSION);
  });

  it('has split "holdout"', () => {
    expect(dataset.split).toBe("holdout");
  });

  it("has labels array with at least 50 entries", () => {
    expect(Array.isArray(dataset.labels)).toBe(true);
    expect(dataset.labels.length).toBeGreaterThanOrEqual(50);
  });

  it("every label has required fields", () => {
    for (const label of dataset.labels) {
      expect(typeof label.url).toBe("string");
      expect(label.url).toBeTruthy();
      expect(typeof label.expectedType).toBe("string");
      expect(typeof label.expectedAcceptanceClass).toBe("string");
      expect(typeof label.shouldAccept).toBe("boolean");
    }
  });
});

// ─── Dataset Validation ────────────────────────────────────────────────────

describe("validateUrlEvaluationDataset", () => {
  it("validates a valid tuning dataset", () => {
    const result = validateUrlEvaluationDataset(createTuningDataset());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.datasetVersion).toBe(URL_EVALUATION_DATASET_VERSION);
    expect(result.split).toBe("tuning");
    expect(result.labelCount).toBeGreaterThan(0);
  });

  it("validates a valid holdout dataset", () => {
    const result = validateUrlEvaluationDataset(createHoldoutDataset());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.datasetVersion).toBe(URL_EVALUATION_DATASET_VERSION);
    expect(result.split).toBe("holdout");
  });

  it("rejects a null dataset", () => {
    const result = validateUrlEvaluationDataset(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a non-object dataset", () => {
    const result = validateUrlEvaluationDataset("invalid");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects missing datasetVersion", () => {
    const result = validateUrlEvaluationDataset({
      datasetVersion: "",
      split: "tuning",
      labels: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "datasetVersion")).toBe(true);
  });

  it("rejects invalid split", () => {
    const result = validateUrlEvaluationDataset({
      datasetVersion: URL_EVALUATION_DATASET_VERSION,
      split: "invalid",
      labels: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "split")).toBe(true);
  });

  it("rejects non-array labels", () => {
    const result = validateUrlEvaluationDataset({
      datasetVersion: URL_EVALUATION_DATASET_VERSION,
      split: "tuning",
      labels: "not-an-array",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "labels")).toBe(true);
  });

  it("rejects malformed labels with missing url", () => {
    const dataset = createTuningDataset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dataset.labels[0] as any).url = "";
    const result = validateUrlEvaluationDataset(dataset);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "url")).toBe(true);
  });

  it("rejects malformed labels with invalid expectedType", () => {
    const dataset = createTuningDataset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dataset.labels[0] as any).expectedType = "INVALID_TYPE";
    const result = validateUrlEvaluationDataset(dataset);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "expectedType")).toBe(true);
  });

  it("rejects malformed labels with invalid expectedAcceptanceClass", () => {
    const dataset = createTuningDataset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dataset.labels[0] as any).expectedAcceptanceClass = "MAYBE";
    const result = validateUrlEvaluationDataset(dataset);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "expectedAcceptanceClass")).toBe(true);
  });

  it("rejects malformed labels with non-boolean shouldAccept", () => {
    const dataset = createTuningDataset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dataset.labels[0] as any).shouldAccept = "yes";
    const result = validateUrlEvaluationDataset(dataset);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "shouldAccept")).toBe(true);
  });

  it("reports errors for all malformed labels, not just the first", () => {
    const dataset = createTuningDataset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dataset.labels[0] as any).url = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dataset.labels[0] as any).shouldAccept = "maybe";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dataset.labels[1] as any).expectedType = "INVALID";
    const result = validateUrlEvaluationDataset(dataset);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("preserves datasetVersion in result even for invalid datasets", () => {
    const result = validateUrlEvaluationDataset({
      datasetVersion: "test-version",
      split: "tuning",
      labels: [],
    });
    expect(result.datasetVersion).toBe("test-version");
  });

  it("preserves split in result even for invalid datasets", () => {
    const result = validateUrlEvaluationDataset({
      datasetVersion: URL_EVALUATION_DATASET_VERSION,
      split: "holdout",
      labels: [],
    });
    expect(result.split).toBe("holdout");
  });
});

// ─── Production Policy Evaluator ───────────────────────────────────────────

describe("evaluateProductionUrlPolicy", () => {
  it("returns ACCEPT for a valid article URL", () => {
    const result = evaluateProductionUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
    });
    expect(result.decision).toBe("ACCEPT");
    expect(result.enforcementMode).toBe("ENFORCED");
    expect(result.policyVersion).toBe(CURRENT_PRODUCTION_URL_POLICY_VERSION);
  });

  it("returns REJECT for a non-article URL", () => {
    const result = evaluateProductionUrlPolicy({
      url: "https://www.rte.ie/radio/clips/11809297",
    });
    expect(result.decision).toBe("REJECT");
    expect(result.reasonCode).toBeTruthy();
  });

  it("never returns UNCERTAIN, even for borderline URLs that trigger UNCERTAIN in candidate", () => {
    // Explicit regression: the gallery URL that triggers UNCERTAIN in the
    // candidate evaluator must NOT trigger UNCERTAIN in production.
    const urls = [
      "https://www.bbc.com/news/articles/c1234567890o",
      "https://www.rte.ie/radio/clips/11809297",
      "https://example.com/",
      "https://example.com/news/article-slug",
      "https://example.com/login",
      // This URL triggers UNCERTAIN in candidate — must stay ACCEPT in production
      "https://example.com/gallery/12345678/some-photo-album",
    ];
    for (const url of urls) {
      const result = evaluateProductionUrlPolicy({ url });
      expect(["ACCEPT", "REJECT"]).toContain(result.decision);
    }
  });

  it("includes evidence with signals", () => {
    const result = evaluateProductionUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
    });
    expect(result.evidence).toBeDefined();
    expect(Array.isArray(result.evidence!.signals)).toBe(true);
  });

  it("preserves sourceId and categoryId when provided", () => {
    const result = evaluateProductionUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
      sourceId: "bbc-com",
      categoryId: "cat-1",
    });
    expect(result.sourceId).toBe("bbc-com");
    expect(result.categoryId).toBe("cat-1");
  });

  it("preserves agent and stage when provided", () => {
    const result = evaluateProductionUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
      agent: "AGENT_1",
      stage: "rss-ingest",
    });
    expect(result.agent).toBe("AGENT_1");
    expect(result.stage).toBe("rss-ingest");
  });

  it("has createdAt as ISO string", () => {
    const result = evaluateProductionUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
    });
    expect(result.createdAt).toBeTruthy();
    expect(() => new Date(result.createdAt)).not.toThrow();
  });

  it("is side-effect-free (same URL produces same result)", () => {
    const input = { url: "https://www.bbc.com/news/articles/c1234567890o" };
    const first = evaluateProductionUrlPolicy(input);
    const second = evaluateProductionUrlPolicy(input);
    expect(first.decision).toBe(second.decision);
    expect(first.reasonCode).toBe(second.reasonCode);
    expect(JSON.stringify(first.evidence)).toBe(JSON.stringify(second.evidence));
  });
});

// ─── Candidate Policy Evaluator ────────────────────────────────────────────

describe("evaluateCandidateUrlPolicy", () => {
  it("returns ACCEPT for a valid article URL", () => {
    const result = evaluateCandidateUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
    });
    expect(result.decision).toBe("ACCEPT");
    expect(result.enforcementMode).toBe("SHADOW");
    expect(result.policyVersion).toBe(CANDIDATE_URL_POLICY_VERSION);
  });

  it("returns REJECT for a non-article URL", () => {
    const result = evaluateCandidateUrlPolicy({
      url: "https://www.rte.ie/radio/clips/11809297",
    });
    expect(result.decision).toBe("REJECT");
  });

  it("returns UNCERTAIN for a borderline gallery URL with weak signals", () => {
    // This URL is accepted by production (numeric_id + deep_path outweigh
    // weak gallery negative) but the candidate policy has low confidence
    // because there are no strong article signals (date_path, long_slug,
    // article_segment).
    const url = "https://example.com/gallery/12345678/some-photo-album";

    // First confirm production says ACCEPT
    const prod = evaluateProductionUrlPolicy({ url });
    expect(prod.decision).toBe("ACCEPT");
    expect(prod.enforcementMode).toBe("ENFORCED");
    expect(prod.policyVersion).toBe(CURRENT_PRODUCTION_URL_POLICY_VERSION);

    // Candidate says UNCERTAIN
    const cand = evaluateCandidateUrlPolicy({ url });
    expect(cand.decision).toBe("UNCERTAIN");
    expect(cand.enforcementMode).toBe("SHADOW");
    expect(cand.policyVersion).toBe(CANDIDATE_URL_POLICY_VERSION);
    expect(cand.reasonCode).toBe("low_article_url_confidence");
    expect(cand.url).toBe(url);

    // Evidence should contain signals and a reason
    expect(cand.evidence).toBeDefined();
    expect(Array.isArray(cand.evidence!.signals)).toBe(true);
    expect(cand.evidence!.signals).toContain("neg:gallery");
    expect(cand.evidence!.signals).toContain("pos:numeric_id");
    expect(cand.evidence!.signals).toContain("pos:deep_path");
    expect(cand.evidence!.reason).toBe("Signals suggest borderline article confidence");
  });

  it("production never returns UNCERTAIN even for borderline URL", () => {
    // Regression: the same URL that triggers UNCERTAIN in candidate
    // must still get ACCEPT from production evaluator.
    const url = "https://example.com/gallery/12345678/some-photo-album";
    const prod = evaluateProductionUrlPolicy({ url });
    expect(prod.decision).toBe("ACCEPT");
    expect(prod.enforcementMode).toBe("ENFORCED");
    // Must not be UNCERTAIN
    expect(["ACCEPT", "REJECT"]).toContain(prod.decision);
  });

  it("is in SHADOW mode", () => {
    const result = evaluateCandidateUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
    });
    expect(result.enforcementMode).toBe("SHADOW");
  });

  it("includes evidence with signals", () => {
    const result = evaluateCandidateUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
    });
    expect(result.evidence).toBeDefined();
    expect(Array.isArray(result.evidence!.signals)).toBe(true);
  });

  it("preserves sourceId, categoryId, agent, stage, discoveryMethod", () => {
    const result = evaluateCandidateUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
      sourceId: "bbc-com",
      categoryId: "cat-1",
      agent: "AGENT_2",
      stage: "sitemap-discovery",
      discoveryMethod: "SITEMAP",
    });
    expect(result.sourceId).toBe("bbc-com");
    expect(result.categoryId).toBe("cat-1");
    expect(result.agent).toBe("AGENT_2");
    expect(result.stage).toBe("sitemap-discovery");
    expect(result.discoveryMethod).toBe("SITEMAP");
  });

  it("is side-effect-free (same URL produces same result)", () => {
    const input = {
      url: "https://www.rte.ie/radio/clips/11809297",
      sourceId: "rte-ie",
    };
    const first = evaluateCandidateUrlPolicy(input);
    const second = evaluateCandidateUrlPolicy(input);
    expect(first.decision).toBe(second.decision);
    expect(first.reasonCode).toBe(second.reasonCode);
    expect(JSON.stringify(first.evidence)).toBe(JSON.stringify(second.evidence));
  });
});

// ─── ENFORCED and SHADOW representation for same URL ──────────────────────

describe("ENFORCED and SHADOW decisions for same URL", () => {
  it("can represent both ENFORCED and SHADOW for a valid article URL", () => {
    const input = { url: "https://www.bbc.com/news/articles/c1234567890o" };
    const prod = evaluateProductionUrlPolicy(input);
    const cand = evaluateCandidateUrlPolicy(input);

    // Both should agree on ACCEPT
    expect(prod.decision).toBe("ACCEPT");
    expect(cand.decision).toBe("ACCEPT");

    // But differ in enforcement mode
    expect(prod.enforcementMode).toBe("ENFORCED");
    expect(cand.enforcementMode).toBe("SHADOW");

    // Different policy versions
    expect(prod.policyVersion).toBe(CURRENT_PRODUCTION_URL_POLICY_VERSION);
    expect(cand.policyVersion).toBe(CANDIDATE_URL_POLICY_VERSION);
  });

  it("can represent both ENFORCED and SHADOW for a rejected URL", () => {
    const input = { url: "https://www.rte.ie/radio/clips/11809297" };
    const prod = evaluateProductionUrlPolicy(input);
    const cand = evaluateCandidateUrlPolicy(input);

    // Both should agree on REJECT
    expect(prod.decision).toBe("REJECT");
    expect(cand.decision).toBe("REJECT");

    // Different enforcement mode and version
    expect(prod.enforcementMode).toBe("ENFORCED");
    expect(cand.enforcementMode).toBe("SHADOW");
    expect(prod.policyVersion).toBe(CURRENT_PRODUCTION_URL_POLICY_VERSION);
    expect(cand.policyVersion).toBe(CANDIDATE_URL_POLICY_VERSION);

    // Both should have the same reason code (same underlying logic)
    expect(prod.reasonCode).toBe(cand.reasonCode);
  });

  it("preserves policyVersion, enforcementMode, reasonCode, and evidence", () => {
    const input = { url: "https://example.com/tag/politics" };
    const prod = evaluateProductionUrlPolicy(input);
    const cand = evaluateCandidateUrlPolicy(input);

    // policyVersion
    expect(prod.policyVersion).toBe(CURRENT_PRODUCTION_URL_POLICY_VERSION);
    expect(cand.policyVersion).toBe(CANDIDATE_URL_POLICY_VERSION);

    // enforcementMode
    expect(prod.enforcementMode).toBe("ENFORCED");
    expect(cand.enforcementMode).toBe("SHADOW");

    // reasonCode
    expect(prod.reasonCode).toBeTruthy();
    expect(cand.reasonCode).toBeTruthy();

    // evidence
    expect(prod.evidence).toBeDefined();
    expect(cand.evidence).toBeDefined();
    expect(prod.evidence!.signals).toBeDefined();
    expect(cand.evidence!.signals).toBeDefined();
  });
});

// ─── isBorderlineAcceptance ────────────────────────────────────────────────

describe("isBorderlineAcceptance", () => {
  it("returns false for signals with strong positives", () => {
    const signals = ["pos:date_path", "pos:long_slug", "pos:article_segment"];
    expect(isBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns false for signals with strong positive override", () => {
    const signals = ["neg:topic", "strong_negative_dominates", "override:very_strong_positive"];
    expect(isBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns false when strong negatives are overridden", () => {
    const signals = ["neg:video", "pos:date_path", "pos:long_slug", "override:strong_positive"];
    expect(isBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns true when strong negatives dominate without override", () => {
    const signals = ["neg:radio_clips", "neg:gallery", "strong_negative_dominates"];
    expect(isBorderlineAcceptance(signals)).toBe(true);
  });

  it("returns false for clean accept signals (no negatives)", () => {
    const signals = ["pos:date_path", "pos:long_slug"];
    expect(isBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns false for bare deep_path with no negatives", () => {
    const signals = ["pos:deep_path"];
    expect(isBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns true for weak negatives without strong article signals", () => {
    const signals = ["neg:gallery"];
    expect(isBorderlineAcceptance(signals)).toBe(true);
  });
});

// ─── isCandidateBorderlineAcceptance ─────────────────────────────────────

describe("isCandidateBorderlineAcceptance", () => {
  it("returns false for signals with strong article positives (date_path)", () => {
    const signals = ["neg:gallery", "pos:numeric_id", "pos:deep_path", "pos:date_path"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns false for signals with strong article positives (long_slug)", () => {
    const signals = ["neg:gallery", "pos:numeric_id", "pos:long_slug"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns false for signals with strong article positives (article_segment)", () => {
    const signals = ["neg:gallery", "pos:numeric_id", "pos:article_segment"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns false for clean accept signals (no negatives)", () => {
    const signals = ["pos:date_path", "pos:long_slug"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns false for bare deep_path with no negatives", () => {
    const signals = ["pos:deep_path"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns true for gallery with numeric_id and no strong article signals", () => {
    const signals = ["neg:gallery", "pos:numeric_id", "pos:deep_path"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(true);
  });

  it("returns true for embed with numeric_id and no strong article signals", () => {
    const signals = ["neg:embed", "pos:numeric_id"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(true);
  });

  it("returns true for multiple weak negatives without strong positives", () => {
    const signals = ["neg:gallery", "neg:clips"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(true);
  });

  it("returns true for numeric_id with weak negative and no strong positives", () => {
    const signals = ["neg:explore", "pos:numeric_id", "pos:deep_path"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(true);
  });

  it("returns false for strong_negative_dominates (production already rejects)", () => {
    const signals = ["neg:radio_clips", "neg:gallery", "strong_negative_dominates"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns false when positive override exists", () => {
    const signals = ["neg:gallery", "pos:numeric_id", "override:strong_positive"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(false);
  });

  it("returns false for gallery with long_slug (strong article signal)", () => {
    const signals = ["neg:gallery", "pos:numeric_id", "pos:deep_path", "pos:long_slug"];
    expect(isCandidateBorderlineAcceptance(signals)).toBe(false);
  });

  it("candidate and legacy agree on gallery+numeric_id+deep_path (both borderline)", () => {
    // Both functions agree this is borderline — weak neg:gallery without
    // strong article signals (date_path, long_slug, article_segment).
    const signals = ["neg:gallery", "pos:numeric_id", "pos:deep_path"];
    expect(isBorderlineAcceptance(signals)).toBe(true);
    expect(isCandidateBorderlineAcceptance(signals)).toBe(true);
  });

  it("candidate catches gallery+numeric_id+deep_path+override that legacy misses", () => {
    // With a positive override, the candidate should accept (not borderline)
    const signalsWithOverride = ["neg:gallery", "pos:numeric_id", "pos:deep_path", "override:strong_positive"];
    expect(isCandidateBorderlineAcceptance(signalsWithOverride)).toBe(false);
  });
});

// ─── Compatibility Wrapper ─────────────────────────────────────────────────

describe("isLikelyArticleUrl compatibility with article-url-policy", () => {
  it("existing isLikelyArticleUrl behaviour is unchanged", () => {
    const testUrls = [
      "https://www.bbc.com/news/articles/c1234567890o",
      "https://www.rte.ie/radio/clips/11809297",
      "https://ground.news/checkout/referral",
      "https://www.bbc.com/hindi/topics/c9wjr8rzzjzt",
      "https://example.com/",
      "https://example.com/login",
      "https://example.com/search?q=test",
      "https://example.com/author/john-smith",
      "https://example.com/tag/politics",
      "https://example.com/privacy",
      "https://example.com/feed",
      "https://www.rte.ie/news/business/2026/0729/1585607-ubs-quarterly-results/",
    ];

    for (const url of testUrls) {
      const existingResult = existingIsLikelyArticleUrl(url);
      const classifyResult = classifyArticleUrl(url).accepted;
      expect(classifyResult).toBe(existingResult);
    }
  });

  it("evaluateProductionUrlPolicy produces consistent results with classifyArticleUrl", () => {
    const input = { url: "https://www.bbc.com/news/articles/c1234567890o" };
    const evalResult = evaluateProductionUrlPolicy(input);
    const classifyResult = classifyArticleUrl(input.url);

    expect(evalResult.decision === "ACCEPT").toBe(classifyResult.accepted);
  });
});

// ─── Production Evaluator: Existing Behaviour Preservation ────────────────

describe("evaluateProductionUrlPolicy preserves existing behaviour", () => {
  // These test cases mirror the existing article-url-policy.test.ts
  // to prove behaviour is unchanged.

  const mustReject: Array<{ url: string; reasonFragment: string }> = [
    { url: "https://www.rte.ie/radio/clips/11809297", reasonFragment: "media_clip" },
    { url: "https://ground.news/checkout/referral", reasonFragment: "checkout" },
    { url: "https://www.bbc.com/hindi/topics/c9wjr8rzzjzt", reasonFragment: "listing" },
    { url: "https://example.com/search?q=test", reasonFragment: "search" },
    { url: "https://example.com/feed", reasonFragment: "feed" },
    { url: "https://example.com/author/john-smith", reasonFragment: "author" },
    { url: "https://example.com/tag/politics", reasonFragment: "listing" },
    { url: "https://example.com/privacy", reasonFragment: "utility" },
    { url: "https://example.com/podcast/latest-episode", reasonFragment: "media_clip" },
    { url: "https://example.com/login", reasonFragment: "account" },
    { url: "https://example.com/terms", reasonFragment: "utility" },
  ];

  for (const { url, reasonFragment } of mustReject) {
    it(`rejects ${url} via production evaluator`, () => {
      const result = evaluateProductionUrlPolicy({ url });
      expect(result.decision).toBe("REJECT");
      expect(result.reasonCode).toContain(reasonFragment);
    });
  }

  const mustAccept: string[] = [
    "https://www.rte.ie/news/business/2026/0729/1585607-ubs-quarterly-results/",
    "https://www.bbc.com/news/articles/c1234567890o",
    "https://www.nba.com/news/nba-announces-team-partnership-ticket-sales-service-awards-2025-26-season",
    "https://timesofindia.indiatimes.com/world/europe/example-news-title/articleshow/123456789.cms",
    "https://pecaverzum.hu/aktualis/budapesten-es-meg-negy-helyszinen-dolt-meg-a-legalacsonyabb-dunai-vizallas-rekordja",
    "https://www.independent.ie/irish-news/courts/example-story-title/a123456789.html",
  ];

  for (const url of mustAccept) {
    it(`accepts ${url} via production evaluator`, () => {
      const result = evaluateProductionUrlPolicy({ url });
      expect(result.decision).toBe("ACCEPT");
    });
  }
});

// ─── Side-Effect-Free Verification ─────────────────────────────────────────

describe("evaluators are side-effect-free", () => {
  it("production evaluator does not modify input", () => {
    const input = { url: "https://example.com/news/article", sourceId: "test" };
    const frozen = JSON.stringify(input);
    evaluateProductionUrlPolicy(input);
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("candidate evaluator does not modify input", () => {
    const input = { url: "https://example.com/news/article", sourceId: "test" };
    const frozen = JSON.stringify(input);
    evaluateCandidateUrlPolicy(input);
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("production evaluator returns fresh objects each call", () => {
    const input = { url: "https://example.com/news/article" };
    const a = evaluateProductionUrlPolicy(input);
    const b = evaluateProductionUrlPolicy(input);
    expect(a).not.toBe(b); // Different object references
  });

  it("candidate evaluator returns fresh objects each call", () => {
    const input = { url: "https://example.com/news/article" };
    const a = evaluateCandidateUrlPolicy(input);
    const b = evaluateCandidateUrlPolicy(input);
    expect(a).not.toBe(b); // Different object references
  });

  it("classifyArticleUrl behaviour is unchanged (regression check)", () => {
    // Critical known examples from the codebase
    expect(classifyArticleUrl("https://www.rte.ie/radio/clips/11809297").accepted).toBe(false);
    expect(classifyArticleUrl("https://ground.news/checkout/referral").accepted).toBe(false);
    expect(classifyArticleUrl("https://www.bbc.com/hindi/topics/c9wjr8rzzjzt").accepted).toBe(false);
    expect(classifyArticleUrl("https://www.bbc.com/news/articles/c1234567890o").accepted).toBe(true);
    expect(classifyArticleUrl("https://www.rte.ie/news/business/2026/0729/1585607-ubs-quarterly-results/").accepted).toBe(true);
  });
});

// ─── Evidence Sanitization ─────────────────────────────────────────────────

describe("sanitizeEvidence", () => {
  it("returns undefined for undefined input", () => {
    expect(sanitizeEvidence(undefined)).toBeUndefined();
  });

  it("passes through normal evidence with signals array", () => {
    const evidence = { signals: ["pos:date_path", "pos:long_slug"] };
    const result = sanitizeEvidence(evidence);
    expect(result).toEqual(evidence);
  });

  it("truncates signals array to 20 entries", () => {
    const signals = Array.from({ length: 50 }, (_, i) => `signal_${i}`);
    const result = sanitizeEvidence({ signals });
    expect(Array.isArray(result!.signals)).toBe(true);
    expect((result!.signals as string[]).length).toBe(20);
    expect(result!.signalsTruncated).toBe(true);
  });

  it("does not truncate signals array under 20 entries", () => {
    const signals = Array.from({ length: 10 }, (_, i) => `signal_${i}`);
    const result = sanitizeEvidence({ signals });
    expect((result!.signals as string[]).length).toBe(10);
    expect(result!.signalsTruncated).toBeUndefined();
  });

  it("strips unsafe keys like html, body, dom, pageText", () => {
    const evidence = {
      signals: ["test"],
      html: "<div>big html</div>",
      body: "article body text",
      dom: "<p>dom fragment</p>",
      pageText: "full page text",
      fullText: "full text",
      content: "content",
      rawHtml: "raw html",
    };
    const result = sanitizeEvidence(evidence);
    expect(result!.signals).toEqual(["test"]);
    expect(result).not.toHaveProperty("html");
    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("dom");
    expect(result).not.toHaveProperty("pageText");
    expect(result).not.toHaveProperty("fullText");
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("rawHtml");
  });

  it("preserves safe keys alongside signals", () => {
    const evidence = {
      signals: ["pos:date_path"],
      reason: "Signals suggest borderline article confidence",
      score: 42,
    };
    const result = sanitizeEvidence(evidence);
    expect(result!.signals).toEqual(["pos:date_path"]);
    expect(result!.reason).toBe("Signals suggest borderline article confidence");
    expect(result!.score).toBe(42);
  });

  it("production evaluator evidence is sanitized", () => {
    const result = evaluateProductionUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
    });
    expect(result.evidence).toBeDefined();
    expect(Array.isArray(result.evidence!.signals)).toBe(true);
    // Evidence should not contain unsafe keys
    expect(result.evidence).not.toHaveProperty("html");
    expect(result.evidence).not.toHaveProperty("body");
    expect(result.evidence).not.toHaveProperty("dom");
  });

  it("candidate evaluator evidence is sanitized", () => {
    const result = evaluateCandidateUrlPolicy({
      url: "https://www.bbc.com/news/articles/c1234567890o",
    });
    expect(result.evidence).toBeDefined();
    expect(Array.isArray(result.evidence!.signals)).toBe(true);
    // Evidence should not contain unsafe keys
    expect(result.evidence).not.toHaveProperty("html");
    expect(result.evidence).not.toHaveProperty("body");
    expect(result.evidence).not.toHaveProperty("dom");
  });

  it("production evidence never includes full HTML or large fragments", () => {
    const testUrls = [
      "https://www.rte.ie/news/business/2026/0729/1585607-ubs-quarterly-results/",
      "https://www.bbc.com/news/articles/c1234567890o",
      "https://example.com/gallery/12345678/some-photo-album",
      "https://ground.news/checkout/referral",
    ];
    for (const url of testUrls) {
      const result = evaluateProductionUrlPolicy({ url });
      const json = JSON.stringify(result.evidence);
      expect(json.length).toBeLessThan(2048);
      expect(result.evidence).not.toHaveProperty("html");
      expect(result.evidence).not.toHaveProperty("body");
      expect(result.evidence).not.toHaveProperty("dom");
      expect(result.evidence).not.toHaveProperty("pageText");
    }
  });

  it("candidate evidence never includes full HTML or large fragments", () => {
    const testUrls = [
      "https://www.rte.ie/news/business/2026/0729/1585607-ubs-quarterly-results/",
      "https://www.bbc.com/news/articles/c1234567890o",
      "https://example.com/gallery/12345678/some-photo-album",
    ];
    for (const url of testUrls) {
      const result = evaluateCandidateUrlPolicy({ url });
      const json = JSON.stringify(result.evidence);
      expect(json.length).toBeLessThan(2048);
      expect(result.evidence).not.toHaveProperty("html");
      expect(result.evidence).not.toHaveProperty("body");
      expect(result.evidence).not.toHaveProperty("dom");
      expect(result.evidence).not.toHaveProperty("pageText");
    }
  });

  it("signalsTruncated flag is propagated when evidence exceeds size limit", () => {
    // Create evidence with a very long reason string that pushes over 2048 bytes
    const longReason = "x".repeat(3000);
    const evidence = { signals: ["test"], reason: longReason };
    const result = sanitizeEvidence(evidence);
    expect(result!.oversized).toBe(true);
    expect(Array.isArray(result!.signals)).toBe(true);
    // reason should be preserved on oversized fallback
    expect(result!.reason).toBe(longReason);
  });

  it("strips unsafe keys but preserves reason on normal-sized evidence", () => {
    const evidence = {
      signals: ["neg:topic", "pos:date_path"],
      reason: "Signals suggest borderline article confidence",
      html: "<div>should be stripped</div>",
    };
    const result = sanitizeEvidence(evidence);
    expect(result!.signals).toEqual(["neg:topic", "pos:date_path"]);
    expect(result!.reason).toBe("Signals suggest borderline article confidence");
    expect(result).not.toHaveProperty("html");
    expect(result).not.toHaveProperty("oversized");
  });

  it("candidate UNCERTAIN evidence is sanitized (gallery borderline case)", () => {
    // Gallery URL triggers UNCERTAIN in candidate with extra "reason" field
    const result = evaluateCandidateUrlPolicy({
      url: "https://example.com/gallery/12345678/some-photo-album",
    });
    expect(result.decision).toBe("UNCERTAIN");
    expect(result.evidence).toBeDefined();
    expect(Array.isArray(result.evidence!.signals)).toBe(true);
    // Should preserve the reason field (safe key)
    expect(result.evidence!.reason).toBe("Signals suggest borderline article confidence");
    // Should not contain unsafe keys
    expect(result.evidence).not.toHaveProperty("html");
    expect(result.evidence).not.toHaveProperty("body");
    expect(result.evidence).not.toHaveProperty("dom");
    // Should be bounded
    const json = JSON.stringify(result.evidence);
    expect(json.length).toBeLessThan(2048);
  });
});

// ─── SHADOW Decisions Never Block ──────────────────────────────────────────

describe("SHADOW decisions never block URLs", () => {
  it("SHADOW REJECT does not change production ACCEPT behavior", () => {
    // Gallery URL: production ACCEPTs, candidate UNCERTAINs
    const url = "https://example.com/gallery/12345678/some-photo-album";
    const prod = evaluateProductionUrlPolicy({ url });
    const cand = evaluateCandidateUrlPolicy({ url });
    expect(prod.decision).toBe("ACCEPT");
    expect(prod.enforcementMode).toBe("ENFORCED");
    expect(cand.decision).toBe("UNCERTAIN");
    expect(cand.enforcementMode).toBe("SHADOW");
    // SHADOW never changes production behavior
  });

  it("candidate SHADOW REJECT mirrors production REJECT for obvious non-articles", () => {
    const urls = [
      "https://www.rte.ie/radio/clips/11809297",
      "https://ground.news/checkout/referral",
      "https://example.com/login",
      "https://example.com/tag/politics",
    ];
    for (const url of urls) {
      const prod = evaluateProductionUrlPolicy({ url });
      const cand = evaluateCandidateUrlPolicy({ url });
      expect(prod.decision).toBe("REJECT");
      expect(cand.decision).toBe("REJECT");
      expect(prod.enforcementMode).toBe("ENFORCED");
      expect(cand.enforcementMode).toBe("SHADOW");
    }
  });

  it("evaluation runner has no side effects (same dataset produces identical results)", () => {
    // Run the evaluation runner with the same dataset twice
    // and verify the results are byte-identical (deterministic, no state mutation)
    const report1 = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    const report2 = runUrlPolicyEvaluation(createTuningDataset(), createHoldoutDataset());
    expect(JSON.stringify(report1)).toBe(JSON.stringify(report2));
  });
});
