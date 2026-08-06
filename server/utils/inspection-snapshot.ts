import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { requireJwtSecret } from "./auth";
import type { InspectionActiveTargetResolution, InspectionTargetType } from "./inspection-active-targets";

export const INSPECTION_SNAPSHOT_VERSION = 1;
export const INSPECTION_SNAPSHOT_TTL_MS = 5 * 60 * 1000; // short expiry

/**
 * Maximum serialized snapshot token length (chars). Worst-case transport
 * measurement: 500 source UUIDs + 500 category UUIDs (the resolver's maximum
 * supported active-target universe) serialize to ~52.6 KB, so the cap is 64 KB
 * to leave headroom. Tokens are transported ONLY in a bounded POST body (see
 * server/services/admin-inspection.ts); they never appear in GET URLs, logs,
 * diagnostics, error messages, or browser history.
 */
export const INSPECTION_SNAPSHOT_MAX_TOKEN_CHARS = 64_000;
const SNAPSHOT_ISSUER = "nusift-admin-inspection";
const SNAPSHOT_AUDIENCE = "nusift-admin-inspection";

/**
 * Cross-endpoint active-target snapshot contract (Prompt 13G).
 *
 * The source inspection endpoint returns a signed token describing the exact
 * bounded active-target universe it resolved; the all-active article endpoint
 * accepts that token, validates it, and uses the exact active source/category
 * IDs instead of independently resolving a different universe. Explicit target
 * inspection never requires a snapshot.
 *
 * The token is a JWT signed with the existing server secret (JWT_SECRET). It
 * carries a version, target type, the canonical active-target filter
 * fingerprint, stable source/category scan boundaries, the bounded active
 * IDs, truncation metadata, generatedAt, a short expiry, and an explicit
 * content hash so any payload modification fails validation even if the JWT
 * signature were ever accepted through a bug.
 *
 * Transport (production-safe, Prompt 13H):
 * - the token is NEVER carried in a GET query parameter. All-active article
 *   inspection sends it in the JSON body of a bounded POST request (64 KB
 *   body cap, 64,000-char token cap) so proxies, browsers, Vercel routing and
 *   server request-line limits can never reject it before application
 *   validation. Oversized input is rejected with HTTP 413.
 * - maximum supported universe: 500 source IDs + 500 category IDs (1,000
 *   total active IDs at the resolver caps). Worst-case UUID-like IDs at that
 *   count serialize to ~52.6 KB, inside the 64 KB caps; the creation guard
 *   below rejects anything larger so a token can never be minted that the
 *   transport could not carry.
 * - the token is never included in logs, diagnostics, error messages,
 *   browser history, referrer URLs, or analytics.
 *
 * Security properties:
 * - unsigned client-supplied IDs are never trusted: every token is verified
 *   against the server secret, issuer, audience, version, fingerprint, expiry
 *   and content hash;
 * - malformed, expired, modified, wrong-target-type and wrong-filter tokens
 *   are rejected with HTTP 400 by the caller;
 * - the token size is bounded: active IDs are capped by the resolver caps and
 *   duplicated IDs are removed;
 * - secrets are never placed in the token payload.
 */

export type InspectionSnapshotSummary = {
  available: boolean;
  version: number;
  targetType: InspectionTargetType;
  targetFingerprint: string;
  sourceCount: number;
  categoryCount: number;
  sourceScanned: number;
  categoryScanned: number;
  sourceTruncated: boolean;
  categoryTruncated: boolean;
  artifactEvidenceTruncated: boolean;
  truncated: boolean;
  generatedAt: string;
  expiresAt: string;
};

export type InspectionSnapshotClaims = {
  version: number;
  targetType: InspectionTargetType;
  targetFingerprint: string;
  sourceIds: string[];
  categoryIds: string[];
  sourceScanned: number;
  categoryScanned: number;
  sourceTruncated: boolean;
  categoryTruncated: boolean;
  artifactEvidenceTruncated: boolean;
  generatedAt: string;
  expiresAt: string;
  contentHash: string;
};

const TARGET_TYPES = new Set<InspectionTargetType>(["SOURCE", "CATEGORY", "ALL"]);

