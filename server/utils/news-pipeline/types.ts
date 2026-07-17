import type { Prisma } from "@prisma/client";

export type ProcessingStatus = "PENDING" | "SUCCESS" | "SKIPPED" | "FAILED";

/**
 * Type-safe nullish filter predicate. Replaces `.filter(Boolean) as any`
 * patterns where the array may contain `null | undefined` alongside valid
 * values. The type guard narrows `T | null | undefined` to `NonNullable<T>`.
 */
export const nonNullish = <T>(value: T | null | undefined): value is NonNullable<T> =>
  value != null;

/**
 * Extract the canonical DiscoveryOutcome sub-object from a persisted
 * discoveryEvidence JSON column. Returns `null` when the input is invalid
 * or the payload predates the outcome model.
 *
 * This is the single entry-point for reading outcome from persisted JSON.
 * All downstream consumers should use this instead of inline extraction.
 */
export const extractDiscoveryOutcome = (
  discoveryEvidence: unknown,
): Record<string, unknown> | null => {
  if (!discoveryEvidence || typeof discoveryEvidence !== "object" || Array.isArray(discoveryEvidence)) {
    return null;
  }
  const raw = discoveryEvidence as Record<string, unknown>;
  return raw.outcome && typeof raw.outcome === "object" && !Array.isArray(raw.outcome)
    ? (raw.outcome as Record<string, unknown>)
    : null;
};

// ─── Validation helpers ─────────────────────────────────────────────────────

