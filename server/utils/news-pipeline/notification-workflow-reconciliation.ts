import { prisma } from "../prisma";
import {
  NOTIFICATION_RECONCILIATION_CONFIRMATION,
  NOTIFICATION_WORKFLOW_STATUSES,
  utcDateKey,
} from "./notification-workflow-constants";

const MAX_RECONCILIATION_SCAN = 100;
const RECONCILIATION_STALE_MS = 15 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const boundedString = (value: unknown, max = 300): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

const markerIsStaleLaunching = (marker: { createdAt: Date; summary: unknown }) => {
  if (!isRecord(marker.summary) || marker.summary.startState !== "launching") return false;
  const raw = boundedString(marker.summary.launchAttemptedAt) || boundedString(marker.summary.startingAt);
  const timestamp = raw ? Date.parse(raw) : marker.createdAt.getTime();
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= RECONCILIATION_STALE_MS;
};

export type NotificationReconciliationMarker = {
  id: string;
  dateKey: string | null;
  status: string;
  createdAt: string;
  startState: string | null;
  launchAttemptId: string | null;
  workflowRunId: string | null;
  launchAttemptedAt: string | null;
  staleLaunching: boolean;
  failureReason: string | null;
  summary: {
    currentSlot: string | null;
    nextSlot: string | null;
    usersProcessed: number;
    pushesSent: number;
    skippedEmpty: number;
    lastError: string | null;
    reconciliationRequired: boolean;
    retrySafe: boolean;
    firstSlotAttempted: boolean;
    deliveryStartedAt: string | null;
    completedSlots: string[];
  };
  externalWorkflow: {
    exists: boolean;
    status: string | null;
  } | null;
  resultingState: string;
  reconciliationOutcome: "active" | "completed" | "failed_retryable" | "missing" | "inconclusive" | "none";
};

const normalizeMarker = (marker: {
  id: string;
  status: string;
  createdAt: Date;
  summary: unknown;
}): NotificationReconciliationMarker => {
  const summary = isRecord(marker.summary) ? marker.summary : {};
  const asCount = (value: unknown) => typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1_000_000, Math.round(value)))
    : 0;
  return {
    id: marker.id,
    dateKey: boundedString(summary.dateKey, 10),
    status: marker.status,
    createdAt: marker.createdAt.toISOString(),
    startState: boundedString(summary.startState, 40),
    launchAttemptId: boundedString(summary.launchAttemptId, 64),
    workflowRunId: boundedString(summary.workflowRunId, 200),
    launchAttemptedAt: boundedString(summary.launchAttemptedAt, 40),
    staleLaunching: markerIsStaleLaunching(marker),
    failureReason: boundedString(summary.failureReason),
    summary: {
      currentSlot: boundedString(summary.currentSlot, 30),
      nextSlot: boundedString(summary.nextSlot, 30),
      usersProcessed: asCount(summary.usersProcessed),
      pushesSent: asCount(summary.pushesSent),
      skippedEmpty: asCount(summary.skippedEmpty),
      lastError: boundedString(summary.lastError),
      reconciliationRequired: marker.status === "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED" ||
        summary.reconciliationRequired === true,
      // Durable retry-safety evidence written by the workflow. The scheduler
      // retries ONLY when retrySafe is true (no delivery attempt recorded).
      retrySafe: summary.retrySafe === true,
      firstSlotAttempted: summary.firstSlotAttempted === true,
      deliveryStartedAt: boundedString(summary.deliveryStartedAt, 40),
      completedSlots: Array.isArray(summary.completedSlots)
        ? summary.completedSlots
            .filter((slot): slot is string => typeof slot === "string")
            .slice(0, 3)
        : [],
    },
    externalWorkflow: null,
    resultingState: marker.status,
    reconciliationOutcome: "none",
  };
};

/**
 * Query the durable workflow platform when a marker already contains an
 * external run ID. This is observation-only: a missing/unknown run never
 * authorizes a restart, and lookup failures remain explicitly inconclusive.
 */
