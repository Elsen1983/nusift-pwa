/**
 * Agent 2 AI-assisted inspection contract.
 *
 * ## Architecture
 * Agent 2 has three layers:
 *   1. Static discovery (fetch + HTML parsing + sitemap + JSON-LD + scoring)
 *   2. Browser fallback (deterministic Playwright-style rendering)
 *   3. AI-assisted inspection (FUTURE — admin-only source repair /
 *      profile-generation layer, NOT normal cron ingest)
 *
 * This module defines the contract for layer 3 ONLY. It does NOT integrate
 * Browser Use, Stagehand, or any AI-browser runtime. It only prepares the
 * type + validation/normalization scaffold so a future admin-only tool can
 * propose deterministic extraction profiles for hard sources.
 *
 * ## Purpose
 * AI-assisted inspection is admin-only. Its purpose is to create
 * deterministic, reusable extraction profiles for sources where static +
 * browser fallback both fail. Future normal Agent 2 runs should consume
 * APPROVED profiles deterministically — the AI layer never runs inside the
 * daily cron ingest.
 *
 * ## Safety
 * - `normalizeAgent2AiInspectionProfile` accepts unknown JSON and returns a
 *   normalized profile or `null`. It never trusts malformed arrays, never
 *   accepts raw HTML / screenshots / DOM dumps, and bounds every array.
 * - No artifact is created by this module. The artifact kind
 *   `article_discovery_ai_inspection_profile` and status `PENDING_REVIEW`
 *   are documented below for future use only.
 *
 * ## Future artifact convention (NOT created yet)
 *   artifactType: "article_discovery_ai_inspection_profile"
 *   status: "PENDING_REVIEW"  (or an existing status if statuses are
 *           constrained by the PipelineArtifact model — see prisma schema)
 *   payload: Agent2AiInspectionProfile (normalized)
 *
 * This module deliberately does NOT create those artifacts. It only
 * provides the type + helper so a future admin-only endpoint can safely
 * persist a proposed profile when there is a vetted admin pattern.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type Agent2AiInspectionConfidence = "low" | "medium" | "high";

export type Agent2AiInspectionProfile = {
  schemaVersion: 1;
  targetUrl: string;
  sourceId: string;
  categoryId?: string | null;
  proposedAt: string;
  proposedBy: "admin" | "ai_inspection";
  confidence: Agent2AiInspectionConfidence;
  listingSelectors: string[];
  articleLinkSelectors: string[];
  titleSelectors: string[];
  dateSelectors: string[];
  descriptionSelectors?: string[];
  paginationHints?: string[];
  blockedSelectors?: string[];
  sampleArticleUrls: string[];
  notes?: string[];
};

// ─── Validation / Normalization ─────────────────────────────────────────────

/**
 * Maximum number of entries allowed per array field. Keeps profiles compact
 * and prevents a malformed / hostile proposal from bloating the artifact
 * payload. Selectors are cheap to store but we still bound them so an AI
 * proposal can't dump thousands of hints.
 */
const MAX_SELECTORS_PER_FIELD = 32;
const MAX_SAMPLE_ARTICLE_URLS = 12;
const MAX_NOTES = 8;
const MAX_SELECTOR_LENGTH = 256;
const MAX_URL_LENGTH = 2048;
const MAX_NOTE_LENGTH = 512;

const VALID_CONFIDENCE_VALUES = new Set<Agent2AiInspectionConfidence>([
  "low",
  "medium",
  "high",
]);

const VALID_PROPOSED_BY_VALUES = new Set(["admin", "ai_inspection"]);

/**
 * Returns true only for plain objects (not arrays, null, or primitives).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce an unknown value to a string, returning null for non-strings or
 * empty strings. Used for scalar fields like targetUrl / sourceId.
 */
function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Filter an unknown value into a clean string[], applying per-entry length
 * bounds and an overall array-size bound. Non-string entries are dropped,
 * empty strings are dropped, over-long strings are dropped, and the final
 * array is truncated to `maxItems`.
 *
 * This is the single safe way to accept any selector / URL / note array
 * from untrusted JSON. It never trusts malformed arrays.
 */
function readBoundedStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const results: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > maxItemLength) continue;
    results.push(trimmed);
    if (results.length >= maxItems) break;
  }
  return results;
}

/**
 * Normalize an unknown JSON value into a valid
 * `Agent2AiInspectionProfile`, or return `null` when the input is not a
 * plain object or is missing required scalar fields.
 *
 * Rules:
 * - Never trusts malformed arrays (filters non-string entries, bounds sizes)
 * - Bounds every array field
 * - Rejects raw HTML / screenshot / DOM dump fields if present (they are
 *   silently dropped — this contract never stores them)
 * - Returns null for unknown / non-object input
 * - Returns null when required fields (targetUrl, sourceId, proposedAt,
 *   proposedBy, confidence) are missing or invalid
 */
