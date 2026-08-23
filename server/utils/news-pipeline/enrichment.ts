import type { Prisma } from "@prisma/client";
import type {
  ArticleAccessClassification,
  ArticleAccessClassificationResult,
} from "./article-access-classification";

// ─────────────────────────────────────────────────────────────────────────────
// Agent 3 — Article enrichment runtime outcome contract (Phase 1)
// ─────────────────────────────────────────────────────────────────────────────
//
// This module is the single source of truth for the Agent 3 article-enrichment
// outcome shape, in the same role that `./types.ts` plays for Agent 1 feed
// discovery (DiscoveryOutcome / createDiscoveryOutcome /
// serializeDiscoveryPayload / validateDiscoveryEvidence).
//
// Phase 1 scope: the structured runtime contract + serialization/validation
// helpers + minimal Article status-tracking fields. The actual HTTP extraction
// crawler and headless worker are Phase 2/3 and are intentionally NOT
// implemented here.
//
// Design constraints honoured:
//  - Agent 1 discovery behavior is untouched; Agent 3 only *reads* upstream
//    provenance (source/category/feed origin) and carries it forward.
//  - Structured runtime model over ad-hoc strings: every outcome has a typed
//    `kind`, a structured `reason`, field-by-field provenance, and timing.
//  - DB-efficient: detailed evidence lives in artifact payloads; only a
//    short summary is persisted on the Article row via `serializeOutcomeSummary`.
//  - Forward-compatible with the hard-case queue: `HEADLESS_REQUIRED` is a
//    first-class outcome kind that future Phase 3 workers will consume.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical outcome kinds for a single article-enrichment attempt.
 *
 * Maps 1:1 to the runtime states required by the Agent 3 dev plan:
 *  - SUCCESS            → enrichment produced usable field improvements
 *  - SKIPPED            → no enrichment needed (e.g. already enriched / stale)
 *  - RETRYABLE_FAILURE  → transient error (timeout, 5xx, network) worth retrying
 *  - HEADLESS_REQUIRED  → hard case: HTTP extraction insufficient, queue for
 *                         a separate headless worker (Phase 3)
 *  - PAYWALL_BLOCKED    → article-level paywall evidence confirms a block
 *  - CANONICAL_MISMATCH → fetched page canonical does not match the article URL
 *  - LOW_CONTENT_QUALITY→ extraction succeeded but content quality below threshold
 *  - UNSUPPORTED_STRUCTURE → page structure not parseable by HTTP extraction
 *  - INTERSTITIAL_OR_CHALLENGE → HTTP 202 page without a usable article body
 *    that resembles an interstitial/challenge/consent/queue page; stays bounded
 *    and retryable (browser-recoverable) instead of a terminal quality failure
 */
export type EnrichmentOutcomeKind =
  | "SUCCESS"
  | "SKIPPED"
  | "RETRYABLE_FAILURE"
  | "HEADLESS_REQUIRED"
  | "PAYWALL_BLOCKED"
  | "CANONICAL_MISMATCH"
  | "LOW_CONTENT_QUALITY"
  | "UNSUPPORTED_STRUCTURE"
  | "HTTP_ACCESS_BLOCKED"
  | "INTERSTITIAL_OR_CHALLENGE";

/**
 * Structured rejection / skip reason. Never a free-form log string.
 *
 * `code` is a stable, machine-readable token; `detail` is an optional
 * human-readable explanation for audit logs. Consumers branch on `code`.
 */
export interface EnrichmentRejectionReason {
  code:
    | "PAYWALL_BLOCKED"
    | "HTTP_FORBIDDEN"
    | "HTTP_NOT_FOUND"
    | "FETCH_TIMEOUT"
    | "LOW_CONTENT_QUALITY"
    | "CANONICAL_MISMATCH"
    | "DUPLICATE_OR_REDUNDANT"
    | "HEADLESS_REQUIRED"
    | "UNSUPPORTED_STRUCTURE"
    | "INTERSTITIAL_OR_CHALLENGE"
    | "ALREADY_ENRICHED"
    | "OUTSIDE_FRESHNESS_WINDOW"
    | "NO_ARTICLE_URL"
    | "UNKNOWN";
  /** Optional human-readable detail for audit logs. */
  detail?: string | null;
  /** HTTP status code when the rejection was HTTP-driven. */
  httpStatus?: number | null;
  /** Actual bounded retry time when upstream supplied one. */
  retryAfterAt?: string | null;
}

/**
 * Where a given enriched field value came from.
 * Preserves the Agent 1 "raw vs normalized vs chosen" lineage.
 */
export type FieldProvenanceSource =
  | "feed" // value taken as-is from Agent 1 ingest (RSS/Atom/JSON/HTML fallback)
  | "meta" // value derived from <meta> / og: / twitter: / JSON-LD
  | "dom" // value derived from article DOM selectors
  | "canonical" // value derived from canonical URL resolution
  | "unchanged" // value was not modified (kept the feed value)
  | "none"; // no value available

/**
 * Field-level provenance for a single enriched article field.
 *
 * Mirrors the Agent 3 dev plan §7.2 field-overwrite rule:
 * keep raw / normalized / chosenValue / chosenFrom / overrideReason.
 */
export interface FieldProvenance<T = string | null> {
  /** Original value supplied by Agent 1 ingest. */
  raw: T;
  /** Value chosen after enrichment comparison. */
  chosenValue: T;
  /** Source the chosen value was taken from. */
  chosenFrom: FieldProvenanceSource;
  /** Why the chosen value overrides (or keeps) the raw value. */
  overrideReason: string;
}

/**
 * Field-by-field provenance for all enrichment-targeted article fields.
 * Every field is optional: a given extraction attempt may only touch a subset.
 */
export interface ArticleFieldProvenance {
  title?: FieldProvenance<string | null>;
  excerpt?: FieldProvenance<string | null>;
  bodyText?: FieldProvenance<string | null>;
  bodyHtml?: FieldProvenance<string | null>;
  imageUrl?: FieldProvenance<string | null>;
  author?: FieldProvenance<string | null>;
  publishedAt?: FieldProvenance<string | null>; // ISO-8601 string
  isPaywall?: FieldProvenance<boolean | null>;
}

/**
 * Upstream Agent 1 provenance carried forward by Agent 3.
 *
 * Agent 3 must NOT re-derive or overwrite this; it preserves traceability of
 * where the article came from (feed discovery / hard-case rerun / etc.).
 */
export type FeedOrigin = "rss" | "atom" | "json" | "html_fallback" | "web_discovery";

export type EarlyAccessRecoveryStatus = "MATCHED" | "NO_MATCH" | "WINDOW_TRUNCATED" | "QUERY_FAILED";

export interface EarlyAccessRecoveryDiagnostics {
  status: EarlyAccessRecoveryStatus;
  artifactTypesQueried: Array<"rss_candidates" | "article_discovery_candidates">;
  artifactsScanned: number;
  artifactWindowLimit: number;
  candidateLimitPerArtifact: number;
  matchingArtifactType: "rss_candidates" | "article_discovery_candidates" | null;
  matchingArtifactId: string | null;
  candidateMatchType: "canonical" | "source" | null;
  windowTruncated: boolean;
}