/**
 * Canonical active-target filter fingerprint. Only filters that genuinely
 * alter target membership contribute. Article display filters (articleState,
 * pipelineStage, title search, article date filters) and source display
 * filters (search, sourceStatus, productivityState, date range) never alter
 * this fingerprint.
 */
export const buildTargetFingerprint = (targetType: InspectionTargetType): string =>
  JSON.stringify({ version: INSPECTION_SNAPSHOT_VERSION, targetType });

const canonicalPayload = (claims: InspectionSnapshotClaims) => JSON.stringify({
  version: claims.version,
  targetType: claims.targetType,
  targetFingerprint: claims.targetFingerprint,
  sourceIds: [...claims.sourceIds].sort(),
  categoryIds: [...claims.categoryIds].sort(),
  sourceScanned: claims.sourceScanned,
  categoryScanned: claims.categoryScanned,
  sourceTruncated: claims.sourceTruncated,
  categoryTruncated: claims.categoryTruncated,
  artifactEvidenceTruncated: claims.artifactEvidenceTruncated,
  generatedAt: claims.generatedAt,
  expiresAt: claims.expiresAt,
});

const contentHashOf = (claims: InspectionSnapshotClaims): string =>
  createHash("sha256").update(canonicalPayload(claims)).digest("hex");

const boundIds = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || id.length > 120 || !/^[A-Za-z0-9_-]{1,120}$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= 1_000) break;
  }
  return result;
};

export const inspectionSnapshotMeta = (resolution: InspectionActiveTargetResolution): InspectionSnapshotSummary => ({
  available: true,
  version: INSPECTION_SNAPSHOT_VERSION,
  targetType: resolution.targetType,
  targetFingerprint: resolution.filterFingerprint,
  sourceCount: resolution.sourceIds.length,
  categoryCount: resolution.categoryIds.length,
  sourceScanned: resolution.sourceScanned,
  categoryScanned: resolution.categoryScanned,
  sourceTruncated: resolution.sourceTruncated,
  categoryTruncated: resolution.categoryTruncated,
  artifactEvidenceTruncated: resolution.artifactEvidenceTruncated,
  truncated: resolution.truncated,
  generatedAt: "",
  expiresAt: "",
});

/**
 * Create a signed snapshot token from a resolver result. The fingerprint
 * stored in the token must be the canonical active-target filter fingerprint.
 * `now` is injectable for deterministic expiry tests.
 */
export function createInspectionSnapshotToken(resolution: InspectionActiveTargetResolution, now: Date = new Date()): string {
  const nowMs = now.getTime();
  const claims: InspectionSnapshotClaims = {
    version: INSPECTION_SNAPSHOT_VERSION,
    targetType: resolution.targetType,
    targetFingerprint: resolution.filterFingerprint,
    sourceIds: boundIds(resolution.sourceIds),
    categoryIds: boundIds(resolution.categoryIds),
    sourceScanned: resolution.sourceScanned,
    categoryScanned: resolution.categoryScanned,
    sourceTruncated: resolution.sourceTruncated,
    categoryTruncated: resolution.categoryTruncated,
    artifactEvidenceTruncated: resolution.artifactEvidenceTruncated,
    generatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + INSPECTION_SNAPSHOT_TTL_MS).toISOString(),
    contentHash: "",
  };
  claims.contentHash = contentHashOf(claims);
  const token = jwt.sign(claims, requireJwtSecret(), {
    expiresIn: `${INSPECTION_SNAPSHOT_TTL_MS / 1000}s`,
    issuer: SNAPSHOT_ISSUER,
    audience: SNAPSHOT_AUDIENCE,
  });
  if (token.length > INSPECTION_SNAPSHOT_MAX_TOKEN_CHARS) {
    // Never mint a token the bounded POST transport could not carry.
    throw new InspectionSnapshotValidationError(
      "Inspection snapshot exceeds the transport size limit.",
    );
  }
  return token;
}

export class InspectionSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionSnapshotValidationError";
  }
}

const asBoolean = (value: unknown): boolean => value === true;
const asCount = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const asDate = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

