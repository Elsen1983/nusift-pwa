import { sleep } from "workflow";
import type { DailyNotificationSlot } from "../utils/notification-sender";

/**
 * Durable daily notification workflow.
 *
 * Vercel Hobby permits at most two cron jobs, so notification delivery cannot
 * have its own cron. Instead the existing daily trigger starts this workflow
 * once per UTC calendar day; the workflow uses durable sleeps to land on the
 * MORNING, NOON, and EVENING digest slots and releases the main pipeline lock
 * immediately (this workflow holds no pipeline lock and never waits for it).
 *
 * Idempotency:
 *  - One marker PipelineRun per UTC dateKey is created (under an advisory
 *    lock) before `start()`, so duplicate daily pipeline executions cannot
 *    start duplicate notification workflows.
 *  - Each slot step delegates to sendDueDailyNotificationsInternal, which
 *    deduplicates per user/day via the existing DAILY_DIGEST Notification
 *    row, so workflow retries never duplicate messages.
 *
 * Past-slot behavior (documented + tested):
 *  - If the workflow starts while a slot window is open (startHour <= now
 *    hour <= endHour), the slot is processed immediately.
 *  - If the slot window has fully ended on the workflow's UTC date, the slot
 *    is skipped deterministically. The workflow never sleeps into the next
 *    day — it is scoped to its own dateKey.
 */

export const NOTIFICATION_SLOTS: DailyNotificationSlot[] = ["MORNING", "NOON", "EVENING"];

/** Inclusive hour windows per slot (startHour, endHour). Shared with notification-sender. */
export const NOTIFICATION_SLOT_HOURS: Record<DailyNotificationSlot, [number, number]> = {
  MORNING: [6, 11],
  NOON: [12, 16],
  EVENING: [18, 22],
};

export type DailyNotificationsWorkflowInput = {
  dateKey: string;
  triggeredAt: string;
  markerRunId: string;
};

export type DailyNotificationsWorkflowResult = {
  dateKey: string;
  markerRunId: string;
  slotsProcessed: DailyNotificationSlot[];
  usersProcessed: number;
  pushesSent: number;
  skippedEmpty: number;
  lastError: string | null;
};

// ─── Pure slot scheduling helpers ───────────────────────────────────────────

const utcDateAtHour = (dateKey: string, hour: number): Date => {
  // dateKey is a UTC yyyy-mm-dd string.
  const [year, month, day] = dateKey.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year!, month! - 1, day!, hour, 0, 0, 0));
};

export const notificationSlotStartUtc = (
  slot: DailyNotificationSlot,
  dateKey: string,
): Date => utcDateAtHour(dateKey, NOTIFICATION_SLOT_HOURS[slot][0]);

export const notificationSlotEndUtc = (
  slot: DailyNotificationSlot,
  dateKey: string,
): Date => {
  const endHour = NOTIFICATION_SLOT_HOURS[slot][1];
  // Inclusive window end: endHour:59:59.999 UTC.
  return new Date(
    utcDateAtHour(dateKey, endHour).getTime() + 59 * 60 * 1000 + 59 * 1000 + 999,
  );
};

export type NotificationSlotDecision =
  | { action: "sleep"; sleepUntil: Date; reason: "scheduled" }
  | { action: "process_now"; reason: "slot_due" }
  | { action: "skip"; reason: "slot_past" };

/**
 * Decide what to do for one slot given the workflow's current time.
 *
 * - now < slot start   → durable sleep until the slot start.
 * - slot start <= now <= slot end → process immediately (slot is due).
 * - now > slot end     → skip deterministically (slot already fully past on
 *   this date; never sleep into the next day).
 */
export function decideNotificationSlotAction(
  slot: DailyNotificationSlot,
  now: Date,
  dateKey: string,
): NotificationSlotDecision {
  const start = notificationSlotStartUtc(slot, dateKey);
  const end = notificationSlotEndUtc(slot, dateKey);
  if (now.getTime() < start.getTime()) {
    return { action: "sleep", sleepUntil: start, reason: "scheduled" };
  }
  if (now.getTime() <= end.getTime()) {
    return { action: "process_now", reason: "slot_due" };
  }
  return { action: "skip", reason: "slot_past" };
}

// ─── Slot step ──────────────────────────────────────────────────────────────

export type NotificationSlotStepResult = {
  slot: DailyNotificationSlot;
  processed: boolean;
  usersProcessed: number;
  pushesSent: number;
  skippedEmpty: number;
  lastError: string | null;
  reason: string;
};

