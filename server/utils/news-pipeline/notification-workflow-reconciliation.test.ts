import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("../prisma", () => ({
  prisma: { pipelineRun: { findMany: mocks.findMany, findUnique: mocks.findUnique, updateMany: mocks.updateMany } },
}));
vi.mock("workflow/api", () => ({ getRun: mocks.getRun }));

import {
  inspectNotificationWorkflowMarkers,
  reconcileNotificationWorkflowMarker,
  RECONCILIATION_STALE_MS,
} from "./notification-workflow-reconciliation";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.getRun.mockImplementation(() => ({ exists: Promise.resolve(true), status: Promise.resolve("running") }));
});

describe("notification workflow reconciliation", () => {
  it("normalizes a stale launching marker with bounded evidence", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-1",
      status: "NOTIFICATION_WORKFLOW_SCHEDULED",
      createdAt: new Date(Date.now() - RECONCILIATION_STALE_MS - 1000),
      summary: {
        kind: "daily_notifications_workflow",
        dateKey: "2026-08-02",
        startState: "launching",
        launchAttemptId: "attempt-1",
        launchAttemptedAt: new Date(Date.now() - RECONCILIATION_STALE_MS - 1000).toISOString(),
        failureReason: "x".repeat(1000),
        usersProcessed: 2,
        pushesSent: 1,
      },
    }]);
    const result = await inspectNotificationWorkflowMarkers({ dateKey: "2026-08-02" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "marker-1",
      staleLaunching: true,
      launchAttemptId: "attempt-1",
      summary: { usersProcessed: 2, pushesSent: 1 },
    });
    expect(result[0]!.failureReason).toHaveLength(300);
  });

  it("exposes the durable retry-safety evidence fields", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-evidence",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(),
      summary: {
        kind: "daily_notifications_workflow",
        dateKey: "2026-08-02",
        startState: "started",
        retrySafe: false,
        firstSlotAttempted: true,
        deliveryStartedAt: "2026-08-02T06:00:00.000Z",
        currentSlot: "NOON",
        nextSlot: "EVENING",
        completedSlots: ["MORNING", "NOON", "EVENING"],
      },
    }]);
    const result = await inspectNotificationWorkflowMarkers({ dateKey: "2026-08-02" });
    expect(result[0]!.summary).toMatchObject({
      retrySafe: false,
      firstSlotAttempted: true,
      deliveryStartedAt: "2026-08-02T06:00:00.000Z",
      currentSlot: "NOON",
      nextSlot: "EVENING",
      completedSlots: ["MORNING", "NOON", "EVENING"],
    });
  });

  it("is read-only without confirmation", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "marker-2",
      status: "NOTIFICATION_WORKFLOW_SCHEDULED",
      createdAt: new Date(Date.now() - RECONCILIATION_STALE_MS - 1000),
      summary: { kind: "daily_notifications_workflow", dateKey: "2026-08-02", startState: "launching" },
    });
    const result = await reconcileNotificationWorkflowMarker({ markerRunId: "marker-2" });
    expect(result.reason).toBe("confirmation_required");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("explicitly marks an uncertain outcome without starting a workflow", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "marker-3",
      status: "NOTIFICATION_WORKFLOW_SCHEDULED",
      createdAt: new Date(Date.now() - RECONCILIATION_STALE_MS - 1000),
      summary: { kind: "daily_notifications_workflow", dateKey: "2026-08-02", startState: "launching" },
    });
    const result = await reconcileNotificationWorkflowMarker({
      markerRunId: "marker-3",
      confirmation: "RECONCILE_NOTIFICATION_WORKFLOW_MARKER",
    });
    expect(result).toMatchObject({ changed: true, reason: "reconciliation_required" });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "marker-3", status: { in: ["NOTIFICATION_WORKFLOW_SCHEDULED", "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED"] } },
      data: expect.objectContaining({
        status: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED",
        summary: expect.objectContaining({ reconciliationRequired: true }),
      }),
    }));
  });

  it("reports a known active external workflow without authorizing a restart", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-active",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(),
      summary: { kind: "daily_notifications_workflow", dateKey: "2026-08-02", startState: "started", workflowRunId: "wf-active" },
    }]);
    mocks.getRun.mockReturnValue({ exists: Promise.resolve(true), status: Promise.resolve("running") });
    const result = await inspectNotificationWorkflowMarkers({ dateKey: "2026-08-02" });
    expect(result[0]).toMatchObject({ externalWorkflow: { exists: true, status: "running" }, reconciliationOutcome: "active", resultingState: "NOTIFICATION_WORKFLOW_ACTIVE" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("reports a completed external workflow", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-completed",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(),
      summary: { kind: "daily_notifications_workflow", dateKey: "2026-08-02", startState: "started", workflowRunId: "wf-completed" },
    }]);
    mocks.getRun.mockReturnValue({ exists: Promise.resolve(true), status: Promise.resolve("completed") });
    const result = await inspectNotificationWorkflowMarkers({ dateKey: "2026-08-02" });
    expect(result[0]).toMatchObject({ externalWorkflow: { exists: true, status: "completed" }, reconciliationOutcome: "completed" });
  });

  it("reports an inconclusive lookup and never treats it as retryable", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-unknown",
      status: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED",
      createdAt: new Date(),
      summary: { kind: "daily_notifications_workflow", dateKey: "2026-08-02", startState: "launching", workflowRunId: "wf-unknown" },
    }]);
    mocks.getRun.mockImplementation(() => { throw new Error("lookup unavailable"); });
    const result = await inspectNotificationWorkflowMarkers({ dateKey: "2026-08-02" });
    expect(result[0]).toMatchObject({ reconciliationOutcome: "inconclusive", summary: { reconciliationRequired: true } });
  });

  it("can explicitly abandon an uncertain marker without starting a workflow", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "marker-abandon",
      status: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED",
      createdAt: new Date(),
      summary: { kind: "daily_notifications_workflow", dateKey: "2026-08-02", startState: "reconciliation_required" },
    });
    const result = await reconcileNotificationWorkflowMarker({ markerRunId: "marker-abandon", confirmation: "RECONCILE_NOTIFICATION_WORKFLOW_MARKER", action: "abandon" });
    expect(result).toMatchObject({ changed: true, reason: "abandoned", marker: { status: "NOTIFICATION_WORKFLOW_ABANDONED" } });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "NOTIFICATION_WORKFLOW_ABANDONED" }) }));
  });

  it("does not change a known active workflow marker", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "marker-4",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(Date.now() - RECONCILIATION_STALE_MS - 1000),
      summary: { kind: "daily_notifications_workflow", dateKey: "2026-08-02", startState: "started", workflowRunId: "wf-4" },
    });
    const result = await reconcileNotificationWorkflowMarker({ markerRunId: "marker-4", confirmation: "RECONCILE_NOTIFICATION_WORKFLOW_MARKER" });
    expect(result).toMatchObject({ changed: false, reason: "not_stale" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