const VALID_SCOPE_MATCHES: ReadonlySet<string> = new Set(["exact", "probable", "generic", "unrelated"]);
const VALID_SCOPE_CONFIDENCES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const VALID_RESOLVER_PATHS: ReadonlySet<string> = new Set(["fetch", "jsdom", "playwright", "none"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringOrNull = (value: unknown): value is string | null =>
  typeof value === "string" || value === null;

/**
 * Check whether a value is an array where every element is a string.
 * Returns `true` for empty arrays.
 */
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((e) => typeof e === "string");

/**
 * Required string-array field names on TaxonomyEvidence.
 * Every one of these must be a `string[]`.
 */
const TAXONOMY_STRING_ARRAY_FIELDS = [
  "sectionIds",
  "tagIds",
  "categorySlugs",
  "collectionIds",
  "routeNames",
  "canonicalSectionHandles",
  "feedParams",
  "matchedFeedUrls",
  "localeHints",
  "hreflangLocales",
  "editionPaths",
] as const;

/**
 * Optional string-array field names on TaxonomyEvidence.
 * When present, must be a `string[]`; when absent, left as-is.
 */
const TAXONOMY_OPTIONAL_STRING_ARRAY_FIELDS = [
  "countryHints",
  "countryCodes",
] as const;

/**
 * Validate and normalize a TaxonomyEvidence object.
 *
 * Field-by-field normalization strategy: each required string-array field
 * is validated deeply (every element must be a string). Malformed arrays
 * are replaced with `[]` rather than rejecting the entire object — a
 * single bad entry in one field should not discard valid data in others.
 *
 * Returns a normalized TaxonomyEvidence or `null` when the input is not
 * a plain object at all.
 */
const normalizeTaxonomyEvidence = (value: unknown): TaxonomyEvidence | null => {
  if (!isPlainObject(value)) return null;

  const result: Record<string, unknown> = {};

  // Required string arrays — missing or malformed → []
  for (const field of TAXONOMY_STRING_ARRAY_FIELDS) {
    const v = value[field];
    result[field] = isStringArray(v) ? v : [];
  }

  // Optional string arrays — present-but-invalid → [], absent → undefined
  for (const field of TAXONOMY_OPTIONAL_STRING_ARRAY_FIELDS) {
    const v = value[field];
    if (v === undefined) continue; // leave absent
    result[field] = isStringArray(v) ? v : [];
  }

  // directoryTraversal: preserve if structurally valid, drop otherwise
  if (value.directoryTraversal !== undefined) {
    const dt = value.directoryTraversal;
    if (
      isPlainObject(dt) &&
      typeof dt.traversedUrl === "string" &&
      typeof dt.matchedLabel === "string" &&
      typeof dt.candidateCount === "number"
    ) {
      result.directoryTraversal = {
        traversedUrl: dt.traversedUrl,
        matchedLabel: dt.matchedLabel,
        candidateCount: dt.candidateCount,
      };
    }
    // else: malformed → omit
  }

  // canonicalIdentity: preserve if string or null, drop otherwise
  if (value.canonicalIdentity !== undefined) {
    result.canonicalIdentity =
      typeof value.canonicalIdentity === "string" || value.canonicalIdentity === null
        ? value.canonicalIdentity
        : null;
  }

  return result as unknown as TaxonomyEvidence;
};

/**
 * Legacy structural check — returns `true` when the value is a valid
 * normalized TaxonomyEvidence. Delegates to `normalizeTaxonomyEvidence`
 * so the same deep validation rules apply.
 *
 * Used as a type guard in `validateDiscoveryEvidence`.
 */
const isValidTaxonomyEvidence = (value: unknown): value is TaxonomyEvidence =>
  normalizeTaxonomyEvidence(value) !== null;

/**
 * Validated and normalized discovery evidence payload.
 *
 * Fields that were absent from the source payload remain `undefined` so
 * downstream consumers can distinguish "missing" from "present with a
 * default-compatible value". Only *present but invalid* values are
 * normalized to safe defaults.
 *
 * Always-present fields (`feedUrl`, `topCandidates`, etc.) use null/[]
 * defaults since they are structural and never semantically "missing".
 */
export type ValidatedDiscoveryEvidence = {
  /** Whether a valid canonical outcome was found in the payload. */
  hasOutcome: boolean;
  /** Whether `outcome` was present but failed structural validation. */
  outcomeMalformed: boolean;
  /** The raw outcome object if present and structurally valid, null otherwise. */
  outcome: Record<string, unknown> | null;
  /** Resolved feed URL (string) or null. */
  feedUrl: string | null;
  /** Detection method. undefined if missing, "unknown" only if present-but-invalid. */
  detection: string | undefined;
  /** Scope match. undefined if missing, normalized enum value if present. */
  scopeMatch: ScopeMatch | undefined;
  /** Scope confidence. undefined if missing, normalized value if present. */
  scopeConfidence: string | undefined;
  /** Candidate score. undefined if missing, 0 only if present-but-invalid. */
  score: number | undefined;
  /** Whether the feed was verified. undefined if missing. */
  verified: boolean | undefined;
  /** Resolver path. undefined if missing, normalized value if present. */
  resolverPath: string | undefined;
  /** Structured taxonomy evidence or null if missing/invalid. */
  taxonomyEvidence: TaxonomyEvidence | null;
  /** Top feed candidates. Defaults to empty array. */
  topCandidates: unknown[];
  /** Rejected feed candidates. Defaults to empty array. */
  rejectedCandidates: unknown[];
  /** Last error message or null. */
  lastError: string | null;
  /** Canonical feed identity or null. */
  canonicalIdentity: string | null;
};

/**
 * Validate the required fields of a canonical DiscoveryOutcome sub-object.
 *
 * These are the fields that `createDiscoveryOutcome()` always produces.
 * If any required field is missing or has the wrong type, the outcome
 * is considered structurally corrupted and should be rejected.
 *
 * This does NOT validate optional/nested fields (those are normalized
 * individually by `validateDiscoveryEvidence`).
 */
const isValidOutcomeShape = (
  outcome: Record<string, unknown>,
): boolean => {
  // Required string fields produced by createDiscoveryOutcome
  if (typeof outcome.evaluatedAt !== "string") return false;
  if (typeof outcome.targetUrl !== "string") return false;
  if (typeof outcome.detection !== "string") return false;
  // feedUrl is string | null
  if (outcome.feedUrl !== null && typeof outcome.feedUrl !== "string") return false;
  // verified is boolean
  if (typeof outcome.verified !== "boolean") return false;
  // topCandidates and rejectedCandidates must be arrays
  if (!Array.isArray(outcome.topCandidates)) return false;
  if (!Array.isArray(outcome.rejectedCandidates)) return false;
  return true;
};
/**
 * Read a field from the preferred source (outcome > legacy), returning
 * `undefined` when the field is genuinely absent.
 *
 * Only reads from `outcome` when it has passed structural validation.
 */
const getField = (
  outcome: Record<string, unknown> | null,
  raw: Record<string, unknown>,
  field: string,
): unknown => {
  const value = outcome?.[field] ?? raw[field];
  return value !== undefined ? value : undefined;
};

/**
 * Normalize a present-but-invalid enum value to a safe default.
 * Returns `undefined` when the field is genuinely absent (not present in source).
 */
const normalizeEnum = (
  value: unknown,
  validSet: ReadonlySet<string>,
  fallback: string,
): string | undefined => {
  if (value === undefined) return undefined;
  return validSet.has(value as string) ? (value as string) : fallback;
};

export const validateDiscoveryEvidence = (
  raw: unknown,
): ValidatedDiscoveryEvidence | null => {
  if (!isPlainObject(raw)) return null;

  const extractedOutcome = extractDiscoveryOutcome(raw);
  // Validate the outcome sub-object's required fields.
  // If the outcome exists but fails structural validation, reject it
  // and fall back to legacy flat fields.
  const outcomeMalformed = extractedOutcome !== null && !isValidOutcomeShape(extractedOutcome);
  const outcome = outcomeMalformed ? null : extractedOutcome;
  const src = outcome ?? raw;

  const rawScopeMatch = getField(outcome, raw, "scopeMatch");
  const rawScopeConfidence = getField(outcome, raw, "scopeConfidence");
  const rawResolverPath = getField(outcome, raw, "resolverPath");
  const rawVerified = getField(outcome, raw, "verified");
  const rawDetection = getField(outcome, raw, "detection");
  const rawScore = getField(outcome, raw, "score");
  const rawTaxonomy = getField(outcome, raw, "taxonomyEvidence");

  return {
    hasOutcome: outcome !== null,
    outcomeMalformed,
    outcome,
    feedUrl: isStringOrNull(src.feedUrl) ? src.feedUrl : null,
    detection: rawDetection !== undefined
      ? (typeof rawDetection === "string" ? rawDetection : "unknown")
      : undefined,
    scopeMatch: normalizeEnum(rawScopeMatch, VALID_SCOPE_MATCHES, "generic") as ScopeMatch | undefined,
    scopeConfidence: normalizeEnum(rawScopeConfidence, VALID_SCOPE_CONFIDENCES, "low"),
    score: rawScore !== undefined ? (typeof rawScore === "number" ? rawScore : 0) : undefined,
    verified: rawVerified !== undefined ? (typeof rawVerified === "boolean" ? rawVerified : undefined) : undefined,
    resolverPath: normalizeEnum(rawResolverPath, VALID_RESOLVER_PATHS, "none"),
    taxonomyEvidence: normalizeTaxonomyEvidence(rawTaxonomy),
    topCandidates: Array.isArray(src.topCandidates) ? src.topCandidates : [],
    rejectedCandidates: Array.isArray(src.rejectedCandidates) ? src.rejectedCandidates : [],
    lastError: typeof src.lastError === "string" ? src.lastError : null,
    canonicalIdentity: isStringOrNull(src.canonicalIdentity) ? src.canonicalIdentity : null,
  };
};



export interface IngestCandidateProvenance {
  origin: "rss" | "atom" | "json" | "html_fallback" | "web_discovery";
  feedUrl?: string | null;
  feedFormat?: "rss" | "atom" | "json" | "unknown" | null;
  discoveredFromCategoryFeed?: boolean;
  sourcePageUrl?: string | null;
  fetchedAt: string;
}

export interface IngestRejectedItem {
  reason:
    | "empty_link"
    | "out_of_scope"
    | "stale_or_missing_published_at"
    | "already_seen_feed_item"
    | "html_fallback_non_article"
    | "html_fallback_stale";
  rawLink?: string | null;
  canonicalUrl?: string | null;
  title?: string | null;
  publishedAt?: string | null;
}

export interface IngestSkipSummary {
  emptyLink: number;
  outOfScope: number;
  staleOrMissingPublishedAt: number;
  alreadySeenFeedItem: number;
  htmlFallbackNonArticle: number;
  htmlFallbackStale: number;
}

export type ScopeMatch = "exact" | "probable" | "generic" | "unrelated";

/** Canonical empty TaxonomyEvidence for error/blocked discovery fallbacks. */
export const emptyTaxonomyEvidence = (): TaxonomyEvidence => ({
  sectionIds: [],
  tagIds: [],
  categorySlugs: [],
  collectionIds: [],
  routeNames: [],
  canonicalSectionHandles: [],
  feedParams: [],
  matchedFeedUrls: [],
  localeHints: [],
  hreflangLocales: [],
  editionPaths: [],
});

/**
 * Structured taxonomy/section evidence extracted from page HTML.
 * Used to generate scoped feed candidates and boost scoring for
 * candidates that align with the target category/section.
 */
export type TaxonomyEvidence = {
  sectionIds: string[];
  tagIds: string[];
  categorySlugs: string[];
  collectionIds: string[];
  routeNames: string[];
  canonicalSectionHandles: string[];
  feedParams: string[];
  matchedFeedUrls: string[];
  /** Present only when the feed was found via directory-traversal fallback. */
  directoryTraversal?: {
    traversedUrl: string;
    matchedLabel: string;
    candidateCount: number;
  };
  /** Locale/edition hints extracted from page metadata (og:locale, html lang, JSON-LD inLanguage). */
  localeHints: string[];
  /** hreflang locale codes extracted from <link rel="alternate" hreflang="..."> tags. */
  hreflangLocales: string[];
  /** Edition/locale-scoped URL paths extracted from hreflang links and edition navigation. */
  editionPaths: string[];
  /** Country names detected from edition/locale labels or hreflang-derived metadata. */
  countryHints?: string[];
  /** ISO 3166-1 alpha-2 country codes detected from edition/locale signals. */
  countryCodes?: string[];
  /** Canonical feed identity derived from canonicalFeedKey(). Persists the normalised feed URL key so downstream tooling can recognise when two different-looking feed URLs are the same feed. */
  canonicalIdentity?: string | null;
};

export interface HardCaseDiscoveryCandidate {
  targetType: "source" | "category";
  sourceId: string;
  categoryId?: string | null;
  targetUrl: string;
  existingFeedUrl?: string | null;
  queueReason:
    | "no_feed_discovered"
    | "candidate_verification_failed"
    | "blocked_or_fetch_failed";
  discovery: {
    feedUrl: string | null;
    discoveredVia: string | null;
    detection: string;
    score: number;
    scopeConfidence: string;
    scopeMatch?: ScopeMatch;
    taxonomyEvidence?: TaxonomyEvidence;
    canonicalIdentity?: string | null;
    topCandidates: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      scopeMatch?: ScopeMatch;
      taxonomyEvidence?: TaxonomyEvidence;
      canonicalIdentity?: string | null;
    }>;
    rejectedCandidates: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      reason: string;
      scopeMatch?: ScopeMatch;
      taxonomyEvidence?: TaxonomyEvidence;
      canonicalIdentity?: string | null;
    }>;
    lastError?: string;
  };
}