export async function runNotificationSlotStep(
  slot: DailyNotificationSlot,
  at: Date,
): Promise<NotificationSlotStepResult> {
  "use step";
  try {
    const { sendDueDailyNotificationsInternal } =
      await import("../utils/notification-sender");
    const { results, stats } = await sendDueDailyNotificationsInternal(at, [slot]);
    return {
      slot,
      processed: true,
      usersProcessed: results.length,
      pushesSent: stats.pushesSent,
      skippedEmpty: stats.skippedEmpty,
      lastError: stats.lastError,
      reason: "slot_due",
    };
  } catch (error: any) {
    // A slot delivery failure must never fail the main article pipeline. It
    // stays bounded here and is surfaced in the workflow result/marker.
    return {
      slot,
      processed: false,
      usersProcessed: 0,
      pushesSent: 0,
      skippedEmpty: 0,
      lastError: error?.message ? String(error.message).slice(0, 300) : "slot delivery failed",
      reason: "delivery_error",
    };
  }
}

// ─── Retry-safety evidence ──────────────────────────────────────────────────

/**
 * Durable retry-safety evidence for the notification marker.
 *
 * `retrySafe === true` means no slot was attempted yet — a failure now may be
 * retried. The moment the first delivery attempt begins, the evidence is
 * flipped to `retrySafe: false` (with `firstSlotAttempted`/`deliveryStartedAt`)
 * and never restored. The scheduler decides retryability ONLY from this
 * durable evidence, never from external workflow status alone.
 */
