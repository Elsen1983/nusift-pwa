import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendDueDailyNotificationsInternal: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("workflow", () => ({
  sleep: (...args: any[]) => mocks.sleep(...args),
}));
vi.mock("../utils/notification-sender", () => ({
  sendDueDailyNotificationsInternal: mocks.sendDueDailyNotificationsInternal,
}));
vi.mock("../utils/prisma", () => ({
  prisma: {
    pipelineRun: { findUnique: mocks.findUnique, updateMany: mocks.updateMany },
  },
}));

import {
  decideNotificationSlotAction,
  notificationSlotStartUtc,
  notificationSlotEndUtc,
  NOTIFICATION_SLOT_HOURS,
  runNotificationSlotStep,
  finalizeNotificationWorkflowStep,
  claimNotificationRetrySafetyStep,
  markNotificationDeliveryStartedStep,
  runDailyNotificationsWorkflow,
} from "./daily-notifications";

describe("notification slot scheduling", () => {
  const dateKey = "2026-08-02";

  it("schedules a durable sleep when now is before the slot start", () => {
    const now = new Date("2026-08-02T03:00:00.000Z"); // pipeline cron time
    const decision = decideNotificationSlotAction("MORNING", now, dateKey);
    expect(decision.action).toBe("sleep");
    expect(decision).toMatchObject({ reason: "scheduled" });
    if (decision.action === "sleep") {
      expect(decision.sleepUntil.toISOString()).toBe("2026-08-02T06:00:00.000Z");
    }
  });

  it("processes a due slot immediately when the window is open", () => {
    const now = new Date("2026-08-02T08:30:00.000Z");
    const decision = decideNotificationSlotAction("MORNING", now, dateKey);
    expect(decision).toMatchObject({ action: "process_now", reason: "slot_due" });
  });

  it("skips a fully past slot deterministically (no sleep into next day)", () => {
    const now = new Date("2026-08-02T13:00:00.000Z");
    const decision = decideNotificationSlotAction("MORNING", now, dateKey);
    expect(decision).toMatchObject({ action: "skip", reason: "slot_past" });
  });

  it("schedules all three slots in order across the day", () => {
    const slots = ["MORNING", "NOON", "EVENING"] as const;
    expect(notificationSlotStartUtc("MORNING", dateKey).getUTCHours()).toBe(6);
    expect(notificationSlotStartUtc("NOON", dateKey).getUTCHours()).toBe(12);
    expect(notificationSlotStartUtc("EVENING", dateKey).getUTCHours()).toBe(18);
    expect(NOTIFICATION_SLOT_HOURS.MORNING[1]).toBe(11);
    expect(NOTIFICATION_SLOT_HOURS.NOON[1]).toBe(16);
    expect(NOTIFICATION_SLOT_HOURS.EVENING[1]).toBe(22);
  });

  it("treats the slot end as inclusive within the hour window", () => {
    const end = notificationSlotEndUtc("MORNING", dateKey);
    expect(end.getUTCHours()).toBe(11);
    const atEnd = new Date("2026-08-02T11:59:59.500Z");
    expect(decideNotificationSlotAction("MORNING", atEnd, dateKey).action).toBe("process_now");
  });

  it("slot boundaries are deterministic across the UTC date", () => {
    const start = notificationSlotStartUtc("NOON", "2026-12-31");
    expect(start.toISOString()).toBe("2026-12-31T12:00:00.000Z");
  });
});

describe("notification slot step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendDueDailyNotificationsInternal.mockResolvedValue({
      results: [{ userId: "u1", sent: 2 }],
      stats: { usersProcessed: 1, pushesSent: 2, skippedEmpty: 3, lastError: null },
    });
  });

  it("delegates to the scoped sender for one slot", async () => {
    const result = await runNotificationSlotStep("MORNING", new Date("2026-08-02T06:00:00.000Z"));
    expect(result).toMatchObject({
      slot: "MORNING",
      processed: true,
      usersProcessed: 1,
      pushesSent: 2,
      skippedEmpty: 3,
      lastError: null,
    });
    expect(mocks.sendDueDailyNotificationsInternal).toHaveBeenCalledWith(
      expect.any(Date),
      ["MORNING"],
    );
  });

  it("turns a delivery error into a bounded slot result instead of throwing", async () => {
    mocks.sendDueDailyNotificationsInternal.mockRejectedValue(new Error("boom"));
    const result = await runNotificationSlotStep("NOON", new Date("2026-08-02T12:00:00.000Z"));
    expect(result).toMatchObject({
      processed: false,
      usersProcessed: 0,
      pushesSent: 0,
      reason: "delivery_error",
    });
    expect(result.lastError).toContain("boom");
  });
});