/** Candidate in a discovery result summary (canonical shared contract). */
export type DiscoverySummaryCandidate = {
  feedUrl: string;
  detection: string;
  score: number;
  contentType?: string | null;
  scopeMatch: ScopeMatch;
  /** Canonical feed identity for this candidate, derived from canonicalFeedKey(). */
  canonicalIdentity?: string | null;
};

/** Rejected candidate from discovery verification. */
export type RejectedDiscoveryCandidate = DiscoverySummaryCandidate & {
  reason: string;
};

/**
 * Canonical discovery result contract returned by feed discovery functions.
 * Shared by feed-discovery.ts, hard-case-consumer.ts, and ingest.ts.
 */
export type FeedDiscoveryResult = {
  feedUrl: string | null;
  discoveredVia: string | null;
  detection: string;
  contentType?: string | null;
  score: number;
  scopeConfidence: "high" | "medium" | "low";
  scopeMatch: ScopeMatch;
  taxonomyEvidence: TaxonomyEvidence;
  topCandidates: DiscoverySummaryCandidate[];
  rejectedCandidates: RejectedDiscoveryCandidate[];
  lastError?: string;
  /** Canonical feed identity for the resolved feedUrl, derived from canonicalFeedKey(). Present when a feed was discovered. */
  canonicalIdentity?: string | null;
};

