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
export const CANDIDATE_URL_POLICY_VERSION = "url-policy-2026-08-candidate-v3-media-program";

/** The dataset version for the first URL evaluation dataset. */
export const URL_EVALUATION_DATASET_VERSION = "url-eval-2026-08-v1";

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
    ],
  };
}

// ─── Expanded Holdout Dataset ──────────────────────────────────────────────

/**
 * Holdout dataset: stratified set held back for final validation.
 * ~50 labels across all expectedType and discoveryMethod categories.
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
      L("https://www.bbc.com/news/business", "LISTING", { sourceId: "bbc-com", discoveryMethod: "STATIC_LISTING" }),
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
      L("https://www.theguardian.com/news/series/investigation-podcast", "MEDIA", { sourceId: "theguardian-com", discoveryMethod: "RSS" }),
      L("https://example.com/video/2026/07/30/documentary-premiere", "MEDIA", { discoveryMethod: "BROWSER", candidateEvidence: { hasArticleMetadata: false, hasPlayerOnlyMetadata: true, structuredDataTypes: ["VideoObject"] } }),
      L("https://example.com/schedule/2026/07/30/evening-lineup", "MEDIA", { discoveryMethod: "RSS", candidateEvidence: { hasArticleMetadata: false, structuredDataTypes: ["BroadcastEvent"] } }),
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
      L("https://example.com/redirect/article?id=123", "BAD_CANONICAL", { discoveryMethod: "BROWSER", notes: "Redirect page URL pointing to canonical article" }),
      // ── Other (should reject) ─────────────────────────────────────
      L("https://example.com/search?q=test", "OTHER", { discoveryMethod: "HTML_FALLBACK" }),
      L("https://example.com/feed", "OTHER", { discoveryMethod: "MANUAL" }),
      L("https://example.com/help/faq", "OTHER", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/careers", "OTHER", { discoveryMethod: "STATIC_LISTING" }),
      L("https://example.com/auth/sign-in", "OTHER", { discoveryMethod: "HTML_FALLBACK" }),
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
  const hasArticleMetadata = input.candidateEvidence?.hasArticleMetadata === true;
  const hasStrongArticleSignal = [
    "pos:date_path", "pos:long_slug", "pos:article_segment", "pos:article_suffix",
  ].some((signal) => signals.includes(signal));
  const strongProgrammeEvidence = routeTokens.length > 0 || structuredDataTypes.length > 0 || playerOnly;

  if (!strongProgrammeEvidence || hasArticleMetadata || hasStrongArticleSignal) return null;

  const noArticleMetadata = input.candidateEvidence?.hasArticleMetadata === false;
  const reasonCode = noArticleMetadata && (routeTokens.length > 0 || structuredDataTypes.length > 0)
    ? "programme_media_without_article_metadata"
    : playerOnly
      ? "player_only_media_metadata"
      : "media_programme_route";

  return {
    decision: noArticleMetadata || playerOnly ? "REJECT" : "UNCERTAIN",
    reasonCode,
    evidence: {
      mediaRouteTokens: routeTokens.slice(0, 8),
      structuredDataTypes: structuredDataTypes.slice(0, 8),
      playerOnlyMetadata: playerOnly,
      articleMetadataPresent: hasArticleMetadata,
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
    const mediaDecision = evaluateCandidateMediaEvidence(input, result.signals);
    // Candidate-only media/program evidence remains SHADOW. Strong article
    // signals or explicit article metadata preserve genuine text articles.
    if (mediaDecision) {
      decision = mediaDecision.decision;
      reasonCode = mediaDecision.reasonCode;
      evidence = { signals: result.signals, ...mediaDecision.evidence };
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