export interface ArticleUpstreamProvenance {
  sourceId: string;
  /** Category id when the article was ingested from a category-scoped feed. */
  categoryId?: string | null;
  /** Feed origin recorded by Agent 1 ingest; null means the origin is unknown. */
  feedOrigin: FeedOrigin | null;
  /** Feed URL the article was ingested from, if known. */
  feedUrl?: string | null;
  /** Original Article URL before a transport-only HTTPS upgrade. */
  originalArticleUrl?: string | null;
  /** Whether the article arrived via a scoped category feed; null means unknown. */
  discoveredFromCategoryFeed?: boolean | null;
  /**
   * Whether the article universe was expanded by an Agent 1 hard-case
   * discovery + targeted rerun; null means unknown.
   */
  arrivedViaHardCaseRerun?: boolean | null;
  /** Stable Agent 1 artifact reference when provenance was recovered from an artifact. */
  ingestArtifactId?: string | null;
  /** Stable Agent 1 pipeline-run reference when provenance was recovered from an artifact. */
  ingestPipelineRunId?: string | null;
  /** ISO-8601 timestamp of the original Agent 1 ingest. */
  ingestedAt?: string | null;
  /** Bounded early access hint from Agent 1/2; never authoritative. */
  earlyAccessEvidence?: {
    classification: "PAYWALL_BLOCKED" | "METERED_OR_DECLARED" | "ACCESSIBLE" | "UNKNOWN";
    sourceStage: "agent1" | "agent2";
    evidenceCodes: string[];
    contradictingEvidenceCodes: string[];
  } | null;
  /** Truthful bounded diagnostics for the Agent 1/2 recovery window. */
  earlyAccessRecovery?: EarlyAccessRecoveryDiagnostics;
  /** True when the bounded artifact window may have omitted older rows. */
  earlyAccessRecoveryWindowTruncated?: boolean;
}

/**
 * Timing metadata for a single enrichment attempt.
 * All values in milliseconds; `startedAt`/`finishedAt` are ISO-8601 strings.
 */
export interface EnrichmentTiming {
  startedAt: string;
  finishedAt: string;
  /** Wall-clock duration of the attempt in ms (finishedAt - startedAt). */
  durationMs: number;
  /** Time spent fetching the article HTML, when measurable. */
  fetchMs?: number | null;
  /** Time spent parsing/extracting, when measurable. */
  extractMs?: number | null;
}

/**
 * Extraction method descriptor.
 * `method` is the coarse strategy; `detail` is selector/strategy specifics.
 */
export interface ExtractionMethod {
  /** Coarse extraction strategy. */
  method: "http-meta" | "http-dom" | "browser-dom" | "none";
  /** Optional detail: selectors used, fallback chain, etc. */
  detail?: string | null;
  /** Final canonical URL resolved for the article, if any. */
  resolvedCanonicalUrl?: string | null;
  /** URL used for the successful transport attempt, when it differs from the Article URL. */
  transportUrl?: string | null;
  /** Original Article URL before HTTPS-first transport normalization. */
  originalArticleUrl?: string | null;
  /** Bounded HTTPS-first/HTTP-fallback attempt evidence. */
  transportAttempts?: Array<{
    protocol: "https" | "http";
    url: string | null;
    statusCode: number | null;
    outcome: "success" | "http_error" | "fetch_error" | "non_html" | "blocked";
  }>;
  /** Whether the page followed redirects and the final URL differed. */
  redirected?: boolean;
}

/**
 * Quality / confidence summary for the extraction.
 * `confidence` is 0..1; `qualityScore` is an optional coarse 0..100 metric.
 */
export interface ExtractionQuality {
  /** 0..1 extraction confidence. */
  confidence: number;
  /** Optional 0..100 content quality score. */
  qualityScore?: number | null;
  /** Signals that influenced the score (e.g. "short_body", "no_author"). */
  signals?: string[];
  /** Approximate extracted body length in characters, when known. */
  bodyLength?: number | null;
}

/**
 * Canonical structured outcome model for a single article-enrichment attempt.
 *
 * This is the Agent 3 equivalent of Agent 1's `DiscoveryOutcome`. It is the
 * single source of truth for "what happened" during an enrichment attempt.
 * Downstream workers, audit tooling, and artifact persistence should read this
 * model instead of reconstructing outcomes from scattered fields.
 *
 * Compatible with Prisma JSON columns (Article.enrichmentOutcome summary,
 * PipelineArtifact payload).
 */
/**
 * Current Agent 3 extractor version.
 * Bumped when the extraction algorithm changes materially (boundary detection,
 * scoring, paragraph extraction, etc.). Stored in enrichmentOutcome JSON so
 * the admin UI can track which articles have been processed with the current
 * extractor and avoid endless reprocessing loops.
 *
 * Stable string — do not include timestamps.
 */
export const AGENT3_EXTRACTOR_VERSION = "a3-serverless-linkedom-v5";

const EVIDENCE_TEXT_LIMIT = 240;

/**
 * Sanitize human-readable evidence before it enters a JSON artifact. This is
 * deliberately conservative: control characters, markup, credentials, and
 * token-like values are removed or redacted, and the result is bounded.
 */
export const sanitizeEnrichmentEvidenceText = (value: unknown, max = EVIDENCE_TEXT_LIMIT): string | null => {
  if (typeof value !== "string") return null;
  // Diagnostic strings that contain markup are not safe evidence; discard
  // them rather than preserving arbitrary inner text from raw HTML.
  if (/<[a-z!/][^>]*>/i.test(value)) return null;
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(https?:\/\/[^\s\"'<>?]+)\?[^\s\"'<>]*/gi, "$1")
    .replace(/(?:authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? sanitized.slice(0, Math.max(1, max)) : null;
};

/** Store only credential-free URL origin/path in diagnostic artifacts. */
export const sanitizeEnrichmentEvidenceUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 4_000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 1_000);
  } catch {
    return sanitizeEnrichmentEvidenceText(value, 1_000);
  }
};

/** Recursively bound diagnostic-only JSON without retaining raw markup/secrets. */
const sanitizeEnrichmentEvidenceJson = (value: unknown, depth = 0): unknown => {
  if (depth > 5) return null;
  if (typeof value === "string") return sanitizeEnrichmentEvidenceText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeEnrichmentEvidenceJson(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([key, item]) => [
      sanitizeEnrichmentEvidenceText(key, 80) || "field",
      sanitizeEnrichmentEvidenceJson(item, depth + 1),
    ]));
  }
  return null;
};

/**
 * Compact extraction diagnostics stored on rejection artifacts.
 * Provides enough data to debug why extraction failed without storing
 * raw HTML, full page text, or full bodyText.
 */
export interface RejectionDiagnostics {
  /** Article title at time of extraction (for admin debugging). */
  title?: string | null;
  selectedContainerSelector: string | null;
  selectedContainerScore: number | null;
  selectedContainerParagraphCount: number | null;
  selectedContainerTextLength: number | null;
  candidateContainerCount: number | null;
  bodyRejectedReason: string | null;
  scoreReasons: string[];
  bodySource: string | null;
  linkTextRatio: number | null;
  boilerplatePenalty: number | null;
  topCandidates: Array<{
    selector: string | null;
    score: number | null;
    paragraphCount: number | null;
    textLength: number | null;
    reasons: string[];
  }>;
  stoppedAtText: string | null;
  stoppedAtClassOrId: string | null;
  excludedBlockCount: number | null;
}

/**
 * Compact metadata about a browser fallback attempt for an article.
 * Stored on the outcome when browser fallback was attempted, providing
 * visibility into whether the browser path helped recover content.
 */
/**
 * Compact browser-side extraction diagnostics stored on BrowserFallbackMetadata
 * when browser fallback fails. Provides enough data to debug browser extraction
 * quality without storing raw HTML or large text blobs.
 */
export interface BrowserDiagnostics {
  selectedContainerSelector: string | null;
  paragraphCount: number | null;
  totalTextLength: number | null;
  candidateContainerCount: number | null;
  stoppedAtText: string | null;
  stoppedAtClassOrId: string | null;
  topCandidates: Array<{
    selector: string | null;
    score: number | null;
    paragraphCount: number | null;
    textLength: number | null;
  }>;
  navigation?: import("./browser-navigation-governor").BrowserNavigationEvidence | null;
}

/** Reasons why browser fallback was skipped for an article. */
export type BrowserFallbackSkippedReason =
  | "not_eligible"
  | "browser_disabled"
  | "max_attempts_exhausted"
  | "source_cooldown"
  | "runtime_unavailable_global_stop"
  | "rate_limited_source"
  | "recently_blocked"
  | "static_429_host";