/**
 * Parse and validate a snapshot token against the expected canonical
 * active-target filter fingerprint. Throws InspectionSnapshotValidationError
 * for malformed, expired, modified, wrong-target-type and wrong-filter
 * tokens; callers map that to HTTP 400.
 */
export function parseInspectionSnapshotToken(
  token: unknown,
  expectedTargetType: InspectionTargetType,
  expectedTargetFingerprint: string,
): InspectionSnapshotClaims {
  if (typeof token !== "string" || token.length === 0 || token.length > INSPECTION_SNAPSHOT_MAX_TOKEN_CHARS) {
    throw new InspectionSnapshotValidationError("Invalid inspection snapshot.");
  }
  let claims: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, requireJwtSecret(), {
      issuer: SNAPSHOT_ISSUER,
      audience: SNAPSHOT_AUDIENCE,
    });
    if (!decoded || typeof decoded !== "object") throw new Error("invalid payload");
    claims = decoded as jwt.JwtPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new InspectionSnapshotValidationError("Inspection snapshot has expired.");
    }
    throw new InspectionSnapshotValidationError("Invalid inspection snapshot.");
  }
  if (claims.version !== INSPECTION_SNAPSHOT_VERSION) {
    throw new InspectionSnapshotValidationError("Unsupported inspection snapshot version.");
  }
  if (!TARGET_TYPES.has(claims.targetType as InspectionTargetType)) {
    throw new InspectionSnapshotValidationError("Invalid inspection snapshot target type.");
  }
  const targetType = claims.targetType as InspectionTargetType;
  if (targetType !== expectedTargetType) {
    throw new InspectionSnapshotValidationError("Inspection snapshot target type does not match the requested filters.");
  }
  if (typeof claims.targetFingerprint !== "string" || claims.targetFingerprint !== expectedTargetFingerprint) {
    throw new InspectionSnapshotValidationError("Inspection snapshot does not match the current filters.");
  }
  const sourceScanned = asCount(claims.sourceScanned);
  const categoryScanned = asCount(claims.categoryScanned);
  const generatedAt = asDate(claims.generatedAt);
  const expiresAt = asDate(claims.expiresAt);
  if (sourceScanned === null || categoryScanned === null || !generatedAt || !expiresAt) {
    throw new InspectionSnapshotValidationError("Invalid inspection snapshot payload.");
  }
  if (Date.parse(expiresAt) <= Date.now()) {
    throw new InspectionSnapshotValidationError("Inspection snapshot has expired.");
  }
  const sourceIds = boundIds(Array.isArray(claims.sourceIds) ? claims.sourceIds : []);
  const categoryIds = boundIds(Array.isArray(claims.categoryIds) ? claims.categoryIds : []);
  const candidate: InspectionSnapshotClaims = {
    version: claims.version,
    targetType,
    targetFingerprint: claims.targetFingerprint,
    sourceIds,
    categoryIds,
    sourceScanned,
    categoryScanned,
    sourceTruncated: asBoolean(claims.sourceTruncated),
    categoryTruncated: asBoolean(claims.categoryTruncated),
    artifactEvidenceTruncated: asBoolean(claims.artifactEvidenceTruncated),
    generatedAt,
    expiresAt,
    contentHash: "",
  };
  if (contentHashOf(candidate) !== claims.contentHash) {
    throw new InspectionSnapshotValidationError("Inspection snapshot has been modified.");
  }
  return { ...candidate, contentHash: claims.contentHash };
}

export const inspectionSnapshotSummaryFromClaims = (claims: InspectionSnapshotClaims): InspectionSnapshotSummary => ({
  available: true,
  version: claims.version,
  targetType: claims.targetType,
  targetFingerprint: claims.targetFingerprint,
  sourceCount: claims.sourceIds.length,
  categoryCount: claims.categoryIds.length,
  sourceScanned: claims.sourceScanned,
  categoryScanned: claims.categoryScanned,
  sourceTruncated: claims.sourceTruncated,
  categoryTruncated: claims.categoryTruncated,
  artifactEvidenceTruncated: claims.artifactEvidenceTruncated,
  truncated: claims.sourceTruncated || claims.categoryTruncated || claims.artifactEvidenceTruncated,
  generatedAt: claims.generatedAt,
  expiresAt: claims.expiresAt,
});
