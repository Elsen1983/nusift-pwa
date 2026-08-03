import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { start } from "workflow/api";
import { runDailyNotificationsWorkflow } from "../../workflows/daily-notifications";
import {
  NOTIFICATION_RECONCILIATION_CONFIRMATION,
  NOTIFICATION_WORKFLOW_STATUSES,
  utcDateKey,
} from "./notification-workflow-constants";
/**
 * Idempotent daily notification workflow starter.
 *
 * Vercel Hobby allows exactly two crons; the notification workflow is started
 * from the existing daily pipeline trigger. Exactly one notification workflow
 * is started per UTC calendar day:
 *  - a marker PipelineRun (kind=daily_notifications_workflow, dateKey) is
 *    created under a PostgreSQL advisory lock, so concurrent duplicate daily
 *    executions cannot double-start;
 *  - only after the marker commit does the workflow get started;
 *  - workflow retries cannot duplicate messages because slot steps
 *    deduplicate via the existing DAILY_DIGEST per-user/day rows.
 */

export const NOTIFICATION_ADVISORY_LOCK_KEYS = [734821, 120027] as const;
const MAX_MARKER_SCAN = 400;
const STARTING_MARKER_STALE_MS = 10 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const markerMatchesDate = (summary: unknown, dateKey: string): boolean =>
  isRecord(summary) &&
  summary.kind === "daily_notifications_workflow" &&
  summary.dateKey === dateKey;

const markerAgeMs = (marker: { createdAt?: Date | string | null; summary: unknown }): number => {
  const summary = isRecord(marker.summary) ? marker.summary : null;
  const startedAt = typeof summary?.startingAt === "string" ? Date.parse(summary.startingAt) : NaN;
  const createdAt = marker.createdAt instanceof Date
    ? marker.createdAt.getTime()
    : typeof marker.createdAt === "string"
      ? Date.parse(marker.createdAt)
      : NaN;
  const timestamp = Number.isFinite(startedAt) ? startedAt : createdAt;
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY;
};

const withStartingAttempt = (summary: unknown, dateKey: string, triggeredAt: string, attempt: number) => ({
  ...(isRecord(summary) ? summary : {}),
  kind: "daily_notifications_workflow",
  dateKey,
  triggeredAt,
  attempt: Math.min(20, Math.max(1, attempt)),
  startingAt: new Date().toISOString(),
  failureReason: null,
});

export type EnsureDailyNotificationsWorkflowResult = {
  started: boolean;
  workflowRunId: string | null;
  markerRunId: string | null;
  dateKey: string;
  reason: "started" | "already_started" | "start_failed" | "reconciliation_required" | "reconciled";
  markerStatus?: string | null;
};

const conclusivelyCompleted = new Set(["completed", "succeeded", "success"]);
const conclusivelyFailed = new Set(["failed", "cancelled", "canceled"]);