describe("notification workflow marker finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ summary: {} });
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it("finalizes a pre-delivery durable sleep failure as retryable", async () => {
    // The workflow's claim step persisted retrySafe: true before the sleep
    // failed, so the marker carries durable proof that no delivery happened.
    mocks.findUnique.mockResolvedValue({
      summary: { retrySafe: true, firstSlotAttempted: false, deliveryStartedAt: null },
    });
    mocks.sleep.mockRejectedValue(new Error("durable sleep unavailable"));

    const result = await runDailyNotificationsWorkflow({
      dateKey: "2026-08-02",
      triggeredAt: "2026-08-02T03:00:00.000Z",
      markerRunId: "marker-workflow-failed",
    });

    expect(result.lastError).toBe("durable sleep unavailable");
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE",
          summary: expect.objectContaining({
            dateKey: "2026-08-02",
            lastError: "durable sleep unavailable",
            retryable: true,
            retrySafe: true,
          }),
        }),
      }),
    );
  });

  it("marks the marker run completed with bounded run stats", async () => {
    await finalizeNotificationWorkflowStep({
      markerRunId: "marker-1",
      dateKey: "2026-08-02",
      slotsProcessed: ["MORNING", "NOON", "EVENING"],
      usersProcessed: 42,
      pushesSent: 90,
      skippedEmpty: 7,
      lastError: null,
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "marker-1",
          status: { in: ["NOTIFICATION_WORKFLOW_SCHEDULED", "NOTIFICATION_WORKFLOW_ACTIVE"] },
        },
        data: expect.objectContaining({
          status: "NOTIFICATION_WORKFLOW_COMPLETED",
          summary: expect.objectContaining({
            kind: "daily_notifications_workflow",
            dateKey: "2026-08-02",
            slotsProcessed: ["MORNING", "NOON", "EVENING"],
            usersProcessed: 42,
            pushesSent: 90,
            skippedEmpty: 7,
            retryable: false,
          }),
        }),
      }),
    );
  });

  it("finalizes a pre-delivery orchestration failure as retryable failed", async () => {
    mocks.findUnique.mockResolvedValue({
      summary: { retrySafe: true, firstSlotAttempted: false, deliveryStartedAt: null },
    });
    await finalizeNotificationWorkflowStep({
      markerRunId: "marker-failed-pre",
      dateKey: "2026-08-02",
      slotsProcessed: [],
      usersProcessed: 0,
      pushesSent: 0,
      skippedEmpty: 0,
      lastError: "durable sleep failed",
      isFatalFailure: true,
    });

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE",
          summary: expect.objectContaining({
            dateKey: "2026-08-02",
            lastError: "durable sleep failed",
            retryable: true,
            retrySafe: true,
          }),
        }),
      }),
    );
  });

  it("finalizes a post-delivery orchestration failure as reconciliation required", async () => {
    // Durable evidence says the first delivery attempt began.
    mocks.findUnique.mockResolvedValue({
      summary: {
        retrySafe: false,
        firstSlotAttempted: true,
        deliveryStartedAt: "2026-08-02T06:00:00.000Z",
        completedSlots: ["MORNING"],
      },
    });
    await finalizeNotificationWorkflowStep({
      markerRunId: "marker-failed-post",
      dateKey: "2026-08-02",
      slotsProcessed: ["MORNING"],
      usersProcessed: 3,
      pushesSent: 5,
      skippedEmpty: 0,
      lastError: "durable sleep failed",
      isFatalFailure: true,
    });

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED",
          summary: expect.objectContaining({
            retryable: false,
            retrySafe: false,
            firstSlotAttempted: true,
            completedSlots: ["MORNING"],
          }),
        }),
      }),
    );
  });

  it("keeps a completed-with-errors run non-retry-safe after a successful notification", async () => {
    mocks.findUnique.mockResolvedValue({
      summary: {
        retrySafe: false,
        firstSlotAttempted: true,
        deliveryStartedAt: "2026-08-02T06:00:00.000Z",
        completedSlots: ["MORNING"],
      },
    });
    await finalizeNotificationWorkflowStep({
      markerRunId: "marker-partial",
      dateKey: "2026-08-02",
      slotsProcessed: ["MORNING", "NOON"],
      usersProcessed: 2,
      pushesSent: 4,
      skippedEmpty: 1,
      lastError: "noon slot delivery failed",
    });

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NOTIFICATION_WORKFLOW_COMPLETED_WITH_ERRORS",
          summary: expect.objectContaining({
            retryable: false,
            retrySafe: false,
            firstSlotAttempted: true,
          }),
        }),
      }),
    );
  });
});

