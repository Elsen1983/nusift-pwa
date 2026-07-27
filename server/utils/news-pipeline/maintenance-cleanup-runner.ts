/**
 * Maintenance cleanup runner for cron execution.
 *
 * Calls the existing article retention and pipeline artifact cleanup utilities
 * in bounded, time-budgeted batches. Designed for /api/internal/cleanup-maintenance
 * which is protected by CRON_SECRET (not admin session auth).
 *
 * Safety:
 *   - Each batch calls a bounded cleanup utility with a per-batch limit.
 *   - A total time budget prevents exceeding Vercel function timeouts.
 *   - Loops stop when no more eligible rows remain, no progress is made,
 *     or time budget is nearly exhausted.
 *   - Pipeline artifacts run first (cheaper/safer diagnostic leftovers),
 *     then articles.
 *
 * No raw payloads or candidate arrays are included in the result.
 */

import { processPipelineArtifactCleanup } from "./pipeline-artifact-cleanup";
import { processOldArticleRetentionCleanup } from "./article-retention-cleanup";
import { logAgentScan } from "./log";

// ─── Types ──────────────────────────────────────────────────────────────────

export type MaintenanceCleanupInput = {
  articleOlderThanDays?: number;
  articleBatchLimit?: number;
  artifactOlderThanDays?: number;
  artifactBatchLimit?: number;
  timeBudgetMs?: number;
  minRemainingMs?: number;
  now?: Date;
  runArticles?: boolean;
  runPipelineArtifacts?: boolean;
};

type PhaseStopReason = "complete" | "time_budget" | "no_progress" | "disabled" | "error" | "skipped_after_error";