/**
 * Tracks which resolver path produced the final result and what the browser
 * resolver observed. Used for auditability of the resolution process.
 *
 * - fetch-only success (browser was never needed)
 * - jsdom fallback success (static HTML DOM inspection found the feed)
 * - playwright fallback success (JS-rendered DOM found the feed)
 * - final failure after all attempts
 *
 * Note on production limitations:
 * - jsdom parses static HTML only — it does NOT execute JavaScript.
 *   Sites that inject feed links via client-side JS (SPAs) will not be
 *   discovered by the jsdom path.
 * - Playwright is the only true JS-rendering path, but requires browser
 *   binaries not available in serverless environments (e.g. Vercel).
 * - Therefore `resolverPath: "jsdom"` means "static DOM inspection",
 *   NOT "browser-rendered DOM".
 */
export type ResolutionMeta = {
  /** Which resolver path produced the final feedUrl (or "none" if all failed). */
  resolverPath: "fetch" | "jsdom" | "playwright" | "none";
  /** Whether browser-based resolution was attempted at all. */
  browserAttempted: boolean;
  /** Which browser method was used (or "none" if browser was skipped/failed). */
  browserMethod: "jsdom" | "playwright" | "none";
  /** Number of unique candidates the browser resolver discovered. */
  browserCandidateCount: number;
  /**
   * All browser candidates from the resolver (before deduplication and verification).
   * This is the full pre-dedup list for audit/debug — the actual verified subset
   * may be smaller after deduplicating against fetch-based candidates.
   */
  browserCandidates: Array<{ feedUrl: string; source: string }>;
  /** Error from the browser resolver, if any. */
  browserError: string | null;
};

