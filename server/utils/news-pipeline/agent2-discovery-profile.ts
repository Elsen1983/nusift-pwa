/**
 * Agent 2 discovery profile persistence.
 *
 * Builds, validates, and applies compact discovery profiles that alter
 * Agent 2 behavior for specific targets. Profiles are stored as
 * PipelineArtifact payloads — no Prisma schema changes.
 *
 * ## Lifecycle
 * 1. A recovery suggestion (from hard-source-recovery.ts) produces a
 *    proposedProfilePatch.
 * 2. buildDiscoveryProfileFromSuggestion() creates a DRAFT profile.
 * 3. An admin reviews and activates it (or it stays draft).
 * 4. Only ACTIVE profiles affect Agent 2 discovery behavior.
 * 5. Profiles can be DISABLED or SUPERSEDED by newer profiles.
 *
 * ## Safety
 * - Draft profiles do NOT affect production discovery.
 * - Only explicitly activated profiles are consumed by Agent 2.
 * - Rules are narrow: they apply only to the matching target
 *   (sourceId + categoryId + targetUrl).
 * - No publisher-specific special casing.
 * - Bounded arrays, compact payloads, no raw HTML.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type Agent2DiscoveryProfileStatus = "draft" | "active" | "disabled" | "superseded";

export type Agent2DiscoveryProfileRules = {
  relaxCategoryScope?: boolean;
  allowedPathPrefixes?: string[];
  deniedPathPrefixes?: string[];
  preferListingAnchors?: boolean;
  allowWeakDateFromListingContext?: boolean;
  maxBrowserDetailEvaluations?: number;
};

export type Agent2DiscoveryProfileEvidence = {
  fromProfileArtifactId?: string;
  reasonCodes: string[];
};

export type Agent2DiscoveryProfile = {
  schemaVersion: 1;
  targetUrl: string;
  sourceId: string;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: "deterministic_recovery" | "admin" | "ai_inspection";
  status: Agent2DiscoveryProfileStatus;
  rules: Agent2DiscoveryProfileRules;
  evidence: Agent2DiscoveryProfileEvidence;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_ALLOWED_PATH_PREFIXES = 10;
const MAX_DENIED_PATH_PREFIXES = 10;
const MAX_REASON_CODES = 10;
const MAX_PREFIX_LENGTH = 256;
const MAX_URL_LENGTH = 2048;

const VALID_PROFILE_STATUSES = new Set<Agent2DiscoveryProfileStatus>([
  "draft",
  "active",
  "disabled",
  "superseded",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

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
    if (trimmed.length === 0 || trimmed.length > maxItemLength) continue;
    results.push(trimmed);
    if (results.length >= maxItems) break;
  }
  return results;
}

// ─── Builder ────────────────────────────────────────────────────────────────

type BuildProfileInput = {
  targetUrl: string;
  sourceId: string;
  categoryId: string | null;
  createdBy: Agent2DiscoveryProfile["createdBy"];
  rules: Agent2DiscoveryProfileRules;
  reasonCodes: string[];
  fromProfileArtifactId?: string;
};

/**
 * Build a new DRAFT discovery profile from a suggestion or admin action.
 * Always starts in "draft" status — must be explicitly activated.
 */
export function buildDiscoveryProfileFromSuggestion(
  input: BuildProfileInput,
): Agent2DiscoveryProfile {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    targetUrl: input.targetUrl,
    sourceId: input.sourceId,
    categoryId: input.categoryId,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
    status: "draft",
    rules: sanitizeRules(input.rules),
    evidence: {
      fromProfileArtifactId: input.fromProfileArtifactId,
      reasonCodes: input.reasonCodes.slice(0, MAX_REASON_CODES),
    },
  };
}

// ─── Rules sanitization ─────────────────────────────────────────────────────

