import type { Prisma } from "@prisma/client";

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
 */
export type EnrichmentOutcomeKind =
  | "SUCCESS"
  | "SKIPPED"
  | "RETRYABLE_FAILURE"
  | "HEADLESS_REQUIRED"
  | "PAYWALL_BLOCKED"
  | "CANONICAL_MISMATCH"
  | "LOW_CONTENT_QUALITY"
  | "UNSUPPORTED_STRUCTURE";

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
    | "ALREADY_ENRICHED"
    | "OUTSIDE_FRESHNESS_WINDOW"
    | "NO_ARTICLE_URL"
    | "UNKNOWN";
  /** Optional human-readable detail for audit logs. */
  detail?: string | null;
  /** HTTP status code when the rejection was HTTP-driven. */
  httpStatus?: number | null;
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
export interface ArticleUpstreamProvenance {
  sourceId: string;
  /** Category id when the article was ingested from a category-scoped feed. */
  categoryId?: string | null;
  /** Feed origin recorded by Agent 1 ingest. */
  feedOrigin: "rss" | "atom" | "json" | "html_fallback" | "web_discovery";
  /** Feed URL the article was ingested from, if known. */
  feedUrl?: string | null;
  /** Whether the article arrived via a scoped category feed. */
  discoveredFromCategoryFeed?: boolean;
  /**
   * Whether the article universe was expanded by an Agent 1 hard-case
   * discovery + targeted rerun. Preserves the §4.1 traceability requirement.
   */
  arrivedViaHardCaseRerun?: boolean;
  /** ISO-8601 timestamp of the original Agent 1 ingest. */
  ingestedAt?: string | null;
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
  method: "http-meta" | "http-dom" | "none";
  /** Optional detail: selectors used, fallback chain, etc. */
  detail?: string | null;
  /** Final canonical URL resolved for the article, if any. */
  resolvedCanonicalUrl?: string | null;
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
export interface ArticleEnrichmentOutcome {
  /** Schema version for forward-compatible deserialization. */
  schemaVersion: 1;
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
  /** Structured rejection / skip reason, present for non-SUCCESS kinds. */
  rejection: EnrichmentRejectionReason | null;
  /** Free-form error message for unexpected exceptions (audit only). */
  error: string | null;
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
  kind: input.kind,
  articleId: input.articleId,
  articleUrl: isStringOrNull(input.articleUrl) ? input.articleUrl : null,
  provenance: {
    sourceId: input.provenance.sourceId,
    categoryId: input.provenance.categoryId ?? null,
    feedOrigin: input.provenance.feedOrigin,
    feedUrl: input.provenance.feedUrl ?? null,
    discoveredFromCategoryFeed: input.provenance.discoveredFromCategoryFeed ?? false,
    arrivedViaHardCaseRerun: input.provenance.arrivedViaHardCaseRerun ?? false,
    ingestedAt: input.provenance.ingestedAt ?? null,
  },
  method: {
    method: input.method?.method ?? "none",
    detail: input.method?.detail ?? null,
    resolvedCanonicalUrl: input.method?.resolvedCanonicalUrl ?? null,
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
export const serializeEnrichmentPayload = (
  outcome: ArticleEnrichmentOutcome,
): Prisma.InputJsonValue =>
  ({
    schemaVersion: outcome.schemaVersion,
    kind: outcome.kind,
    articleId: outcome.articleId,
    articleUrl: outcome.articleUrl,
    provenance: outcome.provenance,
    method: outcome.method,
    timing: outcome.timing,
    quality: outcome.quality,
    fields: outcome.fields,
    rejection: outcome.rejection,
    error: outcome.error,
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
    kind: outcome.kind,
    method: outcome.method.method,
    confidence: outcome.quality.confidence,
    rejectionCode: outcome.rejection?.code ?? null,
    provenance: {
      sourceId: outcome.provenance.sourceId,
      categoryId: outcome.provenance.categoryId,
      feedOrigin: outcome.provenance.feedOrigin,
    },
  }) as Prisma.InputJsonValue;

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
    httpStatus:
      typeof value.httpStatus === "number" ? value.httpStatus : null,
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
  ]);
  if (typeof value.sourceId !== "string") return null;
  return {
    sourceId: value.sourceId,
    categoryId: typeof value.categoryId === "string" ? value.categoryId : null,
    feedOrigin: validOrigins.has(feedOrigin as string)
      ? (feedOrigin as ArticleUpstreamProvenance["feedOrigin"])
      : "rss",
    feedUrl: isStringOrNull(value.feedUrl) ? value.feedUrl : null,
    discoveredFromCategoryFeed:
      typeof value.discoveredFromCategoryFeed === "boolean"
        ? value.discoveredFromCategoryFeed
        : false,
    arrivedViaHardCaseRerun:
      typeof value.arrivedViaHardCaseRerun === "boolean"
        ? value.arrivedViaHardCaseRerun
        : false,
    ingestedAt: typeof value.ingestedAt === "string" ? value.ingestedAt : null,
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
    // HTTP access failures / timeouts as terminal → page not extractable
    case "HTTP_FORBIDDEN":
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
      return "ENRICHMENT_FAILED";
    default:
      return "ENRICHMENT_FAILED";
  }
};