/**
 * Canonical structured outcome model for a feed discovery resolution.
 *
 * Superset of FeedDiscoveryResult that also captures:
 * - Temporal context (evaluatedAt)
 * - Target context (targetUrl)
 * - Resolution metadata (how the feed was resolved)
 * - Verification status (whether the resolution succeeded)
 *
 * This is the single source of truth for "what happened" during a discovery
 * attempt. Downstream consumers and audit tools should read this model
 * instead of reconstructing outcomes from scattered fields.
 *
 * Compatible with Prisma JSON columns (discoveryEvidence, pipelineArtifact payload).
 */
export type DiscoveryOutcome = FeedDiscoveryResult & {
  /** ISO-8601 timestamp when this discovery outcome was evaluated. */
  evaluatedAt: string;
  /** The URL that was evaluated for feed discovery. */
  targetUrl: string;
  /** Whether a verified feed was successfully resolved. */
  verified: boolean;
  /** Which resolver path produced the final result. */
  resolverPath: "fetch" | "jsdom" | "playwright" | "none";
  /** Whether browser-based resolution was attempted. */
  browserAttempted: boolean;
  /** Which browser method was used (or "none" if skipped/failed). */
  browserMethod: "jsdom" | "playwright" | "none";
  /** Number of unique candidates the browser resolver discovered. */
  browserCandidateCount: number;
  /** All browser candidates from the resolver (pre-dedup, for audit). */
  browserCandidates: Array<{ feedUrl: string; source: string }>;
  /** Error from the browser resolver, if any. */
  browserError: string | null;
};

