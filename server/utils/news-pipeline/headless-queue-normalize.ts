/**
 * Normalizes a raw PipelineArtifact row into a compact headless queue item
 * for the admin dashboard. Only includes the fields needed for queue
 * overview — no full candidate arrays or heavy payload blobs.
 *
 * All payload reads are defensive: malformed, missing, or wrong-type values
 * are normalized to null, [], or false rather than propagating cast errors.
 */

// ─── Type-safe payload readers ──────────────────────────────────────────────

/** Returns true only for plain objects (not arrays, null, or primitives). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a string or null. Rejects non-string values. */
export function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Returns a finite number or null. Rejects NaN, Infinity, and non-numbers. */
export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Returns a string array, filtering out any non-string items. Returns [] for non-arrays. */
export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Returns true only when value is exactly boolean true. */
export function readBoolean(value: unknown): boolean {
  return value === true;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type HeadlessQueueStaleSample = {
  url: string;
  normalizedPublishedAt: string | null;
  publishedAtSource: string | null;
  ageDays: number | null;
  staleReason: string | null;
};

export type NormalizedBrowserTopRejectionReason = {
  reason: string;
  count: number;
};

export type NormalizedBrowserLinkAuditEntry = {
  url: string;
  normalizedUrl: string | null;
  anchorText: string | null;
  score: number;
  rejected: boolean;
  reason: string | null;
  scoreReasons: string[];
  sameDomain: boolean;
  utilityPath: boolean;
  categoryScoped: boolean | null;
};

export type NormalizedBrowserQualityAssessment = {
  quality: string | null;
  confidence: string | null;
  shouldEscalateToHeadless: boolean;
  escalationReasons: string[];
  explanation: string | null;
};

export type NormalizedHeadlessQueueItem = {
  id: string;
  status: string;
  artifactType: string;
  sourceId: string | null;
  categoryId: string | null;
  targetUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  quality: string | null;
  confidence: string | null;
  escalationReasons: string[];
  headlessProcessingStartedAt: string | null;
  headlessRecoveryCount: number | null;
  lastHeadlessRecoveryAt: string | null;
  browserFallbackRan: boolean;
  candidateCount: number | null;
  staleSamples: HeadlessQueueStaleSample[];
  dateAnomalySamples: HeadlessQueueStaleSample[];
  // ── Compact browser fallback result metadata ───────────────────────────
  // All of these are normalized defensively. Missing/wrong-type values
  // fall back to null / false / [] / 0. Explicit zero counts are preserved.
  browserFallbackStartedAt: string | null;
  browserFallbackFinishedAt: string | null;
  browserRawLinks: number | null;
  browserEvaluated: number | null;
  browserAccepted: number | null;
  browserRejected: number | null;
  browserInserted: number | null;
  browserSkipped: number | null;
  browserFailed: number | null;
  browserTopRejectionReasons: NormalizedBrowserTopRejectionReason[];
  browserError: string | null;
  browserBlockedReason: string | null;
  browserRateLimited: boolean;
  browserRateLimitReason: string | null;
  browserRateLimitedAt: string | null;
  browserRetryAfterAt: string | null;
  browserRateLimitedCount: number | null;
  browserDetailEvaluationStoppedReason: string | null;
  // ── Browser cooldown metadata (Approach A: stays PENDING_HEADLESS) ────
  skippedDueToBrowserCooldown: boolean;
  browserCooldownUntil: string | null;
  lastBrowserCooldownSkipAt: string | null;
  browserQualityAssessment: NormalizedBrowserQualityAssessment | null;
  renderedUrl: string | null;
  // ── Browser link audit fields ─────────────────────────────────────────
  browserShortlistedLinks: number | null;
  browserTopRejectedLinks: NormalizedBrowserLinkAuditEntry[];
  browserShortlistedLinkSamples: NormalizedBrowserLinkAuditEntry[];
  browserTopLinkRejectionReasons: NormalizedBrowserTopRejectionReason[];
};

export type HeadlessQueueSummary = {
  total: number;
  byStatus: Record<string, number>;
};

// ─── Normalizer ─────────────────────────────────────────────────────────────

/**
 * Safely extract a nested qualityAssessment object from a payload.
 * Returns an empty object for any non-object value (arrays, strings, etc.).
 */
function readQualityAssessment(payload: Record<string, unknown>): Record<string, unknown> {
  const qa = payload.qualityAssessment;
  return isPlainObject(qa) ? qa : {};
}

const MAX_STALE_SAMPLES = 3;
const MAX_BROWSER_REJECTION_REASONS = 5;
const MAX_NORMALIZED_REJECTED_LINKS = 20;
const MAX_NORMALIZED_SHORTLISTED_SAMPLES = 25;

/**
 * Safely extract the nested browserQualityAssessment object from a payload.
 * Returns null for any non-object value (arrays, strings, null, etc.).
 * Distinct from readQualityAssessment because the browser QA is allowed
 * to be missing entirely (e.g. runtime-unavailable failures).
 */
function readBrowserQualityAssessment(
  value: unknown,
): NormalizedBrowserQualityAssessment | null {
  if (!isPlainObject(value)) return null;
  return {
    quality: readString(value.quality),
    confidence: readString(value.confidence),
    shouldEscalateToHeadless: readBoolean(value.shouldEscalateToHeadless),
    escalationReasons: readStringArray(value.escalationReasons),
    explanation: readString(value.explanation),
  };
}

/**
 * Extract up to 5 compact `{ reason, count }` entries from a raw array.
 * Filters malformed entries (non-objects, missing reason/count, wrong types).
 * Returns [] for any non-array input.
 */
function extractBrowserTopRejectionReasons(
  value: unknown,
): NormalizedBrowserTopRejectionReason[] {
  if (!Array.isArray(value)) return [];
  const results: NormalizedBrowserTopRejectionReason[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const reason = readString(entry.reason);
    const count = readNumber(entry.count);
    if (reason === null || count === null) continue;
    results.push({ reason, count });
    if (results.length >= MAX_BROWSER_REJECTION_REASONS) break;
  }
  return results;
}

/**
 * Safely normalize a BrowserLinkAuditEntry array from payload.
 * Drops malformed entries and caps at the provided limit.
 */
function extractBrowserLinkAuditEntries(
  value: unknown,
  maxEntries: number,
): NormalizedBrowserLinkAuditEntry[] {
  if (!Array.isArray(value)) return [];
  const results: NormalizedBrowserLinkAuditEntry[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const url = readString(entry.url);
    if (!url) continue;
    results.push({
      url,
      normalizedUrl: readString(entry.normalizedUrl),
      anchorText: readString(entry.anchorText),
      score: readNumber(entry.score) ?? 0,
      rejected: readBoolean(entry.rejected),
      reason: readString(entry.reason),
      scoreReasons: readStringArray(entry.scoreReasons),
      sameDomain: readBoolean(entry.sameDomain),
      utilityPath: readBoolean(entry.utilityPath),
      categoryScoped: entry.categoryScoped === null ? null : readBoolean(entry.categoryScoped),
    });
    if (results.length >= maxEntries) break;
  }
  return results;
}

function collectStaleSamplesFromRejected(
  rejectedCandidates: unknown,
  samples: HeadlessQueueStaleSample[],
): void {
  if (!Array.isArray(rejectedCandidates)) return;
  for (const entry of rejectedCandidates) {
    if (!isPlainObject(entry)) continue;
    if (entry.status !== "rejected_stale") continue;
    if (typeof entry.staleReason !== "string") continue;

    samples.push({
      url: readString(entry.url) ?? "",
      normalizedPublishedAt: readString(entry.normalizedPublishedAt),
      publishedAtSource: readString(entry.publishedAtSource),
      ageDays: readNumber(entry.ageDays),
      staleReason: entry.staleReason,
    });

    if (samples.length >= MAX_STALE_SAMPLES) break;
  }
}

/**
 * Extract up to 3 compact stale/date anomaly samples from static and browser
 * rejected outcomes in the payload.
 */
function extractStaleSamples(...rejectedOutcomeSources: unknown[]): HeadlessQueueStaleSample[] {
  const samples: HeadlessQueueStaleSample[] = [];
  for (const source of rejectedOutcomeSources) {
    collectStaleSamplesFromRejected(source, samples);
    if (samples.length >= MAX_STALE_SAMPLES) break;
  }
  return samples;
}

function extractDateAnomalySamples(browserRejectedOutcomes: unknown): HeadlessQueueStaleSample[] {
  const allBrowserSamples = extractStaleSamples(browserRejectedOutcomes);
  return allBrowserSamples.filter((sample) =>
    sample.staleReason === "future_published_at" ||
    sample.staleReason === "invalid_published_at" ||
    sample.staleReason === "missing_published_at",
  );
}

export function normalizeHeadlessQueueArtifact(artifact: {
  id: string;
  status: string;
  artifactType: string;
  sourceId: string | null;
  categoryId: string | null;
  createdAt: Date;
  updatedAt: Date;
  candidateCount: number;
  payload: unknown;
}): NormalizedHeadlessQueueItem {
  const payload = isPlainObject(artifact.payload) ? artifact.payload : {};
  const qa = readQualityAssessment(payload);

  // Browser quality assessment is stored under a dedicated key on browser
  // fallback artifacts. It may be null when the browser failed before any
  // candidate evaluation (e.g. runtime unavailable, navigation failed).
  const browserQa = readBrowserQualityAssessment(payload.browserQualityAssessment);

  return {
    id: artifact.id,
    status: artifact.status,
    artifactType: artifact.artifactType,
    sourceId: artifact.sourceId,
    categoryId: artifact.categoryId,
    targetUrl: readString(payload.targetUrl),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    quality: readString(qa.quality) ?? readString(payload.quality),
    confidence: readString(qa.confidence),
    escalationReasons:
      readStringArray(qa.escalationReasons).length > 0
        ? readStringArray(qa.escalationReasons)
        : readStringArray(payload.escalationReasons),
    headlessProcessingStartedAt: readString(payload.headlessProcessingStartedAt),
    headlessRecoveryCount: readNumber(payload.headlessRecoveryCount),
    lastHeadlessRecoveryAt: readString(payload.lastHeadlessRecoveryAt),
    browserFallbackRan: readBoolean(payload.browserFallbackRan),
    candidateCount: artifact.candidateCount,
    staleSamples: extractStaleSamples(payload.rejectedCandidates, payload.browserRejectedOutcomes),
    dateAnomalySamples: extractDateAnomalySamples(payload.browserRejectedOutcomes),
    // ── Compact browser fallback result metadata ───────────────────────
    browserFallbackStartedAt: readString(payload.browserFallbackStartedAt),
    browserFallbackFinishedAt: readString(payload.browserFallbackFinishedAt),
    // readNumber already preserves explicit zeros (0 is a finite number),
    // so a browser run that evaluated links and accepted 0 surfaces as 0,
    // not null. Missing/wrong-type values fall back to null for "—".
    browserRawLinks: readNumber(payload.browserRawLinks),
    browserEvaluated: readNumber(payload.browserEvaluated),
    browserAccepted: readNumber(payload.browserAccepted),
    browserRejected: readNumber(payload.browserRejected),
    browserInserted: readNumber(payload.browserInserted),
    browserSkipped: readNumber(payload.browserSkipped),
    browserFailed: readNumber(payload.browserFailed),
    browserTopRejectionReasons: extractBrowserTopRejectionReasons(payload.browserTopRejectionReasons),
    browserError: readString(payload.browserError),
    browserBlockedReason: readString(payload.browserBlockedReason),
    browserRateLimited: readBoolean(payload.browserRateLimited),
    browserRateLimitReason: readString(payload.browserRateLimitReason),
    browserRateLimitedAt: readString(payload.browserRateLimitedAt),
    browserRetryAfterAt: readString(payload.browserRetryAfterAt),
    browserRateLimitedCount: readNumber(payload.browserRateLimitedCount),
    browserDetailEvaluationStoppedReason: readString(payload.browserDetailEvaluationStoppedReason),
    skippedDueToBrowserCooldown: readBoolean(payload.skippedDueToBrowserCooldown),
    browserCooldownUntil: readString(payload.browserCooldownUntil),
    lastBrowserCooldownSkipAt: readString(payload.lastBrowserCooldownSkipAt),
    browserQualityAssessment: browserQa,
    renderedUrl: readString(payload.renderedUrl),
    // ── Browser link audit fields ─────────────────────────────────────
    browserShortlistedLinks: readNumber(payload.browserShortlistedLinks),
    browserTopRejectedLinks: extractBrowserLinkAuditEntries(
      payload.browserTopRejectedLinks,
      MAX_NORMALIZED_REJECTED_LINKS,
    ),
    browserShortlistedLinkSamples: extractBrowserLinkAuditEntries(
      payload.browserShortlistedLinkSamples,
      MAX_NORMALIZED_SHORTLISTED_SAMPLES,
    ),
    browserTopLinkRejectionReasons: extractBrowserTopRejectionReasons(
      payload.browserTopLinkRejectionReasons,
    ),
  };
}

// ─── Summary builder ────────────────────────────────────────────────────────

export function buildHeadlessQueueSummary(
  items: NormalizedHeadlessQueueItem[],
): HeadlessQueueSummary {
  const byStatus: Record<string, number> = {};
  for (const item of items) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
  }
  return { total: items.length, byStatus };
}
