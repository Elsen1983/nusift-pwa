import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import {
  createPipelineRun,
  finalizePipelineRun,
  persistAgent1TargetOutcomeArtifact,
  persistHardCaseDiscoveryArtifacts,
  persistPipelineArtifact,
} from "./artifacts";
import { logAgentScan } from "./log";
import { ingestSource, persistCandidates } from "./ingest";
import { markFeedRunOutcome } from "./feed-productivity";
import { runArticleDiscoveryBatch } from "./article-discovery";
import {
  resolveActivePipelineTargets,
  hydratePipelineTargets,
} from "./targets";
import type { IngestDeferredReason, PipelineResult, PipelineTarget } from "./types";
import { isIngestResultDeferred } from "./ingest-defer";
import { readBoundedNumber } from "./parse-bounded-number";
import {
  createNoopStageBatchProbe,
  type StageBatchProbe,
} from "./stage-telemetry";
import { boundedPipelineItemError, isUnsafePipelineInvariantError } from "./item-failure";
import { persistRunTargetManifest } from "./run-funnel";

export type RunNewsPipelineOptions = {
  /**
   * When true, run Agent 2 article discovery batch after Agent 1 completes.
   * Default: false. Admin/cron endpoints run Agent 1 only by default.
   * User-facing flows also run A1 only; Agent 2 picks up eligible targets
   * on the next scheduled batch.
   */
  runAgent2Afterwards?: boolean;
};

export const shouldTrackFeedProductivity = (result: {
  feedUrl?: string | null;
  feedFormat?: string | null;
  deferredReason?: string | null;
}) =>
  !result.deferredReason &&
  Boolean(result.feedUrl) &&
  result.feedFormat !== "html_fallback";

/**
 * Legacy full-pipeline entry point.
 *
 * **Prefer `runAgent1Batch` for admin and cron flows.** This function runs
 * all resolved targets without a time budget or max-targets guard and is
 * retained only for backward-compatible user-facing flows (e.g. add-source
 * that needs an immediate unbounded ingest). It does NOT run Agent 2 unless
 * `options.runAgent2Afterwards` is explicitly true.
 *
 * Agent 2 is a separate pipeline — use `runArticleDiscoveryBatch` or the
 * Agent 2 endpoint directly. Do not couple Agent 2 execution to Agent 1.
 */