export type MaintenanceCleanupResult = {
  ok: true;
  dryRun: false;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timeBudgetMs: number;
  minRemainingMs: number;
  stoppedReason:
    | "complete"
    | "time_budget"
    | "no_progress"
    | "pipeline_artifacts_disabled"
    | "error";
  pipelineArtifacts: {
    enabled: boolean;
    batches: number;
    inspected: number;
    eligibleForDeletion: number;
    deleted: number;
    protected: number;
    skipped: number;
    stoppedReason: PhaseStopReason;
    byStatus: Record<string, number>;
    byArtifactType: Record<string, number>;
    protectedReasons: Record<string, number>;
    skippedReasons: Record<string, number>;
  };
  articles: {
    enabled: boolean;
    batches: number;
    inspected: number;
    eligibleForDeletion: number;
    deleted: number;
    protected: number;
    skipped: number;
    stoppedReason: PhaseStopReason;
    bySource: Array<{ sourceId: string | null; count: number }>;
    protectedReasons: Record<string, number>;
    skippedReasons: Record<string, number>;
  };
  errors: Array<{
    phase: "pipelineArtifacts" | "articles";
    message: string;
  }>;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_ARTICLE_OLDER_THAN_DAYS = 7;
const DEFAULT_ARTICLE_BATCH_LIMIT = 500;
const DEFAULT_ARTIFACT_OLDER_THAN_DAYS = 14;
const DEFAULT_ARTIFACT_BATCH_LIMIT = 1000;
const DEFAULT_TIME_BUDGET_MS = 45_000;
const DEFAULT_MIN_REMAINING_MS = 5_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null || typeof value === "boolean") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function mergeRecord(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [key, count] of Object.entries(source)) {
    target[key] = (target[key] || 0) + count;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function runMaintenanceCleanup(
  input?: MaintenanceCleanupInput,
): Promise<MaintenanceCleanupResult> {
  const runPipelineArtifacts = input?.runPipelineArtifacts !== false;
  const runArticles = input?.runArticles !== false;
  const articleOlderThanDays = clampInt(
    input?.articleOlderThanDays,
    DEFAULT_ARTICLE_OLDER_THAN_DAYS,
    1,
    365,
  );
  const articleBatchLimit = clampInt(
    input?.articleBatchLimit,
    DEFAULT_ARTICLE_BATCH_LIMIT,
    1,
    1000,
  );
  const artifactOlderThanDays = clampInt(
    input?.artifactOlderThanDays,
    DEFAULT_ARTIFACT_OLDER_THAN_DAYS,
    1,
    365,
  );
  const artifactBatchLimit = clampInt(
    input?.artifactBatchLimit,
    DEFAULT_ARTIFACT_BATCH_LIMIT,
    1,
    2000,
  );
  const timeBudgetMs = clampInt(
    input?.timeBudgetMs,
    DEFAULT_TIME_BUDGET_MS,
    5_000,
    120_000,
  );
  const minRemainingMs = clampInt(
    input?.minRemainingMs,
    DEFAULT_MIN_REMAINING_MS,
    1_000,
    30_000,
  );
  const now = input?.now ?? new Date();

  const startedAt = new Date();
  const startMs = Date.now();

  await logAgentScan({
    status: "MAINTENANCE_CLEANUP_STARTED",
    executionTimeMs: 0,
    errorLog:
      `Maintenance cleanup started. ` +
      `runPipelineArtifacts=${runPipelineArtifacts}, runArticles=${runArticles}, ` +
      `artifactOlderThanDays=${artifactOlderThanDays}, artifactBatchLimit=${artifactBatchLimit}, ` +
      `articleOlderThanDays=${articleOlderThanDays}, articleBatchLimit=${articleBatchLimit}, ` +
      `timeBudgetMs=${timeBudgetMs}, minRemainingMs=${minRemainingMs}.`,
  }).catch(() => {});

  const errors: MaintenanceCleanupResult["errors"] = [];

  const artifactState = {
    enabled: runPipelineArtifacts,
    batches: 0,
    inspected: 0,
    eligibleForDeletion: 0,
    deleted: 0,
    protected: 0,
    skipped: 0,
    stoppedReason: (runPipelineArtifacts ? "complete" : "disabled") as PhaseStopReason,
    byStatus: {} as Record<string, number>,
    byArtifactType: {} as Record<string, number>,
    protectedReasons: {} as Record<string, number>,
    skippedReasons: {} as Record<string, number>,
  };

  const articleState = {
    enabled: runArticles,
    batches: 0,
    inspected: 0,
    eligibleForDeletion: 0,
    deleted: 0,
    protected: 0,
    skipped: 0,
    stoppedReason: (runArticles ? "complete" : "disabled") as PhaseStopReason,
    bySourceMap: new Map<string | null, number>(),
    protectedReasons: {} as Record<string, number>,
    skippedReasons: {} as Record<string, number>,
  };

  // ── Phase 1: Pipeline artifacts (runs first — cheaper/safer) ──────────
  if (runPipelineArtifacts) {
    try {
      while (true) {
        const elapsed = Date.now() - startMs;
        if (timeBudgetMs - elapsed < minRemainingMs) {
          artifactState.stoppedReason = "time_budget";
          break;
        }

        const result = await processPipelineArtifactCleanup({
          dryRun: false,
          olderThanDays: artifactOlderThanDays,
          limit: artifactBatchLimit,
          now,
        });

        artifactState.batches += 1;
        artifactState.inspected += result.inspected;
        artifactState.eligibleForDeletion += result.eligibleForDeletion;
        artifactState.deleted += result.deleted;
        artifactState.protected += result.protected;
        artifactState.skipped += result.skipped;
        mergeRecord(artifactState.byStatus, result.byStatus);
        mergeRecord(artifactState.byArtifactType, result.byArtifactType);
        mergeRecord(artifactState.protectedReasons, result.protectedReasons);
        mergeRecord(artifactState.skippedReasons, result.skippedReasons);

        // Stop conditions
        if (result.eligibleForDeletion === 0) {
          artifactState.stoppedReason = "complete";
          break;
        }
        if (result.deleted === 0 && result.eligibleForDeletion > 0) {
          artifactState.stoppedReason = "no_progress";
          break;
        }
      }
    } catch (err: any) {
      artifactState.stoppedReason = "error";
      errors.push({
        phase: "pipelineArtifacts",
        message: err?.message || String(err),
      });
    }
  }

  // ── Phase 2: Articles ─────────────────────────────────────────────────
  // Fail-fast: skip articles phase if artifact phase had an error.
  if (runArticles && errors.length > 0) {
    articleState.stoppedReason = "skipped_after_error";
  }
  if (runArticles && errors.length === 0) {
    try {
      while (true) {
        const elapsed = Date.now() - startMs;
        if (timeBudgetMs - elapsed < minRemainingMs) {
          articleState.stoppedReason = "time_budget";
          break;
        }

        const result = await processOldArticleRetentionCleanup({
          dryRun: false,
          olderThanDays: articleOlderThanDays,
          limit: articleBatchLimit,
          now,
        });

        articleState.batches += 1;
        articleState.inspected += result.inspected;
        articleState.eligibleForDeletion += result.eligibleForDeletion;
        articleState.deleted += result.deleted;
        articleState.protected += result.protected;
        articleState.skipped += result.skipped;
        mergeRecord(articleState.protectedReasons, result.protectedReasons);
        mergeRecord(articleState.skippedReasons, result.skippedReasons);

        // Aggregate bySource
        for (const entry of result.bySource) {
          const key = entry.sourceId;
          articleState.bySourceMap.set(key, (articleState.bySourceMap.get(key) || 0) + entry.count);
        }

        // Stop conditions
        if (result.eligibleForDeletion === 0) {
          articleState.stoppedReason = "complete";
          break;
        }
        if (result.deleted === 0 && result.eligibleForDeletion > 0) {
          articleState.stoppedReason = "no_progress";
          break;
        }
      }
    } catch (err: any) {
      articleState.stoppedReason = "error";
      errors.push({
        phase: "articles",
        message: err?.message || String(err),
      });
    }
  }

  // ── Build final result ────────────────────────────────────────────────
  const finishedAt = new Date();
  const durationMs = Date.now() - startMs;

  // Aggregate bySource → top 10
  const bySource = [...articleState.bySourceMap.entries()]
    .map(([sourceId, count]) => ({ sourceId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Determine overall stoppedReason
  let stoppedReason: MaintenanceCleanupResult["stoppedReason"];
  if (errors.length > 0) {
    stoppedReason = "error";
  } else if (!runPipelineArtifacts && !runArticles) {
    stoppedReason = "complete"; // nothing to do
  } else if (artifactState.stoppedReason === "time_budget" || articleState.stoppedReason === "time_budget") {
    stoppedReason = "time_budget";
  } else if (artifactState.stoppedReason === "no_progress" || articleState.stoppedReason === "no_progress") {
    stoppedReason = "no_progress";
  } else {
    stoppedReason = "complete";
  }

  const result: MaintenanceCleanupResult = {
    ok: true,
    dryRun: false,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    timeBudgetMs,
    minRemainingMs,
    stoppedReason,
    pipelineArtifacts: {
      enabled: artifactState.enabled,
      batches: artifactState.batches,
      inspected: artifactState.inspected,
      eligibleForDeletion: artifactState.eligibleForDeletion,
      deleted: artifactState.deleted,
      protected: artifactState.protected,
      skipped: artifactState.skipped,
      stoppedReason: artifactState.stoppedReason,
      byStatus: artifactState.byStatus,
      byArtifactType: artifactState.byArtifactType,
      protectedReasons: artifactState.protectedReasons,
      skippedReasons: artifactState.skippedReasons,
    },
    articles: {
      enabled: articleState.enabled,
      batches: articleState.batches,
      inspected: articleState.inspected,
      eligibleForDeletion: articleState.eligibleForDeletion,
      deleted: articleState.deleted,
      protected: articleState.protected,
      skipped: articleState.skipped,
      stoppedReason: articleState.stoppedReason,
      bySource,
      protectedReasons: articleState.protectedReasons,
      skippedReasons: articleState.skippedReasons,
    },
    errors,
  };

  const overallStatus = errors.length > 0 ? "MAINTENANCE_CLEANUP_FAILED" : "MAINTENANCE_CLEANUP_FINISHED";
  await logAgentScan({
    status: overallStatus,
    executionTimeMs: durationMs,
    errorLog:
      `Maintenance cleanup ${errors.length > 0 ? "failed" : "finished"}. ` +
      `durationMs=${durationMs}, stoppedReason=${stoppedReason}. ` +
      `pipelineArtifacts: batches=${artifactState.batches}, deleted=${artifactState.deleted}, ` +
      `stopped=${artifactState.stoppedReason}. ` +
      `articles: batches=${articleState.batches}, deleted=${articleState.deleted}, ` +
      `stopped=${articleState.stoppedReason}.` +
      (errors.length > 0 ? ` errors=${errors.map((e) => `${e.phase}: ${e.message}`).join("; ")}` : ""),
  }).catch(() => {});

  return result;
}