export interface BrowserFallbackMetadata {
  /** Static HTTP status retained even when browser fallback runs or succeeds. */
  staticStatusCode: number | null;
  /** Whether browser fallback was attempted. */
  attempted: boolean;
  /** Whether browser fallback succeeded (produced usable content). */
  succeeded: boolean;
  /** The static extractor rejection reason that triggered the browser fallback. */
  staticRejectedReason: string | null;
  /** The static extractor method before fallback. */
  staticMethod: string | null;
  /** Extraction method from the browser result. */
  method: string | null;
  /** Rejection reason from the browser extraction result. */
  rejectedReason: string | null;
  /** Browser-specific rejection reason when the browser itself failed (e.g. "browser_runtime_unavailable"). */
  browserRejectedReason: string | null;
  /** HTTP status code from the browser navigation. */
  statusCode: number | null;
  /** Whether the browser runtime was unavailable. */
  runtimeUnavailable: boolean;
  /** Whether the browser hit a rate limit (429). */
  rateLimited: boolean;
  /** Why browser fallback was skipped, if it was not attempted. */
  browserFallbackSkippedReason?: BrowserFallbackSkippedReason | null;
  /** Confidence score from browser extraction (if succeeded). */
  confidence: number | null;
  /** Compact browser-side diagnostics when fallback failed. */
  browserDiagnostics: BrowserDiagnostics | null;
}

/**
 * Per-batch browser fallback run statistics.
 * Persisted in PipelineRun.summary for post-refresh observability.
 */
export interface BrowserFallbackRunStats {
  attempted: number;
  succeeded: number;
  failed: number;
  runtimeUnavailable: number;
  rateLimited: number;
}

export interface Agent3RetryDiagnostics {
  disposition: "READY_NEW" | "READY_RETRY" | "DEFERRED" | "QUARANTINED" | "NON_RETRYABLE";
  reasonCode: string | null;
  attemptNumber: number;
  retryAfter: string | null;
  articleId: number;
  sourceId: string;
  hostname: string;
  pipelineRunId: string | null;
  browserFallbackCouldHelp: boolean;
  evidenceSummary: string;
  httpStatus?: number | null;
  extractorVersion?: string;
  previousAttemptAt?: string | null;
  /** Durable retry timestamp origin, without exposing raw response headers. */
  retryAfterSource?: "persisted" | "derived" | null;
  /** True when an implausibly distant persisted retry time was bounded. */
  retryAfterCapped?: boolean;
}

export interface ArticleAccessOutcomeSummary {
  classification: ArticleAccessClassification;
  /** Agent stage that produced this access decision; Agent 3 is authoritative. */
  sourceStage: "agent1" | "agent2" | "agent3";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  detectorVersion: string;
  evidenceCodes: string[];
  contradictingEvidenceCodes: string[];
  evidenceArticleScoped: boolean;
  usableBodyExtracted: boolean;
  bodyTruncationDetected: boolean;
  articleScopedGateOrOverlayDetected: boolean;
  decisive: boolean;
  previousIsPaywall: boolean;
  earlyStageClassification: ArticleAccessClassification | null;
  earlyStageSource: "agent1" | "agent2" | null;
  earlyStageEvidenceCodes: string[];
  earlyStageContradictingEvidenceCodes: string[];
  finalIsPaywall: boolean | null;
  overrideReason: string | null;
}

export const summarizeArticleAccess = (
  access: ArticleAccessClassificationResult,
  input?: {
    previousIsPaywall?: boolean;
    earlyStageClassification?: ArticleAccessClassification | null;
    earlyStageSource?: "agent1" | "agent2" | null;
    earlyStageEvidenceCodes?: string[];
    earlyStageContradictingEvidenceCodes?: string[];
    sourceStage?: "agent1" | "agent2" | "agent3";
    finalIsPaywall?: boolean | null;
    overrideReason?: string | null;
  },
): ArticleAccessOutcomeSummary => ({
  classification: access.classification,
  sourceStage: input?.sourceStage ?? "agent3",
  confidence: access.confidence,
  detectorVersion: access.detectorVersion,
  evidenceCodes: access.evidence.map((entry) => entry.code).slice(0, 12),
  contradictingEvidenceCodes: access.contradictingEvidence.map((entry) => entry.code).slice(0, 12),
  evidenceArticleScoped: access.evidenceArticleScoped,
  usableBodyExtracted: access.usableBodyExtracted,
  bodyTruncationDetected: access.bodyTruncationDetected,
  articleScopedGateOrOverlayDetected: access.articleScopedGateOrOverlayDetected,
  decisive: access.decisive,
  previousIsPaywall: input?.previousIsPaywall ?? false,
  earlyStageClassification: input?.earlyStageClassification ?? null,
  earlyStageSource: input?.earlyStageSource ?? null,
    earlyStageEvidenceCodes: (input?.earlyStageEvidenceCodes ?? [])
      .map((code) => sanitizeEnrichmentEvidenceText(code, 80))
      .filter((code): code is string => Boolean(code))
      .slice(0, 12),
    earlyStageContradictingEvidenceCodes: (input?.earlyStageContradictingEvidenceCodes ?? [])
      .map((code) => sanitizeEnrichmentEvidenceText(code, 80))
      .filter((code): code is string => Boolean(code))
      .slice(0, 12),
  finalIsPaywall: input?.finalIsPaywall ?? access.isPaywall,
  overrideReason: input?.overrideReason ?? null,
});

export interface ArticleEnrichmentOutcome {
  /** Schema version for forward-compatible deserialization. */
  schemaVersion: 1;
  /** Agent 3 extractor version that produced this outcome. */
  extractorVersion: string;
  /** Canonical outcome kind. */
  kind: EnrichmentOutcomeKind;
  /** Numeric Article.id this outcome refers to. */
  articleId: number;
  /** Article canonical/source URL that was evaluated. */
  articleUrl: string | null;
  /** Upstream Agent 1 provenance, preserved untouched. */
  provenance: ArticleUpstreamProvenance;
  /** Extraction method + canonical resolution metadata. */
  method: ExtractionMethod;
  /** Timing metadata for the attempt. */
  timing: EnrichmentTiming;
  /** Quality / confidence summary. */
  quality: ExtractionQuality;
  /** Field-by-field provenance for touched fields. */
  fields: ArticleFieldProvenance;
  /** Bounded Agent 3 access classification and compatibility decision. */
  access?: ArticleAccessOutcomeSummary;
  /** Structured rejection / skip reason, present for non-SUCCESS kinds. */
  rejection: EnrichmentRejectionReason | null;
  /** Free-form error message for unexpected exceptions (audit only). */
  error: string | null;
  /** Compact extraction diagnostics for rejection artifacts (admin debugging). */
  rejectionDiagnostics?: RejectionDiagnostics;
  /** Browser fallback metadata, present when browser fallback was attempted. */
  browserFallback?: BrowserFallbackMetadata;
  /** Compact, bounded queue disposition persisted on deferred/quarantined outcomes. */
  retryDiagnostics?: Agent3RetryDiagnostics;
}

// ─── Constants / validation sets ─────────────────────────────────────────────

export const ENRICHMENT_STATUS_VALUES = [
  "INGESTED",
  "ENRICHING",
  "ENRICHED",
  "ENRICHMENT_FAILED",
  "ENRICHMENT_SKIPPED",
  "ENRICHMENT_QUEUED_HEADLESS",
] as const;
export type EnrichmentStatus = (typeof ENRICHMENT_STATUS_VALUES)[number];

const VALID_OUTCOME_KINDS: ReadonlySet<string> = new Set<EnrichmentOutcomeKind>([
  "SUCCESS",
  "SKIPPED",
  "RETRYABLE_FAILURE",
  "HEADLESS_REQUIRED",
  "PAYWALL_BLOCKED",
  "CANONICAL_MISMATCH",
  "LOW_CONTENT_QUALITY",
  "UNSUPPORTED_STRUCTURE",
  "HTTP_ACCESS_BLOCKED",
  "INTERSTITIAL_OR_CHALLENGE",
]);