function sanitizeRules(rules: Agent2DiscoveryProfileRules): Agent2DiscoveryProfileRules {
  const result: Agent2DiscoveryProfileRules = {};

  if (rules.relaxCategoryScope === true) {
    result.relaxCategoryScope = true;
  }

  if (Array.isArray(rules.allowedPathPrefixes)) {
    result.allowedPathPrefixes = readBoundedStringArray(
      rules.allowedPathPrefixes,
      MAX_ALLOWED_PATH_PREFIXES,
      MAX_PREFIX_LENGTH,
    );
  }

  if (Array.isArray(rules.deniedPathPrefixes)) {
    result.deniedPathPrefixes = readBoundedStringArray(
      rules.deniedPathPrefixes,
      MAX_DENIED_PATH_PREFIXES,
      MAX_PREFIX_LENGTH,
    );
  }

  if (rules.preferListingAnchors === true) {
    result.preferListingAnchors = true;
  }

  if (rules.allowWeakDateFromListingContext === true) {
    result.allowWeakDateFromListingContext = true;
  }

  const maxDetail = readNumber(rules.maxBrowserDetailEvaluations);
  if (maxDetail !== null && maxDetail >= 1 && maxDetail <= 50) {
    result.maxBrowserDetailEvaluations = Math.round(maxDetail);
  }

  return result;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate an unknown JSON value as a discovery profile.
 * Returns the normalized profile or null if invalid.
 */
export function validateDiscoveryProfile(value: unknown): Agent2DiscoveryProfile | null {
  if (!isPlainObject(value)) return null;

  // schemaVersion must be 1
  if (value.schemaVersion !== 1) return null;

  // Required string fields
  const targetUrl = readString(value.targetUrl);
  const sourceId = readString(value.sourceId);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  if (!targetUrl || !sourceId || !createdAt || !updatedAt) return null;

  // targetUrl must be a valid URL
  if (targetUrl.length > MAX_URL_LENGTH) return null;

  // categoryId: string | null
  const categoryId = typeof value.categoryId === "string"
    ? value.categoryId
    : value.categoryId === null
      ? null
      : null;

  // createdBy
  const createdBy = readString(value.createdBy);
  const validCreators = new Set(["deterministic_recovery", "admin", "ai_inspection"]);
  if (!createdBy || !validCreators.has(createdBy)) return null;

  // status
  const status = readString(value.status);
  if (!status || !VALID_PROFILE_STATUSES.has(status as Agent2DiscoveryProfileStatus)) return null;

  // rules
  const rules = isPlainObject(value.rules) ? sanitizeRules(value.rules) : {};

  // evidence
  const evidence: Agent2DiscoveryProfileEvidence = {
    reasonCodes: [],
  };
  if (isPlainObject(value.evidence)) {
    evidence.fromProfileArtifactId = readString(value.evidence.fromProfileArtifactId) ?? undefined;
    evidence.reasonCodes = readBoundedStringArray(
      value.evidence.reasonCodes,
      MAX_REASON_CODES,
      256,
    );
  }

  return {
    schemaVersion: 1,
    targetUrl,
    sourceId,
    categoryId,
    createdAt,
    updatedAt,
    createdBy: createdBy as Agent2DiscoveryProfile["createdBy"],
    status: status as Agent2DiscoveryProfileStatus,
    rules,
    evidence,
  };
}

// ─── Suggestion-to-rules mapping ───────────────────────────────────────────

/**
 * Map a hard-source suggestedNextAction to a discovery profile action
 * and default rules.
 *
 * Exported from this utility file so both the activation endpoint and
 * tests can import it without coupling to HTTP handler files.
 */
export function mapSuggestionToDiscoveryRules(suggestedAction: string): {
  action: string;
  rules: Agent2DiscoveryProfile["rules"];
} {
  switch (suggestedAction) {
    case "relax_category_scope":
      return {
        action: "relax_category_scope",
        rules: { relaxCategoryScope: true },
      };
    case "weak_date_policy_review":
      return {
        action: "use_browser_detail_dates",
        rules: { allowWeakDateFromListingContext: true },
      };
    case "ai_profile_inspection":
      return {
        action: "needs_ai_inspection",
        rules: {},
      };
    case "browser_runtime_fix":
      return {
        action: "respect_cooldown",
        rules: {},
      };
    default:
      return {
        action: "manual_review",
        rules: {},
      };
  }
}

// ─── Active Profile Lookup ──────────────────────────────────────────────────

import { prisma } from "../prisma";
import { normalizeUrl } from "./text";

/**
 * Look up the latest ACTIVE discovery profile for a given target.
 * Returns the validated profile or null if no active profile exists.
 *
 * Only ACTIVE profiles are returned — draft, disabled, and superseded
 * profiles are ignored.
 */
export async function lookupActiveDiscoveryProfile(input: {
  sourceId: string;
  categoryId: string | null;
  targetUrl: string;
}): Promise<Agent2DiscoveryProfile | null> {
  // Fetch a bounded recent set of ACTIVE profiles for this source/category.
  // targetUrl is stored inside payload JSON, so we filter in memory after
  // normalized URL comparison. take:20 is generous enough to find the match
  // even when multiple ACTIVE profiles exist for different targets.
  const artifacts = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: "agent2_discovery_profile",
      status: "ACTIVE",
      sourceId: input.sourceId,
      categoryId: input.categoryId ?? null,
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { payload: true },
  });

  if (artifacts.length === 0) return null;

  // Normalize the requested targetUrl for comparison
  let normalizedInputUrl: string;
  try {
    normalizedInputUrl = normalizeUrl(input.targetUrl) || input.targetUrl;
  } catch {
    normalizedInputUrl = input.targetUrl;
  }

  for (const artifact of artifacts) {
    const payload = artifact.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") continue;

    const profile = payload.profile;
    if (!profile || typeof profile !== "object") continue;

    const validated = validateDiscoveryProfile(profile);
    if (!validated) continue;
    if (validated.status !== "active") continue;
    if (validated.sourceId !== input.sourceId) continue;
    if (validated.categoryId !== input.categoryId) continue;

    // Normalize the profile's targetUrl for comparison
    let normalizedProfileUrl: string;
    try {
      normalizedProfileUrl = normalizeUrl(validated.targetUrl) || validated.targetUrl;
    } catch {
      normalizedProfileUrl = validated.targetUrl;
    }

    if (normalizedProfileUrl === normalizedInputUrl) {
      return validated;
    }
  }

  return null;
}