async function lookupExternalWorkflow(runId: string | null) {
  if (!runId) return null;
  try {
    // Keep workflow-runtime lookup lazy: importing workflow/api while Nitro
    // renders the admin page can evaluate runtime-only globals. A lookup
    // failure is intentionally inconclusive and never authorizes a restart.
    const workflowApi = await import("workflow/api") as { getRun?: (id: string) => { exists: Promise<boolean>; status: Promise<unknown> } };
    if (typeof workflowApi.getRun !== "function") return null;
    const run = workflowApi.getRun(runId);
    const [exists, status] = await Promise.all([run.exists, run.status]);
    return {
      exists,
      status: typeof status === "string" ? status.slice(0, 40) : null,
    };
  } catch {
    return null;
  }
}

export async function inspectNotificationWorkflowMarkers(input?: { dateKey?: string }) {
  const dateKey = input?.dateKey || utcDateKey(new Date());
  const markers = await prisma.pipelineRun.findMany({
    where: { status: { in: [...NOTIFICATION_WORKFLOW_STATUSES] } },
    orderBy: { createdAt: "desc" },
    take: MAX_RECONCILIATION_SCAN,
    select: { id: true, status: true, createdAt: true, summary: true },
  });
  const normalized = markers
    .filter((marker) => isRecord(marker.summary) && marker.summary.kind === "daily_notifications_workflow" && marker.summary.dateKey === dateKey)
    .slice(0, 10)
    .map(normalizeMarker);
  return await Promise.all(normalized.map(async (entry) => {
    const externalWorkflow = await lookupExternalWorkflow(entry.workflowRunId);
    const lookupInconclusive = Boolean(entry.workflowRunId) && externalWorkflow === null;
    const externalStatus = externalWorkflow?.status?.toLowerCase() || "";
    const reconciliationOutcome = lookupInconclusive
      ? "inconclusive" as const
      : externalWorkflow?.exists === false
        ? "missing" as const
        : externalStatus === "completed" || externalStatus === "succeeded" || externalStatus === "success"
          ? "completed" as const
          : externalStatus === "failed" || externalStatus === "cancelled" || externalStatus === "canceled"
            ? "failed_retryable" as const
            : externalWorkflow?.exists
              ? "active" as const
              : "none" as const;
    return {
      ...entry,
      externalWorkflow,
      resultingState: entry.status,
      reconciliationOutcome,
      summary: {
        ...entry.summary,
        // A stale launch, or a run-ID lookup that cannot conclusively identify
        // the external execution, is explicitly reviewable. It never enables
        // an automatic restart.
        reconciliationRequired: entry.summary.reconciliationRequired ||
          entry.staleLaunching || lookupInconclusive,
      },
    };
  }));
}

export async function reconcileNotificationWorkflowMarker(input: {
  markerRunId: string;
  confirmation?: string;
  action?: "acknowledge" | "abandon";
}) {
  const confirmed = input.confirmation === NOTIFICATION_RECONCILIATION_CONFIRMATION;
  const marker = await prisma.pipelineRun.findUnique({
    where: { id: input.markerRunId },
    select: { id: true, status: true, createdAt: true, summary: true },
  });
  if (!marker) return { changed: false, reason: "not_found" as const, marker: null };
  const normalized = normalizeMarker(marker);
  if (!confirmed) return { changed: false, reason: "confirmation_required" as const, marker: normalized };
  if (!normalized.staleLaunching && marker.status !== "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED") {
    return { changed: false, reason: "not_stale" as const, marker: normalized };
  }

  const summary = isRecord(marker.summary) ? marker.summary : {};
  const action = input.action || "acknowledge";
  const nextStatus = action === "abandon" ? "NOTIFICATION_WORKFLOW_ABANDONED" : "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED";
  const result = await prisma.pipelineRun.updateMany({
    where: {
      id: marker.id,
      status: { in: ["NOTIFICATION_WORKFLOW_SCHEDULED", "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED"] },
    },
    data: {
      status: nextStatus,
      summary: {
        ...summary,
        reconciliationRequired: action !== "abandon",
        reconciliationConfirmedAt: new Date().toISOString(),
        reconciliationNote: action === "abandon"
          ? "Admin explicitly abandoned the uncertain external workflow; no workflow was started."
          : "Admin acknowledged uncertain external workflow outcome; no automatic restart permitted.",
      },
    },
  });
  const resultingMarker = { ...normalized, status: nextStatus, resultingState: nextStatus };
  return {
    changed: result.count === 1,
    reason: result.count === 1 ? action === "abandon" ? "abandoned" as const : "reconciliation_required" as const : "already_changed" as const,
    marker: resultingMarker,
  };
}

export { RECONCILIATION_STALE_MS };