describe("notification workflow retry-safety evidence", () => {
  const makeMarkerHarness = (initial: Record<string, unknown> = {}) => {
    const state: { summary: Record<string, unknown> } = { summary: { ...initial } };
    mocks.findUnique.mockImplementation(async () => ({ summary: state.summary }));
    mocks.updateMany.mockImplementation(async ({ data }: any) => {
      state.summary = { ...state.summary, ...(data?.summary ?? {}) };
      return { count: 1 };
    });
    return state;
  };

  const emptySlotResult = () => ({
    results: [] as Array<{ userId: string; sent: number }>,
    stats: { usersProcessed: 0, pushesSent: 0, skippedEmpty: 0, lastError: null },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sleep.mockResolvedValue(undefined);
    mocks.sendDueDailyNotificationsInternal.mockResolvedValue(emptySlotResult());
  });

  it("persists retrySafe before any slot and flips to non-retry-safe before the first delivery attempt", async () => {
    const state = makeMarkerHarness();
    mocks.sendDueDailyNotificationsInternal.mockResolvedValue({
      results: [{ userId: "u1", sent: 2 }],
      stats: { usersProcessed: 1, pushesSent: 2, skippedEmpty: 3, lastError: null },
    });

    await runDailyNotificationsWorkflow({
      dateKey: "2026-08-02",
      triggeredAt: "2026-08-02T06:00:00.000Z",
      markerRunId: "marker-evidence",
    });

    // Claim wrote retrySafe true; the first delivery attempt flipped it and it
    // was never restored.
    expect(state.summary.retrySafe).toBe(false);
    expect(state.summary.firstSlotAttempted).toBe(true);
    expect(typeof state.summary.deliveryStartedAt).toBe("string");
    expect(state.summary.completedSlots).toEqual(["MORNING", "NOON", "EVENING"]);
    expect(mocks.sendDueDailyNotificationsInternal).toHaveBeenCalledTimes(3);
  });

  it("a failure before the first delivery attempt is retryable", async () => {
    makeMarkerHarness();
    mocks.sleep.mockRejectedValue(new Error("durable sleep unavailable"));

    const result = await runDailyNotificationsWorkflow({
      dateKey: "2026-08-02",
      triggeredAt: "2026-08-02T03:00:00.000Z",
      markerRunId: "marker-predelivery",
    });

    expect(result.lastError).toBe("durable sleep unavailable");
    expect(mocks.sendDueDailyNotificationsInternal).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE",
          summary: expect.objectContaining({ retryable: true, retrySafe: true }),
        }),
      }),
    );
  });

  it("a failure after the first slot begins is not retryable", async () => {
    makeMarkerHarness();
    mocks.sendDueDailyNotificationsInternal.mockResolvedValue({
      results: [{ userId: "u1", sent: 2 }],
      stats: { usersProcessed: 1, pushesSent: 2, skippedEmpty: 0, lastError: null },
    });
    // MORNING is due at 06:00 and delivers; the NOON durable sleep then fails.
    mocks.sleep.mockRejectedValue(new Error("durable sleep unavailable"));

    const result = await runDailyNotificationsWorkflow({
      dateKey: "2026-08-02",
      triggeredAt: "2026-08-02T06:00:00.000Z",
      markerRunId: "marker-postdelivery",
    });

    expect(result.lastError).toBe("durable sleep unavailable");
    expect(mocks.sendDueDailyNotificationsInternal).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED",
          summary: expect.objectContaining({ retryable: false, retrySafe: false }),
        }),
      }),
    );
  });

  it("a delivery failure after a successful notification is never retryable", async () => {
    makeMarkerHarness();
    mocks.sendDueDailyNotificationsInternal
      .mockResolvedValueOnce({
        results: [{ userId: "u1", sent: 1 }],
        stats: { usersProcessed: 1, pushesSent: 1, skippedEmpty: 0, lastError: null },
      })
      .mockRejectedValueOnce(new Error("noon boom"))
      .mockResolvedValueOnce({
        results: [{ userId: "u1", sent: 1 }],
        stats: { usersProcessed: 1, pushesSent: 1, skippedEmpty: 0, lastError: null },
      });

    const result = await runDailyNotificationsWorkflow({
      dateKey: "2026-08-02",
      triggeredAt: "2026-08-02T06:00:00.000Z",
      markerRunId: "marker-partial",
    });

    expect(result.slotsProcessed).toEqual(["MORNING", "NOON", "EVENING"]);
    expect(result.lastError).toContain("noon boom");
    expect(mocks.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NOTIFICATION_WORKFLOW_COMPLETED_WITH_ERRORS",
          summary: expect.objectContaining({ retryable: false, retrySafe: false }),
        }),
      }),
    );
  });

  it("marker persistence failure defaults to reconciliation-required and skips delivery", async () => {
    const state = makeMarkerHarness();
    let failNextEvidenceWrite = true;
    mocks.updateMany.mockImplementation(async (args: any) => {
      if (failNextEvidenceWrite && args?.data?.summary?.firstSlotAttempted === true) {
        failNextEvidenceWrite = false;
        throw new Error("marker persistence unavailable");
      }
      state.summary = { ...state.summary, ...(args?.data?.summary ?? {}) };
      return { count: 1 };
    });

    const result = await runDailyNotificationsWorkflow({
      dateKey: "2026-08-02",
      triggeredAt: "2026-08-02T06:00:00.000Z",
      markerRunId: "marker-evidence-fail",
    });

    expect(mocks.sendDueDailyNotificationsInternal).not.toHaveBeenCalled();
    expect(result.lastError).toContain("retry-safety evidence");
    expect(mocks.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED",
        }),
      }),
    );
  });

  it("workflow replay cannot reset retrySafe after delivery started", async () => {
    const state = makeMarkerHarness({
      kind: "daily_notifications_workflow",
      dateKey: "2026-08-02",
      retrySafe: false,
      firstSlotAttempted: true,
      deliveryStartedAt: "2026-08-02T06:00:00.000Z",
      completedSlots: ["MORNING"],
    });

    await runDailyNotificationsWorkflow({
      dateKey: "2026-08-02",
      triggeredAt: "2026-08-02T06:00:00.000Z",
      markerRunId: "marker-replay",
    });

    expect(state.summary.retrySafe).toBe(false);
    expect(state.summary.firstSlotAttempted).toBe(true);
    expect(state.summary.deliveryStartedAt).toBe("2026-08-02T06:00:00.000Z");
  });

  it("the claim step never restores retrySafe once delivery started", async () => {
    const state = makeMarkerHarness({
      retrySafe: false,
      firstSlotAttempted: true,
      deliveryStartedAt: "2026-08-02T06:00:00.000Z",
      completedSlots: ["MORNING"],
    });

    const ok = await claimNotificationRetrySafetyStep("marker-claim");

    expect(ok).toBe(true);
    expect(state.summary.retrySafe).toBe(false);
    expect(state.summary.firstSlotAttempted).toBe(true);
  });

  it("marks each delivery attempt with the bounded durable evidence fields", async () => {
    const state = makeMarkerHarness({ retrySafe: true, firstSlotAttempted: false });

    const ok = await markNotificationDeliveryStartedStep(
      "marker-mark",
      "MORNING",
      new Date("2026-08-02T06:00:00.000Z"),
    );

    expect(ok).toBe(true);
    expect(state.summary).toMatchObject({
      retrySafe: false,
      firstSlotAttempted: true,
      currentSlot: "MORNING",
      nextSlot: "NOON",
      deliveryStartedAt: "2026-08-02T06:00:00.000Z",
    });
  });
});