export function normalizeAgent2AiInspectionProfile(
  value: unknown,
): Agent2AiInspectionProfile | null {
  if (!isPlainObject(value)) return null;

  // ── Required scalar fields ───────────────────────────────────────────
  const targetUrl = readString(value.targetUrl);
  const sourceId = readString(value.sourceId);
  const proposedAt = readString(value.proposedAt);
  if (!targetUrl || !sourceId || !proposedAt) return null;

  const proposedBy = readString(value.proposedBy);
  if (!proposedBy || !VALID_PROPOSED_BY_VALUES.has(proposedBy)) return null;

  const confidenceRaw = readString(value.confidence);
  if (!confidenceRaw || !VALID_CONFIDENCE_VALUES.has(confidenceRaw as Agent2AiInspectionConfidence)) {
    return null;
  }

  // ── Required bounded string arrays ───────────────────────────────────
  const listingSelectors = readBoundedStringArray(
    value.listingSelectors,
    MAX_SELECTORS_PER_FIELD,
    MAX_SELECTOR_LENGTH,
  );
  const articleLinkSelectors = readBoundedStringArray(
    value.articleLinkSelectors,
    MAX_SELECTORS_PER_FIELD,
    MAX_SELECTOR_LENGTH,
  );
  const titleSelectors = readBoundedStringArray(
    value.titleSelectors,
    MAX_SELECTORS_PER_FIELD,
    MAX_SELECTOR_LENGTH,
  );
  const dateSelectors = readBoundedStringArray(
    value.dateSelectors,
    MAX_SELECTORS_PER_FIELD,
    MAX_SELECTOR_LENGTH,
  );
  const sampleArticleUrls = readBoundedStringArray(
    value.sampleArticleUrls,
    MAX_SAMPLE_ARTICLE_URLS,
    MAX_URL_LENGTH,
  );

  // A profile with no selectors at all is not useful — reject it.
  if (
    listingSelectors.length === 0 &&
    articleLinkSelectors.length === 0 &&
    titleSelectors.length === 0 &&
    dateSelectors.length === 0
  ) {
    return null;
  }

  // ── Optional bounded string arrays ───────────────────────────────────
  // Only included when present (and an array). A missing field stays
  // undefined to preserve the "absent vs empty" distinction.
  const descriptionSelectors = Array.isArray(value.descriptionSelectors)
    ? readBoundedStringArray(value.descriptionSelectors, MAX_SELECTORS_PER_FIELD, MAX_SELECTOR_LENGTH)
    : undefined;
  const paginationHints = Array.isArray(value.paginationHints)
    ? readBoundedStringArray(value.paginationHints, MAX_SELECTORS_PER_FIELD, MAX_SELECTOR_LENGTH)
    : undefined;
  const blockedSelectors = Array.isArray(value.blockedSelectors)
    ? readBoundedStringArray(value.blockedSelectors, MAX_SELECTORS_PER_FIELD, MAX_SELECTOR_LENGTH)
    : undefined;
  const notes = Array.isArray(value.notes)
    ? readBoundedStringArray(value.notes, MAX_NOTES, MAX_NOTE_LENGTH)
    : undefined;

  // ── categoryId (optional, string | null) ─────────────────────────────
  const categoryId =
    typeof value.categoryId === "string" && value.categoryId.length > 0
      ? value.categoryId
      : value.categoryId === null
        ? null
        : undefined;

  // ── schemaVersion (must be exactly 1) ────────────────────────────────
  if (value.schemaVersion !== 1) {
    // Reject unknown schema versions — a future v2 must opt in explicitly.
    return null;
  }

  // ── Reject raw HTML / screenshot / DOM dump fields ───────────────────
  // These are NEVER accepted by this contract. If present, they cause the
  // whole profile to be rejected so a caller cannot smuggle large blobs
  // through optional fields.
  const FORBIDDEN_BLOB_FIELDS = [
    "rawHtml",
    "html",
    "screenshot",
    "screenshotBase64",
    "domDump",
    "outerHtml",
    "pageHtml",
    "rawPageHtml",
  ];
  for (const field of FORBIDDEN_BLOB_FIELDS) {
    if (value[field] !== undefined && value[field] !== null && value[field] !== "") {
      return null;
    }
  }

  return {
    schemaVersion: 1,
    targetUrl,
    sourceId,
    categoryId,
    proposedAt,
    proposedBy: proposedBy as "admin" | "ai_inspection",
    confidence: confidenceRaw as Agent2AiInspectionConfidence,
    listingSelectors,
    articleLinkSelectors,
    titleSelectors,
    dateSelectors,
    descriptionSelectors,
    paginationHints,
    blockedSelectors,
    sampleArticleUrls,
    notes,
  };
}

// ─── Future artifact convention (documentation only) ────────────────────────

/**
 * Future artifact kind for AI-assisted inspection profiles.
 *
 * NOT created by this module. Documented here so a future admin-only
 * endpoint can adopt it without redefining the contract.
 *
 * When an admin (or future AI-inspection runtime) proposes a profile:
 *   artifactType: "article_discovery_ai_inspection_profile"
 *   status: "PENDING_REVIEW"
 *   payload: Agent2AiInspectionProfile
 *
 * Status flow (future):
 *   PENDING_REVIEW → APPROVED (admin reviews + approves)
 *   PENDING_REVIEW → REJECTED (admin rejects)
 *
 * Once APPROVED, future normal Agent 2 static discovery runs for the same
 * targetUrl should consume the profile deterministically (selector-based
 * extraction) WITHOUT invoking the AI layer again. The AI layer is only
 * used to GENERATE proposals, never to run inside daily cron ingest.
 */
export const AI_INSPECTION_PROFILE_ARTIFACT_TYPE =
  "article_discovery_ai_inspection_profile" as const;

export const AI_INSPECTION_PROFILE_PENDING_STATUS = "PENDING_REVIEW" as const;