export async function runNewsPipeline(
  sourceIds?: string[],
  categoryIds?: string[],
  options?: RunNewsPipelineOptions,
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const hasTargetFilters =
    (sourceIds && sourceIds.length > 0) || (categoryIds && categoryIds.length > 0);
  const resolvedTargets = hasTargetFilters
    ? await hydratePipelineTargets(sourceIds || [], categoryIds || [])
    : await resolveActivePipelineTargets();

  let candidatesFound = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let deferred = 0;
  let artifactCount = 0;
  const sameInvocationStatic429Hostnames = new Set<string>();
  const pipelineRun = await createPipelineRun(resolvedTargets.length);

  await logAgentScan({
    status: "PIPELINE_STARTED",
    executionTimeMs: 0,
    errorLog: `Pipeline started for ${resolvedTargets.length} target(s). runId=${pipelineRun.id}.`,
  });

  for (const target of resolvedTargets) {
    try {
      const result = await ingestSource(
        target.sourceId,
        target.categoryId || undefined,
        undefined,
        pipelineRun.id,
        { static429Hostnames: sameInvocationStatic429Hostnames },
      );
      candidatesFound += result.candidates.length;
      await persistPipelineArtifact({
        pipelineRunId: pipelineRun.id,
        result,
      });
      artifactCount += 1;
      const hardCaseArtifactCount = await persistHardCaseDiscoveryArtifacts({
        pipelineRunId: pipelineRun.id,
        result,
      });
      artifactCount += hardCaseArtifactCount;
      if (hardCaseArtifactCount > 0) {
        await logAgentScan({
          sourceId: target.sourceId,
          categoryId: target.categoryId || undefined,
          status: "HARD_CASE_DISCOVERY_QUEUED",
          executionTimeMs: 0,
          errorLog: `Queued ${hardCaseArtifactCount} hard-case discovery target(s) for later headless processing. runId=${pipelineRun.id}.`,
        });
      }
      const persisted = await persistCandidates(result.candidates);
      inserted += persisted.inserted;
      skipped += persisted.skipped;
      failed += persisted.failed + result.failed;
      await persistAgent1TargetOutcomeArtifact({
        pipelineRunId: pipelineRun.id,
        result,
        persisted,
      });
      artifactCount += 1;
      if (isIngestResultDeferred(result) && persisted.failed === 0) deferred += 1;
      // Deferred outcomes are neutral retry boundaries. They must not mutate
      // publisher productivity state or be recorded as unproductive results.
      if (!result.deferredReason) {
        await markFeedRunOutcome({
          sourceId: target.sourceId,
          categoryId: target.categoryId || undefined,
          feedUrl: result.feedUrl || null,
          feedRunOutcomeKind: result.feedRunOutcomeKind,
          shouldTrackFeedProductivity: shouldTrackFeedProductivity(result),
        });
      }
    } catch {
      failed += 1;
    }
  }

  const result: PipelineResult = {
    sourcesScanned: resolvedTargets.length,
    candidatesFound,
    inserted,
    skipped,
    failed,
    deferred,
    artifactCount,
  };

  await finalizePipelineRun({
    pipelineRunId: pipelineRun.id,
    result,
  });

  await logAgentScan({
    status: "PIPELINE_FINISHED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Pipeline finished. runId=${pipelineRun.id}, targets=${resolvedTargets.length}, candidates=${candidatesFound}, inserted=${inserted}, skipped=${skipped}, failed=${failed}, deferred=${deferred}, artifacts=${artifactCount}.`,
  });

  // ── Agent 2: web discovery for eligible no-RSS / not-productive targets ──
  // Only runs when explicitly requested via runAgent2Afterwards option.
  // No user-facing flow currently passes true. Agent 2 picks up eligible
  // targets on the next scheduled cron batch.
  if (options?.runAgent2Afterwards) {
    try {
      await runArticleDiscoveryBatch(
        hasTargetFilters ? { sourceIds: sourceIds || [], categoryIds: categoryIds || [] } : undefined,
      );
    } catch (error: any) {
      await logAgentScan({
        status: "ARTICLE_DISCOVERY_FAILED",
        executionTimeMs: 0,
        errorLog: `Agent 2 orchestration skipped: ${error?.message || String(error)}`,
      }).catch(() => {});
    }
  }

  return result;
}

// ─── Agent 1 Bounded Batch ──────────────────────────────────────────────────

export type Agent1BatchStoppedReason =
  | "completed"
  | "max_targets"
  | "time_budget"
  | "no_targets";

export type Agent1BatchResult = {
  pipelineRunId: string | null;
  targetsResolved: number;
  processed: number;
  deferred: number;
  remainingEligible: number;
  stoppedReason: Agent1BatchStoppedReason;
  durationMs: number;
  result: {
    candidates: number;
    inserted: number;
    skipped: number;
    failed: number;
    deferred: number;
    artifactCount: number;
  };
  /** Selected target disposition counts; these are the Agent 1 telemetry source of truth. */
  targetDispositions: {
    succeeded: number;
    failedRetryable: number;
    failedPermanent: number;
    skipped: number;
    deferred: number;
    quarantined: number;
    persistenceFailed: number;
  };
  selectedTargets: number;
  /** Article-level productivity, intentionally separate from target dispositions. */
  productivity: {
    candidateArticlesFound: number;
    articlesInserted: number;
    articlesSkipped: number;
    articlePersistenceFailures: number;
  };
  deferredTargets: Array<{
    sourceId: string;
    categoryId: string | null;
    reason: "max_targets" | "time_budget" | IngestDeferredReason;
  }>;
};

const readPayloadRecord = (payload: Prisma.JsonValue | null): Record<string, unknown> | null =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;

const agent1TargetKey = (target: Pick<PipelineTarget, "sourceId" | "categoryId">) =>
  `${target.sourceId}|${target.categoryId || ""}`;

