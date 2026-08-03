/**
 * Hard-source repair utility.
 *
 * Before Phase 4, BROWSER_RUNTIME_UNAVAILABLE (a platform/runtime failure)
 * could be persisted as hard-source evidence. Those invalid profiles are
 * surfaced here through normal application logic (lifecycleState -> "stale"
 * with status INVALIDATED_RUNTIME_EVIDENCE) so they never describe the
 * publisher as hard.
 *
 * The repair is DRY-RUN BY DEFAULT: writes require an explicit confirmation
 * flag. All scans are bounded.
 */

import { prisma } from "../prisma";
import { classifyBrowserFailureOrigin } from "./failure-origin";

export type RuntimeEvidenceOnlyProfile = {
  id: string;
  sourceId: string | null;
  categoryId: string | null;
  targetUrl: string | null;
  staticQuality: string | null;
  browserStatus: string | null;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** Original persisted payload, preserved on invalidation. */
  payload: Record<string, unknown> | null;
};

const DEFAULT_SCAN_LIMIT = 200;
const MAX_SCAN_LIMIT = 500;

const RUNTIME_ONLY_BROWSER_STATUSES: ReadonlySet<string> = new Set([
  "BROWSER_RUNTIME_UNAVAILABLE",
  "BROWSER_FALLBACK_DISABLED",
]);

/**
 * Whether a stored hard-source profile payload was created from
 * platform/runtime or configuration evidence (no genuine publisher evidence).
 */
export function isRuntimeEvidenceOnlyProfilePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const raw = payload as Record<string, unknown>;
  const browserStatus = typeof raw.browserStatus === "string" ? raw.browserStatus : null;
  if (!browserStatus) return false;
  const origin = classifyBrowserFailureOrigin(browserStatus);
  if (origin === "platform_runtime_failure" || origin === "configuration_failure") {
    // BROWSER_FALLBACK_DISABLED is configuration evidence; BROWSER_RUNTIME_
    // UNAVAILABLE is platform evidence. Neither says anything about the
    // publisher, even when the static side also failed.
    return RUNTIME_ONLY_BROWSER_STATUSES.has(browserStatus);
  }
  return false;
}

/**
 * Bounded scan: find hard-source profiles created solely from runtime/config
 * evidence. Read-only.
 */
export async function findRuntimeEvidenceOnlyProfiles(input?: {
  scanLimit?: number;
}): Promise<RuntimeEvidenceOnlyProfile[]> {
  const scanLimit = Math.min(
    Math.max(input?.scanLimit ?? DEFAULT_SCAN_LIMIT, 1),
    MAX_SCAN_LIMIT,
  );

  const artifacts = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: "article_discovery_hard_source_profile",
      status: { notIn: ["RESOLVED", "RESOLVED_BY_AGENT1_RSS"] },
    },
    select: {
      id: true,
      sourceId: true,
      categoryId: true,
      createdAt: true,
      updatedAt: true,
      payload: true,
    },
    orderBy: { createdAt: "desc" },
    take: scanLimit,
  });

  const matches: RuntimeEvidenceOnlyProfile[] = [];
  for (const artifact of artifacts) {
    if (!isRuntimeEvidenceOnlyProfilePayload(artifact.payload)) continue;
    const payload = artifact.payload as Record<string, unknown> | null;
    matches.push({
      id: artifact.id,
      sourceId: artifact.sourceId,
      categoryId: artifact.categoryId,
      targetUrl: typeof payload?.targetUrl === "string" ? payload.targetUrl : null,
      staticQuality: typeof payload?.staticQuality === "string" ? payload.staticQuality : null,
      browserStatus: typeof payload?.browserStatus === "string" ? payload.browserStatus : null,
      failureCount: typeof payload?.failureCount === "number" && Number.isFinite(payload.failureCount)
        ? Math.max(0, Math.round(payload.failureCount))
        : 1,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      payload: payload as Record<string, unknown> | null,
    });
  }

  return matches;
}

export type RepairRuntimeEvidenceResult = {
  dryRun: boolean;
  scanned: number;
  matched: number;
  updated: number;
  failed: number;
  profiles: RuntimeEvidenceOnlyProfile[];
};

/**
 * Repair invalid runtime-evidence-only hard-source profiles.
 *
 * DRY-RUN BY DEFAULT: when `dryRun` is true (or omitted) no writes happen and
 * `updated` stays 0. Writes require `dryRun: false` (explicit confirmation).
 *
 * Writes invalidate matching profiles through normal application logic:
 * lifecycleState -> "stale" and status -> INVALIDATED_RUNTIME_EVIDENCE, so
 * admin diagnostics and health scoring stop treating them as publisher
 * evidence.
 */
export async function repairRuntimeEvidenceOnlyProfiles(input?: {
  dryRun?: boolean;
  scanLimit?: number;
}): Promise<RepairRuntimeEvidenceResult> {
  const dryRun = input?.dryRun !== false; // explicit confirmation required for writes
  const scanLimit = Math.min(
    Math.max(input?.scanLimit ?? DEFAULT_SCAN_LIMIT, 1),
    MAX_SCAN_LIMIT,
  );

  const profiles = await findRuntimeEvidenceOnlyProfiles({ scanLimit });
  let updated = 0;
  let failed = 0;

  if (!dryRun) {
    for (const profile of profiles) {
      try {
        // Preserve the original payload and mark it stale through normal
        // application logic (lifecycleState -> stale, status -> invalidated).
        const result = await prisma.pipelineArtifact.updateMany({
          where: { id: profile.id },
          data: {
            status: "INVALIDATED_RUNTIME_EVIDENCE",
            payload: {
              ...(profile.payload ?? {}),
              lifecycleState: "stale",
              invalidatedReason: "platform_runtime_evidence_only",
              invalidatedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          },
        });
        if (result.count > 0) updated += 1;
      } catch {
        failed += 1;
      }
    }
  }

  return {
    dryRun,
    scanned: profiles.length,
    matched: profiles.length,
    updated,
    failed,
    profiles,
  };
}