export type NotificationRetrySafetyEvidence = {
  retrySafe: boolean;
  deliveryStartedAt: string | null;
  firstSlotAttempted: boolean;
  currentSlot: DailyNotificationSlot | null;
  nextSlot: DailyNotificationSlot | null;
  completedSlots: DailyNotificationSlot[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const EVIDENCE_UPDATE_STATUSES = [
  "NOTIFICATION_WORKFLOW_SCHEDULED",
  "NOTIFICATION_WORKFLOW_ACTIVE",
  "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE",
  "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED",
] as const;

const asSlotArray = (value: unknown): DailyNotificationSlot[] =>
  Array.isArray(value)
    ? value
        .filter((slot): slot is DailyNotificationSlot =>
          NOTIFICATION_SLOTS.includes(slot as DailyNotificationSlot),
        )
        .slice(0, NOTIFICATION_SLOTS.length)
    : [];

const nextSlotAfter = (slot: DailyNotificationSlot): DailyNotificationSlot | null => {
  const index = NOTIFICATION_SLOTS.indexOf(slot);
  return index >= 0 && index < NOTIFICATION_SLOTS.length - 1
    ? NOTIFICATION_SLOTS[index + 1]!
    : null;
};

const readMarkerSummary = async (
  markerRunId: string,
): Promise<Record<string, unknown>> => {
  const { prisma } = await import("../utils/prisma");
  const marker = await prisma.pipelineRun.findUnique({
    where: { id: markerRunId },
    select: { summary: true },
  });
  return marker?.summary && isRecord(marker.summary) ? marker.summary : {};
};

/**
 * Persist the durable pre-delivery claim: `retrySafe: true`. Called before any
 * notification slot is processed. This step NEVER restores retry safety once
 * the marker records a delivery attempt, so a workflow replay after delivery
 * began cannot resurrect a retryable run. A persistence failure returns false
 * and the caller must default to non-retry-safe behavior.
 */
export async function claimNotificationRetrySafetyStep(
  markerRunId: string,
): Promise<boolean> {
  "use step";
  try {
    const summary = await readMarkerSummary(markerRunId);
    if (
      summary.firstSlotAttempted === true ||
      typeof summary.deliveryStartedAt === "string"
    ) {
      // Delivery already began on an earlier execution. Never reset.
      return true;
    }
    const { prisma } = await import("../utils/prisma");
    const result = await prisma.pipelineRun.updateMany({
      where: { id: markerRunId, status: { in: [...EVIDENCE_UPDATE_STATUSES] } },
      data: {
        summary: {
          ...summary,
          retrySafe: true,
          firstSlotAttempted: false,
          deliveryStartedAt: null,
          currentSlot: typeof summary.currentSlot === "string" ? summary.currentSlot : null,
          nextSlot: typeof summary.nextSlot === "string" ? summary.nextSlot : null,
          completedSlots: asSlotArray(summary.completedSlots),
        },
      },
    });
    return result.count === 1;
  } catch {
    // Marker update failure defaults to non-retry-safe behavior.
    return false;
  }
}

/**
 * Persist the durable flip to non-retry-safe immediately before (atomically
 * with) the first delivery attempt. After this succeeds the marker must remain
 * non-retry-safe for the rest of the run. Returns false when the marker cannot
 * be updated — the caller must NOT proceed with delivery (at-most-once).
 */
export async function markNotificationDeliveryStartedStep(
  markerRunId: string,
  slot: DailyNotificationSlot,
  at: Date,
): Promise<boolean> {
  "use step";
  try {
    const summary = await readMarkerSummary(markerRunId);
    const deliveryStartedAt =
      typeof summary.deliveryStartedAt === "string"
        ? summary.deliveryStartedAt
        : at.toISOString();
    const { prisma } = await import("../utils/prisma");
    const result = await prisma.pipelineRun.updateMany({
      where: { id: markerRunId, status: { in: [...EVIDENCE_UPDATE_STATUSES] } },
      data: {
        summary: {
          ...summary,
          retrySafe: false,
          firstSlotAttempted: true,
          deliveryStartedAt,
          currentSlot: slot,
          nextSlot: nextSlotAfter(slot),
          completedSlots: asSlotArray(summary.completedSlots),
        },
      },
    });
    return result.count === 1;
  } catch {
    return false;
  }
}

/**
 * Best-effort durable progress record after a slot completes. Failures here
 * are observation-only and never change retry-safety semantics.
 */
export async function recordNotificationSlotCompletedStep(
  markerRunId: string,
  slot: DailyNotificationSlot,
): Promise<boolean> {
  "use step";
  try {
    const summary = await readMarkerSummary(markerRunId);
    const completed = asSlotArray(summary.completedSlots);
    if (!completed.includes(slot)) completed.push(slot);
    const { prisma } = await import("../utils/prisma");
    const result = await prisma.pipelineRun.updateMany({
      where: { id: markerRunId, status: { in: [...EVIDENCE_UPDATE_STATUSES] } },
      data: {
        summary: {
          ...summary,
          currentSlot: null,
          completedSlots: completed,
        },
      },
    });
    return result.count === 1;
  } catch {
    return false;
  }
}

// ─── Marker finalization step ───────────────────────────────────────────────

export type NotificationWorkflowFinalizeInput = {
  markerRunId: string;
  dateKey: string;
  slotsProcessed: DailyNotificationSlot[];
  usersProcessed: number;
  pushesSent: number;
  skippedEmpty: number;
  lastError: string | null;
  /** True when orchestration failed before normal completion. */
  isFatalFailure?: boolean;
  /** True when a retry-safety evidence write failed; default non-retry-safe. */
  evidenceBroken?: boolean;
};

/**
 * Finalize the marker with retry-safety semantics:
 *  - persistence failure in the evidence chain → RECONCILIATION_REQUIRED;
 *  - fatal failure BEFORE the first delivery attempt → FAILED_RETRYABLE;
 *  - fatal failure AFTER delivery began → RECONCILIATION_REQUIRED;
 *  - in-band slot errors with successful orchestration → COMPLETED_WITH_ERRORS;
 *  - otherwise → COMPLETED.
 *
 * Retryability is decided from the DURABLE marker evidence (`firstSlotAttempted`
 * / `deliveryStartedAt` / `retrySafe`), never from external workflow status.
 */
export async function finalizeNotificationWorkflowStep(
  input: NotificationWorkflowFinalizeInput,
): Promise<void> {
  "use step";
  const { prisma } = await import("../utils/prisma");
  const existingMarker = await prisma.pipelineRun.findUnique({
    where: { id: input.markerRunId },
    select: { summary: true },
  });
  const existingSummary = existingMarker?.summary && typeof existingMarker.summary === "object" && !Array.isArray(existingMarker.summary)
    ? existingMarker.summary
    : {};

  const deliveryStarted =
    existingSummary.firstSlotAttempted === true ||
    typeof existingSummary.deliveryStartedAt === "string";

  let status: string;
  if (input.evidenceBroken) {
    status = "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED";
  } else if (input.isFatalFailure) {
    status = deliveryStarted
      ? "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED"
      : "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE";
  } else if (input.lastError) {
    status = "NOTIFICATION_WORKFLOW_COMPLETED_WITH_ERRORS";
  } else {
    status = "NOTIFICATION_WORKFLOW_COMPLETED";
  }

  await prisma.pipelineRun.updateMany({
    where: {
      id: input.markerRunId,
      status: {
        in: ["NOTIFICATION_WORKFLOW_SCHEDULED", "NOTIFICATION_WORKFLOW_ACTIVE"],
      },
    },
    data: {
      status,
      finishedAt: new Date(),
      summary: {
        ...existingSummary,
        kind: "daily_notifications_workflow",
        dateKey: input.dateKey,
        slotsProcessed: input.slotsProcessed,
        usersProcessed: input.usersProcessed,
        pushesSent: input.pushesSent,
        skippedEmpty: input.skippedEmpty,
        lastError: input.lastError,
        completedAt: new Date().toISOString(),
        retryable: status === "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE",
        retrySafe: status === "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE"
          ? true
          : existingSummary.retrySafe === true,
        firstSlotAttempted: existingSummary.firstSlotAttempted === true,
        deliveryStartedAt: typeof existingSummary.deliveryStartedAt === "string"
          ? existingSummary.deliveryStartedAt
          : null,
        currentSlot: typeof existingSummary.currentSlot === "string"
          ? existingSummary.currentSlot
          : null,
        nextSlot: typeof existingSummary.nextSlot === "string"
          ? existingSummary.nextSlot
          : null,
        completedSlots: asSlotArray(existingSummary.completedSlots),
      },
    },
  });
}

// ─── Workflow ───────────────────────────────────────────────────────────────

export async function runDailyNotificationsWorkflow(
  input: DailyNotificationsWorkflowInput,
): Promise<DailyNotificationsWorkflowResult> {
  "use workflow";

  const now = new Date(input.triggeredAt);
  const slotsProcessed: DailyNotificationSlot[] = [];
  let usersProcessed = 0;
  let pushesSent = 0;
  let skippedEmpty = 0;
  let lastError: string | null = null;
  let isFatalFailure = false;
  let evidenceBroken = false;

  try {
    // Before any notification slot is processed, persist the durable
    // retry-safety claim. A persistence failure defaults the run to
    // non-retry-safe behavior.
    if (!(await claimNotificationRetrySafetyStep(input.markerRunId))) {
      evidenceBroken = true;
    }

    for (const slot of NOTIFICATION_SLOTS) {
      const decision = decideNotificationSlotAction(slot, now, input.dateKey);
      if (decision.action === "skip") {
        continue; // slot_past — deterministic skip for this date
      }

      const at = decision.action === "sleep" ? decision.sleepUntil : now;
      if (decision.action === "sleep") {
        await sleep(decision.sleepUntil);
      }

      // Immediately before the first delivery attempt, persist the durable
      // non-retry-safe flip. If the marker cannot be updated, delivery is
      // skipped (at-most-once safety) and the run finalizes as
      // reconciliation-required.
      if (!(await markNotificationDeliveryStartedStep(input.markerRunId, slot, at))) {
        evidenceBroken = true;
        lastError = "delivery retry-safety evidence could not be persisted; slot delivery skipped";
        break;
      }

      const slotResult = await runNotificationSlotStep(slot, at);
      slotsProcessed.push(slotResult.slot);
      usersProcessed += slotResult.usersProcessed;
      pushesSent += slotResult.pushesSent;
      skippedEmpty += slotResult.skippedEmpty;
      if (slotResult.lastError) lastError = slotResult.lastError;

      // Best-effort durable progress; never changes retry-safety semantics.
      await recordNotificationSlotCompletedStep(input.markerRunId, slot);
    }
  } catch (error: any) {
    // Catch orchestration failures (including durable sleep failures) so an
    // ACTIVE marker never becomes an unrecoverable daily dead-letter. The
    // bounded failure marker is retryable by the scheduler on a later run
    // ONLY when delivery has not begun (durable evidence decides).
    isFatalFailure = true;
    lastError = error?.message ? String(error.message).slice(0, 300) : "notification workflow failed";
  }

  // Marker finalization is observation-only and must not mask a delivery
  // error; the workflow result is authoritative either way.
  try {
    await finalizeNotificationWorkflowStep({
      markerRunId: input.markerRunId,
      dateKey: input.dateKey,
      slotsProcessed,
      usersProcessed,
      pushesSent,
      skippedEmpty,
      lastError,
      isFatalFailure,
      evidenceBroken,
    });
  } catch (error: any) {
    lastError = lastError ?? (error?.message ? String(error.message).slice(0, 300) : "marker finalize failed");
  }

  return {
    dateKey: input.dateKey,
    markerRunId: input.markerRunId,
    slotsProcessed,
    usersProcessed,
    pushesSent,
    skippedEmpty,
    lastError,
  };
}