const VALID_REJECTION_CODES: ReadonlySet<string> = new Set([
  "PAYWALL_BLOCKED",
  "HTTP_FORBIDDEN",
  "HTTP_NOT_FOUND",
  "FETCH_TIMEOUT",
  "LOW_CONTENT_QUALITY",
  "CANONICAL_MISMATCH",
  "DUPLICATE_OR_REDUNDANT",
  "HEADLESS_REQUIRED",
  "UNSUPPORTED_STRUCTURE",
  "INTERSTITIAL_OR_CHALLENGE",
  "ALREADY_ENRICHED",
  "OUTSIDE_FRESHNESS_WINDOW",
  "NO_ARTICLE_URL",
  "UNKNOWN",
]);

const VALID_FIELD_SOURCES: ReadonlySet<string> = new Set([
  "feed",
  "meta",
  "dom",
  "canonical",
  "unchanged",
  "none",
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringOrNull = (value: unknown): value is string | null =>
  typeof value === "string" || value === null;

const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface CreateEnrichmentOutcomeInput {
  kind: EnrichmentOutcomeKind;
  articleId: number;
  articleUrl?: string | null;
  provenance: ArticleUpstreamProvenance;
  method?: Partial<ExtractionMethod>;
  timing: EnrichmentTiming;
  quality?: Partial<ExtractionQuality>;
  fields?: ArticleFieldProvenance;
  access?: ArticleAccessOutcomeSummary;
  rejection?: EnrichmentRejectionReason | null;
  error?: string | null;
}

/**
 * Create a canonical `ArticleEnrichmentOutcome` from loosely-typed inputs.
 *
 * This is the single factory for producing structured enrichment outcomes
 * suitable for persistence and auditing. Mirrors Agent 1's
 * `createDiscoveryOutcome`. All optional fields are normalized to safe
 * defaults so callers never produce a partial/malformed outcome.
 */
export const createEnrichmentOutcome = (
  input: CreateEnrichmentOutcomeInput,
): ArticleEnrichmentOutcome => ({
  schemaVersion: 1,
  extractorVersion: AGENT3_EXTRACTOR_VERSION,
  kind: input.kind,
  articleId: input.articleId,
  articleUrl: isStringOrNull(input.articleUrl) ? input.articleUrl : null,
  provenance: {
    sourceId: input.provenance.sourceId,
    categoryId: input.provenance.categoryId ?? null,
    feedOrigin: input.provenance.feedOrigin ?? null,
    feedUrl: input.provenance.feedUrl ?? null,
    ...(input.provenance.originalArticleUrl !== undefined
      ? { originalArticleUrl: input.provenance.originalArticleUrl }
      : {}),
    discoveredFromCategoryFeed: input.provenance.discoveredFromCategoryFeed ?? null,
    arrivedViaHardCaseRerun: input.provenance.arrivedViaHardCaseRerun ?? null,
    ...(input.provenance.ingestArtifactId !== undefined
      ? { ingestArtifactId: input.provenance.ingestArtifactId }
      : {}),
    ...(input.provenance.ingestPipelineRunId !== undefined
      ? { ingestPipelineRunId: input.provenance.ingestPipelineRunId }
      : {}),
    ingestedAt: input.provenance.ingestedAt ?? null,
    ...(input.provenance.earlyAccessEvidence
      ? {
          earlyAccessEvidence: {
            classification: input.provenance.earlyAccessEvidence.classification,
            sourceStage: input.provenance.earlyAccessEvidence.sourceStage,
            evidenceCodes: input.provenance.earlyAccessEvidence.evidenceCodes.slice(0, 12),
            contradictingEvidenceCodes: input.provenance.earlyAccessEvidence.contradictingEvidenceCodes.slice(0, 12),
          },
        }
      : {}),
    ...(input.provenance.earlyAccessRecovery
      ? { earlyAccessRecovery: input.provenance.earlyAccessRecovery }
      : {}),
    ...(input.provenance.earlyAccessRecoveryWindowTruncated !== undefined
      ? { earlyAccessRecoveryWindowTruncated: input.provenance.earlyAccessRecoveryWindowTruncated }
      : {}),
  },
  method: {
    method: input.method?.method ?? "none",
    detail: input.method?.detail ?? null,
    resolvedCanonicalUrl: input.method?.resolvedCanonicalUrl ?? null,
    ...(input.method?.transportUrl !== undefined
      ? { transportUrl: input.method.transportUrl }
      : {}),
    ...(input.method?.originalArticleUrl !== undefined
      ? { originalArticleUrl: input.method.originalArticleUrl }
      : {}),
    ...(input.method?.transportAttempts
      ? { transportAttempts: input.method.transportAttempts.slice(0, 3) }
      : {}),
    redirected: input.method?.redirected ?? false,
  },
  timing: {
    startedAt: input.timing.startedAt,
    finishedAt: input.timing.finishedAt,
    durationMs:
      typeof input.timing.durationMs === "number" ? input.timing.durationMs : 0,
    fetchMs: input.timing.fetchMs ?? null,
    extractMs: input.timing.extractMs ?? null,
  },
  quality: {
    confidence: clamp01(input.quality?.confidence ?? 0),
    qualityScore:
      typeof input.quality?.qualityScore === "number"
        ? input.quality.qualityScore
        : null,
    signals: Array.isArray(input.quality?.signals)
      ? (input.quality!.signals as string[])
      : [],
    bodyLength:
      typeof input.quality?.bodyLength === "number" ? input.quality.bodyLength : null,
  },
  fields: input.fields ?? {},
  access: input.access,
  rejection: input.rejection ?? null,
  error: input.error ?? null,
});

// ─── Serialization ───────────────────────────────────────────────────────────

/**
 * Serialize a fully-constructed `ArticleEnrichmentOutcome` into the canonical
 * payload shape for Prisma JSON columns (PipelineArtifact payload or the
 * Article.enrichmentOutcome summary). Returns `Prisma.InputJsonValue` directly
 * so callers never need unsafe casts. Mirrors Agent 1's
 * `serializeDiscoveryPayload`.
 */
const serializeAccessSummary = (access: ArticleAccessOutcomeSummary | undefined): ArticleAccessOutcomeSummary | null => access
  ? {
      ...access,
      detectorVersion: access.detectorVersion.slice(0, 80),
      evidenceCodes: access.evidenceCodes
        .map((code) => sanitizeEnrichmentEvidenceText(code, 80))
        .filter((code): code is string => Boolean(code))
        .slice(0, 12),
      contradictingEvidenceCodes: access.contradictingEvidenceCodes
        .map((code) => sanitizeEnrichmentEvidenceText(code, 80))
        .filter((code): code is string => Boolean(code))
        .slice(0, 12),
      overrideReason: sanitizeEnrichmentEvidenceText(access.overrideReason),
    }
  : null;

const serializeEvidenceFields = (fields: ArticleFieldProvenance): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...fields };
  // Evidence must never persist raw HTML or the full article body. Keep the
  // provenance decision and bounded metadata, but redact large content values
  // at the artifact boundary. The Article row remains the content store.
  for (const key of ["bodyText", "bodyHtml"] as const) {
    const field = fields[key];
    if (!field) continue;
    result[key] = {
      raw: null,
      chosenValue: null,
      chosenFrom: field.chosenFrom,
      overrideReason: sanitizeEnrichmentEvidenceText(field.overrideReason),
    };
  }
  return result;
};

