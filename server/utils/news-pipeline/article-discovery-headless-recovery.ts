import { prisma } from "../prisma";
import { logAgentScan } from "./log";

const RECOVERY_DEFAULT_LIMIT = 10;
const RECOVERY_MAX_LIMIT = 50;
const RECOVERY_DEFAULT_TIME_BUDGET_MS = 5_000;
const RECOVERY_MAX_TIME_BUDGET_MS = 30_000;

type RecoveryInput = {
  /** Legacy API compatibility; scalar claim expiry is authoritative. */
  olderThanMinutes?: number;
  limit?: number;
  mode?: "retry" | "fail";
  now?: Date;
  timeBudgetMs?: number;
  clock?: () => number;
  db?: HeadlessRecoveryDb;
  log?: typeof logAgentScan;
};

export type HeadlessRecoveryDb = {
  pipelineArtifact: {
    findMany(args: Record<string, unknown>): Promise<Array<Record<string, any>>>;
    updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
};

export type HeadlessClaimRecoveryResult = {
  inspected: number;
  staleFound: number;
  recovered: number;
  failedStale: number;
  skippedAlreadyChanged: number;
  malformed: number;
  failed: number;
  timeBudgetExhausted: boolean;
  artifactIds: string[];
};

/** Recover only claims whose exact persisted token and expiry still match. */
export async function recoverStaleArticleDiscoveryHeadlessProcessing(
  input?: RecoveryInput,
): Promise<HeadlessClaimRecoveryResult> {
  const limit = Math.min(Math.max(input?.limit ?? RECOVERY_DEFAULT_LIMIT, 1), RECOVERY_MAX_LIMIT);
  const mode = input?.mode ?? "retry";
  const clock = input?.clock ?? Date.now;
  const db = input?.db ?? (prisma as unknown as HeadlessRecoveryDb);
  const recoveryLog = input?.log ?? logAgentScan;
  const startedAt = clock();
  const recoveryNow = input?.now ?? new Date();
  const requestedTimeBudget = input?.timeBudgetMs ?? RECOVERY_DEFAULT_TIME_BUDGET_MS;
  const timeBudgetMs = Number.isFinite(requestedTimeBudget)
    ? Math.max(1, Math.min(Math.floor(requestedTimeBudget), RECOVERY_MAX_TIME_BUDGET_MS))
    : RECOVERY_DEFAULT_TIME_BUDGET_MS;

  await recoveryLog({
    status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_STARTED",
    executionTimeMs: 0,
    errorLog: `Headless recovery started. limit=${limit}, timeBudgetMs=${timeBudgetMs}, mode=${mode}, expiryCutoff=${recoveryNow.toISOString()}.`,
  });

  let inspected = 0;
  let staleFound = 0;
  let recovered = 0;
  let failedStale = 0;
  let skippedAlreadyChanged = 0;
  let malformed = 0;
  let failed = 0;
  let timeBudgetExhausted = false;
  const artifactIds: string[] = [];

  try {
    const expiredArtifacts = await db.pipelineArtifact.findMany({
      where: {
        artifactType: "article_discovery_headless_required",
        status: "HEADLESS_PROCESSING",
        headlessClaimToken: { not: null },
        headlessClaimExpiresAt: { lte: recoveryNow },
      },
      orderBy: [{ headlessClaimExpiresAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        headlessClaimToken: true,
        headlessClaimExpiresAt: true,
        payload: true,
      },
    });
    const malformedArtifacts = await db.pipelineArtifact.findMany({
      where: {
        artifactType: "article_discovery_headless_required",
        status: "HEADLESS_PROCESSING",
        OR: [{ headlessClaimToken: null }, { headlessClaimExpiresAt: null }],
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: Math.min(limit, 20),
      select: {
        id: true,
        headlessClaimToken: true,
        headlessClaimExpiresAt: true,
      },
    });
    const actualMalformed = malformedArtifacts.filter(
      (artifact) => !artifact.headlessClaimToken || !artifact.headlessClaimExpiresAt,
    );
    inspected = expiredArtifacts.length + actualMalformed.length;
    malformed = actualMalformed.length;
    const recoveryTimestamp = recoveryNow.toISOString();
    let processedExpired = 0;

    for (const artifact of expiredArtifacts) {
      if (clock() - startedAt >= timeBudgetMs) {
        timeBudgetExhausted = true;
        break;
      }
      if (!artifact.headlessClaimToken || !(artifact.headlessClaimExpiresAt instanceof Date)) {
        malformed += 1;
        continue;
      }
      if (artifact.headlessClaimExpiresAt > recoveryNow) continue;
      staleFound += 1;
      if (processedExpired >= limit) continue;
      processedExpired += 1;
      const payload = (artifact.payload as Record<string, unknown>) || {};
      try {
        const { count } = await db.pipelineArtifact.updateMany({
          where: {
            id: artifact.id,
            artifactType: "article_discovery_headless_required",
            status: "HEADLESS_PROCESSING",
            headlessClaimToken: artifact.headlessClaimToken,
            headlessClaimExpiresAt: artifact.headlessClaimExpiresAt,
          },
          data: {
            status: mode === "retry" ? "PENDING_HEADLESS" : "HEADLESS_PROCESSING_STALE",
            headlessClaimToken: null,
            headlessClaimExpiresAt: null,
            errorLog:
              mode === "retry"
                ? "Expired headless claim recovered and reset to PENDING_HEADLESS for retry."
                : "Expired headless claim marked HEADLESS_PROCESSING_STALE for manual review.",
            payload: {
              ...payload,
              headlessRecoveryCount: ((payload.headlessRecoveryCount as number) || 0) + 1,
              lastHeadlessRecoveryAt: recoveryTimestamp,
            },
          },
        });
        if (count === 0) {
          skippedAlreadyChanged += 1;
        } else if (mode === "retry") {
          recovered += 1;
          artifactIds.push(artifact.id);
        } else {
          failedStale += 1;
          artifactIds.push(artifact.id);
        }
      } catch {
        failed += 1;
      }
    }
  } catch {
    failed += 1;
    await recoveryLog({
      status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_FAILED",
      executionTimeMs: clock() - startedAt,
      errorLog: "Headless recovery persistence failed; no recovery was claimed.",
    });
  }

  await recoveryLog({
    status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_FINISHED",
    executionTimeMs: clock() - startedAt,
    errorLog: `Headless recovery complete. inspected=${inspected}, staleFound=${staleFound}, recovered=${recovered}, failedStale=${failedStale}, conflicted=${skippedAlreadyChanged}, malformed=${malformed}, failed=${failed}, timeBudgetExhausted=${timeBudgetExhausted}, mode=${mode}.`,
  });

  return {
    inspected,
    staleFound,
    recovered,
    failedStale,
    skippedAlreadyChanged,
    malformed,
    failed,
    timeBudgetExhausted,
    artifactIds,
  };
}
