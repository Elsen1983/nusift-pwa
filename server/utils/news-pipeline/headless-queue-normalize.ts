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

/**
 * Extract up to 3 compact stale samples from rejectedCandidates in the payload.
 */
function extractStaleSamples(rejectedCandidates: unknown): HeadlessQueueStaleSample[] {
  if (!Array.isArray(rejectedCandidates)) return [];

  const samples: HeadlessQueueStaleSample[] = [];
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

  return samples;
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
    staleSamples: extractStaleSamples(payload.rejectedCandidates),
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
