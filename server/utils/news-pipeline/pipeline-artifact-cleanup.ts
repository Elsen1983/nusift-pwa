/**
 * Pipeline artifact cleanup.
 *
 * Deletes old, terminal, or superseded PipelineArtifact rows. This is
 * diagnostic/pipeline-leftover cleanup — NOT article cleanup. Active/in-flight
 * artifacts are never deleted. Unresolved hard-source profiles are protected.
 *
 * Status policy (matches headless-queue-normalize.ts conventions):
 *
 *   A. Always keep (active / in-flight):
 *      - PENDING_HEADLESS (unless superseded by a newer successful terminal artifact)
 *      - HEADLESS_PROCESSING
 *      - HEADLESS_PROCESSING_STALE (recovery path owns these)
 *
 *   B. Safe to delete after olderThanDays (terminal history):
 *      - RESOLVED
 *      - RESOLVED_BY_STATIC_DISCOVERY
 *      - RESOLVED_BY_AGENT1_RSS
 *      - BROWSER_FALLBACK_DISABLED (legacy terminal)
 *
 *   C. Superseded retryable failures — delete only if a newer successful
 *      terminal artifact exists for the SAME target (sourceId + categoryId +
 *      normalized targetUrl):
 *      - BROWSER_NO_CANDIDATES
 *      - BROWSER_RUNTIME_UNAVAILABLE
 *      - article_discovery_candidates (when superseded)
 *
 *   E. Diagnostic history artifacts (Agent 1 RSS / hard-case):
 *      - Artifact types `rss_candidates` and `hard_case_discovery_candidate`
 *        with terminal diagnostic statuses CAPTURED, FAILED, FAILED_FINAL are
 *        eligible for deletion after the retention window.
 *      - These are purely diagnostic/audit payloads; no production code
 *        depends on old rows as source-of-truth. Agent 3 provenance recovery
 *        only uses the most recent CAPTURED artifact per sourceId, which
 *        will always be within the retention window.
 *      - `hard_case_discovery_candidate` with PENDING_HEADLESS remains
 *        handled by rule A (active/in-flight).
 *
 *   D. Hard-source profiles:
 *      - article_discovery_hard_source_profile is protected if it still
 *        represents an unresolved hard source (status !== RESOLVED_BY_AGENT1_RSS
 *        and no resolvedBy/resolvedAt metadata).
 *      - It MAY be deleted if resolved metadata exists AND it is older than the
 *        retention window. If unclear, skip it.
 *
 * Target identity (for superseded comparison):
 *   - sourceId (must match, including null vs non-null categoryId)
 *   - categoryId (must match, including null vs non-null)
 *   - payload.targetUrl normalized via the existing normalizeUrl helper
 *   - If targetUrl is missing/malformed, do NOT loose-match; the artifact is
 *     only eligible via status-age cleanup for clearly terminal statuses (B).
 *
 * Bounded + idempotent + safe to repeat. No raw payloads in the result.
 */

import { prisma } from "../prisma";
import { logAgentScan } from "./log";
import { normalizeUrl } from "./text";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PipelineArtifactCleanupInput = {
  dryRun?: boolean;
  olderThanDays?: number;
  limit?: number;
  now?: Date;
};