async function reconcileKnownExternalRun(marker: {
  id: string;
  status: string;
  summary: unknown;
}) {
  const summary = isRecord(marker.summary) ? marker.summary : {};
  const runId = typeof summary.workflowRunId === "string" ? summary.workflowRunId : null;
  if (!runId) return null;
  try {
    const workflowApi = await import("workflow/api") as { getRun?: (id: string) => { exists: Promise<boolean>; status: Promise<unknown> } };
    if (typeof workflowApi.getRun !== "function") return null;
    const run = workflowApi.getRun(runId);
    const exists = await run.exists;
    if (!exists) {
      // A conclusively missing run proves the external start did not create a
      // durable workflow. Only the durable pre-delivery claim (retrySafe: true,
      // written by the workflow before any slot) authorizes a guarded retry;
      // otherwise the outcome is explicitly reviewable. Retry safety is never
      // inferred from the external status alone.
      const retrySafe = summary.retrySafe === true;
      const nextStatus = retrySafe
        ? "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE"
        : "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED";
      await prisma.pipelineRun.updateMany({
        where: { id: marker.id, status: { in: ["NOTIFICATION_WORKFLOW_ACTIVE", "NOTIFICATION_WORKFLOW_SCHEDULED", "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED"] } },
        data: {
          status: nextStatus,
          summary: {
            ...summary,
            workflowRunId: null,
            previousWorkflowRunId: runId.slice(0, 200),
            startState: retrySafe ? "failed_retryable" : "reconciliation_required",
            retryable: retrySafe,
            reconciliationRequired: !retrySafe,
            externalStatus: "missing",
          },
        },
      });
      return nextStatus;
    }
    let statusValue: unknown = null;
    try {
      statusValue = await run.status;
    } catch {
      // A known existing run whose status is not terminal is still active.
      await prisma.pipelineRun.updateMany({
        where: { id: marker.id, status: { in: ["NOTIFICATION_WORKFLOW_ACTIVE", "NOTIFICATION_WORKFLOW_SCHEDULED", "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED"] } },
        data: { status: "NOTIFICATION_WORKFLOW_ACTIVE", summary: { ...summary, startState: "started", reconciliationRequired: false } },
      });
      return "NOTIFICATION_WORKFLOW_ACTIVE";
    }
    const externalStatus = typeof statusValue === "string" ? statusValue.toLowerCase() : "";
    if (exists && conclusivelyCompleted.has(externalStatus)) {
      const status = externalStatus === "succeeded" || externalStatus === "success"
        ? "NOTIFICATION_WORKFLOW_COMPLETED"
        : "NOTIFICATION_WORKFLOW_COMPLETED";
      await prisma.pipelineRun.updateMany({
        where: { id: marker.id, status: { in: ["NOTIFICATION_WORKFLOW_ACTIVE", "NOTIFICATION_WORKFLOW_SCHEDULED", "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED"] } },
        data: { status, summary: { ...summary, startState: "completed", externalStatus: externalStatus.slice(0, 40) } },
      });
      return status;
    }
    if (exists && conclusivelyFailed.has(externalStatus)) {
      // A failed external run may already have delivered some slots. Only a
      // durable safety proof (set by the workflow before any delivery) allows
      // retry; otherwise preserve at-most-once delivery under review.
      const retrySafe = summary.retrySafe === true;
      const nextStatus = retrySafe
        ? "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE"
        : "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED";
      await prisma.pipelineRun.updateMany({
        where: { id: marker.id, status: { in: ["NOTIFICATION_WORKFLOW_ACTIVE", "NOTIFICATION_WORKFLOW_SCHEDULED", "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED"] } },
        data: {
          status: nextStatus,
          summary: {
            ...summary,
            startState: retrySafe ? "failed_retryable" : "reconciliation_required",
            retryable: retrySafe,
            reconciliationRequired: !retrySafe,
            workflowRunId: retrySafe ? null : typeof summary.workflowRunId === "string" ? summary.workflowRunId.slice(0, 200) : null,
            ...(retrySafe ? { previousWorkflowRunId: runId.slice(0, 200) } : {}),
            externalStatus: externalStatus.slice(0, 40),
          },
        },
      });
      return nextStatus;
    }
    if (exists) {
      await prisma.pipelineRun.updateMany({
        where: { id: marker.id, status: { in: ["NOTIFICATION_WORKFLOW_ACTIVE", "NOTIFICATION_WORKFLOW_SCHEDULED", "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED"] } },
        data: { status: "NOTIFICATION_WORKFLOW_ACTIVE", summary: { ...summary, startState: "started", externalStatus: externalStatus.slice(0, 40), reconciliationRequired: false } },
      });
      return "NOTIFICATION_WORKFLOW_ACTIVE";
    }
    // A conclusively missing run proves that the external start did not create
    // a durable workflow. Mark it retryable; a later scheduler claim may retry.
    await prisma.pipelineRun.updateMany({
      where: { id: marker.id, status: { in: ["NOTIFICATION_WORKFLOW_ACTIVE", "NOTIFICATION_WORKFLOW_SCHEDULED", "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED"] } },
      data: {
        status: "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE",
        summary: {
          ...summary,
          workflowRunId: null,
          previousWorkflowRunId: runId.slice(0, 200),
          startState: "failed_retryable",
          retryable: true,
          externalStatus: "missing",
        },
      },
    });
    return "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE";
  } catch {
    // Lookup failure is inconclusive. Never mutate to retryable and never start.
    return null;
  }
}

