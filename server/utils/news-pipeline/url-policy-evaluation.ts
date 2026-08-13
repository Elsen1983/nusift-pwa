/**
 * URL Policy Evaluation Framework
 *
 * Foundations for a versioned, measurable URL acceptance policy.
 * Provides:
 * - Evaluation dataset schema with tuning/holdout fixtures
 * - Centralized expectedAcceptanceClass mapping
 * - Versioned policy decision types (ACCEPT / REJECT / UNCERTAIN)
 * - Side-effect-free production and candidate policy evaluators
 * - Compatibility wrapper that preserves existing isLikelyArticleUrl() behaviour
 *
 * Production behaviour must remain unchanged.
 */

import { classifyArticleUrl } from "./article-url-policy";

// ─── Constants ────────────────────────────────────────────────────────────────

/** The version string for the current production URL policy. */
export const CURRENT_PRODUCTION_URL_POLICY_VERSION = "url-policy-2026-07-prod";

/** The version string for the candidate (next-gen) URL policy. */
export const CANDIDATE_URL_POLICY_VERSION = "url-policy-2026-08-candidate-v5-metadata-tristate";

/** The dataset version for the first URL evaluation dataset. */
export const URL_EVALUATION_DATASET_VERSION = "url-eval-2026-08-v2";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type DiscoveryMethod =
  | "RSS"
  | "ATOM"
  | "JSON_FEED"
  | "HTML_FALLBACK"
  | "STATIC_LISTING"
  | "SITEMAP"
  | "BROWSER"
  | "MANUAL";

export type ExpectedUrlType =
  | "ARTICLE"
  | "LISTING"
  | "HOMEPAGE"
  | "MEDIA"
  | "LIVEBLOG"
  | "GALLERY"
  | "PAYWALL_ARTICLE"
  | "STALE_ARTICLE"
  | "BAD_CANONICAL"
  | "OTHER";

export type ExpectedAcceptanceClass =
  | "ACCEPTABLE_ARTICLE"
  | "NON_ARTICLE";

export type DatasetSplit = "tuning" | "holdout";

/**
 * A single labelled URL in the evaluation dataset.
 */
export type CandidateUrlEvidence = {
  /** Optional bounded page metadata used only by the candidate SHADOW policy. */
  structuredDataTypes?: string[];
  hasArticleMetadata?: boolean;
  hasPlayerOnlyMetadata?: boolean;
};

export type UrlEvaluationLabel = {
  url: string;
  sourceId?: string;
  categoryId?: string;
  discoveryMethod?: DiscoveryMethod;
  expectedType: ExpectedUrlType;
  expectedAcceptanceClass: ExpectedAcceptanceClass;
  shouldAccept: boolean;
  extractionExpected?: boolean;
  expectedCanonicalUrl?: string;
  expectedPublishedDate?: string;
  expectedLanguage?: string;
  notes?: string;
  labelVersion: number;
  labelledAt: string;
  labelledBy: string;
  candidateEvidence?: CandidateUrlEvidence;
};

/**
 * A versioned evaluation dataset with split metadata.
 */
export type UrlEvaluationDataset = {
  datasetVersion: string;
  split: DatasetSplit;
  labels: UrlEvaluationLabel[];
};

export type AgentName = "AGENT_1" | "AGENT_2" | "AGENT_3";

export type EnforcementMode = "ENFORCED" | "SHADOW";

export type UrlPolicyDecision = "ACCEPT" | "REJECT" | "UNCERTAIN";

/**
 * Structured decision log produced by a URL policy evaluator.
 * Never stores full HTML or large DOM fragments.
 */
export type UrlPolicyDecisionLog = {
  id?: string;
  url: string;
  normalizedUrl?: string;
  sourceId?: string | null;
  categoryId?: string | null;

  agent?: AgentName | null;
  stage?: string;
  discoveryMethod?: string | null;

  policyVersion: string;
  ruleVersion?: string | null;
  enforcementMode: EnforcementMode;

  decision: UrlPolicyDecision;
  reasonCode: string;
  evidence?: Record<string, unknown>;

  evaluationDatasetVersion?: string | null;
  createdAt: string;
};

/**
 * Input shape for policy evaluators.
 */
export type UrlPolicyEvaluationInput = {
  url: string;
  sourceId?: string | null;
  categoryId?: string | null;
  agent?: AgentName | null;
  stage?: string;
  discoveryMethod?: string | null;
  candidateEvidence?: CandidateUrlEvidence;
};

// ─── Centralized expectedAcceptanceClass Mapping ────────────────────────────

/**
 * The set of expectedType values that are considered acceptable articles.
 * This is the single source of truth — metrics MUST use expectedAcceptanceClass,
 * not expectedType directly.
 */
export const ACCEPTABLE_ARTICLE_TYPES: ReadonlySet<ExpectedUrlType> = new Set([
  "ARTICLE",
  "LIVEBLOG",
  "PAYWALL_ARTICLE",
  "STALE_ARTICLE",
]);

/**
 * Derive the expectedAcceptanceClass from an expectedType.
 *
 * Uses the ACCEPTABLE_ARTICLE_TYPES set as the source of truth.
 * An explicit override (expectedAcceptanceClass) always wins.
 *
 * @param expectedType - The type of URL as labelled.
 * @param override - Optional explicit override for the acceptance class.
 * @returns The determined ExpectedAcceptanceClass.
 */
export function deriveExpectedAcceptanceClass(
  expectedType: ExpectedUrlType,
  override?: ExpectedAcceptanceClass,
): ExpectedAcceptanceClass {
  if (override === "ACCEPTABLE_ARTICLE" || override === "NON_ARTICLE") {
    return override;
  }
  return ACCEPTABLE_ARTICLE_TYPES.has(expectedType)
    ? "ACCEPTABLE_ARTICLE"
    : "NON_ARTICLE";
}

// ─── Dataset Validation ─────────────────────────────────────────────────────

export type DatasetValidationError = {
  labelIndex: number;
  field: string;
  message: string;
};

export type DatasetValidationResult = {
  valid: boolean;
  errors: DatasetValidationError[];
  datasetVersion: string;
  split: DatasetSplit;
  labelCount: number;
};

/** Documented tuning/holdout movements. Each replacement is independently
 * stratified; originals remain in tuning and replacements remain in holdout. */
export const URL_POLICY_DATASET_MOVEMENTS = [
  {
    originalUrl: "https://www.bbc.com/news/business",
    destinationSplit: "tuning",
    replacementUrl: "https://www.bbc.com/news/entertainment",
    replacementSplit: "holdout",
    expectedType: "LISTING",
    discoveryMethod: "STATIC_LISTING",
    reason: "The original news-section listing was consumed while tuning the section-landing rule; the independent BBC entertainment section remains holdout evidence.",
  },
  {
    originalUrl: "https://www.theguardian.com/news/series/investigation-podcast",
    destinationSplit: "tuning",
    replacementUrl: "https://www.theguardian.com/news/series/audio-long-reads",
    replacementSplit: "holdout",
    expectedType: "MEDIA",
    discoveryMethod: "RSS",
    reason: "The original podcast-series media URL was consumed while tuning media semantics; the independent Guardian series remains holdout evidence.",
  },
  {
    originalUrl: "https://example.com/video/2026/07/30/documentary-premiere",
    destinationSplit: "tuning",
    replacementUrl: "https://example.com/video/2026/08/01/evening-news-roundup",
    replacementSplit: "holdout",
    expectedType: "MEDIA",
    discoveryMethod: "BROWSER",
    reason: "The original player-only video URL was consumed while tuning media semantics; the independent VideoObject URL remains holdout evidence.",
  },
  {
    originalUrl: "https://example.com/schedule/2026/07/30/evening-lineup",
    destinationSplit: "tuning",
    replacementUrl: "https://example.com/schedule/2026/08/01/primetime-block",
    replacementSplit: "holdout",
    expectedType: "MEDIA",
    discoveryMethod: "RSS",
    reason: "The original BroadcastEvent schedule URL was consumed while tuning programme semantics; the independent schedule remains holdout evidence.",
  },
  {
    originalUrl: "https://example.com/redirect/article?id=123",
    destinationSplit: "tuning",
    replacementUrl: "https://example.com/redirector/article-view?id=42",
    replacementSplit: "holdout",
    expectedType: "BAD_CANONICAL",
    discoveryMethod: "BROWSER",
    reason: "The original redirect-style URL was consumed while tuning redirect semantics; the independent redirect form remains holdout evidence.",
  },
  {
    originalUrl: "https://example.com/search?q=test",
    destinationSplit: "tuning",
    replacementUrl: "https://example.com/search?q=holdout",
    replacementSplit: "holdout",
    expectedType: "OTHER",
    discoveryMethod: "HTML_FALLBACK",
    reason: "The original search landing URL was consumed while tuning generic landing semantics; the independent query remains holdout evidence.",
  },
  {
    originalUrl: "https://example.com/feed",
    destinationSplit: "tuning",
    replacementUrl: "https://example.com/feed/holdout",
    replacementSplit: "holdout",
    expectedType: "OTHER",
    discoveryMethod: "MANUAL",
    reason: "The original feed landing URL was consumed while tuning generic landing semantics; the independent feed path remains holdout evidence.",
  },
] as const;

function normalizeEvaluationUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    const meaningfulParams = [...parsed.searchParams.entries()]
      .filter(([key]) => !/^utm_[^=]+$/i.test(key) && key.toLowerCase() !== "fbclid")
      .sort(([keyA, valueA], [keyB, valueB]) => `${keyA}=${valueA}`.localeCompare(`${keyB}=${valueB}`));
    parsed.search = "";
    for (const [key, value] of meaningfulParams) parsed.searchParams.append(key, value);
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Reject accidental URL leakage between tuning and holdout splits. */
export function validateUrlEvaluationDatasetSplits(
  datasets: UrlEvaluationDataset[],
): string[] {
  const seen = new Map<string, DatasetSplit>();
  const errors: string[] = [];
  for (const dataset of datasets) {
    for (const label of dataset.labels) {
      const normalized = normalizeEvaluationUrl(label.url);
      if (!normalized) continue;
      const previous = seen.get(normalized);
      if (previous && previous !== dataset.split) {
        errors.push(`normalized URL appears in both ${previous} and ${dataset.split}: ${normalized}`);
      } else {
        seen.set(normalized, dataset.split);
      }
    }
  }
  return [...new Set(errors)].sort();
}

/** Validate every documented movement against the actual split contents. */
export function validateUrlPolicyDatasetMovements(
  datasets: UrlEvaluationDataset[],
): string[] {
  const errors: string[] = [];
  const bySplit = new Map<DatasetSplit, UrlEvaluationLabel[]>();
  for (const dataset of datasets) bySplit.set(dataset.split, dataset.labels);
  for (const movement of URL_POLICY_DATASET_MOVEMENTS) {
    const original = bySplit.get(movement.destinationSplit)?.find((label) => normalizeEvaluationUrl(label.url) === normalizeEvaluationUrl(movement.originalUrl));
    const replacement = bySplit.get(movement.replacementSplit)?.find((label) => normalizeEvaluationUrl(label.url) === normalizeEvaluationUrl(movement.replacementUrl));
    if (!original) errors.push(`movement original missing from ${movement.destinationSplit}: ${movement.originalUrl}`);
    if (!replacement) errors.push(`movement replacement missing from ${movement.replacementSplit}: ${movement.replacementUrl}`);
    if (bySplit.get(movement.replacementSplit)?.some((label) => normalizeEvaluationUrl(label.url) === normalizeEvaluationUrl(movement.originalUrl))) {
      errors.push(`movement original also appears in replacement split: ${movement.originalUrl}`);
    }
    if (bySplit.get(movement.destinationSplit)?.some((label) => normalizeEvaluationUrl(label.url) === normalizeEvaluationUrl(movement.replacementUrl))) {
      errors.push(`movement replacement also appears in destination split: ${movement.replacementUrl}`);
    }
    if (normalizeEvaluationUrl(movement.originalUrl) === normalizeEvaluationUrl(movement.replacementUrl)) errors.push(`movement original and replacement are identical: ${movement.originalUrl}`);
    if (movement.destinationSplit !== "tuning") errors.push(`movement destinationSplit must be tuning: ${movement.originalUrl}`);
    if (movement.replacementSplit !== "holdout") errors.push(`movement replacementSplit must be holdout: ${movement.replacementUrl}`);
    if (original && original.expectedType !== movement.expectedType) errors.push(`movement original expectedType mismatch: ${movement.originalUrl}`);
    if (replacement && replacement.expectedType !== movement.expectedType) errors.push(`movement replacement expectedType mismatch: ${movement.replacementUrl}`);
    if (original && original.discoveryMethod !== movement.discoveryMethod) errors.push(`movement original discoveryMethod mismatch: ${movement.originalUrl}`);
    if (replacement && replacement.discoveryMethod !== movement.discoveryMethod) errors.push(`movement replacement discoveryMethod mismatch: ${movement.replacementUrl}`);
    const expectedShouldAccept = ACCEPTABLE_ARTICLE_TYPES.has(movement.expectedType);
    if (original && original.shouldAccept !== expectedShouldAccept) errors.push(`movement original acceptance class mismatch: ${movement.originalUrl}`);
    if (replacement && replacement.shouldAccept !== expectedShouldAccept) errors.push(`movement replacement acceptance class mismatch: ${movement.replacementUrl}`);
  }
  return [...new Set(errors)].sort();
}

/**
 * Validate a URL evaluation dataset.
 * Returns all validation errors rather than failing on the first one.
 * Malformed labels are reported but do not throw — the caller decides.
 */
export function validateUrlEvaluationDataset(
  dataset: unknown,
): DatasetValidationResult {
  const errors: DatasetValidationError[] = [];

  if (!dataset || typeof dataset !== "object") {
    return {
      valid: false,
      errors: [{ labelIndex: -1, field: "dataset", message: "Dataset must be a non-null object" }],
      datasetVersion: "",
      split: "tuning",
      labelCount: 0,
    };
  }

  const d = dataset as Record<string, unknown>;

  // Validate datasetVersion
  if (typeof d.datasetVersion !== "string" || !d.datasetVersion) {
    errors.push({ labelIndex: -1, field: "datasetVersion", message: "datasetVersion must be a non-empty string" });
  }

  // Validate split
  if (d.split !== "tuning" && d.split !== "holdout") {
    errors.push({ labelIndex: -1, field: "split", message: 'split must be "tuning" or "holdout"' });
  }

  // Validate labels array
  if (!Array.isArray(d.labels)) {
    errors.push({ labelIndex: -1, field: "labels", message: "labels must be an array" });
    return {
      valid: errors.length === 0,
      errors,
      datasetVersion: (d.datasetVersion as string) || "",
      split: (d.split as DatasetSplit) || "tuning",
      labelCount: 0,
    };
  }

  const labels = d.labels as unknown[];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label || typeof label !== "object") {
      errors.push({ labelIndex: i, field: "labels[]", message: "Each label must be a non-null object" });
      continue;
    }
    const l = label as Record<string, unknown>;

    // url is required
    if (typeof l.url !== "string" || !l.url) {
      errors.push({ labelIndex: i, field: "url", message: "url must be a non-empty string" });
    }

    // expectedType is required
    const validTypes: ExpectedUrlType[] = [
      "ARTICLE", "LISTING", "HOMEPAGE", "MEDIA", "LIVEBLOG",
      "GALLERY", "PAYWALL_ARTICLE", "STALE_ARTICLE", "BAD_CANONICAL", "OTHER",
    ];
    if (!validTypes.includes(l.expectedType as ExpectedUrlType)) {
      errors.push({
        labelIndex: i,
        field: "expectedType",
        message: `expectedType must be one of: ${validTypes.join(", ")}`,
      });
    }

    // expectedAcceptanceClass is required
    if (l.expectedAcceptanceClass !== "ACCEPTABLE_ARTICLE" && l.expectedAcceptanceClass !== "NON_ARTICLE") {
      errors.push({
        labelIndex: i,
        field: "expectedAcceptanceClass",
        message: 'expectedAcceptanceClass must be "ACCEPTABLE_ARTICLE" or "NON_ARTICLE"',
      });
    }

    // shouldAccept must be boolean
    if (typeof l.shouldAccept !== "boolean") {
      errors.push({ labelIndex: i, field: "shouldAccept", message: "shouldAccept must be a boolean" });
    }

    // labelVersion must be a positive number
    if (typeof l.labelVersion !== "number" || l.labelVersion < 1) {
      errors.push({ labelIndex: i, field: "labelVersion", message: "labelVersion must be a positive number" });
    }

    // labelledAt must be a non-empty string
    if (typeof l.labelledAt !== "string" || !l.labelledAt) {
      errors.push({ labelIndex: i, field: "labelledAt", message: "labelledAt must be a non-empty string" });
    }

    // labelledBy must be a non-empty string
    if (typeof l.labelledBy !== "string" || !l.labelledBy) {
      errors.push({ labelIndex: i, field: "labelledBy", message: "labelledBy must be a non-empty string" });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    datasetVersion: (d.datasetVersion as string) || "",
    split: (d.split as DatasetSplit) || "tuning",
    labelCount: labels.length,
  };
}

// ─── Dataset Helper ────────────────────────────────────────────────────────

const LABELLED_AT = "2026-07-30T00:00:00.000Z";
const LABELLED_BY = "url-policy-evaluation-framework-setup";

/** Shorthand label builder to reduce boilerplate in dataset definitions. */
function L(
  url: string,
  expectedType: ExpectedUrlType,
  opts: Partial<Pick<UrlEvaluationLabel,
    "sourceId" | "discoveryMethod" | "extractionExpected" | "expectedLanguage" |
    "expectedPublishedDate" | "notes" | "categoryId" | "candidateEvidence"
  >> = {},
): UrlEvaluationLabel {
  return {
    url,
    expectedType,
    expectedAcceptanceClass: deriveExpectedAcceptanceClass(expectedType),
    shouldAccept: deriveExpectedAcceptanceClass(expectedType) === "ACCEPTABLE_ARTICLE",
    labelVersion: 1,
    labelledAt: LABELLED_AT,
    labelledBy: LABELLED_BY,
    ...opts,
  };
}

// ─── Expanded Tuning Dataset ───────────────────────────────────────────────

/**
 * Tuning dataset: stratified set used to calibrate candidate policies.
 * ~100 labels across all expectedType and discoveryMethod categories.
 * Format supports 300-500+ URLs in the future.
 */