export type PipelineArtifactCleanupResult = {
  ok: true;
  dryRun: boolean;
  olderThanDays: number;
  cutoff: string;
  inspected: number;
  eligibleForDeletion: number;
  deleted: number;
  protected: number;
  skipped: number;
  limit: number;
  durationMs: number;
  byArtifactType: Record<string, number>;
  byStatus: Record<string, number>;
  protectedReasons: Record<string, number>;
  skippedReasons: Record<string, number>;
  sampleDeletedOrWouldDelete: Array<{
    id: string;
    artifactType: string;
    status: string;
    sourceId: string | null;
    categoryId: string | null;
    targetUrl: string | null;
    createdAt: string;
    updatedAt: string;
    reason: string;
  }>;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_OLDER_THAN_DAYS = 14;
const MIN_OLDER_THAN_DAYS = 1;
const MAX_OLDER_THAN_DAYS = 365;

const DEFAULT_LIMIT = 200;
const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;

const MAX_SAMPLE_SIZE = 20;

// Status sets — kept in sync with headless-queue-normalize.ts semantics.

/** Always-active statuses. Never deleted regardless of age (unless superseded). */
const ACTIVE_STATUSES = new Set([
  "PENDING_HEADLESS",
  "HEADLESS_PROCESSING",
  "HEADLESS_PROCESSING_STALE",
]);

/** Terminal statuses. Safe to delete after the retention window. */
const TERMINAL_STATUSES = new Set([
  "RESOLVED",
  "RESOLVED_BY_STATIC_DISCOVERY",
  "RESOLVED_BY_AGENT1_RSS",
  "BROWSER_FALLBACK_DISABLED",
]);

/** Successful terminal statuses used for superseded comparison. */
const SUCCESSFUL_TERMINAL_STATUSES = new Set([
  "RESOLVED",
  "RESOLVED_BY_STATIC_DISCOVERY",
  "RESOLVED_BY_AGENT1_RSS",
]);

/** Retryable failure statuses — eligible only if superseded by a newer success. */
const RETRYABLE_FAILURE_STATUSES = new Set([
  "BROWSER_NO_CANDIDATES",
  "BROWSER_RUNTIME_UNAVAILABLE",
]);

/** Artifact types that participate in target-based superseded logic. */
const TARGET_BASED_ARTIFACT_TYPES = new Set([
  "article_discovery_headless_required",
  "article_discovery_candidates",
]);

/**
 * Diagnostic artifact types whose historical rows are purely audit/diagnostic
 * and safe to delete after the retention window. No production code depends
 * on old rows from these types as source-of-truth.
 */
const DIAGNOSTIC_ARTIFACT_TYPES = new Set([
  "rss_candidates",
  "hard_case_discovery_candidate",
]);

/**
 * Terminal statuses for diagnostic artifacts. These statuses indicate the
 * artifact's pipeline work is finished and the row exists only as history.
 */
const DIAGNOSTIC_HISTORY_STATUSES = new Set([
  "CAPTURED",
  "FAILED",
  "FAILED_FINAL",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null || typeof value === "boolean") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Safely normalize a URL for target comparison, returning null on invalid
 * input. Reuses the existing normalizeUrl helper from ./text.ts which strips
 * hash, tracking params (UTM, fbclid, gclid), and trailing slashes.
 */
function safeNormalizeUrl(raw: string): string | null {
  try {
    return normalizeUrl(raw) || null;
  } catch {
    return null;
  }
}

/**
 * Build a strict target key from sourceId + categoryId + normalized targetUrl.
 * Returns null if any required component is missing — meaning the artifact
 * cannot be safely matched for superseded logic and must rely on status-age
 * cleanup only.
 *
 * categoryId null vs non-null is significant and preserved in the key.
 */
function buildTargetKey(
  sourceId: string | null,
  categoryId: string | null,
  targetUrl: string | null,
): string | null {
  if (!sourceId || !targetUrl) return null;
  const normalized = safeNormalizeUrl(targetUrl);
  if (!normalized) return null;
  return [sourceId, categoryId ?? "", normalized].join("\u0001");
}

type ArtifactRow = {
  id: string;
  artifactType: string;
  status: string;
  sourceId: string | null;
  categoryId: string | null;
  createdAt: Date;
  updatedAt: Date;
  payload: unknown;
};

type ClassifiedArtifact = ArtifactRow & {
  targetKey: string | null;
  targetUrl: string | null;
  reason: string;
  decision: "eligible" | "protected" | "skipped";
};

// ─── Main ───────────────────────────────────────────────────────────────────

export async function processPipelineArtifactCleanup(
  input?: PipelineArtifactCleanupInput,
): Promise<PipelineArtifactCleanupResult> {
  const dryRun = input?.dryRun !== false; // default true for safety
  const olderThanDays = clampInt(
    input?.olderThanDays,
    DEFAULT_OLDER_THAN_DAYS,
    MIN_OLDER_THAN_DAYS,
    MAX_OLDER_THAN_DAYS,
  );
  const limit = clampInt(input?.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
  const now = input?.now ?? new Date();
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);

  const startedAt = Date.now();
  const baseResult = (): PipelineArtifactCleanupResult => ({
    ok: true,
    dryRun,
    olderThanDays,
    cutoff: cutoff.toISOString(),
    inspected: 0,
    eligibleForDeletion: 0,
    deleted: 0,
    protected: 0,
    skipped: 0,
    limit,
    durationMs: 0,
    byArtifactType: {},
    byStatus: {},
    protectedReasons: {},
    skippedReasons: {},
    sampleDeletedOrWouldDelete: [],
  });

  await logAgentScan({
    status: "PIPELINE_ARTIFACT_CLEANUP_STARTED",
    executionTimeMs: 0,
    errorLog:
      `Pipeline artifact cleanup ${dryRun ? "inspection" : "run"} started. ` +
      `olderThanDays=${olderThanDays}, limit=${limit}, dryRun=${dryRun}, cutoff=${cutoff.toISOString()}.`,
  }).catch(() => {});

  try {
    // ── Step 1: Fetch candidate artifacts older than cutoff ──────────────
    // We fetch rows older than the cutoff (by updatedAt, which reflects the
    // last status change). `take: limit` keeps the candidate pool bounded.
    const rows = await prisma.pipelineArtifact.findMany({
      where: {
        updatedAt: { lt: cutoff },
      },
      select: {
        id: true,
        artifactType: true,
        status: true,
        sourceId: true,
        categoryId: true,
        createdAt: true,
        updatedAt: true,
        payload: true,
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });

    const inspected = rows.length;
    if (inspected === 0) {
      const result = baseResult();
      result.durationMs = Date.now() - startedAt;
      await logAgentScan({
        status: "PIPELINE_ARTIFACT_CLEANUP_FINISHED",
        executionTimeMs: result.durationMs,
        errorLog:
          `Pipeline artifact cleanup ${dryRun ? "inspection" : "run"} complete. ` +
          `No candidates older than cutoff. inspected=0.`,
      }).catch(() => {});
      return result;
    }

    // ── Step 2: Classify each candidate ──────────────────────────────────
    const classified: ClassifiedArtifact[] = rows.map((row) => {
      const payload = isPlainObject(row.payload) ? row.payload : {};
      const targetUrl = readString(payload.targetUrl);
      const targetKey = buildTargetKey(row.sourceId, row.categoryId, targetUrl);
      return classifyArtifact(row, payload, targetUrl, targetKey);
    });

    // ── Step 3: Resolve superseded logic for retryable failures ──────────
    // For RETRYABLE_FAILURE_STATUSES and article_discovery_candidates, we
    // only delete if a newer successful terminal artifact exists for the same
    // target. We batch-query successful terminal artifacts for the relevant
    // sourceIds and resolve in-memory.
    const needsSupersededCheck = classified.filter(
      (c) =>
        c.decision === "skipped" &&
        ((RETRYABLE_FAILURE_STATUSES.has(c.status) &&
          c.artifactType === "article_discovery_headless_required") ||
          (c.artifactType === "article_discovery_candidates")),
    );

    if (needsSupersededCheck.length > 0) {
      const targetKeysToCheck = new Set<string>();
      const sourceIdsToCheck = new Set<string>();
      for (const c of needsSupersededCheck) {
        if (c.targetKey) {
          targetKeysToCheck.add(c.targetKey);
          if (c.sourceId) sourceIdsToCheck.add(c.sourceId);
        }
      }

      if (targetKeysToCheck.size > 0 && sourceIdsToCheck.size > 0) {
        // Fetch successful terminal artifacts for these sourceIds (bounded).
        const successfulArtifacts = await prisma.pipelineArtifact.findMany({
          where: {
            status: { in: [...SUCCESSFUL_TERMINAL_STATUSES] },
            sourceId: { in: [...sourceIdsToCheck] },
          },
          select: {
            id: true,
            status: true,
            artifactType: true,
            sourceId: true,
            categoryId: true,
            updatedAt: true,
            createdAt: true,
            payload: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 500,
        });

        // Build a map of targetKey → newest successful updatedAt (ms).
        const newestSuccessByTarget = new Map<string, number>();
        for (const a of successfulArtifacts) {
          const p = isPlainObject(a.payload) ? a.payload : {};
          const key = buildTargetKey(a.sourceId, a.categoryId, readString(p.targetUrl));
          if (!key || !targetKeysToCheck.has(key)) continue;
          const ts = new Date(a.updatedAt).getTime();
          const prev = newestSuccessByTarget.get(key) ?? 0;
          if (ts > prev) newestSuccessByTarget.set(key, ts);
        }

        // Re-classify the needsSupersededCheck entries.
        for (const c of needsSupersededCheck) {
          if (!c.targetKey) continue;
          const newestSuccessMs = newestSuccessByTarget.get(c.targetKey);
          if (newestSuccessMs == null) {
            // No newer success for this target → keep protected.
            c.decision = "protected";
            c.reason = "no_newer_success_for_target";
            continue;
          }
          const candidateUpdatedMs = new Date(c.updatedAt).getTime();
          if (newestSuccessMs > candidateUpdatedMs) {
            // Superseded by a newer successful terminal artifact.
            c.decision = "eligible";
            c.reason = "superseded_by_newer_success";
          } else {
            // The candidate is newer than the latest success → not superseded.
            c.decision = "protected";
            c.reason = "candidate_newer_than_latest_success";
          }
        }
      }
    }

    // ── Step 4: Aggregate counts + samples ───────────────────────────────
    const byArtifactType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const protectedReasons: Record<string, number> = {};
    const skippedReasons: Record<string, number> = {};

    const eligible: ClassifiedArtifact[] = [];
    let protectedCount = 0;
    let skippedCount = 0;

    for (const c of classified) {
      bump(byArtifactType, c.artifactType);
      bump(byStatus, c.status);

      if (c.decision === "eligible") {
        eligible.push(c);
      } else if (c.decision === "protected") {
        protectedCount += 1;
        bump(protectedReasons, c.reason);
        bump(skippedReasons, "protected");
      } else {
        skippedCount += 1;
        bump(skippedReasons, c.reason);
      }
    }

    const eligibleForDeletion = eligible.length;

    const sampleDeletedOrWouldDelete = eligible
      .slice(0, MAX_SAMPLE_SIZE)
      .map((c) => ({
        id: c.id,
        artifactType: c.artifactType,
        status: c.status,
        sourceId: c.sourceId ?? null,
        categoryId: c.categoryId ?? null,
        targetUrl: c.targetUrl ?? null,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        reason: c.reason,
      }));

    // ── Step 5: Dry-run short-circuit ────────────────────────────────────
    if (dryRun) {
      const result = baseResult();
      result.inspected = inspected;
      result.eligibleForDeletion = eligibleForDeletion;
      result.deleted = 0;
      result.protected = protectedCount;
      result.skipped = skippedCount;
      result.byArtifactType = byArtifactType;
      result.byStatus = byStatus;
      result.protectedReasons = protectedReasons;
      result.skippedReasons = skippedReasons;
      result.sampleDeletedOrWouldDelete = sampleDeletedOrWouldDelete;
      result.durationMs = Date.now() - startedAt;

      await logAgentScan({
        status: "PIPELINE_ARTIFACT_CLEANUP_FINISHED",
        executionTimeMs: result.durationMs,
        errorLog:
          `Pipeline artifact cleanup inspection complete. ` +
          `inspected=${inspected}, eligibleForDeletion=${eligibleForDeletion}, ` +
          `protected=${protectedCount}, skipped=${skippedCount}.`,
      }).catch(() => {});

      return result;
    }

    // ── Step 6: Non-dry-run deletion (bounded, explicit id list) ─────────
    const eligibleIds = eligible.map((c) => c.id);
    let deleted = 0;
    if (eligibleIds.length > 0) {
      const delResult = await prisma.pipelineArtifact.deleteMany({
        where: { id: { in: eligibleIds } },
      });
      deleted = delResult.count;

      if (deleted !== eligibleIds.length) {
        bump(skippedReasons, "deleteCountMismatch");
      }
    }

    const result = baseResult();
    result.inspected = inspected;
    result.eligibleForDeletion = eligibleForDeletion;
    result.deleted = deleted;
    result.protected = protectedCount;
    result.skipped = skippedCount;
    result.byArtifactType = byArtifactType;
    result.byStatus = byStatus;
    result.protectedReasons = protectedReasons;
    result.skippedReasons = skippedReasons;
    result.sampleDeletedOrWouldDelete = sampleDeletedOrWouldDelete;
    result.durationMs = Date.now() - startedAt;

    await logAgentScan({
      status: "PIPELINE_ARTIFACT_CLEANUP_FINISHED",
      executionTimeMs: result.durationMs,
      errorLog:
        `Pipeline artifact cleanup run complete. ` +
        `inspected=${inspected}, eligibleForDeletion=${eligibleForDeletion}, ` +
        `deleted=${deleted}, protected=${protectedCount}, skipped=${skippedCount}.`,
    }).catch(() => {});

    return result;
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    await logAgentScan({
      status: "PIPELINE_ARTIFACT_CLEANUP_FAILED",
      executionTimeMs: durationMs,
      errorLog:
        `Pipeline artifact cleanup failed: ${error?.message || String(error)}. ` +
        `olderThanDays=${olderThanDays}, limit=${limit}, dryRun=${dryRun}.`,
    }).catch(() => {});

    throw error;
  }
}

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Classify a single candidate artifact into eligible / protected / skipped
 * based on status and artifact type, WITHOUT considering superseded logic
 * (which requires the cross-target query and is applied later).
 *
 * Initial decision for retryable failures / candidates is "skipped" pending
 * the superseded check; the caller re-classifies those after fetching the
 * successful-terminal set.
 */
function classifyArtifact(
  row: ArtifactRow,
  payload: Record<string, unknown>,
  targetUrl: string | null,
  targetKey: string | null,
): ClassifiedArtifact {
  // ── A. Always keep active/in-flight statuses ───────────────────────────
  // NOTE: Active statuses are never hard-source profiles, so the order here
  // is safe.
  if (ACTIVE_STATUSES.has(row.status)) {
    // PENDING_HEADLESS may be superseded, but only if we can match its target.
    // If targetKey is null (missing/malformed targetUrl), we cannot safely
    // supersede-match it, so keep it protected.
    if (row.status === "PENDING_HEADLESS" && targetKey) {
      // Defer to superseded check.
      return {
        ...row,
        targetUrl,
        targetKey,
        reason: "pending_superseded_check",
        decision: "skipped",
      };
    }
    return {
      ...row,
      targetUrl,
      targetKey,
      reason: "active_inflight_status",
      decision: "protected",
    };
  }

  // ── E. Diagnostic history artifacts (Agent 1 RSS / hard-case) ──────────
  // These artifact types with diagnostic history statuses are purely
  // audit/history. Eligible after the retention window (age enforced by query).
  if (DIAGNOSTIC_ARTIFACT_TYPES.has(row.artifactType) && DIAGNOSTIC_HISTORY_STATUSES.has(row.status)) {
    return {
      ...row,
      targetUrl,
      targetKey,
      reason: "diagnostic_artifact_aged",
      decision: "eligible",
    };
  }

  // ── D. Hard-source profiles (checked BEFORE terminal statuses) ─────────
  // A hard-source profile may carry status RESOLVED_BY_AGENT1_RSS, which is
  // also a terminal status. The profile-specific semantics (resolvedBy /
  // resolvedAt metadata, unresolved protection) must take precedence so the
  // reason reflects "hard_source_profile_resolved" rather than the generic
  // "terminal_status_aged".
  if (row.artifactType === "article_discovery_hard_source_profile") {
    const resolvedBy = readString(payload.resolvedBy);
    const resolvedAt = readString(payload.resolvedAt);
    const isResolvedStatus = row.status === "RESOLVED_BY_AGENT1_RSS";

    if (isResolvedStatus || (resolvedBy && resolvedAt)) {
      // Resolved profile older than cutoff → eligible.
      return {
        ...row,
        targetUrl,
        targetKey,
        reason: "hard_source_profile_resolved",
        decision: "eligible",
      };
    }
    // Unresolved or unclear → protected.
    return {
      ...row,
      targetUrl,
      targetKey,
      reason: "hard_source_profile_unresolved",
      decision: "protected",
    };
  }

  // ── B. Terminal statuses → eligible (age already enforced by the query) ─
  // Reached only for non-hard-source artifacts with a terminal status.
  if (TERMINAL_STATUSES.has(row.status)) {
    return {
      ...row,
      targetUrl,
      targetKey,
      reason: "terminal_status_aged",
      decision: "eligible",
    };
  }

  // ── C. Retryable failures + candidates → defer to superseded check ─────
  if (
    (RETRYABLE_FAILURE_STATUSES.has(row.status) &&
      row.artifactType === "article_discovery_headless_required") ||
    row.artifactType === "article_discovery_candidates"
  ) {
    // If we cannot build a target key (missing/malformed targetUrl), we
    // cannot loose-match. Keep protected — do NOT use status-age cleanup
    // for these retryable statuses.
    if (!targetKey) {
      return {
        ...row,
        targetUrl,
        targetKey,
        reason: "missing_or_malformed_target_url",
        decision: "protected",
      };
    }
    return {
      ...row,
      targetUrl,
      targetKey,
      reason: "pending_superseded_check",
      decision: "skipped",
    };
  }

  // ── Unknown / other statuses → skip conservatively ─────────────────────
  // e.g. SKIPPED_UNIMPLEMENTED, INVALID, PROFILE, BROWSER_COOLDOWN_DEFERRED,
  // or any future status. We do not delete what we don't explicitly understand.
  return {
    ...row,
    targetUrl,
    targetKey,
    reason: "unhandled_status_conservative_skip",
    decision: "skipped",
  };
}