export async function ensureDailyNotificationsWorkflow(
  date: Date = new Date(),
): Promise<EnsureDailyNotificationsWorkflowResult> {
  const dateKey = utcDateKey(date);
  const triggeredAt = date.toISOString();

  const marker = await prisma.$transaction(async (tx) => {
    // Postgres returns void for this statement; cast to text so the driver
    // adapter can decode it (same pattern as the daily pipeline lock).
    // The advisory keys are intentionally distinct from the pipeline lock
    // so the notification workflow is independent of the pipeline lock.
    await tx.$queryRaw<Array<{ lock: string }>>`
      SELECT pg_advisory_xact_lock(734821, 120027)::text AS lock
    `;
    // Prisma's JSON filter type cannot safely express the compound nested
    // predicate used here. Scan only a bounded recent marker window and match
    // kind/date deterministically in memory; one marker is retained per day.
    const recentMarkers = await tx.pipelineRun.findMany({
      where: { status: { in: [...NOTIFICATION_WORKFLOW_STATUSES] } },
      orderBy: { createdAt: "desc" },
      take: MAX_MARKER_SCAN,
      select: { id: true, status: true, createdAt: true, summary: true },
    });
    const existing = recentMarkers.find((candidate) => markerMatchesDate(candidate.summary, dateKey));
    if (existing) {
      const existingSummary = isRecord(existing.summary) ? existing.summary : {};
      const hasExternalRunId = typeof existingSummary.workflowRunId === "string" &&
        existingSummary.workflowRunId.length > 0;
      const startState = typeof existingSummary.startState === "string"
        ? existingSummary.startState
        : "starting";
      const staleLaunching = existing.status === "NOTIFICATION_WORKFLOW_SCHEDULED" &&
        !hasExternalRunId && startState === "launching" && markerAgeMs(existing) >= STARTING_MARKER_STALE_MS;
      if (staleLaunching) {
        const reconciliationSummary = {
          ...existingSummary,
          reconciliationRequired: true,
          startState: "reconciliation_required",
          reconciliationRequiredAt: new Date().toISOString(),
        };
        await tx.pipelineRun.update({
          where: { id: existing.id },
          data: { status: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED", summary: reconciliationSummary },
        });
        return {
          created: false as const,
          id: existing.id,
          summary: reconciliationSummary,
          reconciliationRequired: true as const,
        };
      }
      const canRecover =
        ((existing.status === "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE" ||
          existing.status === "NOTIFICATION_WORKFLOW_FAILED") &&
          !hasExternalRunId &&
          isRecord(existing.summary) &&
          existing.summary.retryable === true) ||
        (existing.status === "NOTIFICATION_WORKFLOW_SCHEDULED" &&
          !hasExternalRunId &&
          startState === "starting" &&
          typeof existingSummary.launchAttemptId !== "string" &&
          markerAgeMs(existing) >= STARTING_MARKER_STALE_MS);
      if (canRecover) {
        const summary = withStartingAttempt(existing.summary, dateKey, triggeredAt, Number(
          isRecord(existing.summary) ? existing.summary.attempt : 0,
        ) + 1);
        await tx.pipelineRun.update({
          where: { id: existing.id },
          data: { status: "NOTIFICATION_WORKFLOW_SCHEDULED", summary },
        });
        return { created: true as const, id: existing.id, summary };
      }
      return { created: false as const, id: existing.id, summary: existing.summary, reconciliationRequired: false as const };
    }
    const created = await tx.pipelineRun.create({
      data: {
        status: "NOTIFICATION_WORKFLOW_SCHEDULED",
        summary: {
          ...withStartingAttempt(null, dateKey, triggeredAt, 1),
          // The marker is explicitly in a pre-start state. A later recovery
          // may steal only this state; once an external run ID is persisted,
          // the marker is never auto-recovered by age.
          startState: "starting",
        },
      },
      select: { id: true },
    });
    return {
      created: true as const,
      id: created.id,
      summary: {
        ...withStartingAttempt(null, dateKey, triggeredAt, 1),
        startState: "starting",
      },
    };
  });

  if (!marker.created) {
    const markerSummary: Record<string, unknown> = {};
    if (isRecord(marker.summary)) Object.assign(markerSummary, marker.summary);
    const reconciledStatus = await reconcileKnownExternalRun({ id: marker.id, status: "", summary: markerSummary });
    return {
      started: false,
      workflowRunId: typeof markerSummary.workflowRunId === "string"
        ? markerSummary.workflowRunId : null,
      markerRunId: marker.id,
      dateKey,
      reason: marker.reconciliationRequired ||
        markerSummary.reconciliationRequired === true
        ? "reconciliation_required"
        : reconciledStatus ? "reconciled" : "already_started",
      markerStatus: reconciledStatus,
    };
  }

  // Mark the committed marker as an in-flight start before calling the
  // external workflow API. If the post-start persistence update later fails,
  // this state is deliberately not age-recoverable; at-most-once delivery is
  // safer than blindly starting a possible duplicate workflow.
  const startingSummary = withStartingAttempt(
    marker.summary,
    dateKey,
    triggeredAt,
    isRecord(marker.summary) && typeof marker.summary.attempt === "number"
      ? marker.summary.attempt
      : 1,
  );
  const launchAttemptId = randomUUID().slice(0, 64);
  try {
    const claim = await prisma.pipelineRun.updateMany({
      where: { id: marker.id, status: "NOTIFICATION_WORKFLOW_SCHEDULED" },
      data: {
        summary: { ...startingSummary, startState: "starting" },
      },
    });
    if (claim.count !== 1) {
      return {
        started: false,
        workflowRunId: null,
        markerRunId: marker.id,
        dateKey,
        reason: "already_started",
      };
    }
  } catch {
    return {
      started: false,
      workflowRunId: null,
      markerRunId: marker.id,
      dateKey,
      reason: "start_failed",
    };
  }

  // Once the external start is about to happen, make the marker explicitly
  // non-stealable. If the process loses the response or cannot persist the
  // returned run ID, a later scheduler invocation must not risk starting a
  // duplicate workflow. A failed start below still transitions this marker to
  // FAILED and remains retryable.
  try {
    const launchClaim = await prisma.pipelineRun.updateMany({
      where: { id: marker.id, status: "NOTIFICATION_WORKFLOW_SCHEDULED" },
      data: {
        summary: {
          ...startingSummary,
          startState: "launching",
          launchAttemptId,
          launchAttemptedAt: new Date().toISOString(),
        },
      },
    });
    if (launchClaim.count !== 1) {
      return {
        started: false,
        workflowRunId: null,
        markerRunId: marker.id,
        dateKey,
        reason: "already_started",
      };
    }
  } catch {
    return {
      started: false,
      workflowRunId: null,
      markerRunId: marker.id,
      dateKey,
      reason: "start_failed",
    };
  }

  try {
    const run = await start(runDailyNotificationsWorkflow, [
      { dateKey, triggeredAt, markerRunId: marker.id },
    ]);
    try {
      await prisma.pipelineRun.updateMany({
        where: { id: marker.id, status: "NOTIFICATION_WORKFLOW_SCHEDULED" },
        data: {
          status: "NOTIFICATION_WORKFLOW_ACTIVE",
          summary: {
            kind: "daily_notifications_workflow",
            dateKey,
            triggeredAt,
            workflowRunId: String(run.runId).slice(0, 200),
            startState: "started",
            startedAt: new Date().toISOString(),
          },
        },
      });
    } catch {
      // The durable workflow owns finalization; inability to persist the run
      // ID here must not turn a successfully started workflow into a retry.
    }
    return {
      started: true,
      workflowRunId: run.runId,
      markerRunId: marker.id,
      dateKey,
      reason: "started",
    };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    try {
      await prisma.pipelineRun.updateMany({
        where: { id: marker.id, status: "NOTIFICATION_WORKFLOW_SCHEDULED" },
        data: {            status: "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE",
            finishedAt: new Date(),
          summary: {
            kind: "daily_notifications_workflow",
            dateKey,
            triggeredAt,
            failureReason: failureReason.slice(0, 300),
            failedAt: new Date().toISOString(),
            retryable: true,
            startState: "failed_retryable",
            launchAttemptId,
          },
        },
      });
    } catch {
      // Preserve the main pipeline's success even if marker recovery logging
      // is unavailable. A stale scheduled marker remains recoverable.
    }
    return {
      started: false,
      workflowRunId: null,
      markerRunId: marker.id,
      dateKey,
      reason: "start_failed",
    };
  }
}