export const serializeEnrichmentPayload = (
  outcome: ArticleEnrichmentOutcome,
): Prisma.InputJsonValue =>
  ({
    schemaVersion: outcome.schemaVersion,
    extractorVersion: sanitizeEnrichmentEvidenceText(outcome.extractorVersion, 80),
    kind: outcome.kind,
    articleId: outcome.articleId,
    articleUrl: sanitizeEnrichmentEvidenceUrl(outcome.articleUrl),
    provenance: {
      sourceId: sanitizeEnrichmentEvidenceText(outcome.provenance.sourceId, 120),
      categoryId: sanitizeEnrichmentEvidenceText(outcome.provenance.categoryId, 120),
      feedOrigin: outcome.provenance.feedOrigin ?? null,
      feedUrl: sanitizeEnrichmentEvidenceUrl(outcome.provenance.feedUrl),
      ...(outcome.provenance.originalArticleUrl !== undefined
        ? { originalArticleUrl: sanitizeEnrichmentEvidenceUrl(outcome.provenance.originalArticleUrl) }
        : {}),
      discoveredFromCategoryFeed: outcome.provenance.discoveredFromCategoryFeed ?? null,
      arrivedViaHardCaseRerun: outcome.provenance.arrivedViaHardCaseRerun ?? null,
      ingestArtifactId: sanitizeEnrichmentEvidenceText(outcome.provenance.ingestArtifactId, 120),
      ingestPipelineRunId: sanitizeEnrichmentEvidenceText(outcome.provenance.ingestPipelineRunId, 120),
      ingestedAt: sanitizeEnrichmentEvidenceText(outcome.provenance.ingestedAt, 80),
      ...(outcome.provenance.earlyAccessEvidence
        ? {
            earlyAccessEvidence: {
              classification: outcome.provenance.earlyAccessEvidence.classification,
              sourceStage: outcome.provenance.earlyAccessEvidence.sourceStage,
              evidenceCodes: outcome.provenance.earlyAccessEvidence.evidenceCodes.slice(0, 12),
              contradictingEvidenceCodes: outcome.provenance.earlyAccessEvidence.contradictingEvidenceCodes.slice(0, 12),
            },
          }
        : {}),
      ...(outcome.provenance.earlyAccessRecovery
        ? { earlyAccessRecovery: outcome.provenance.earlyAccessRecovery }
        : {}),
      ...(outcome.provenance.earlyAccessRecoveryWindowTruncated !== undefined
        ? { earlyAccessRecoveryWindowTruncated: outcome.provenance.earlyAccessRecoveryWindowTruncated }
        : {}),
    },
    method: {
      ...outcome.method,
      detail: sanitizeEnrichmentEvidenceText(outcome.method.detail),
      resolvedCanonicalUrl: sanitizeEnrichmentEvidenceUrl(outcome.method.resolvedCanonicalUrl),
      ...(outcome.method.transportUrl !== undefined
        ? { transportUrl: sanitizeEnrichmentEvidenceUrl(outcome.method.transportUrl) }
        : {}),
      ...(outcome.method.originalArticleUrl !== undefined
        ? { originalArticleUrl: sanitizeEnrichmentEvidenceUrl(outcome.method.originalArticleUrl) }
        : {}),
      ...(outcome.method.transportAttempts
        ? {
            transportAttempts: outcome.method.transportAttempts.slice(0, 3).map((attempt) => ({
              protocol: attempt.protocol as "https" | "http",
              url: sanitizeEnrichmentEvidenceUrl(attempt.url),
              statusCode: attempt.statusCode,
              outcome: attempt.outcome,
            })),
          }
        : {}),
    },
    timing: outcome.timing,
    quality: {
      ...outcome.quality,
      signals: outcome.quality.signals?.map((signal) => sanitizeEnrichmentEvidenceText(signal, 120)).filter((signal): signal is string => Boolean(signal)).slice(0, 20),
    },
    fields: serializeEvidenceFields(outcome.fields),
    access: serializeAccessSummary(outcome.access),
    rejection: outcome.rejection
      ? {
          ...outcome.rejection,
          detail: sanitizeEnrichmentEvidenceText(outcome.rejection.detail),
        }
      : null,
    error: sanitizeEnrichmentEvidenceText(outcome.error),
    rejectionDiagnostics: sanitizeEnrichmentEvidenceJson(outcome.rejectionDiagnostics),
    browserFallback: sanitizeEnrichmentEvidenceJson(outcome.browserFallback),
    retryDiagnostics: sanitizeEnrichmentEvidenceJson(outcome.retryDiagnostics),
    // The nested generic FieldProvenance<T> types prevent a direct
    // Prisma.InputJsonValue assertion (TS2352). Double-cast through
    // `unknown` is safe here: every value is JSON-primitive-compatible
    // (strings, numbers, booleans, null, arrays, plain objects) and we
    // control construction end-to-end. Mirrors the safety profile of
    // Agent 1's serializeDiscoveryPayload cast.
  }) as unknown as Prisma.InputJsonValue;

/**
 * Build the minimal summary object persisted on `Article.enrichmentOutcome`.
 *
 * Keeps the row-level JSON small (DB-efficient) while still carrying the
 * outcome kind, method, confidence, rejection code, and upstream provenance
 * for quick status reads without joining artifacts. Detailed evidence stays
 * in the artifact payload.
 */
export const serializeOutcomeSummary = (
  outcome: ArticleEnrichmentOutcome,
): Prisma.InputJsonValue =>
  ({
    schemaVersion: outcome.schemaVersion,
    extractorVersion: outcome.extractorVersion,
    kind: outcome.kind,
    method: outcome.method.method,
    confidence: outcome.quality.confidence,
    rejectionCode: outcome.rejection?.code ?? null,
    rejectionHttpStatus: outcome.rejection?.httpStatus ?? null,
    rejectionDetail: sanitizeEnrichmentEvidenceText(outcome.rejection?.detail),
    retryAfterAt: outcome.rejection?.retryAfterAt ?? null,
    browserFallback: outcome.browserFallback
      ? {
          attempted: outcome.browserFallback.attempted,
          succeeded: outcome.browserFallback.succeeded,
          runtimeUnavailable: outcome.browserFallback.runtimeUnavailable,
          rateLimited: outcome.browserFallback.rateLimited,
          statusCode: outcome.browserFallback.statusCode,
          browserRejectedReason: outcome.browserFallback.browserRejectedReason,
          browserFallbackSkippedReason: outcome.browserFallback.browserFallbackSkippedReason ?? null,
        }
      : null,
    access: serializeAccessSummary(outcome.access),
    provenance: {
      sourceId: sanitizeEnrichmentEvidenceText(outcome.provenance.sourceId, 120),
      categoryId: sanitizeEnrichmentEvidenceText(outcome.provenance.categoryId, 120),
      feedOrigin: outcome.provenance.feedOrigin ?? null,
      feedUrl: sanitizeEnrichmentEvidenceUrl(outcome.provenance.feedUrl),
      ...(outcome.provenance.originalArticleUrl !== undefined
        ? { originalArticleUrl: sanitizeEnrichmentEvidenceUrl(outcome.provenance.originalArticleUrl) }
        : {}),
      ingestArtifactId: sanitizeEnrichmentEvidenceText(outcome.provenance.ingestArtifactId, 120),
      ingestPipelineRunId: sanitizeEnrichmentEvidenceText(outcome.provenance.ingestPipelineRunId, 120),
      ...(outcome.provenance.earlyAccessEvidence
        ? {
            earlyAccessEvidence: {
              classification: outcome.provenance.earlyAccessEvidence.classification,
              sourceStage: outcome.provenance.earlyAccessEvidence.sourceStage,
              evidenceCodes: outcome.provenance.earlyAccessEvidence.evidenceCodes.slice(0, 12),
              contradictingEvidenceCodes: outcome.provenance.earlyAccessEvidence.contradictingEvidenceCodes.slice(0, 12),
            },
          }
        : {}),
      ...(outcome.provenance.earlyAccessRecovery
        ? { earlyAccessRecovery: outcome.provenance.earlyAccessRecovery }
        : {}),
      ...(outcome.provenance.earlyAccessRecoveryWindowTruncated !== undefined
        ? { earlyAccessRecoveryWindowTruncated: outcome.provenance.earlyAccessRecoveryWindowTruncated }
        : {}),
    },
  }) as unknown as Prisma.InputJsonValue;