// ─── Applicator ─────────────────────────────────────────────────────────────

export type Agent2TargetDiscoveryOverrides = {
  relaxCategoryScope: boolean;
  deniedPathPrefixes: string[] | null;
  preferListingAnchors: boolean;
  allowWeakDateFromListingContext: boolean;
  maxBrowserDetailEvaluations: number | null;
};

/**
 * Extract discovery overrides from an active profile for a specific target.
 * Returns null if the profile is not active or does not match the target.
 *
 * Only ACTIVE profiles produce overrides — draft, disabled, and superseded
 * profiles are ignored.
 */
export function applyDiscoveryProfileToAgent2Target(
  profile: Agent2DiscoveryProfile,
  target: {
    sourceId: string;
    categoryId: string | null;
    targetUrl: string;
  },
): Agent2TargetDiscoveryOverrides | null {
  // Only active profiles apply
  if (profile.status !== "active") return null;

  // Must match target
  if (profile.sourceId !== target.sourceId) return null;
  if (profile.categoryId !== target.categoryId) return null;
  if (profile.targetUrl !== target.targetUrl) return null;

  return {
    relaxCategoryScope: profile.rules.relaxCategoryScope === true,
    deniedPathPrefixes: profile.rules.deniedPathPrefixes ?? null,
    preferListingAnchors: profile.rules.preferListingAnchors === true,
    allowWeakDateFromListingContext: profile.rules.allowWeakDateFromListingContext === true,
    maxBrowserDetailEvaluations: profile.rules.maxBrowserDetailEvaluations ?? null,
  };
}