async function getLatestAgent1DeferredTargetPriority(input?: {
  sourceIds?: string[];
  categoryIds?: string[];
}): Promise<string[]> {
  const latestRun = await prisma.pipelineRun.findFirst({
    where: {
      status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] },
      artifacts: {
        some: {
          artifactType: { in: ["agent1_target_outcome", "agent1_deferred"] },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (!latestRun) return [];

  const sourceFilter = input?.sourceIds && input.sourceIds.length > 0
    ? { in: input.sourceIds }
    : undefined;
  const categoryFilter = input?.categoryIds && input.categoryIds.length > 0
    ? { in: input.categoryIds }
    : undefined;

  const deferredArtifacts = await prisma.pipelineArtifact.findMany({
    where: {
      pipelineRunId: latestRun.id,
      artifactType: "agent1_deferred",
      status: { in: ["DEFERRED_MAX_TARGETS", "DEFERRED_TIME_BUDGET"] },
      ...(sourceFilter ? { sourceId: sourceFilter } : {}),
      ...(categoryFilter ? { categoryId: categoryFilter } : {}),
    },
    select: {
      sourceId: true,
      categoryId: true,
      payload: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  return deferredArtifacts
    .map((artifact) => {
      if (!artifact.sourceId) return null;
      const payload = readPayloadRecord(artifact.payload);
      const position = typeof payload?.position === "number" && Number.isFinite(payload.position)
        ? payload.position
        : Number.MAX_SAFE_INTEGER;
      return {
        key: agent1TargetKey({
          sourceId: artifact.sourceId,
          categoryId: artifact.categoryId,
        }),
        position,
      };
    })
    .filter((entry): entry is { key: string; position: number } => Boolean(entry))
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.key);
}

async function selectAgent1BatchTargets(
  targets: PipelineTarget[],
  input?: { sourceIds?: string[]; categoryIds?: string[] },
): Promise<PipelineTarget[]> {
  let deferredPriority: string[] = [];
  try {
    deferredPriority = await getLatestAgent1DeferredTargetPriority(input);
  } catch {
    return targets;
  }
  if (deferredPriority.length === 0) return targets;

  const priorityByKey = new Map(deferredPriority.map((key, index) => [key, index]));
  const deferredTargets = targets
    .filter((target) => priorityByKey.has(agent1TargetKey(target)))
    .sort((a, b) => {
      const aPriority = priorityByKey.get(agent1TargetKey(a)) ?? Number.MAX_SAFE_INTEGER;
      const bPriority = priorityByKey.get(agent1TargetKey(b)) ?? Number.MAX_SAFE_INTEGER;
      return aPriority - bPriority;
    });
  if (deferredTargets.length === 0) return targets;

  // A bounded batch is a durable cycle. Do not append a new cycle behind its
  // unfinished targets, otherwise every invocation re-defers work forever.
  return deferredTargets;
}

/**
 * Resolve eligible Agent 1 targets (RSS ingest targets).
 *
 * Returns all active pipeline targets. Agent 1 targets are all subscribed
 * sources/categories — unlike Agent 2, there is no eligibility filtering
 * beyond subscription status.
 */
export async function resolveAgent1Targets(input?: {
  sourceIds?: string[];
  categoryIds?: string[];
}): Promise<{ targets: PipelineTarget[] }> {
  const hasTargetFilters =
    (input?.sourceIds && input.sourceIds.length > 0) ||
    (input?.categoryIds && input.categoryIds.length > 0);
  const targets = hasTargetFilters
    ? await hydratePipelineTargets(input?.sourceIds || [], input?.categoryIds || [])
    : await resolveActivePipelineTargets();

  return { targets };
}

/**
 * Run a bounded Agent 1 RSS ingest batch.
 *
 * Processes targets sequentially with time-budget and max-targets guards.
 * Mirrors the Agent 2 batch pattern (runArticleDiscoveryBatch).
 *
 * Never runs Agent 2 automatically.
 */
export async function runAgent1Batch(input?: {
  sourceIds?: string[];
  categoryIds?: string[];
  maxTargets?: number;
  timeBudgetMs?: number;
  minRemainingMs?: number;
  /** Explicit admin-only reprocessing of terminal redirect URLs. */
  bypassRedirectTerminal?: boolean;
  /** Operation-level stage telemetry probe (optional, no-op by default). */
  telemetry?: StageBatchProbe;
  /** Daily workflow correlation; never replaces the owning batch run ID. */
  orchestrationRunId?: string | null;
}): Promise<Agent1BatchResult> {
  const probe = input?.telemetry ?? createNoopStageBatchProbe();
  const maxTargets = readBoundedNumber(input?.maxTargets, 5, 1, 50);
  const timeBudgetMs = readBoundedNumber(input?.timeBudgetMs, 240_000, 10_000, 600_000);
  const minRemainingMs = readBoundedNumber(input?.minRemainingMs, 30_000, 5_000, 120_000);

  const startedAt = Date.now();
  const { targets } = await resolveAgent1Targets(input);
  const resolvedTargets = await selectAgent1BatchTargets(targets, input);

  if (resolvedTargets.length === 0) {
    await logAgentScan({
      status: "A1_BATCH_STOPPED",
      executionTimeMs: Date.now() - startedAt,
      errorLog: `stoppedReason=no_targets, eligible=0, elapsed=${Date.now() - startedAt}ms`,
    });
    return {
      pipelineRunId: null,
      targetsResolved: 0,
      processed: 0,
      deferred: 0,
      remainingEligible: 0,
      stoppedReason: "no_targets",
      durationMs: Date.now() - startedAt,
      result: { candidates: 0, inserted: 0, skipped: 0, failed: 0, deferred: 0, artifactCount: 0 },
      targetDispositions: {
        succeeded: 0, failedRetryable: 0, failedPermanent: 0, skipped: 0,
        deferred: 0, quarantined: 0, persistenceFailed: 0,
      },
      selectedTargets: 0,
      productivity: {
        candidateArticlesFound: 0, articlesInserted: 0, articlesSkipped: 0,
        articlePersistenceFailures: 0,
      },
      deferredTargets: [],
    };
  }

  const sameInvocationStatic429Hostnames = new Set<string>();
  const pipelineRun = await createPipelineRun(Math.min(resolvedTargets.length, maxTargets));
  if (input?.orchestrationRunId) {
    await persistRunTargetManifest({
      pipelineRunId: pipelineRun.id,
      orchestrationRunId: input.orchestrationRunId,
      stage: "agent1",
      targets: resolvedTargets.slice(0, maxTargets).map((target) => ({
        sourceId: target.sourceId,
        categoryId: target.categoryId ?? null,
        disposition: "selected" as const,
      })),
    }).catch(() => undefined);
  }

  await logAgentScan({
    status: "A1_BATCH_STARTED",
    executionTimeMs: 0,
    errorLog: `Agent 1 batch started for ${resolvedTargets.length} target(s). runId=${pipelineRun.id}. maxTargets=${maxTargets}, timeBudgetMs=${timeBudgetMs}, minRemainingMs=${minRemainingMs}.`,
  });

  let candidatesFound = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let artifactCount = 0;
  let processed = 0;
  let targetSucceeded = 0;
  let targetFailedRetryable = 0;
  let targetDeferred = 0;
  let targetPersistenceFailed = 0;
  const processedDeferredTargets: Agent1BatchResult["deferredTargets"] = [];
  let stoppedReason: Agent1BatchStoppedReason = "completed";

  for (let i = 0; i < resolvedTargets.length; i++) {
    const target = resolvedTargets[i]!;

    // ── Budget guard: check before starting each target ──
    if (processed >= maxTargets) {
      stoppedReason = "max_targets";
      break;
    }

    const elapsed = Date.now() - startedAt;
    const remaining = timeBudgetMs - elapsed;
    if (remaining < minRemainingMs) {
      stoppedReason = "time_budget";
      break;
    }
    const targetStartedAt = Date.now();
    let ingestCompleted = false;
    let targetDisposition: "succeeded" | "failedRetryable" | "deferred" | "persistenceFailed" = "failedRetryable";
    let targetDeferredReason: IngestDeferredReason | null = null;
    try {
      await logAgentScan({
        sourceId: target.sourceId,
        categoryId: target.categoryId || undefined,
        status: "A1_TARGET_STARTED",
        executionTimeMs: 0,
        errorLog: `Agent 1 target started. runId=${pipelineRun.id}, position=${i + 1}/${resolvedTargets.length}.`,
      });

      // Preserve the legacy two-argument call shape when no telemetry probe
      // was supplied. Production workflow runs pass the probe explicitly; old
      // callers and mocks remain behaviorally/API compatible.
      const result = input?.bypassRedirectTerminal
        ? await ingestSource(target.sourceId, target.categoryId || undefined, input?.telemetry ? probe : undefined, pipelineRun.id, {
            bypassRedirectTerminal: true,
            static429Hostnames: sameInvocationStatic429Hostnames,
          })
        : input?.telemetry
          ? await ingestSource(target.sourceId, target.categoryId || undefined, probe, pipelineRun.id, {
              static429Hostnames: sameInvocationStatic429Hostnames,
            })
          : await ingestSource(target.sourceId, target.categoryId || undefined, undefined, pipelineRun.id, {
              static429Hostnames: sameInvocationStatic429Hostnames,
            });
      ingestCompleted = true;
      targetDeferredReason = isIngestResultDeferred(result)
        ? result.deferredReason!
        : null;
      targetDisposition = targetDeferredReason
        ? "deferred"
        : result.failed > 0
          ? "failedRetryable"
          : "succeeded";
      if (result.deferredReason === "rate_limited") {
        // Only confirmed publisher HTTP 429 outcomes enter rate-limit telemetry.
        probe.recordRateLimited(429);
      }
      candidatesFound += result.candidates.length;
      await probe.timed("persistence", () => persistPipelineArtifact({
        pipelineRunId: pipelineRun.id,
        orchestrationRunId: input?.orchestrationRunId,
        result,
      }));
      probe.recordDbOperation();
      artifactCount += 1;
      const hardCaseArtifactCount = await probe.timed("persistence", () => persistHardCaseDiscoveryArtifacts({
        pipelineRunId: pipelineRun.id,
        orchestrationRunId: input?.orchestrationRunId,
        result,
      }));
      probe.recordDbOperation();
      artifactCount += hardCaseArtifactCount;
      if (hardCaseArtifactCount > 0) {
        await logAgentScan({
          sourceId: target.sourceId,
          categoryId: target.categoryId || undefined,
          status: "HARD_CASE_DISCOVERY_QUEUED",
          executionTimeMs: 0,
          errorLog: `Queued ${hardCaseArtifactCount} hard-case discovery target(s) for later headless processing. runId=${pipelineRun.id}.`,
        });
      }
      const persisted = await probe.timed("persistence", () => persistCandidates(result.candidates));
      probe.recordDbOperation();
      inserted += persisted.inserted;
      skipped += persisted.skipped;
      failed += persisted.failed + result.failed;
      if (persisted.failed > 0) {
        targetDisposition = "persistenceFailed";
        targetDeferredReason = null;
      }
      await probe.timed("persistence", () => persistAgent1TargetOutcomeArtifact({
        pipelineRunId: pipelineRun.id,
        orchestrationRunId: input?.orchestrationRunId,
        result,
        persisted,
      }));
      probe.recordDbOperation();
      artifactCount += 1;
      if (!result.deferredReason) {
        await probe.timed("persistence", () => markFeedRunOutcome({
          sourceId: target.sourceId,
          categoryId: target.categoryId || undefined,
          feedUrl: result.feedUrl || null,
          feedRunOutcomeKind: result.feedRunOutcomeKind,
          shouldTrackFeedProductivity: shouldTrackFeedProductivity(result),
        }));
        probe.recordDbOperation();
      }
      processed += 1;
      if (targetDisposition === "succeeded") targetSucceeded += 1;
      else if (targetDisposition === "persistenceFailed") targetPersistenceFailed += 1;
      else if (targetDisposition === "deferred" && targetDeferredReason) {
        targetDeferred += 1;
        processedDeferredTargets.push({
          sourceId: target.sourceId,
          categoryId: target.categoryId ?? null,
          reason: targetDeferredReason,
        });
      }
      else targetFailedRetryable += 1;
      await logAgentScan({
        sourceId: target.sourceId,
        categoryId: target.categoryId || undefined,
        status: "A1_TARGET_FINISHED",
        executionTimeMs: Date.now() - targetStartedAt,
        errorLog: `Agent 1 target finished. runId=${pipelineRun.id}, position=${i + 1}/${resolvedTargets.length}, candidates=${result.candidates.length}, inserted=${persisted.inserted}, skipped=${persisted.skipped}, failed=${persisted.failed + result.failed}, deferredReason=${result.deferredReason || "none"}.`,
      });
    } catch (error: any) {
      if (isUnsafePipelineInvariantError(error)) throw error;
      failed += 1;
      if (ingestCompleted) targetPersistenceFailed += 1;
      else targetFailedRetryable += 1;
      processed += 1;
      await logAgentScan({
        sourceId: target.sourceId,
        categoryId: target.categoryId || undefined,
        status: "A1_TARGET_FAILED",
        executionTimeMs: Date.now() - targetStartedAt,
        errorLog: `Agent 1 target failed. runId=${pipelineRun.id}, position=${i + 1}/${resolvedTargets.length}, error=${boundedPipelineItemError(error)}.`,
      });
    }
  }

  // ── Deferred targets: persist audit artifacts ─────────────────────────
  const budgetDeferredTargets = resolvedTargets.slice(processed);
  const budgetDeferredCount = budgetDeferredTargets.length;
  const totalDeferred = targetDeferred + budgetDeferredCount;
  const elapsedMs = Date.now() - startedAt;

  if (budgetDeferredCount > 0) {
    const deferredStatus = stoppedReason === "max_targets"
      ? "DEFERRED_MAX_TARGETS"
      : "DEFERRED_TIME_BUDGET";

    await prisma.pipelineArtifact.createMany({
      data: budgetDeferredTargets.map((target, position) => ({
        pipelineRunId: pipelineRun.id,
        orchestrationRunId: input?.orchestrationRunId ?? null,
        sourceId: target.sourceId,
        categoryId: target.categoryId || null,
        artifactType: "agent1_deferred",
        status: deferredStatus,
        candidateCount: 0,
        payload: {
          schemaVersion: 1,
          artifactKind: "agent1_deferred_target",
          sourceId: target.sourceId,
          categoryId: target.categoryId || null,
          reason: stoppedReason,
          runId: pipelineRun.id,
          deferredAt: new Date().toISOString(),
          elapsedMs,
          timeBudgetMs,
          minRemainingMs,
          maxTargets,
          position,
          totalTargetsResolved: resolvedTargets.length,
        } satisfies Prisma.InputJsonValue,
        errorLog: `Deferred target ${target.sourceId}${target.categoryId ? `/${target.categoryId}` : ""}. reason=${stoppedReason}, position=${position + 1}/${budgetDeferredCount}.`,
      })),
    });
    probe.recordDbOperation();
    artifactCount += budgetDeferredCount;

    await logAgentScan({
      status: "A1_TARGETS_DEFERRED",
      executionTimeMs: elapsedMs,
      errorLog: `deferred=${budgetDeferredCount}, reason=${stoppedReason}, processed=${processed}, total=${resolvedTargets.length}, elapsed=${elapsedMs}ms.`,
    });
  }

  const result: PipelineResult = {
    sourcesScanned: processed,
    candidatesFound,
    inserted,
    skipped,
    failed,
    deferred: totalDeferred,
    artifactCount,
  };

  await finalizePipelineRun({
    pipelineRunId: pipelineRun.id,
    result,
  });

  const remainingEligible = budgetDeferredCount;

  await logAgentScan({
    status: stoppedReason === "completed" ? "A1_BATCH_FINISHED" : "A1_BATCH_STOPPED",
    executionTimeMs: elapsedMs,
    errorLog: `Agent 1 batch ${stoppedReason === "completed" ? "finished" : "stopped"}. runId=${pipelineRun.id}, ` +
      `targets=${resolvedTargets.length}, processed=${processed}, deferred=${totalDeferred}, ` +
      `candidates=${candidatesFound}, inserted=${inserted}, skipped=${skipped}, failed=${failed}, ` +
      `stoppedReason=${stoppedReason}, remainingEligible=${remainingEligible}, elapsed=${elapsedMs}ms.`,
  });

  return {
    pipelineRunId: pipelineRun.id,
    targetsResolved: resolvedTargets.length,
    processed,
    deferred: totalDeferred,
    remainingEligible,
    stoppedReason,
    durationMs: elapsedMs,
    result: {
      candidates: candidatesFound,
      inserted,
      skipped,
      failed,
      deferred: totalDeferred,
      artifactCount,
    },
    targetDispositions: {
      succeeded: targetSucceeded,
      failedRetryable: targetFailedRetryable,
      failedPermanent: 0,
      skipped: 0,
      deferred: totalDeferred,
      quarantined: 0,
      persistenceFailed: targetPersistenceFailed,
    },
    selectedTargets: resolvedTargets.length,
    productivity: {
      candidateArticlesFound: candidatesFound,
      articlesInserted: inserted,
      articlesSkipped: skipped,
      articlePersistenceFailures: targetPersistenceFailed,
    },
    deferredTargets: [
      ...processedDeferredTargets,
      ...budgetDeferredTargets.map((t) => ({
        sourceId: t.sourceId,
        categoryId: t.categoryId ?? null,
        reason: stoppedReason as "max_targets" | "time_budget",
      })),
    ],
  };
}

/**
 * Get compact Agent 1 progress state for admin UI.
 * Queries the latest A1 PipelineRun (identified by agent1_target_outcome artifacts)
 * and recent deferred artifacts.
 */
export async function getAgent1Progress(): Promise<{
  totalEligibleNow: number;
  latestRunId: string | null;
  latestRunStartedAt: string | null;
  latestRunFinishedAt: string | null;
  lastDurationMs: number | null;
  processedLastRun: number;
  deferredLastRun: number;
  remainingEligible: number;
  stoppedReason: string | null;
  recentDeferredTargets: Array<{
    sourceId: string | null;
    categoryId: string | null;
    reason: string;
    position: number;
    totalTargetsResolved: number;
  }>;
  lastRunAt: string | null;
}> {
  const { targets: currentTargets } = await resolveAgent1Targets();

  // Find latest completed Agent 1 PipelineRun by looking for agent1_target_outcome artifacts
  // in runs that finished successfully. This avoids returning stale/incomplete data from
  // a run that crashed partway through.
  const latestArtifact = await prisma.pipelineArtifact.findFirst({
    where: {
      artifactType: "agent1_target_outcome",
      pipelineRun: { status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] } },
    },
    select: { pipelineRunId: true },
    orderBy: { createdAt: "desc" },
  });

  if (!latestArtifact) {
    return {
      totalEligibleNow: currentTargets.length,
      latestRunId: null,
      latestRunStartedAt: null,
      latestRunFinishedAt: null,
      lastDurationMs: null,
      processedLastRun: 0,
      deferredLastRun: 0,
      remainingEligible: 0,
      stoppedReason: null,
      recentDeferredTargets: [],
      lastRunAt: null,
    };
  }

  const latestRun = await prisma.pipelineRun.findUnique({
    where: { id: latestArtifact.pipelineRunId },
 select: {
      id: true,
      startedAt: true,
      finishedAt: true,
      targetCount: true,
      candidatesFound: true,
      inserted: true,
      skipped: true,
      failed: true,
      artifactCount: true,
    },
  });

  let processedLastRun = 0;
  let deferredLastRun = 0;
  let stoppedReason: string | null = null;
  let recentDeferredTargets: Array<{
    sourceId: string | null;
    categoryId: string | null;
    reason: string;
    position: number;
    totalTargetsResolved: number;
  }> = [];

  if (latestRun) {
    // Count processed targets from agent1_target_outcome artifacts
    processedLastRun = await prisma.pipelineArtifact.count({
      where: {
        pipelineRunId: latestRun.id,
        artifactType: "agent1_target_outcome",
      },
    });

    // Count deferred targets
    deferredLastRun = await prisma.pipelineArtifact.count({
      where: {
        pipelineRunId: latestRun.id,
        artifactType: "agent1_deferred",
      },
    });

    if (deferredLastRun > 0) {
      const deferredArtifacts = await prisma.pipelineArtifact.findMany({
        where: {
          pipelineRunId: latestRun.id,
          artifactType: "agent1_deferred",
        },
        take: 10,
        select: {
          sourceId: true,
          categoryId: true,
          payload: true,
        },
      });

      const firstPayload = deferredArtifacts[0]?.payload as Record<string, unknown> | null;
      stoppedReason = typeof firstPayload?.reason === "string" ? firstPayload.reason : null;

      recentDeferredTargets = deferredArtifacts.map((a) => {
        const payload = a.payload as Record<string, unknown> | null;
        return {
          sourceId: a.sourceId,
          categoryId: a.categoryId,
          reason: typeof payload?.reason === "string" ? payload.reason : "unknown",
          position: typeof payload?.position === "number" ? payload.position : 0,
          totalTargetsResolved: typeof payload?.totalTargetsResolved === "number" ? payload.totalTargetsResolved : 0,
        };
      });
    }
  }

  const lastDurationMs = latestRun?.finishedAt && latestRun?.startedAt
    ? new Date(latestRun.finishedAt).getTime() - new Date(latestRun.startedAt).getTime()
    : null;

  return {
    totalEligibleNow: currentTargets.length,
    latestRunId: latestRun?.id ?? null,
    latestRunStartedAt: latestRun?.startedAt?.toISOString() ?? null,
    latestRunFinishedAt: latestRun?.finishedAt?.toISOString() ?? null,
    lastDurationMs,
    processedLastRun,
    deferredLastRun,
    remainingEligible: deferredLastRun,
    stoppedReason,
    recentDeferredTargets,
    lastRunAt: latestRun?.finishedAt?.toISOString() ?? latestRun?.startedAt?.toISOString() ?? null,
  };
}