// ─── Validation / deserialization ────────────────────────────────────────────

export interface ValidatedEnrichmentOutcome {
  /** Whether the input was a structurally valid outcome object. */
  valid: boolean;
  /** Whether `kind` was present but not a recognized enum value. */
  kindMalformed: boolean;
  /** The normalized outcome, or null when structurally invalid. */
  outcome: ArticleEnrichmentOutcome | null;
}

/**
 * Normalize a string-valued field provenance entry.
 * Used for title/excerpt/bodyText/bodyHtml/imageUrl/author/publishedAt.
 */
const normalizeStringFieldProvenance = (
  value: unknown,
): FieldProvenance<string | null> | null => {
  if (!isPlainObject(value)) return null;
  const chosenFrom = value.chosenFrom;
  return {
    raw: isStringOrNull(value.raw) ? value.raw : null,
    chosenValue: isStringOrNull(value.chosenValue) ? value.chosenValue : null,
    chosenFrom: VALID_FIELD_SOURCES.has(chosenFrom as string)
      ? (chosenFrom as FieldProvenanceSource)
      : "none",
    overrideReason:
      typeof value.overrideReason === "string" ? value.overrideReason : "",
  };
};

/**
 * Normalize a boolean-valued field provenance entry (isPaywall).
 * Separate from the string path so the TypeScript type stays sound.
 */
const normalizeBoolFieldProvenance = (
  value: unknown,
): FieldProvenance<boolean | null> | null => {
  if (!isPlainObject(value)) return null;
  const chosenFrom = value.chosenFrom;
  return {
    raw: typeof value.raw === "boolean" ? value.raw : null,
    chosenValue: typeof value.chosenValue === "boolean" ? value.chosenValue : null,
    chosenFrom: VALID_FIELD_SOURCES.has(chosenFrom as string)
      ? (chosenFrom as FieldProvenanceSource)
      : "none",
    overrideReason:
      typeof value.overrideReason === "string" ? value.overrideReason : "",
  };
};

const STRING_FIELD_KEYS: ReadonlyArray<keyof ArticleFieldProvenance> = [
  "title",
  "excerpt",
  "bodyText",
  "bodyHtml",
  "imageUrl",
  "author",
  "publishedAt",
];

const normalizeFields = (
  value: unknown,
): ArticleFieldProvenance => {
  if (!isPlainObject(value)) return {};
  const out: ArticleFieldProvenance = {};
  for (const key of STRING_FIELD_KEYS) {
    const fp = normalizeStringFieldProvenance(value[key as string]);
    if (fp) (out as Record<string, unknown>)[key as string] = fp;
  }
  const isPaywallFp = normalizeBoolFieldProvenance(value.isPaywall);
  if (isPaywallFp) out.isPaywall = isPaywallFp;
  return out;
};

const normalizeAccessSummary = (
  value: unknown,
): ArticleAccessOutcomeSummary | undefined => {
  if (!isPlainObject(value) || typeof value.classification !== "string") return undefined;
  const classifications: ReadonlySet<string> = new Set([
    "ACCESSIBLE", "PAYWALL_BLOCKED", "METERED_OR_DECLARED",
    "INTERSTITIAL_OR_CHALLENGE", "HTTP_ACCESS_BLOCKED", "UNKNOWN",
  ]);
  const confidence = value.confidence === "HIGH" || value.confidence === "MEDIUM" || value.confidence === "LOW"
    ? value.confidence
    : "LOW";
  return {
    classification: classifications.has(value.classification)
      ? value.classification as ArticleAccessClassification
      : "UNKNOWN",
    sourceStage: value.sourceStage === "agent1" || value.sourceStage === "agent2" || value.sourceStage === "agent3"
      ? value.sourceStage
      : "agent3",
    confidence,
    detectorVersion: typeof value.detectorVersion === "string" ? value.detectorVersion.slice(0, 80) : "",
    evidenceCodes: Array.isArray(value.evidenceCodes) ? value.evidenceCodes.filter((code): code is string => typeof code === "string").slice(0, 12) : [],
    contradictingEvidenceCodes: Array.isArray(value.contradictingEvidenceCodes) ? value.contradictingEvidenceCodes.filter((code): code is string => typeof code === "string").slice(0, 12) : [],
    evidenceArticleScoped: value.evidenceArticleScoped === true,
    usableBodyExtracted: value.usableBodyExtracted === true,
    bodyTruncationDetected: value.bodyTruncationDetected === true,
    articleScopedGateOrOverlayDetected: value.articleScopedGateOrOverlayDetected === true,
    decisive: value.decisive === true,
    previousIsPaywall: value.previousIsPaywall === true,
    earlyStageClassification: classifications.has(String(value.earlyStageClassification))
      ? value.earlyStageClassification as ArticleAccessClassification
      : null,
    earlyStageSource: value.earlyStageSource === "agent1" || value.earlyStageSource === "agent2"
      ? value.earlyStageSource
      : null,
    earlyStageEvidenceCodes: Array.isArray(value.earlyStageEvidenceCodes)
      ? value.earlyStageEvidenceCodes.filter((code): code is string => typeof code === "string").slice(0, 12)
      : [],
    earlyStageContradictingEvidenceCodes: Array.isArray(value.earlyStageContradictingEvidenceCodes)
      ? value.earlyStageContradictingEvidenceCodes.filter((code): code is string => typeof code === "string").slice(0, 12)
      : [],
    finalIsPaywall: typeof value.finalIsPaywall === "boolean" ? value.finalIsPaywall : null,
    overrideReason: typeof value.overrideReason === "string" ? value.overrideReason.slice(0, 240) : null,
  };
};

const normalizeRejection = (
  value: unknown,
): EnrichmentRejectionReason | null => {
  if (!isPlainObject(value)) return null;
  const code = value.code;
  return {
    code: VALID_REJECTION_CODES.has(code as string)
      ? (code as EnrichmentRejectionReason["code"])
      : "UNKNOWN",
    detail: typeof value.detail === "string" ? value.detail : null,
    httpStatus: typeof value.httpStatus === "number" ? value.httpStatus : null,
    retryAfterAt: typeof value.retryAfterAt === "string" ? value.retryAfterAt : null,
  };
};