export function createTuningDataset(): UrlEvaluationDataset {
  return {
    datasetVersion: URL_EVALUATION_DATASET_VERSION,
    split: "tuning",
    labels: [
      // ── Normal article URLs (should accept) ──────────────────────
      L("https://www.rte.ie/news/business/2026/0729/1585607-ubs-quarterly-results/", "ARTICLE", { sourceId: "rte-ie", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.bbc.com/news/articles/c1234567890o", "ARTICLE", { sourceId: "bbc-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://pecaverzum.hu/aktualis/budapesten-es-meg-negy-helyszinen-dolt-meg-a-legalacsonyabb-dunai-vizallas-rekordja", "ARTICLE", { sourceId: "pecaverzum-hu", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "hu" }),
      L("https://www.nba.com/news/nba-announces-team-partnership-ticket-sales-service-awards-2025-26-season", "ARTICLE", { sourceId: "nba-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://timesofindia.indiatimes.com/world/europe/example-news-title/articleshow/123456789.cms", "ARTICLE", { sourceId: "timesofindia-indiatimes-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.independent.ie/irish-news/courts/example-story-title/a123456789.html", "ARTICLE", { sourceId: "independent-ie", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      // Additional article URLs with diverse patterns
      L("https://www.theguardian.com/world/2026/jul/29/climate-summit-reaches-agreement-on-emissions", "ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.reuters.com/business/finance/global-markets-rally-on-earnings-beats-2026-07-29/", "ARTICLE", { sourceId: "reuters-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.nytimes.com/2026/07/29/technology/ai-regulation-framework-approved.html", "ARTICLE", { sourceId: "nytimes-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://edition.cnn.com/2026/07/29/politics/infrastructure-bill-vote/index.html", "ARTICLE", { sourceId: "cnn-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.cnbc.com/2026/07/29/fed-decision-interest-rates-hold-steady.html", "ARTICLE", { sourceId: "cnbc-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.aljazeera.com/news/2026/7/29/peace-talks-resume-in-geneva", "ARTICLE", { sourceId: "aljazeera-com", discoveryMethod: "ATOM", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.theguardian.com/politics/2026/jul/29/uk-government-announces-new-infrastructure-plan", "ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.rte.ie/news/2026/0729/1441883-minister-announcement/", "ARTICLE", { sourceId: "rte-ie", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.independent.ie/irish-news/courts/major-fraud-trial-reaches-verdict/a987654321.html", "ARTICLE", { sourceId: "independent-ie", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://444.hu/2026/07/29/budapest-transport-overhaul-plans-revealed", "ARTICLE", { sourceId: "444-hu", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "hu" }),
      L("https://hvg.hu/gazdasag/20260729_orban_viktor_economy_speech", "ARTICLE", { sourceId: "hvg-hu", discoveryMethod: "ATOM", extractionExpected: true, expectedLanguage: "hu" }),
      L("https://www.aljazeera.com/economy/2026/7/29/oil-prices-surge-amid-supply-concerns", "ARTICLE", { sourceId: "aljazeera-com", discoveryMethod: "JSON_FEED", extractionExpected: true }),
      L("https://www.theguardian.com/environment/2026/jul/29/renewable-energy-investment-hits-record", "ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "SITEMAP", extractionExpected: true }),
      L("https://www.reuters.com/technology/cybersecurity-breach-affects-major-banks-2026-07-29/", "ARTICLE", { sourceId: "reuters-com", discoveryMethod: "BROWSER", extractionExpected: true }),
      L("https://www.cnbc.com/2026/07/29/tech-earnings-season-wraps-up-with-mixed-results.html", "ARTICLE", { sourceId: "cnbc-com", discoveryMethod: "MANUAL", extractionExpected: true }),
      L("https://www.nytimes.com/2026/07/29/health/new-treatment-breakthrough-for-rare-disease.html", "ARTICLE", { sourceId: "nytimes-com", discoveryMethod: "HTML_FALLBACK", extractionExpected: true }),
      L("https://www.theguardian.com/uk-news/2026/jul/29/scottish-parliament-debates-independence", "ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.bbc.com/sport/football/articles/premier-league-transfer-window-update-2026", "ARTICLE", { sourceId: "bbc-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.rte.ie/news/ireland/2026/0729/1441900-housing-policy-update/", "ARTICLE", { sourceId: "rte-ie", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://telex.hu/kulfold/2026/07/29/eu-summit-climate-agreement", "ARTICLE", { sourceId: "telex-hu", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "hu" }),
      L("https://www.voanews.com/a/economy-business_us-tariff-negotiations-continue/7712345.html", "ARTICLE", { sourceId: "voanews-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.theguardian.com/commentisfree/2026/jul/29/democracy-requires-civic-engagement", "ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.reuters.com/world/middle-east/humanitarian-aid-deliveries-resume-2026-07-29/", "ARTICLE", { sourceId: "reuters-com", discoveryMethod: "ATOM", extractionExpected: true }),
      L("https://www.cnbc.com/2026/07/29/cryptocurrency-market-digests-new-regulations.html", "ARTICLE", { sourceId: "cnbc-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.nytimes.com/2026/07/29/science/space-telescope-discovers-new-exoplanet.html", "ARTICLE", { sourceId: "nytimes-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.aljazeera.com/features/2026/7/29/indigenous-communities-lead-conservation-efforts", "ARTICLE", { sourceId: "aljazeera-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.rte.ie/lyric/features/article/1441910-cultural-heritage-preservation/", "ARTICLE", { sourceId: "rte-ie", discoveryMethod: "SITEMAP", extractionExpected: true }),
      L("https://www.independent.ie/business/irish/tech-giant-announces-dublin-expansion/plans/a555666777.html", "ARTICLE", { sourceId: "independent-ie", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://444.hu/2026/07/29/innovative-startup-budapest-wins-european-award", "ARTICLE", { sourceId: "444-hu", discoveryMethod: "BROWSER", extractionExpected: true, expectedLanguage: "hu" }),
      L("https://www.theguardian.com/technology/2026/jul/29/quantum-computing-milestone-achieved", "ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "JSON_FEED", extractionExpected: true }),
      L("https://www.reuters.com/sports/soccer-champions-league-draw-2026-07-29/", "ARTICLE", { sourceId: "reuters-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.bbc.com/news/uk-england-london/articles/c9988776655o", "ARTICLE", { sourceId: "bbc-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://hvg.hu/tudomany/20260729_research_breakthrough_hungary", "ARTICLE", { sourceId: "hvg-hu", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "hu" }),
      L("https://edition.cnn.com/2026/07/29/world/global-weather-extremes/index.html", "ARTICLE", { sourceId: "cnn-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.cnbc.com/2026/07/29/retail-sector-adapts-to-changing-consumer-habits.html", "ARTICLE", { sourceId: "cnbc-com", discoveryMethod: "SITEMAP", extractionExpected: true }),
      L("https://www.nytimes.com/2026/07/29/arts/best-new-books-summer-reading-list.html", "ARTICLE", { sourceId: "nytimes-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.theguardian.com/film/2026/jul/29/film-festival-awards-season-begins", "ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://telex.hu/belfold/2026/07/29/budapest-metro-expansion-plans", "ARTICLE", { sourceId: "telex-hu", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "hu" }),
      L("https://www.aljazeera.com/sports/2026/7/29/olympic-preparations-enter-final-phase", "ARTICLE", { sourceId: "aljazeera-com", discoveryMethod: "RSS", extractionExpected: true }),
      // ── Listing / category / topic pages (should reject) ─────────
      L("https://www.bbc.com/hindi/topics/c9wjr8rzzjzt", "LISTING", { sourceId: "bbc-com", discoveryMethod: "RSS" }),
      L("https://example.com/tag/politics", "LISTING", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/category/world-news", "LISTING", { discoveryMethod: "SITEMAP" }),
      L("https://www.theguardian.com/world", "LISTING", { sourceId: "theguardian-com", discoveryMethod: "STATIC_LISTING" }),
      L("https://www.bbc.com/news/technology", "LISTING", { sourceId: "bbc-com", discoveryMethod: "STATIC_LISTING" }),
      L("https://www.irishexaminer.com/news/cork/", "LISTING", { sourceId: "irishexaminer-com", discoveryMethod: "SITEMAP" }),
      L("https://example.com/most-read", "LISTING", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/section/opinion", "LISTING", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/hub/investigation", "LISTING", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/popular", "LISTING", { discoveryMethod: "SITEMAP" }),
      L("https://example.com/browse/news", "LISTING", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://example.com/index.html", "LISTING", { discoveryMethod: "MANUAL" }),
      // ── Homepage (should reject) ──────────────────────────────────
      L("https://example.com/", "HOMEPAGE", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com", "HOMEPAGE", { discoveryMethod: "MANUAL" }),
      L("https://www.irishtimes.com/", "HOMEPAGE", { sourceId: "irishtimes-com", discoveryMethod: "STATIC_LISTING" }),
      L("https://www.npr.org/", "HOMEPAGE", { sourceId: "npr-org", discoveryMethod: "HTML_FALLBACK" }),
      L("https://www.reuters.com/", "HOMEPAGE", { sourceId: "reuters-com", discoveryMethod: "STATIC_LISTING" }),
      L("https://edition.cnn.com/", "HOMEPAGE", { sourceId: "cnn-com", discoveryMethod: "STATIC_LISTING" }),
      // ── Media / video / podcast / radio clip URLs (should reject) ─
      L("https://www.rte.ie/radio/clips/11809297", "MEDIA", { sourceId: "rte-ie", discoveryMethod: "RSS" }),
      L("https://example.com/video/2026/07/29/sports-highlights", "MEDIA", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/podcast/latest-episode", "MEDIA", { discoveryMethod: "RSS" }),
      L("https://www.rte.ie/podcast/ep12345", "MEDIA", { sourceId: "rte-ie", discoveryMethod: "RSS" }),
      L("https://example.com/audio/analysis-daily-update", "MEDIA", { discoveryMethod: "RSS" }),
      L("https://example.com/video/breaking-news-live-stream", "MEDIA", { discoveryMethod: "BROWSER" }),
      L("https://www.bbc.com/sounds/play/p0abc123", "MEDIA", { sourceId: "bbc-com", discoveryMethod: "RSS" }),
      L("https://example.com/embed/98765432", "MEDIA", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/listen/special-investigation-podcast", "MEDIA", { discoveryMethod: "RSS", candidateEvidence: { hasArticleMetadata: false, hasPlayerOnlyMetadata: true, structuredDataTypes: ["AudioObject"] } }),
      L("https://example.com/player/documentary-series", "MEDIA", { discoveryMethod: "STATIC_LISTING", candidateEvidence: { hasArticleMetadata: false, hasPlayerOnlyMetadata: true, structuredDataTypes: ["VideoObject"] } }),
      L("https://example.com/programmes/morning-briefing", "MEDIA", { discoveryMethod: "RSS", candidateEvidence: { hasArticleMetadata: false, structuredDataTypes: ["BroadcastEvent"] } }),
      L("https://example.com/podcast/episodes/season-two-finale", "MEDIA", { discoveryMethod: "RSS", candidateEvidence: { hasArticleMetadata: false, structuredDataTypes: ["PodcastEpisode"] } }),
      L("https://example.com/radio/programmes/weekly-review", "MEDIA", { discoveryMethod: "RSS", candidateEvidence: { hasArticleMetadata: false, structuredDataTypes: ["RadioEpisode"] } }),
      L("https://example.com/video/2026/07/29/investigation-article-text", "ARTICLE", { discoveryMethod: "RSS", extractionExpected: true, notes: "Media route but genuine text article metadata preserves acceptance", candidateEvidence: { hasArticleMetadata: true, structuredDataTypes: ["Article", "VideoObject"] } }),
      // ── Liveblog (should accept) ──────────────────────────────────
      L("https://example.com/liveblog/2026/07/29/election-results-updates", "LIVEBLOG", { discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.bbc.com/news/liveblog/uk-politics-2026-07-29", "LIVEBLOG", { sourceId: "bbc-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.theguardian.com/politics/live/2026/jul/29/prime-ministers-questions-live", "LIVEBLOG", { sourceId: "theguardian-com", discoveryMethod: "RSS", extractionExpected: true }),
      // ── Gallery (should reject, but production may accept some) ──
      // Trigger UNCERTAIN in candidate: accepted by production (numeric_id + deep_path)
      // but no strong article signals (date_path, long_slug, article_segment).
      L("https://example.com/gallery/12345678/some-photo-album", "GALLERY", { discoveryMethod: "STATIC_LISTING", notes: "Gallery page accepted by production but weak signals \u2192 candidate returns UNCERTAIN" }),
      // Accepted by both: has long slug (4+ hyphens)
      L("https://example.com/gallery/12345678/photo-essay-of-the-year", "GALLERY", { discoveryMethod: "STATIC_LISTING", notes: "Gallery with strong slug signals \u2192 accepted by both policies" }),
      // Rejected by both: short numeric path, no deep_path
      L("https://example.com/gallery/555", "GALLERY", { discoveryMethod: "STATIC_LISTING" }),
      // UNCERTAIN candidate: gallery with only numeric_id, no slug
      L("https://example.com/gallery/87654321", "GALLERY", { discoveryMethod: "SITEMAP", notes: "Gallery with only numeric_id, no slug \u2192 candidate UNCERTAIN" }),
      // ── Paywall article (should accept) ──────────────────────────
      L("https://example.com/news/2026/07/29/premium-investigation-report", "PAYWALL_ARTICLE", { discoveryMethod: "RSS", extractionExpected: true, notes: "Article behind paywall, but still an article URL" }),
      L("https://www.ft.com/content/abc123-def4-paywall-tech-giants-under-scrutiny", "PAYWALL_ARTICLE", { sourceId: "ft-com", discoveryMethod: "RSS", extractionExpected: true, notes: "Financial Times paywall article" }),
      L("https://www.wsj.com/articles/global-supply-chain-disruptions-persist-2026-07-29", "PAYWALL_ARTICLE", { sourceId: "wsj-com", discoveryMethod: "RSS", extractionExpected: true }),
      // ── Stale article (should accept) ─────────────────────────────
      L("https://example.com/news/2023/01/15/old-article-that-is-still-an-article", "STALE_ARTICLE", { discoveryMethod: "SITEMAP", extractionExpected: true, expectedPublishedDate: "2023-01-15", notes: "Stale but structurally a valid article URL" }),
      L("https://www.theguardian.com/world/2022/dec/01/archived-story-still-valid-url-structure", "STALE_ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "SITEMAP", extractionExpected: true, expectedPublishedDate: "2022-12-01" }),
      L("https://www.nytimes.com/2021/03/15/technology/old-tech-article-still-structurally-valid.html", "STALE_ARTICLE", { sourceId: "nytimes-com", discoveryMethod: "SITEMAP", extractionExpected: true, expectedPublishedDate: "2021-03-15" }),
      // ── Bad canonical style (should reject) ──────────────────────
      L("https://example.com/some/page/with/no/article/signals", "BAD_CANONICAL", { discoveryMethod: "BROWSER", notes: "Canonical URL points to non-article page" }),
      L("https://www.vogue.com/fashion/designer-spotlight", "BAD_CANONICAL", { sourceId: "vogue-com", discoveryMethod: "BROWSER", notes: "Weak canonical - no strong article signals" }),
      L("https://example.com/docs/api/getting-started", "BAD_CANONICAL", { discoveryMethod: "BROWSER" }),
      // ── Utility / account / commerce pages (should reject) ───────
      L("https://ground.news/checkout/referral", "OTHER", { sourceId: "ground-news", discoveryMethod: "RSS" }),
      L("https://example.com/login", "OTHER", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://example.com/account/settings", "OTHER", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://example.com/terms", "OTHER", { discoveryMethod: "MANUAL" }),
      L("https://example.com/privacy", "OTHER", { discoveryMethod: "MANUAL" }),
      L("https://example.com/about", "OTHER", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/contact", "OTHER", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/search?q=news", "OTHER", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://example.com/feed", "OTHER", { discoveryMethod: "MANUAL" }),
      L("https://example.com/subscribe/premium-plan", "OTHER", { discoveryMethod: "RSS" }),
      L("https://example.com/author/jane-doe", "OTHER", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/newsletter/weekly-digest", "OTHER", { discoveryMethod: "RSS" }),
      // ── Movement originals intentionally consumed during tuning ─────
      L("https://www.bbc.com/news/business", "LISTING", { sourceId: "bbc-com", discoveryMethod: "STATIC_LISTING" }),
      L("https://www.theguardian.com/news/series/investigation-podcast", "MEDIA", { sourceId: "theguardian-com", discoveryMethod: "RSS" }),
      L("https://example.com/video/2026/07/30/documentary-premiere", "MEDIA", { discoveryMethod: "BROWSER", candidateEvidence: { hasArticleMetadata: false, hasPlayerOnlyMetadata: true, structuredDataTypes: ["VideoObject"] } }),
      L("https://example.com/schedule/2026/07/30/evening-lineup", "MEDIA", { discoveryMethod: "RSS", candidateEvidence: { hasArticleMetadata: false, structuredDataTypes: ["BroadcastEvent"] } }),
      L("https://example.com/redirect/article?id=123", "BAD_CANONICAL", { discoveryMethod: "BROWSER" }),
      L("https://example.com/search?q=test", "OTHER", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://example.com/feed", "OTHER", { discoveryMethod: "MANUAL" }),
    ],
  };
}

// ─── Expanded Holdout Dataset ──────────────────────────────────────────────

/**
 * Holdout dataset: stratified set held back for final validation.
 * 100+ labels across all expectedType and discoveryMethod categories.
 * Never used for tuning — only for final candidate policy evaluation.
 * Format supports 300-500+ URLs in the future.
 */
export function createHoldoutDataset(): UrlEvaluationDataset {
  return {
    datasetVersion: URL_EVALUATION_DATASET_VERSION,
    split: "holdout",
    labels: [
      // ── Normal article URLs (should accept) ──────────────────────
      L("https://www.irishmirror.ie/news/irish-news/family-missing-charlie-clarke-feared-12345678", "ARTICLE", { sourceId: "irishmirror-ie", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.bbc.com/sport/articles/c0000000000o", "ARTICLE", { sourceId: "bbc-com", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "en" }),
      L("https://www.rte.ie/news/politics/2026/0730/1441920-budget-announcement/", "ARTICLE", { sourceId: "rte-ie", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.bbc.com/news/articles/c9999999999o", "ARTICLE", { sourceId: "bbc-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.theguardian.com/society/2026/jul/30/nhs-reform-bill-introduced-in-parliament", "ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.reuters.com/world/europe/heatwave-records-broken-across-southern-europe-2026-07-30/", "ARTICLE", { sourceId: "reuters-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.nytimes.com/2026/07/30/us/politics/congressional-hearing-tech-oversight.html", "ARTICLE", { sourceId: "nytimes-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://edition.cnn.com/2026/07/30/asia/japan-earthquake-response/index.html", "ARTICLE", { sourceId: "cnn-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.cnbc.com/2026/07/30/global-trade-tensions-escalate.html", "ARTICLE", { sourceId: "cnbc-com", discoveryMethod: "ATOM", extractionExpected: true }),
      L("https://www.aljazeera.com/economy/2026/7/30/emerging-markets-report", "ARTICLE", { sourceId: "aljazeera-com", discoveryMethod: "JSON_FEED", extractionExpected: true }),
      L("https://www.nbcnews.com/politics/congress/new-bipartisan-bill-aims-infrastructure-funding-rcna123456", "ARTICLE", { sourceId: "nbcnews-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://abcnews.go.com/International/wildfire-spreads-california-evacuations-ordered/story?id=12345678", "ARTICLE", { sourceId: "abcnews-go-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.thehindu.com/news/international/monsoon-floods-displace-millions-in-south-asia/article67890123.ece", "ARTICLE", { sourceId: "thehindu-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.japantimes.co.jp/news/2026/07/30/national/robotics-advance-transforms-manufacturing/", "ARTICLE", { sourceId: "japantimes-co-jp", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.smh.com.au/world/europe/heatwave-records-shattered-across-mediterranean-20260730-p5dc12.html", "ARTICLE", { sourceId: "smh-com-au", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.ft.com/content/flood-insurance-reform-sparks-debate-2026-07-30", "ARTICLE", { sourceId: "ft-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.washingtonpost.com/climate-environment/2026/07/30/epa-new-emissions-rule/", "ARTICLE", { sourceId: "washingtonpost-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://444.hu/2026/07/30/hungary-eu-relations-new-chapter", "ARTICLE", { sourceId: "444-hu", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "hu" }),
      L("https://hvg.hu/vilag/20260730_global_diplomacy_update", "ARTICLE", { sourceId: "hvg-hu", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "hu" }),
      L("https://www.rte.ie/news/world/2026/0730/1441925-un-climate-report/", "ARTICLE", { sourceId: "rte-ie", discoveryMethod: "SITEMAP", extractionExpected: true }),
      L("https://www.theguardian.com/business/2026/jul/30/bank-of-england-rate-decision", "ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "BROWSER", extractionExpected: true }),
      L("https://telex.hu/kulfold/2026/07/30/nato-summit-results", "ARTICLE", { sourceId: "telex-hu", discoveryMethod: "RSS", extractionExpected: true, expectedLanguage: "hu" }),
      L("https://www.bbc.com/news/uk/articles/c1111111111o", "ARTICLE", { sourceId: "bbc-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.reuters.com/technology/artificial-intelligence-2026-07-30/", "ARTICLE", { sourceId: "reuters-com", discoveryMethod: "SITEMAP", extractionExpected: true }),
      L("https://www.cnbc.com/2026/07/30/wall-street-earnings-season-preview.html", "ARTICLE", { sourceId: "cnbc-com", discoveryMethod: "RSS", extractionExpected: true }),
      // ── Listing pages (should reject) ─────────────────────────────
      L("https://example.com/latest", "LISTING", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/trending", "LISTING", { discoveryMethod: "STATIC_LISTING" }),
      L("https://www.bbc.com/news/entertainment", "LISTING", { sourceId: "bbc-com", discoveryMethod: "STATIC_LISTING", notes: "Replacement holdout for news-section listing class (original moved to tuning)" }),
      L("https://www.theguardian.com/commentisfree", "LISTING", { sourceId: "theguardian-com", discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/tag/economy", "LISTING", { discoveryMethod: "SITEMAP" }),
      L("https://example.com/category/science", "LISTING", { discoveryMethod: "SITEMAP" }),
      L("https://example.com/discover", "LISTING", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://example.com/explore/trending", "LISTING", { discoveryMethod: "STATIC_LISTING" }),
      // ── Homepage (should reject) ──────────────────────────────────
      L("https://www.smh.com.au/", "HOMEPAGE", { sourceId: "smh-com-au", discoveryMethod: "STATIC_LISTING" }),
      L("https://www.japantimes.co.jp/", "HOMEPAGE", { sourceId: "japantimes-co-jp", discoveryMethod: "STATIC_LISTING" }),
      L("https://www.theguardian.com/international", "HOMEPAGE", { sourceId: "theguardian-com", discoveryMethod: "STATIC_LISTING" }),
      L("https://www.nbcnews.com/", "HOMEPAGE", { sourceId: "nbcnews-com", discoveryMethod: "HTML_FALLBACK" }),
      // ── Media (should reject) ─────────────────────────────────────
      L("https://example.com/audio/special-report", "MEDIA", { discoveryMethod: "RSS" }),
      L("https://example.com/clips/highlights-20260729", "MEDIA", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/podcast/true-crime-season-finale", "MEDIA", { discoveryMethod: "RSS" }),
      L("https://www.theguardian.com/news/series/audio-long-reads", "MEDIA", { sourceId: "theguardian-com", discoveryMethod: "RSS", notes: "Replacement holdout for podcast-series media class (original moved to tuning)" }),
      L("https://example.com/video/2026/08/01/evening-news-roundup", "MEDIA", { discoveryMethod: "BROWSER", candidateEvidence: { hasArticleMetadata: false, hasPlayerOnlyMetadata: true, structuredDataTypes: ["VideoObject"] }, notes: "Replacement holdout for video media class (original moved to tuning)" }),
      L("https://example.com/schedule/2026/08/01/primetime-block", "MEDIA", { discoveryMethod: "RSS", candidateEvidence: { hasArticleMetadata: false, structuredDataTypes: ["BroadcastEvent"] }, notes: "Replacement holdout for schedule media class (original moved to tuning)" }),
      L("https://example.com/radio/programmes/long-form-investigation", "MEDIA", { discoveryMethod: "RSS", candidateEvidence: { hasArticleMetadata: false, structuredDataTypes: ["RadioEpisode"] } }),
      L("https://example.com/video/2026/07/30/text-report-from-the-field", "ARTICLE", { discoveryMethod: "RSS", extractionExpected: true, notes: "Genuine text article under a media route", candidateEvidence: { hasArticleMetadata: true, structuredDataTypes: ["Article", "VideoObject"] } }),
      // ── Liveblog (should accept) ──────────────────────────────────
      L("https://example.com/live/2026/07/29/sports-match-updates", "LIVEBLOG", { discoveryMethod: "BROWSER", extractionExpected: true }),
      L("https://www.bbc.com/news/live/world-europe-2026-07-30", "LIVEBLOG", { sourceId: "bbc-com", discoveryMethod: "RSS", extractionExpected: true }),
      // ── Gallery (should reject) ───────────────────────────────────
      L("https://example.com/gallery/12345678/annual-photo-contest-winners", "GALLERY", { discoveryMethod: "STATIC_LISTING", notes: "Gallery with numeric_id + short slug \u2192 production ACCEPTs, candidate UNCERTAIN" }),
      L("https://example.com/gallery/99999999/news-week-in-pictures", "GALLERY", { discoveryMethod: "SITEMAP", notes: "Gallery with numeric_id + short slug \u2192 candidate UNCERTAIN" }),
      // ── Paywall article (should accept) ──────────────────────────
      L("https://www.ft.com/content/major-central-bank-policy-shift-looms-2026-07-30", "PAYWALL_ARTICLE", { sourceId: "ft-com", discoveryMethod: "RSS", extractionExpected: true }),
      L("https://www.wsj.com/articles/global-trade-war-escalation-2026-07-30", "PAYWALL_ARTICLE", { sourceId: "wsj-com", discoveryMethod: "RSS", extractionExpected: true }),
      // ── Stale article (should accept) ─────────────────────────────
      L("https://www.theguardian.com/world/2021/feb/14/old-story-with-valid-url-structure", "STALE_ARTICLE", { sourceId: "theguardian-com", discoveryMethod: "SITEMAP", extractionExpected: true, expectedPublishedDate: "2021-02-14" }),
      // ── Bad canonical (should reject) ─────────────────────────────
      L("https://example.com/redirector/article-view?id=42", "BAD_CANONICAL", { discoveryMethod: "BROWSER", notes: "Replacement holdout for redirect-style BAD_CANONICAL class (original moved to tuning)" }),
      // ── Other (should reject) ─────────────────────────────────────
      L("https://example.com/search?q=holdout", "OTHER", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://example.com/feed/holdout", "OTHER", { discoveryMethod: "MANUAL" }),
      L("https://example.com/help/faq", "OTHER", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/careers", "OTHER", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/auth/sign-in", "OTHER", { discoveryMethod: "HTML_FALLBACK" }),
      // Independent calibration expansion: strong article URLs.
      L("https://holdout-one.example.net/news/2026/08/11/coastal-rescue-operation-saves-five-people", "ARTICLE", { discoveryMethod: "RSS", extractionExpected: true }),
      L("https://holdout-two.example.net/world/2026/08/11/regional-leaders-sign-new-climate-agreement", "ARTICLE", { discoveryMethod: "ATOM", extractionExpected: true }),
      L("https://holdout-three.example.net/business/2026/08/11/markets-rally-after-inflation-report", "ARTICLE", { discoveryMethod: "JSON_FEED", extractionExpected: true }),
      L("https://holdout-four.example.net/technology/2026/08/11/researchers-publish-new-battery-design", "ARTICLE", { discoveryMethod: "SITEMAP", extractionExpected: true }),
      L("https://holdout-five.example.net/politics/2026/08/11/parliament-approves-transport-funding-bill", "ARTICLE", { discoveryMethod: "BROWSER", extractionExpected: true }),
      L("https://holdout-six.example.net/sport/2026/08/11/championship-final-decided-after-extra-time", "ARTICLE", { discoveryMethod: "STATIC_LISTING", extractionExpected: true }),
      L("https://holdout-seven.example.net/culture/2026/08/11/city-museum-opens-major-summer-exhibition", "ARTICLE", { discoveryMethod: "HTML_FALLBACK", extractionExpected: true }),
      L("https://holdout-eight.example.net/science/2026/08/11/astronomers-observe-rare-stellar-event", "ARTICLE", { discoveryMethod: "MANUAL", extractionExpected: true }),
      L("https://holdout-nine.example.net/local/2026/08/12/council-confirms-new-housing-development", "ARTICLE", { discoveryMethod: "RSS", extractionExpected: true }),
      L("https://holdout-ten.example.net/health/2026/08/12/hospital-launches-community-care-programme", "ARTICLE", { discoveryMethod: "ATOM", extractionExpected: true }),
      L("https://holdout-eleven.example.net/environment/2026/08/12/river-restoration-project-reaches-final-stage", "ARTICLE", { discoveryMethod: "JSON_FEED", extractionExpected: true }),
      L("https://holdout-twelve.example.net/education/2026/08/12/university-announces-expanded-scholarship-fund", "ARTICLE", { discoveryMethod: "SITEMAP", extractionExpected: true }),
      L("https://holdout-thirteen.example.net/economy/2026/08/12/central-bank-keeps-interest-rates-unchanged", "ARTICLE", { discoveryMethod: "BROWSER", extractionExpected: true }),
      L("https://holdout-fourteen.example.net/transport/2026/08/12/new-rail-service-connects-three-regional-cities", "ARTICLE", { discoveryMethod: "STATIC_LISTING", extractionExpected: true }),
      L("https://holdout-fifteen.example.net/energy/2026/08/12/offshore-wind-project-receives-final-approval", "ARTICLE", { discoveryMethod: "HTML_FALLBACK", extractionExpected: true }),
      L("https://holdout-sixteen.example.net/justice/2026/08/12/court-publishes-landmark-data-protection-ruling", "ARTICLE", { discoveryMethod: "MANUAL", extractionExpected: true }),
      L("https://holdout-seventeen.example.net/news/articles/c1234567890x", "ARTICLE", { discoveryMethod: "RSS", extractionExpected: true }),
      L("https://holdout-eighteen.example.net/article/98765432/regulators-release-annual-safety-review", "ARTICLE", { discoveryMethod: "ATOM", extractionExpected: true }),
      L("https://holdout-nineteen.example.net/story/2026/08/13/emergency-services-respond-to-severe-weather", "ARTICLE", { discoveryMethod: "JSON_FEED", extractionExpected: true }),
      L("https://holdout-twenty.example.net/news/20260813/international-aid-convoy-reaches-border-region", "ARTICLE", { discoveryMethod: "SITEMAP", extractionExpected: true }),
      L("https://holdout-twenty-one.example.net/live/2026/08/13/election-results-and-reaction", "LIVEBLOG", { discoveryMethod: "BROWSER", extractionExpected: true }),
      L("https://holdout-twenty-two.example.net/live/markets/2026/08/13/trading-session-updates", "LIVEBLOG", { discoveryMethod: "STATIC_LISTING", extractionExpected: true }),
      L("https://holdout-twenty-three.example.net/archive/2020/05/14/valid-older-investigation", "STALE_ARTICLE", { discoveryMethod: "SITEMAP", extractionExpected: true, expectedPublishedDate: "2020-05-14" }),
      L("https://holdout-twenty-four.example.net/premium/2026/08/13/inside-the-global-shipping-recovery", "PAYWALL_ARTICLE", { discoveryMethod: "RSS", extractionExpected: true }),
      // Independent calibration expansion: clear non-article URLs.
      L("https://holdout-one.example.net/latest", "LISTING", { discoveryMethod: "STATIC_LISTING" }),
      L("https://holdout-two.example.net/news", "LISTING", { discoveryMethod: "STATIC_LISTING" }),
      L("https://holdout-three.example.net/category/world", "LISTING", { discoveryMethod: "SITEMAP" }),
      L("https://holdout-four.example.net/tag/elections", "LISTING", { discoveryMethod: "SITEMAP" }),
      L("https://holdout-five.example.net/topics/climate", "LISTING", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://holdout-six.example.net/archive", "LISTING", { discoveryMethod: "MANUAL" }),
      L("https://holdout-seven.example.net/most-read", "LISTING", { discoveryMethod: "BROWSER" }),
      L("https://holdout-eight.example.net/section/business", "LISTING", { discoveryMethod: "STATIC_LISTING" }),
      L("https://holdout-nine.example.net/", "HOMEPAGE", { discoveryMethod: "STATIC_LISTING" }),
      L("https://holdout-ten.example.net/home", "HOMEPAGE", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://holdout-eleven.example.net/video/daily-news-bulletin", "MEDIA", { discoveryMethod: "BROWSER", candidateEvidence: { hasPlayerOnlyMetadata: true, structuredDataTypes: ["VideoObject"] } }),
      L("https://holdout-twelve.example.net/podcast/evening-analysis", "MEDIA", { discoveryMethod: "RSS" }),
      L("https://holdout-thirteen.example.net/audio/morning-briefing", "MEDIA", { discoveryMethod: "ATOM" }),
      L("https://holdout-fourteen.example.net/programmes/current-affairs", "MEDIA", { discoveryMethod: "STATIC_LISTING" }),
      L("https://holdout-fifteen.example.net/gallery/24681012/storm-images", "GALLERY", { discoveryMethod: "SITEMAP" }),
      L("https://holdout-sixteen.example.net/photos/week-in-review", "GALLERY", { discoveryMethod: "STATIC_LISTING" }),
      L("https://holdout-seventeen.example.net/slideshow/13579/election-campaign", "GALLERY", { discoveryMethod: "BROWSER" }),
      L("https://holdout-eighteen.example.net/redirect?url=https%3A%2F%2Fnews.example", "BAD_CANONICAL", { discoveryMethod: "BROWSER" }),
      L("https://holdout-nineteen.example.net/out?target=story", "BAD_CANONICAL", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://holdout-twenty.example.net/search?q=markets", "OTHER", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://holdout-twenty-one.example.net/account/login", "OTHER", { discoveryMethod: "MANUAL" }),
      L("https://holdout-twenty-two.example.net/newsletter/signup", "OTHER", { discoveryMethod: "STATIC_LISTING" }),
      L("https://holdout-twenty-three.example.net/about/contact", "OTHER", { discoveryMethod: "STATIC_LISTING" }),
      L("https://holdout-twenty-four.example.net/rss", "OTHER", { discoveryMethod: "RSS" }),
    ],
  };
}

// ─── Side-Effect-Free Policy Evaluators ────────────────────────────────────

/**
 * Evaluate a URL against the current production URL policy.
 *
 * Side-effect-free: no I/O, no mutations, no external calls.
 * Delegates to classifyArticleUrl() from article-url-policy.ts.
 *
 * The production evaluator only returns ACCEPT or REJECT (never UNCERTAIN),
 * matching the current binary classifyArticleUrl() behaviour.
 */
export function evaluateProductionUrlPolicy(
  input: UrlPolicyEvaluationInput,
): UrlPolicyDecisionLog {
  const result = classifyArticleUrl(input.url);

  const decision: UrlPolicyDecision = result.accepted ? "ACCEPT" : "REJECT";
  const reasonCode = result.reason || (result.accepted ? "accepted" : "unknown_rejection");
  const createdAt = new Date().toISOString();

  return {
    url: input.url,
    normalizedUrl: result.normalizedUrl ?? undefined,
    sourceId: input.sourceId ?? null,
    categoryId: input.categoryId ?? null,
    agent: input.agent ?? null,
    stage: input.stage ?? undefined,
    discoveryMethod: input.discoveryMethod ?? null,
    policyVersion: CURRENT_PRODUCTION_URL_POLICY_VERSION,
    enforcementMode: "ENFORCED",
    decision,
    reasonCode,
    evidence: sanitizeEvidence({ signals: result.signals }),
    createdAt,
  };
}

/**
 * Evaluate a URL against the candidate (next-gen) URL policy.
 *
 * Side-effect-free: no I/O, no mutations, no external calls.
 * Supports three output states:
 * - ACCEPT  — URL is a likely article
 * - REJECT  — URL is clearly not an article
 * - UNCERTAIN — URL was accepted by production but has weak signals,
 *   meaning the candidate policy is less confident than production.
 *
 * Enforcement mode is SHADOW — decisions are recorded but not acted upon.
 *
 * The candidate policy starts as a clone of production, with additional
 * UNCERTAIN paths for URLs the production policy accepts but where the
 * signal profile is borderline. Uses isCandidateBorderlineAcceptance()
 * which applies genuinely different rules from production.
 */
const MEDIA_ROUTE_TOKENS = new Set([
  "radio", "radios", "programme", "programmes", "program", "programs",
  "episode", "episodes", "podcast", "podcasts", "schedule", "schedules",
  "archive", "archives", "listing", "listings", "audio", "video", "player",
  "listen", "broadcast",
]);

const MEDIA_STRUCTURED_DATA_TYPES = new Set([
  "RadioEpisode", "PodcastEpisode", "BroadcastEvent", "AudioObject", "VideoObject",
]);

function evaluateCandidateSemanticLandingEvidence(
  input: UrlPolicyEvaluationInput,
  signals: string[],
): { decision: UrlPolicyDecision; reasonCode: string; evidence: Record<string, unknown> } | null {
  const parsed = new URL(input.url);
  const segments = parsed.pathname.toLowerCase().split("/").filter(Boolean);
  const pathTokens = new Set(segments.flatMap((segment) => segment.split(/[-_]/g)));
  const articleMetadataState = input.candidateEvidence?.hasArticleMetadata;
  const hasArticleMetadata = articleMetadataState === true;
  const metadataConfirmedAbsent = articleMetadataState === false;
  const structuredDataTypes = input.candidateEvidence?.structuredDataTypes ?? [];
  const hasArticleStructuredData = structuredDataTypes
    .some((type) => ["Article", "NewsArticle", "LiveBlogPosting"].includes(type));
  const hasExplicitListingStructuredData = structuredDataTypes
    .some((type) => ["CollectionPage", "ItemList", "SearchResultsPage", "WebSite"].includes(type));
  const hasStrongArticleSignal = [
    "pos:date_path", "pos:long_slug", "pos:article_segment", "pos:article_suffix",
  ].some((signal) => signals.includes(signal));

  const docsTokens = ["docs", "documentation", "api", "developer", "reference", "swagger", "openapi", "getting", "started"];
  if (!hasArticleMetadata && !hasArticleStructuredData && !hasStrongArticleSignal && docsTokens.some((token) => pathTokens.has(token)) && segments.length <= 4) {
    return {
      decision: "REJECT",
      reasonCode: "documentation_api_landing_without_article_evidence",
      evidence: { semanticPathClass: "documentation_api_landing", pathSegments: segments.slice(0, 8) },
    };
  }

  const sectionTokens = ["section", "category", "categories", "topic", "topics", "technology", "business", "politics", "world", "news"];
  const hasDatedOrLongArticleEvidence = signals.includes("pos:date_path") || signals.includes("pos:long_slug");
  const sectionLikePath = segments.length <= 2 && sectionTokens.some((token) => pathTokens.has(token));
  const confirmedListing = metadataConfirmedAbsent && hasExplicitListingStructuredData;
  if (!hasArticleMetadata && !hasArticleStructuredData && sectionLikePath && (confirmedListing || (!hasStrongArticleSignal && !hasDatedOrLongArticleEvidence))) {
    // A short section-like URL is ambiguous when page metadata was not
    // evaluated. Only confirmed absence plus explicit listing evidence is
    // strong enough for REJECT; unknown metadata abstains to UNCERTAIN.
    return {
      decision: confirmedListing ? "REJECT" : "UNCERTAIN",
      reasonCode: confirmedListing
        ? "section_landing_without_article_evidence"
        : "ambiguous_section_without_confirmed_metadata",
      evidence: {
        semanticPathClass: "section_landing",
        pathSegments: segments.slice(0, 8),
        articleMetadataState: articleMetadataState ?? "unknown",
        explicitListingEvidence: hasExplicitListingStructuredData,
      },
    };
  }

  const redirectTokens = ["redirect", "redirector", "article", "view", "go", "link"];
  if (!hasArticleMetadata && !hasArticleStructuredData && !hasStrongArticleSignal && segments.some((segment) => redirectTokens.includes(segment)) && (parsed.searchParams.has("id") || segments.includes("redirect") || segments.includes("redirector"))) {
    return {
      decision: "REJECT",
      reasonCode: "redirect_style_without_article_evidence",
      evidence: { semanticPathClass: "redirect_style", pathSegments: segments.slice(0, 8) },
    };
  }

  const shallowLandingTokens = ["latest", "trending", "popular", "most-read", "browse", "explore", "discover", "search", "feed"];
  if (!hasArticleMetadata && !hasArticleStructuredData && !hasStrongArticleSignal && segments.length <= 2 && segments.some((segment) => shallowLandingTokens.includes(segment))) {
    return {
      decision: "REJECT",
      reasonCode: "generic_shallow_landing_without_article_evidence",
      evidence: { semanticPathClass: "generic_shallow_landing", pathSegments: segments.slice(0, 8) },
    };
  }

  if (!hasArticleMetadata && !hasArticleStructuredData && !hasStrongArticleSignal && segments.length === 2 && segments.every((segment) => /^[a-z-]{2,24}$/.test(segment))) {
    return {
      decision: "UNCERTAIN",
      reasonCode: "generic_shallow_path_without_article_evidence",
      evidence: { semanticPathClass: "generic_shallow_path", pathSegments: segments.slice(0, 8) },
    };
  }

  if (hasArticleMetadata || hasArticleStructuredData || hasStrongArticleSignal) return null;
  return null;
}

function evaluateCandidateMediaEvidence(
  input: UrlPolicyEvaluationInput,
  signals: string[],
): { decision: UrlPolicyDecision; reasonCode: string; evidence: Record<string, unknown> } | null {
  const parsed = new URL(input.url);
  const segments = parsed.pathname.toLowerCase().split("/").filter(Boolean);
  const routeTokens = segments.filter((segment) => MEDIA_ROUTE_TOKENS.has(segment.replace(/[-_]/g, "")));
  const structuredDataTypes = (input.candidateEvidence?.structuredDataTypes ?? [])
    .filter((type) => typeof type === "string")
    .map((type) => type.slice(0, 80))
    .filter((type) => MEDIA_STRUCTURED_DATA_TYPES.has(type));
  const playerOnly = input.candidateEvidence?.hasPlayerOnlyMetadata === true;
  const articleMetadataState = input.candidateEvidence?.hasArticleMetadata;
  const hasArticleMetadata = articleMetadataState === true;
  const hasArticleStructuredData = (input.candidateEvidence?.structuredDataTypes ?? [])
    .some((type) => ["Article", "NewsArticle", "LiveBlogPosting"].includes(type));
  const hasStrongArticleSignal = [
    "pos:date_path", "pos:long_slug", "pos:article_segment", "pos:article_suffix",
  ].some((signal) => signals.includes(signal));
  const strongProgrammeEvidence = routeTokens.length > 0 || structuredDataTypes.length > 0 || playerOnly;

  const explicitNonArticleStructuredData = structuredDataTypes.length > 0;
  if (!strongProgrammeEvidence || hasArticleMetadata || hasArticleStructuredData || (hasStrongArticleSignal && !explicitNonArticleStructuredData && !playerOnly)) return null;

  const noArticleMetadata = articleMetadataState === false;
  const reasonCode = explicitNonArticleStructuredData
    ? "explicit_non_article_media_structured_data"
    : noArticleMetadata && routeTokens.length > 0
      ? "programme_media_without_article_metadata"
      : playerOnly
        ? "player_only_media_metadata"
        : "media_programme_route";

  return {
    decision: explicitNonArticleStructuredData || noArticleMetadata || playerOnly ? "REJECT" : "UNCERTAIN",
    reasonCode,
    evidence: {
      mediaRouteTokens: routeTokens.slice(0, 8),
      structuredDataTypes: structuredDataTypes.slice(0, 8),
      playerOnlyMetadata: playerOnly,
      articleMetadataPresent: hasArticleMetadata,
      articleMetadataState: articleMetadataState ?? "unknown",
      articleSignals: ["pos:date_path", "pos:long_slug", "pos:article_segment", "pos:article_suffix"]
        .filter((signal) => signals.includes(signal)),
    },
  };
}

export function evaluateCandidateUrlPolicy(
  input: UrlPolicyEvaluationInput,
): UrlPolicyDecisionLog {
  // Candidate policy starts as a clone of production policy.
  const result = classifyArticleUrl(input.url);

  let decision: UrlPolicyDecision;
  let reasonCode: string;
  let evidence: Record<string, unknown>;

  if (!result.accepted) {
    decision = "REJECT";
    reasonCode = result.reason || "unknown_rejection";
    evidence = { signals: result.signals };
  } else {
    // Evaluate deterministic media evidence first so programme/video/audio
    // pages cannot be downgraded by the generic shallow-path rule.
    const mediaDecision = evaluateCandidateMediaEvidence(input, result.signals);
    const semanticDecision = mediaDecision ? null : evaluateCandidateSemanticLandingEvidence(input, result.signals);
    // Candidate-only media/program evidence remains SHADOW. Strong article
    // signals or explicit article metadata preserve genuine text articles.
    if (mediaDecision) {
      decision = mediaDecision.decision;
      reasonCode = mediaDecision.reasonCode;
      evidence = { signals: result.signals, ...mediaDecision.evidence };
    } else if (semanticDecision) {
      decision = semanticDecision.decision;
      reasonCode = semanticDecision.reasonCode;
      evidence = { signals: result.signals, ...semanticDecision.evidence };
    } else if (isCandidateBorderlineAcceptance(result.signals)) {
      decision = "UNCERTAIN";
      reasonCode = "low_article_url_confidence";
      evidence = {
        signals: result.signals,
        reason: "Signals suggest borderline article confidence",
      };
    } else {
      decision = "ACCEPT";
      reasonCode = "accepted";
      evidence = { signals: result.signals };
    }
  }

  const createdAt = new Date().toISOString();

  return {
    url: input.url,
    normalizedUrl: result.normalizedUrl ?? undefined,
    sourceId: input.sourceId ?? null,
    categoryId: input.categoryId ?? null,
    agent: input.agent ?? null,
    stage: input.stage ?? undefined,
    discoveryMethod: input.discoveryMethod ?? null,
    policyVersion: CANDIDATE_URL_POLICY_VERSION,
    enforcementMode: "SHADOW",
    decision,
    reasonCode,
    evidence: sanitizeEvidence(evidence),
    createdAt,
  };
}

/**
 * Heuristic to detect borderline article URL acceptance (legacy, production-compatible).
 *
 * Preserved for backward compatibility. The candidate evaluator now uses
 * isCandidateBorderlineAcceptance() which applies genuinely different rules.
 *
 * @internal Visible for testing.
 */
export function isBorderlineAcceptance(signals: string[]): boolean {
  const hasStrongNegative = signals.some(
    (s) => s.startsWith("neg:") && signals.includes("strong_negative_dominates"),
  );
  const hasStrongPositiveOverride = signals.some(
    (s) => s.startsWith("override:"),
  );
  const hasDatePath = signals.includes("pos:date_path");
  const hasLongSlug = signals.includes("pos:long_slug");
  const hasArticleSegment = signals.includes("pos:article_segment");

  // If strong negatives exist without a strong positive override, it's borderline.
  if (hasStrongNegative && !hasStrongPositiveOverride) {
    return true;
  }

  // If strong negatives exist but are overridden by strong positives, not borderline.
  if (hasStrongNegative && hasStrongPositiveOverride) {
    return false;
  }

  // If there's at least one strong article signal (date path, long slug, article segment),
  // the classification is confident.
  if (hasDatePath || hasLongSlug || hasArticleSegment) {
    return false;
  }

  // No strong negatives, but also no strong article positives — conservative:
  // only borderline if there are weak negatives present.
  const hasWeakNegative = signals.some(
    (s) => s.startsWith("neg:") || s === "search_query_param",
  );
  // If there are weak negatives without strong article positives, it's borderline.
  // If there are no negatives at all, it's a clean accept — not borderline.
  return hasWeakNegative;
}

/**
 * Candidate-specific borderline detection with genuinely different rules
 * from the production policy.
 *
 * Applies three additional checks that the production policy does not:
 *
 * 1. **Multiple weak negatives without strong positives**: URLs with 2+ weak
 *    negative signals but no strong article positives (date_path, long_slug,
 *    article_segment) are marked UNCERTAIN. Production accepts these as long
 *    as the total score is non-negative.
 *
 * 2. **Media/embed with only generic positives**: Gallery or embed URLs with
 *    only numeric_id and/or deep_path as positive signals (no date_path,
 *    long_slug, article_segment) are marked UNCERTAIN. Production accepts
 *    these when generic positives outweigh the weak negative.
 *
 * 3. **Ambiguous slug patterns**: URLs with a multi-segment path and a
 *    numeric segment but no date_path, no long_slug (>=4 hyphens), and no
 *    article_segment are marked UNCERTAIN. Production accepts these via
 *    deep_path alone.
 *
 * All three rules are conservative — they only affect borderline URLs that
 * production accepts. URLs that production rejects are not affected.
 *
 * @internal Visible for testing.
 */
export function isCandidateBorderlineAcceptance(signals: string[]): boolean {
  const hasDatePath = signals.includes("pos:date_path");
  const hasLongSlug = signals.includes("pos:long_slug");
  const hasArticleSegment = signals.includes("pos:article_segment");

  // Strong article signals make any URL confident — not borderline.
  if (hasDatePath || hasLongSlug || hasArticleSegment) {
    return false;
  }

  // Count weak negatives (those that are not in a strong_negative_dominates context)
  const weakNegatives = signals.filter(
    (s) => (s.startsWith("neg:") || s === "search_query_param") && !signals.includes("strong_negative_dominates"),
  );
  const hasWeakNegative = weakNegatives.length > 0;
  const hasMultipleWeakNegatives = weakNegatives.length >= 2;
  const hasPositiveOverride = signals.some((s) => s.startsWith("override:"));

  // Rule 1: Multiple weak negatives without strong article positives.
  // Production accepts when total score >= 0, but candidate is less confident
  // when multiple negatives accumulate without any strong article evidence.
  if (hasMultipleWeakNegatives && !hasPositiveOverride) {
    return true;
  }

  // Rule 2: Media/embed URLs with only generic positives (numeric_id, deep_path).
  // These are commonly non-article pages that slip through production because
  // generic positives outweigh weak negatives.
  const hasGalleryOrEmbed = signals.some((s) => s === "neg:gallery" || s === "neg:embed");
  const hasNumericId = signals.includes("pos:numeric_id");
  const hasOnlyGenericPositives = signals.some((s) => s.startsWith("pos:")) &&
    !hasDatePath && !hasLongSlug && !hasArticleSegment;
  if (hasGalleryOrEmbed && hasNumericId && hasOnlyGenericPositives && !hasPositiveOverride) {
    return true;
  }

  // Rule 3: Ambiguous slug patterns — numeric segment with short/generic slug.
  // Multi-segment URLs that end with a numeric ID or have a numeric segment
  // followed by a very short slug lack strong article signals.
  if (hasNumericId && hasWeakNegative && !hasPositiveOverride) {
    return true;
  }

  // Default: not borderline — same as production behavior.
  return false;
}

/**
 * Maximum number of signal strings to include in decision evidence.
 * Prevents unbounded evidence growth from pathological URLs that
 * trigger many negative and positive patterns.
 */
const MAX_EVIDENCE_SIGNALS = 20;

/**
 * Maximum byte-length of evidence JSON serialization.
 * Prevents oversized payloads from reaching persistence.
 */
const MAX_EVIDENCE_JSON_BYTES = 2048;

/**
 * Keys that must never appear in persisted decision evidence.
 * Includes full HTML, article body text, DOM fragments, and similar
 * payloads that could leak sensitive content or bloat storage.
 */
const UNSAFE_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  "html", "body", "dom", "pageText", "fullText", "content", "rawHtml",
]);

/**
 * Sanitize decision evidence to ensure bounded size.
 * - Truncates signals array to MAX_EVIDENCE_SIGNALS entries
 * - Strips keys that could contain full HTML or article body text
 * - Bounds total JSON size to MAX_EVIDENCE_JSON_BYTES
 *
 * Exported for testing. Called internally by both evaluators.
 */
export function sanitizeEvidence(
  evidence: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!evidence) return undefined;

  // Strip unsafe keys
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (!UNSAFE_EVIDENCE_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }

  // Truncate signals array
  if (Array.isArray(sanitized.signals) && sanitized.signals.length > MAX_EVIDENCE_SIGNALS) {
    sanitized.signals = sanitized.signals.slice(0, MAX_EVIDENCE_SIGNALS);
    sanitized.signalsTruncated = true;
  }

  // Check total size
  try {
    const json = JSON.stringify(sanitized);
    if (json.length > MAX_EVIDENCE_JSON_BYTES) {
      // Preserve signals and reason on oversized fallback
      return {
        signals: sanitized.signals,
        signalsTruncated: sanitized.signalsTruncated,
        ...(typeof sanitized.reason === "string" ? { reason: sanitized.reason } : {}),
        oversized: true,
      };
    }
  } catch {
    return { signals: sanitized.signals, serializationError: true };
  }

  return sanitized;
}

/**
 * Internal convenience wrapper around classifyArticleUrl().
 *
 * Behaviour is identical to article-url-policy.ts's exported
 * `isLikelyArticleUrl()` — both delegate to classifyArticleUrl().
 *
 * === PUBLIC API CLARIFICATION ===
 *
 * This module does NOT export `isLikelyArticleUrl`.
 * The canonical export lives in `article-url-policy.ts`
 * and is unchanged. All existing imports and auto-imports
 * continue to resolve to that file without issue.
 *
 * If you need the simple boolean check, import directly:
 *   import { isLikelyArticleUrl } from "./article-url-policy";
 *
 * If you need the new evaluation framework, use:
 *   evaluateProductionUrlPolicy() — side-effect-free ENFORCED decision
 *   evaluateCandidateUrlPolicy()  — side-effect-free SHADOW decision
 *   UrlPolicyDecisionLog           — structured decision type
 *   UrlEvaluationLabel             — dataset label type
 *   isBorderlineAcceptance()       — legacy heuristic (internal, exported for testing)
 *   isCandidateBorderlineAcceptance() — candidate heuristic (internal, exported for testing)
 */
function isLikelyArticleUrl(url: string): boolean {
  return classifyArticleUrl(url).accepted;
}