/**
 * Create a canonical DiscoveryOutcome from a FeedDiscoveryResult and optional
 * resolution metadata. This is the single factory for producing structured
 * discovery outcomes suitable for persistence and auditing.
 *
 * @param targetUrl - The URL that was evaluated for feed discovery.
 * @param discovery - The raw discovery result from the discovery engine.
 * @param meta - Optional resolution metadata (defaults to fetch-only).
 */
export const createDiscoveryOutcome = (
  targetUrl: string,
  discovery: FeedDiscoveryResult,
  meta: ResolutionMeta = {
    resolverPath: "fetch",
    browserAttempted: false,
    browserMethod: "none",
    browserCandidateCount: 0,
    browserCandidates: [],
    browserError: null,
  },
): DiscoveryOutcome => ({
  ...discovery,
  discoveredVia: discovery.discoveredVia || null,
  contentType: discovery.contentType || null,
  lastError: discovery.lastError || undefined,
  canonicalIdentity: discovery.canonicalIdentity ?? null,
  evaluatedAt: new Date().toISOString(),
  targetUrl,
  verified: Boolean(discovery.feedUrl),
  resolverPath: meta.resolverPath,
  browserAttempted: meta.browserAttempted,
  browserMethod: meta.browserMethod,
  browserCandidateCount: meta.browserCandidateCount,
  browserCandidates: meta.browserCandidates,
  browserError: meta.browserError,
});

/**
 * Serialize a fully-constructed DiscoveryOutcome into the canonical flat
 * payload shape for Prisma JSON columns. This is the single source of truth
 * for discovery evidence serialization — all callers should delegate to this
 * instead of manually mapping fields.
 *
 * Produces legacy flat fields for backward compatibility AND includes the
 * canonical `outcome` field for structured downstream consumption.
 */
/**
 * Serialize a fully-constructed DiscoveryOutcome into the canonical flat
 * payload shape for Prisma JSON columns. Returns `Prisma.InputJsonValue`
 * directly so callers never need unsafe casts.
 *
 * @param legacyOverrides - Optional overrides for legacy flat fields.
 *   Used by ingest.ts to preserve `null` for taxonomyEvidence when the
 *   original input had none (backward compatibility).
 */
export const serializeDiscoveryPayload = (
  outcome: DiscoveryOutcome,
  legacyOverrides?: Record<string, unknown>,
): Prisma.InputJsonValue => ({
  // Legacy flat fields (backward compatible)
  evaluatedAt: outcome.evaluatedAt,
  targetUrl: outcome.targetUrl,
  feedUrl: outcome.feedUrl,
  discoveredVia: outcome.discoveredVia,
  detection: outcome.detection,
  scopeConfidence: outcome.scopeConfidence,
  scopeMatch: outcome.scopeMatch,
  taxonomyEvidence: outcome.taxonomyEvidence,
  canonicalIdentity: outcome.canonicalIdentity ?? null,
  score: outcome.score,
  topCandidates: outcome.topCandidates,
  rejectedCandidates: outcome.rejectedCandidates,
  lastError: outcome.lastError ?? null,
  // Canonical structured outcome
  outcome,
  // Apply any legacy field overrides for backward compatibility
  ...legacyOverrides,
} as Prisma.InputJsonValue);

/**
 * Serialize a DiscoveryOutcome that includes browser/resolution metadata
 * in the flat legacy fields. Used by callers that have ResolutionMeta
 * (e.g. hard-case-consumer).
 */