const normalizeProvenance = (
  value: unknown,
): ArticleUpstreamProvenance | null => {
  if (!isPlainObject(value)) return null;
  const feedOrigin = value.feedOrigin;
  const validOrigins: ReadonlySet<string> = new Set([
    "rss",
    "atom",
    "json",
    "html_fallback",
    "web_discovery",
  ]);
  if (typeof value.sourceId !== "string") return null;
  return {
    sourceId: value.sourceId,
    categoryId: typeof value.categoryId === "string" ? value.categoryId : null,
    feedOrigin: typeof feedOrigin === "string" && validOrigins.has(feedOrigin)
      ? (feedOrigin as ArticleUpstreamProvenance["feedOrigin"])
      : null,
    feedUrl: isStringOrNull(value.feedUrl) ? value.feedUrl : null,
    originalArticleUrl: isStringOrNull(value.originalArticleUrl) ? value.originalArticleUrl : undefined,
    discoveredFromCategoryFeed:
      typeof value.discoveredFromCategoryFeed === "boolean"
        ? value.discoveredFromCategoryFeed
        : null,
    arrivedViaHardCaseRerun:
      typeof value.arrivedViaHardCaseRerun === "boolean"
        ? value.arrivedViaHardCaseRerun
        : null,
    ingestArtifactId: typeof value.ingestArtifactId === "string" ? value.ingestArtifactId : null,
    ingestPipelineRunId: typeof value.ingestPipelineRunId === "string" ? value.ingestPipelineRunId : null,
    ingestedAt: typeof value.ingestedAt === "string" ? value.ingestedAt : null,
    earlyAccessEvidence: isPlainObject(value.earlyAccessEvidence)
      && (value.earlyAccessEvidence.sourceStage === "agent1" || value.earlyAccessEvidence.sourceStage === "agent2")
      && typeof value.earlyAccessEvidence.classification === "string"
      ? {
          classification: value.earlyAccessEvidence.classification as NonNullable<ArticleUpstreamProvenance["earlyAccessEvidence"]>["classification"],
          sourceStage: value.earlyAccessEvidence.sourceStage,
          evidenceCodes: Array.isArray(value.earlyAccessEvidence.evidenceCodes)
            ? value.earlyAccessEvidence.evidenceCodes.filter((code): code is string => typeof code === "string").slice(0, 12)
            : [],
          contradictingEvidenceCodes: Array.isArray(value.earlyAccessEvidence.contradictingEvidenceCodes)
            ? value.earlyAccessEvidence.contradictingEvidenceCodes.filter((code): code is string => typeof code === "string").slice(0, 12)
            : [],
        }
      : null,
    earlyAccessRecovery: isPlainObject(value.earlyAccessRecovery)
      ? {
          status: value.earlyAccessRecovery.status === "MATCHED" || value.earlyAccessRecovery.status === "NO_MATCH" || value.earlyAccessRecovery.status === "WINDOW_TRUNCATED" || value.earlyAccessRecovery.status === "QUERY_FAILED"
            ? value.earlyAccessRecovery.status
            : "QUERY_FAILED",
          artifactTypesQueried: Array.isArray(value.earlyAccessRecovery.artifactTypesQueried)
            ? value.earlyAccessRecovery.artifactTypesQueried.filter((type): type is "rss_candidates" | "article_discovery_candidates" => type === "rss_candidates" || type === "article_discovery_candidates").slice(0, 2)
            : [],
          artifactsScanned: typeof value.earlyAccessRecovery.artifactsScanned === "number" ? Math.max(0, Math.min(200, Math.floor(value.earlyAccessRecovery.artifactsScanned))) : 0,
          artifactWindowLimit: typeof value.earlyAccessRecovery.artifactWindowLimit === "number" ? Math.max(1, Math.min(200, Math.floor(value.earlyAccessRecovery.artifactWindowLimit))) : 200,
          candidateLimitPerArtifact: typeof value.earlyAccessRecovery.candidateLimitPerArtifact === "number" ? Math.max(1, Math.min(100, Math.floor(value.earlyAccessRecovery.candidateLimitPerArtifact))) : 100,
          matchingArtifactType: value.earlyAccessRecovery.matchingArtifactType === "rss_candidates" || value.earlyAccessRecovery.matchingArtifactType === "article_discovery_candidates" ? value.earlyAccessRecovery.matchingArtifactType : null,
          matchingArtifactId: typeof value.earlyAccessRecovery.matchingArtifactId === "string" ? value.earlyAccessRecovery.matchingArtifactId.slice(0, 120) : null,
          candidateMatchType: value.earlyAccessRecovery.candidateMatchType === "canonical" || value.earlyAccessRecovery.candidateMatchType === "source" ? value.earlyAccessRecovery.candidateMatchType : null,
          windowTruncated: value.earlyAccessRecovery.windowTruncated === true,
        }
      : undefined,
    earlyAccessRecoveryWindowTruncated: value.earlyAccessRecoveryWindowTruncated === true,
  };
};

/**
 * Validate and normalize a persisted enrichment outcome JSON value.
 *
 * Single entry-point for reading outcomes back from Prisma JSON columns,
 * mirroring Agent 1's `validateDiscoveryEvidence`. Malformed sub-objects are
 * normalized to safe defaults rather than rejecting the whole payload — a
 * single bad field should not discard valid data in others. Returns
 * `{ valid: false, outcome: null }` only when the top-level shape is wrong or
 * required fields (articleId/provenance/timing) are missing/invalid.
 */
export const validateEnrichmentOutcome = (
  raw: unknown,
): ValidatedEnrichmentOutcome => {
  if (!isPlainObject(raw)) {
    return { valid: false, kindMalformed: false, outcome: null };
  }

  const kind = raw.kind;
  const kindMalformed =
    typeof kind === "string" && !VALID_OUTCOME_KINDS.has(kind);
  if (typeof kind !== "string" || kindMalformed) {
    return { valid: false, kindMalformed, outcome: null };
  }

  if (typeof raw.articleId !== "number") {
    return { valid: false, kindMalformed: false, outcome: null };
  }

  const provenance = normalizeProvenance(raw.provenance);
  if (!provenance) {
    return { valid: false, kindMalformed: false, outcome: null };
  }

  const timingRaw = raw.timing;
  if (
    !isPlainObject(timingRaw) ||
    typeof timingRaw.startedAt !== "string" ||
    typeof timingRaw.finishedAt !== "string"
  ) {
    return { valid: false, kindMalformed: false, outcome: null };
  }

  const methodRaw = isPlainObject(raw.method) ? raw.method : {};
  const qualityRaw = isPlainObject(raw.quality) ? raw.quality : {};

  const outcome: ArticleEnrichmentOutcome = {
    // This is the v1 validator; always emit schemaVersion 1. A future v2
    // payload would be handled by a dedicated v2 validator, not here.
    schemaVersion: 1,
    extractorVersion: typeof raw.extractorVersion === "string" ? raw.extractorVersion : "",
    kind: kind as EnrichmentOutcomeKind,
    articleId: raw.articleId,
    articleUrl: isStringOrNull(raw.articleUrl) ? raw.articleUrl : null,
    provenance,
    method: {
      method:
        methodRaw.method === "http-meta" ||
        methodRaw.method === "http-dom" ||
        methodRaw.method === "none"
          ? methodRaw.method
          : "none",
      detail: typeof methodRaw.detail === "string" ? methodRaw.detail : null,
      resolvedCanonicalUrl: isStringOrNull(methodRaw.resolvedCanonicalUrl)
        ? methodRaw.resolvedCanonicalUrl
        : null,
      transportUrl: isStringOrNull(methodRaw.transportUrl) ? methodRaw.transportUrl : undefined,
      originalArticleUrl: isStringOrNull(methodRaw.originalArticleUrl) ? methodRaw.originalArticleUrl : undefined,
      transportAttempts: Array.isArray(methodRaw.transportAttempts)
        ? methodRaw.transportAttempts.flatMap((attempt) => {
            if (!isPlainObject(attempt)) return [];
            if (attempt.protocol !== "https" && attempt.protocol !== "http") return [];
            if (!["success", "http_error", "fetch_error", "non_html", "blocked"].includes(String(attempt.outcome))) return [];
            return [{
              protocol: attempt.protocol as "https" | "http",
              url: isStringOrNull(attempt.url) ? attempt.url : null,
              statusCode: typeof attempt.statusCode === "number" ? attempt.statusCode : null,
              outcome: attempt.outcome as NonNullable<ExtractionMethod["transportAttempts"]>[number]["outcome"],
            }];
          }).slice(0, 3)
        : undefined,
      redirected: typeof methodRaw.redirected === "boolean" ? methodRaw.redirected : false,
    },
    timing: {
      startedAt: timingRaw.startedAt,
      finishedAt: timingRaw.finishedAt,
      durationMs:
        typeof timingRaw.durationMs === "number" ? timingRaw.durationMs : 0,
      fetchMs: typeof timingRaw.fetchMs === "number" ? timingRaw.fetchMs : null,
      extractMs: typeof timingRaw.extractMs === "number" ? timingRaw.extractMs : null,
    },
    quality: {
      confidence: clamp01(typeof qualityRaw.confidence === "number" ? qualityRaw.confidence : 0),
      qualityScore:
        typeof qualityRaw.qualityScore === "number" ? qualityRaw.qualityScore : null,
      signals: Array.isArray(qualityRaw.signals)
        ? (qualityRaw.signals as string[]).filter((s) => typeof s === "string")
        : [],
      bodyLength:
        typeof qualityRaw.bodyLength === "number" ? qualityRaw.bodyLength : null,
    },
    fields: normalizeFields(raw.fields),
    access: normalizeAccessSummary(raw.access),
    rejection: normalizeRejection(raw.rejection),
    error: typeof raw.error === "string" ? raw.error : null,
  };

  return { valid: true, kindMalformed: false, outcome };
};