export const serializeDiscoveryPayloadWithMeta = (
  outcome: DiscoveryOutcome,
  meta: ResolutionMeta,
  legacyOverrides?: Record<string, unknown>,
): Prisma.InputJsonValue => ({
  ...(serializeDiscoveryPayload(outcome) as Record<string, unknown>),
  resolverPath: meta.resolverPath,
  browserAttempted: meta.browserAttempted,
  browserMethod: meta.browserMethod,
  browserCandidateCount: meta.browserCandidateCount,
  browserCandidates: meta.browserCandidates,
  browserError: meta.browserError,
  ...legacyOverrides,
} as Prisma.InputJsonValue);

/**
 * Format discovery result for log output.
 * When an outcome is provided, includes verified/resolverPath metadata
 * from the canonical outcome model.
 */
export const formatDiscoveryLog = (
  discovery: {
    detection: string;
    scopeConfidence?: string;
    score?: number;
    topCandidates?: Array<{ feedUrl: string; detection: string; score: number }>;
    lastError?: string;
  },
  outcome?: DiscoveryOutcome | null,
): string => {
  const candidates =
    discovery.topCandidates?.length
      ? discovery.topCandidates
          .slice(0, 3)
          .map((c) => `${c.detection}:${c.score}:${c.feedUrl}`)
          .join(" | ")
      : "none";

  const outcomeSuffix = outcome
    ? `, verified=${outcome.verified}, resolverPath=${outcome.resolverPath}`
    : "";

  return `method=${discovery.detection}, confidence=${discovery.scopeConfidence || "n/a"}, score=${discovery.score ?? 0}, candidates=${candidates}${outcomeSuffix}${discovery.lastError ? `, lastError=${discovery.lastError}` : ""}`;
};

/**
 * Build a canonical DiscoveryOutcome for error/blocked/failed discovery attempts.
 * Replaces the repeated pattern of constructing empty-field error outcomes
 * across discovery.ts, hard-case-consumer.ts, etc.
 */
export const buildErrorDiscoveryOutcome = (
  targetUrl: string,
  detection: string,
  lastError: string,
): DiscoveryOutcome => {
  const discovery: FeedDiscoveryResult = {
    feedUrl: null,
    discoveredVia: null,
    detection,
    contentType: null,
    score: 0,
    scopeConfidence: "low",
    scopeMatch: "unrelated",
    taxonomyEvidence: emptyTaxonomyEvidence(),
    topCandidates: [],
    rejectedCandidates: [],
    lastError,
  };
  return createDiscoveryOutcome(targetUrl, discovery);
};

export interface IngestCandidate {
  sourceId: string;
  categoryId?: string | null;
  sourceUrl: string;
  canonicalUrl: string;
  rssGuid?: string | null;
  rawTitle?: string | null;
  title: string;
  publishedAt?: Date | null;
  rawBodyText?: string | null;
  bodyText?: string | null;
  contentHash: string;
  isPaywall: boolean;
  rawTags: string[];
  rawSignals: string[];
  reasoning: string;
  provenance: IngestCandidateProvenance;
  normalizationFlags?: string[];
}

export interface IngestResult {
  sourceId: string;
  categoryId?: string | null;
  candidates: IngestCandidate[];
  failed: number;
  feedUrl?: string | null;
  feedFormat?: "rss" | "atom" | "json" | "html_fallback" | "unknown" | null;
  skipSummary: IngestSkipSummary;
  rejectedItems: IngestRejectedItem[];
  hardCaseQueueCandidates?: HardCaseDiscoveryCandidate[];
}

export interface PipelineTarget {
  sourceId: string;
  categoryId?: string | null;
}

export interface PipelineResult {
  sourcesScanned: number;
  candidatesFound: number;
  inserted: number;
  skipped: number;
  failed: number;
  artifactCount?: number;
}