// ─── Convenience builders (mirror Agent 1 buildErrorDiscoveryOutcome) ─────────

const baseTiming = (durationMs = 0): EnrichmentTiming => {
  const now = new Date();
  const started = new Date(now.getTime() - durationMs);
  return {
    startedAt: started.toISOString(),
    finishedAt: now.toISOString(),
    durationMs,
  };
};

/**
 * Build a SUCCESS outcome with field provenance and quality.
 */
export const buildSuccessOutcome = (input: {
  articleId: number;
  articleUrl?: string | null;
  provenance: ArticleUpstreamProvenance;
  method?: Partial<ExtractionMethod>;
  timing?: EnrichmentTiming;
  quality?: Partial<ExtractionQuality>;
  fields: ArticleFieldProvenance;
  access?: ArticleAccessOutcomeSummary;
}): ArticleEnrichmentOutcome =>
  createEnrichmentOutcome({
    kind: "SUCCESS",
    articleId: input.articleId,
    articleUrl: input.articleUrl ?? null,
    provenance: input.provenance,
    method: input.method,
    timing: input.timing ?? baseTiming(),
    quality: { confidence: 0.8, ...input.quality },
    fields: input.fields,
    access: input.access,
    rejection: null,
  });

/**
 * Build a SKIPPED outcome (no enrichment needed / performed).
 */
export const buildSkippedOutcome = (input: {
  articleId: number;
  articleUrl?: string | null;
  provenance: ArticleUpstreamProvenance;
  reasonCode: EnrichmentRejectionReason["code"];
  detail?: string | null;
  timing?: EnrichmentTiming;
}): ArticleEnrichmentOutcome =>
  createEnrichmentOutcome({
    kind: "SKIPPED",
    articleId: input.articleId,
    articleUrl: input.articleUrl ?? null,
    provenance: input.provenance,
    method: { method: "none" },
    timing: input.timing ?? baseTiming(),
    quality: { confidence: 0 },
    fields: {},
    rejection: { code: input.reasonCode, detail: input.detail ?? null },
  });

/**
 * Build a HEADLESS_REQUIRED outcome (hard case → queue for Phase 3 worker).
 */
export const buildHeadlessRequiredOutcome = (input: {
  articleId: number;
  articleUrl?: string | null;
  provenance: ArticleUpstreamProvenance;
  detail?: string | null;
  method?: Partial<ExtractionMethod>;
  timing?: EnrichmentTiming;
}): ArticleEnrichmentOutcome =>
  createEnrichmentOutcome({
    kind: "HEADLESS_REQUIRED",
    articleId: input.articleId,
    articleUrl: input.articleUrl ?? null,
    provenance: input.provenance,
    method: input.method ?? { method: "http-dom" },
    timing: input.timing ?? baseTiming(),
    quality: { confidence: 0 },
    fields: {},
    rejection: { code: "HEADLESS_REQUIRED", detail: input.detail ?? null },
  });

/**
 * Map a rejection code to the terminal (non-retryable) outcome kind.
 *
 * Single source of truth for code→kind so `buildFailureOutcome` never
 * produces an invalid kind. Codes that are also valid outcome kinds map
 * directly; HTTP access failures and timeouts map to UNSUPPORTED_STRUCTURE
 * (the page could not be fetched/extracted); skip-like codes (which should
 * normally use `buildSkippedOutcome`) map to SKIPPED so they remain valid.
 */
const rejectionCodeToTerminalKind = (
  code: EnrichmentRejectionReason["code"],
): EnrichmentOutcomeKind => {
  switch (code) {
    case "PAYWALL_BLOCKED":
      return "PAYWALL_BLOCKED";
    case "CANONICAL_MISMATCH":
      return "CANONICAL_MISMATCH";
    case "LOW_CONTENT_QUALITY":
      return "LOW_CONTENT_QUALITY";
    case "UNSUPPORTED_STRUCTURE":
      return "UNSUPPORTED_STRUCTURE";
    case "HEADLESS_REQUIRED":
      return "HEADLESS_REQUIRED";
    case "INTERSTITIAL_OR_CHALLENGE":
      return "INTERSTITIAL_OR_CHALLENGE";
    // HTTP 403/429 access failures → distinct HTTP_ACCESS_BLOCKED kind
    case "HTTP_FORBIDDEN":
      return "HTTP_ACCESS_BLOCKED";
    // Other HTTP failures / timeouts → page not extractable
    case "HTTP_NOT_FOUND":
    case "FETCH_TIMEOUT":
      return "UNSUPPORTED_STRUCTURE";
    // Skip-like codes → prefer buildSkippedOutcome, but stay valid here
    case "DUPLICATE_OR_REDUNDANT":
    case "ALREADY_ENRICHED":
    case "OUTSIDE_FRESHNESS_WINDOW":
    case "NO_ARTICLE_URL":
      return "SKIPPED";
    case "UNKNOWN":
    default:
      return "UNSUPPORTED_STRUCTURE";
  }
};

/**
 * Build a failure outcome (retryable or terminal) with a structured reason.
 * `retryable` selects RETRYABLE_FAILURE vs a terminal kind derived from the
 * rejection code via `rejectionCodeToTerminalKind`.
 */
export const buildFailureOutcome = (input: {
  articleId: number;
  articleUrl?: string | null;
  provenance: ArticleUpstreamProvenance;
  reason: EnrichmentRejectionReason;
  retryable?: boolean;
  error?: string | null;
  method?: Partial<ExtractionMethod>;
  timing?: EnrichmentTiming;
  httpStatus?: number | null;
}): ArticleEnrichmentOutcome => {
  const kind: EnrichmentOutcomeKind = input.retryable
    ? "RETRYABLE_FAILURE"
    : rejectionCodeToTerminalKind(input.reason.code);
  return createEnrichmentOutcome({
    kind,
    articleId: input.articleId,
    articleUrl: input.articleUrl ?? null,
    provenance: input.provenance,
    method: input.method ?? { method: "none" },
    timing: input.timing ?? baseTiming(),
    quality: { confidence: 0 },
    fields: {},
    rejection: {
      code: input.reason.code,
      detail: input.reason.detail ?? null,
      httpStatus: input.httpStatus ?? input.reason.httpStatus ?? null,
      retryAfterAt: input.reason.retryAfterAt ?? null,
    },
    error: input.error ?? null,
  });
};

/**
 * Map an `ArticleEnrichmentOutcome.kind` to the persisted
 * `Article.enrichmentStatus` value. Single source of truth for the
 * kind→status mapping so DB writes and the outcome contract stay in sync.
 */
export const outcomeKindToStatus = (
  kind: EnrichmentOutcomeKind,
): EnrichmentStatus => {
  switch (kind) {
    case "SUCCESS":
      return "ENRICHED";
    case "SKIPPED":
      return "ENRICHMENT_SKIPPED";
    case "HEADLESS_REQUIRED":
      return "ENRICHMENT_QUEUED_HEADLESS";
    case "RETRYABLE_FAILURE":
      return "ENRICHMENT_FAILED";
    case "PAYWALL_BLOCKED":
    case "CANONICAL_MISMATCH":
    case "LOW_CONTENT_QUALITY":
    case "UNSUPPORTED_STRUCTURE":
    case "HTTP_ACCESS_BLOCKED":
    case "INTERSTITIAL_OR_CHALLENGE":
      return "ENRICHMENT_FAILED";
    default:
      return "ENRICHMENT_FAILED";
  }
};
