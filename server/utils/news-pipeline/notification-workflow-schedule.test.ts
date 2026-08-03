import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  markerUpdateMany: vi.fn(),
  findUnique: vi.fn(),
  queryRaw: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  start: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    pipelineRun: { updateMany: mocks.markerUpdateMany, findUnique: mocks.findUnique },
  },
}));
vi.mock("workflow/api", () => ({
  start: (...args: any[]) => mocks.start(...args),
  getRun: (...args: any[]) => mocks.getRun(...args),
}));
vi.mock("../../workflows/daily-notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workflows/daily-notifications")>();
  return {
    ...actual,
    // The scheduler only passes the workflow function to the (mocked) runtime;
    // the real claim/mark steps are kept so the production retry-safety
    // evidence path is exercised against the real workflow code.
    runDailyNotificationsWorkflow: { name: "runDailyNotificationsWorkflow" } as unknown as typeof actual.runDailyNotificationsWorkflow,
  };
});

import { ensureDailyNotificationsWorkflow } from "./notification-workflow-schedule";
import { utcDateKey } from "./notification-workflow-constants";

describe("ensureDailyNotificationsWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([{ lock: "" }]);
    mocks.markerUpdateMany.mockResolvedValue({ count: 1 });
    mocks.getRun.mockReturnValue({ exists: Promise.resolve(true), status: Promise.resolve("running") });
    mocks.transaction.mockImplementation((callback) =>
      callback({
        $queryRaw: mocks.queryRaw,
        pipelineRun: {
          findMany: mocks.findMany,
          update: mocks.update,
          updateMany: mocks.updateMany,
          create: mocks.create,
        },
      }),
    );
  });

  it("computes a UTC date key from a timestamp", () => {
    expect(utcDateKey(new Date("2026-08-02T23:30:00.000Z"))).toBe("2026-08-02");
    expect(utcDateKey(new Date("2026-08-03T00:30:00.000Z"))).toBe("2026-08-03");
  });

  it("creates the marker and starts exactly one workflow per day", async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: "marker-1" });
    mocks.start.mockResolvedValue({ runId: "wf-run-1" });

    const result = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));

    expect(result).toMatchObject({
      started: true,
      workflowRunId: "wf-run-1",
      markerRunId: "marker-1",
      dateKey: "2026-08-02",
      reason: "started",
    });
    expect(mocks.start).toHaveBeenCalledWith(
      expect.anything(),
      [{ dateKey: "2026-08-02", triggeredAt: "2026-08-02T03:00:00.000Z", markerRunId: "marker-1" }],
    );
  });

  it("is idempotent: duplicate starts skip when the marker exists", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-existing",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(),
      summary: { kind: "daily_notifications_workflow", dateKey: "2026-08-02" },
    }]);

    const first = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    expect(first).toMatchObject({ started: false, reason: "already_started", markerRunId: "marker-existing" });

    const second = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T09:00:00.000Z"));
    expect(second.started).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("uses the advisory lock to guard the check-and-create", async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: "marker-2" });
    mocks.start.mockResolvedValue({ runId: "wf-run-2" });

    await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    const sql = mocks.queryRaw.mock.calls[0]![0].join(" ");
    expect(sql).toContain("pg_advisory_xact_lock(734821, 120027)::text");
  });

  it("reports start_failed without a workflow run when start() throws", async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: "marker-3" });
    mocks.start.mockRejectedValue(new Error("workflow runtime unavailable"));

    const result = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    expect(result).toMatchObject({ started: false, workflowRunId: null, reason: "start_failed" });
    expect(result.markerRunId).toBe("marker-3");
  });

  it("recovers a failed marker and retries start", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-failed",
      status: "NOTIFICATION_WORKFLOW_FAILED",
      createdAt: new Date(),
      summary: {
        kind: "daily_notifications_workflow",
        dateKey: "2026-08-02",
        attempt: 1,
        failureReason: "temporary start failure",
        retryable: true,
      },
    }]);
    mocks.start.mockResolvedValue({ runId: "wf-retry-1" });

    const result = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));

    expect(result).toMatchObject({
      started: true,
      workflowRunId: "wf-retry-1",
      markerRunId: "marker-failed",
      reason: "started",
    });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "marker-failed" },
      data: expect.objectContaining({ status: "NOTIFICATION_WORKFLOW_SCHEDULED" }),
    }));
  });

  it("recovers a stale scheduled marker but protects a fresh active marker", async () => {
    mocks.findMany.mockResolvedValueOnce([{
      id: "marker-stale",
      status: "NOTIFICATION_WORKFLOW_SCHEDULED",
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
      summary: { kind: "daily_notifications_workflow", dateKey: "2026-08-02" },
    }]);
    mocks.start.mockResolvedValue({ runId: "wf-stale-retry" });

    const recovered = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    expect(recovered).toMatchObject({ started: true, markerRunId: "marker-stale" });

    mocks.findMany.mockResolvedValueOnce([{
      id: "marker-active",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      summary: {
        kind: "daily_notifications_workflow",
        dateKey: "2026-08-02",
        workflowRunId: "wf-active",
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    }]);
    const protectedResult = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T09:00:00.000Z"));
    expect(protectedResult).toMatchObject({
      started: false,
      reason: "reconciled",
      markerRunId: "marker-active",
      markerStatus: "NOTIFICATION_WORKFLOW_ACTIVE",
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("persists the durable workflow run ID after a successful start", async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: "marker-run-id" });
    mocks.start.mockResolvedValue({ runId: "workflow-run-persisted" });

    await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));

    expect(mocks.markerUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "marker-run-id", status: "NOTIFICATION_WORKFLOW_SCHEDULED" },
      data: expect.objectContaining({
        status: "NOTIFICATION_WORKFLOW_ACTIVE",
        summary: expect.objectContaining({ workflowRunId: "workflow-run-persisted" }),
      }),
    }));
  });

  it("does not steal a marker when start succeeds but run-ID persistence fails", async () => {
    mocks.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "marker-uncertain",
        status: "NOTIFICATION_WORKFLOW_SCHEDULED",
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
        summary: {
          kind: "daily_notifications_workflow",
          dateKey: "2026-08-02",
          startState: "launching",
          startingAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        },
      }]);
    mocks.create.mockResolvedValue({ id: "marker-uncertain" });
    mocks.start.mockResolvedValue({ runId: "workflow-uncertain" });
    mocks.markerUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("marker persistence unavailable"));

    const started = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    const followUp = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T04:00:00.000Z"));

    expect(started).toMatchObject({ started: true, workflowRunId: "workflow-uncertain" });
    expect(followUp).toMatchObject({
      started: false,
      reason: "reconciliation_required",
      markerRunId: "marker-uncertain",
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent initial calls so only one workflow starts", async () => {
    let marker: { id: string; status: string; createdAt: Date; summary: any } | null = null;
    let transactionTail = Promise.resolve();
    mocks.transaction.mockImplementation((callback: (tx: any) => Promise<unknown>) => {
      const current = transactionTail.then(() => callback({
        $queryRaw: mocks.queryRaw,
        pipelineRun: {
          findMany: vi.fn(async () => marker ? [marker] : []),
          update: mocks.update,
          updateMany: mocks.updateMany,
          create: vi.fn(async ({ data }: any) => {
            marker = {
              id: "marker-concurrent",
              status: data.status,
              createdAt: new Date(),
              summary: data.summary,
            };
            return { id: marker.id };
          }),
        },
      }));
      transactionTail = current.then(() => undefined, () => undefined);
      return current;
    });
    mocks.start.mockResolvedValue({ runId: "workflow-concurrent" });

    const results = await Promise.all([
      ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z")),
      ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:01.000Z")),
    ]);

    expect(results.filter((result) => result.started)).toHaveLength(1);
    expect(results.filter((result) => result.reason === "already_started")).toHaveLength(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent retries of one failed marker", async () => {
    let marker: { id: string; status: string; createdAt: Date; summary: any } = {
      id: "marker-concurrent-failed",
      status: "NOTIFICATION_WORKFLOW_FAILED",
      createdAt: new Date(),
      summary: {
        kind: "daily_notifications_workflow",
        dateKey: "2026-08-02",
        attempt: 1,
        failureReason: "temporary failure",
        retryable: true,
      },
    };
    let transactionTail = Promise.resolve();
    mocks.transaction.mockImplementation((callback: (tx: any) => Promise<unknown>) => {
      const current = transactionTail.then(() => callback({
        $queryRaw: mocks.queryRaw,
        pipelineRun: {
          findMany: vi.fn(async () => [marker]),
          update: vi.fn(async ({ data }: any) => {
            marker = { ...marker, status: data.status, summary: data.summary };
          }),
          updateMany: mocks.updateMany,
          create: mocks.create,
        },
      }));
      transactionTail = current.then(() => undefined, () => undefined);
      return current;
    });
    mocks.start.mockRejectedValue(new Error("retry start failed"));

    const results = await Promise.all([
      ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z")),
      ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:01.000Z")),
    ]);

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.reason === "start_failed")).toHaveLength(1);
    expect(results.filter((result) => result.reason === "already_started")).toHaveLength(1);
  });

  it("reconciles a known completed external workflow without starting another", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-known-completed",
      status: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED",
      createdAt: new Date(),
      summary: {
        kind: "daily_notifications_workflow",
        dateKey: "2026-08-02",
        workflowRunId: "workflow-known-completed",
        startState: "reconciliation_required",
      },
    }]);
    mocks.getRun.mockReturnValue({ exists: Promise.resolve(true), status: Promise.resolve("completed") });
    const result = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    expect(result).toMatchObject({ started: false, reason: "reconciled", markerStatus: "NOTIFICATION_WORKFLOW_COMPLETED" });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not retry a failed external workflow without retry-safety proof", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-known-failed",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(),
      summary: {
        kind: "daily_notifications_workflow",
        dateKey: "2026-08-02",
        workflowRunId: "workflow-known-failed",
        startState: "started",
      },
    }]);
    mocks.getRun.mockReturnValue({ exists: Promise.resolve(true), status: Promise.resolve("failed") });
    const result = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    expect(result).toMatchObject({ started: false, reason: "reconciled", markerStatus: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED" });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("permits a guarded retry when the external run is missing and durable evidence proves no delivery", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-known-missing",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(),
      summary: {
        kind: "daily_notifications_workflow",
        dateKey: "2026-08-02",
        workflowRunId: "workflow-known-missing",
        startState: "started",
        // Written by the workflow's claim step before any slot was processed.
        retrySafe: true,
        firstSlotAttempted: false,
        deliveryStartedAt: null,
      },
    }]);
    mocks.getRun.mockReturnValue({ exists: Promise.resolve(false), status: Promise.resolve("unknown") });
    const result = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    expect(result).toMatchObject({ started: false, reason: "reconciled", markerStatus: "NOTIFICATION_WORKFLOW_FAILED_RETRYABLE" });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("never retries a missing external run without durable retry-safety proof", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "marker-missing-unproven",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(),
      summary: {
        kind: "daily_notifications_workflow",
        dateKey: "2026-08-02",
        workflowRunId: "workflow-missing-unproven",
        startState: "started",
        // No retrySafe evidence: retry safety must not be inferred from the
        // missing external status alone.
        retrySafe: false,
        firstSlotAttempted: true,
        deliveryStartedAt: "2026-08-02T06:00:00.000Z",
      },
    }]);
    mocks.getRun.mockReturnValue({ exists: Promise.resolve(false), status: Promise.resolve("unknown") });
    const result = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    expect(result).toMatchObject({ started: false, reason: "reconciled", markerStatus: "NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED" });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("receives real retry-safety evidence from the workflow claim step before reconciling", async () => {
    // The scheduler starts a workflow, then the PRODUCTION claim step writes
    // the durable evidence; the scheduler later reads exactly that evidence.
    const markerState: { summary: Record<string, unknown> } = { summary: {} };
    mocks.findUnique.mockImplementation(async () => ({ summary: markerState.summary }));
    mocks.markerUpdateMany.mockImplementation(async ({ data }: any) => {
      markerState.summary = { ...markerState.summary, ...(data?.summary ?? {}) };
      return { count: 1 };
    });
    mocks.findMany.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: "marker-real" });
    mocks.start.mockResolvedValue({ runId: "wf-real-1" });

    const started = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    expect(started.started).toBe(true);

    // Production workflow claim step persists retrySafe: true before slots.
    const { claimNotificationRetrySafetyStep } = await import("../../workflows/daily-notifications");
    expect(await claimNotificationRetrySafetyStep("marker-real")).toBe(true);
    expect(markerState.summary.retrySafe).toBe(true);
    expect(markerState.summary.firstSlotAttempted).toBe(false);

    // The external run fails; the scheduler reconciles using ONLY that durable evidence.
    mocks.findMany.mockResolvedValue([{
      id: "marker-real",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(),
      summary: { ...markerState.summary, workflowRunId: "wf-real-1", startState: "started" },
    }]);
    mocks.getRun.mockReturnValue({ exists: Promise.resolve(true), status: Promise.resolve("failed") });
    const reconciled = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T09:00:00.000Z"));
    expect(reconciled.markerStatus).toBe("NOTIFICATION_WORKFLOW_FAILED_RETRYABLE");
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("blocks retries once the production delivery-start evidence exists", async () => {
    const markerState: { summary: Record<string, unknown> } = { summary: {} };
    mocks.findUnique.mockImplementation(async () => ({ summary: markerState.summary }));
    mocks.markerUpdateMany.mockImplementation(async ({ data }: any) => {
      markerState.summary = { ...markerState.summary, ...(data?.summary ?? {}) };
      return { count: 1 };
    });
    mocks.findMany.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: "marker-real-2" });
    mocks.start.mockResolvedValue({ runId: "wf-real-2" });

    const started = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T03:00:00.000Z"));
    expect(started.started).toBe(true);

    // Production workflow flips the durable evidence before the first delivery.
    const { markNotificationDeliveryStartedStep } = await import("../../workflows/daily-notifications");
    await markNotificationDeliveryStartedStep("marker-real-2", "MORNING", new Date("2026-08-02T06:00:00.000Z"));
    expect(markerState.summary.retrySafe).toBe(false);
    expect(markerState.summary.firstSlotAttempted).toBe(true);

    // A later external failure must NOT become retryable.
    mocks.findMany.mockResolvedValue([{
      id: "marker-real-2",
      status: "NOTIFICATION_WORKFLOW_ACTIVE",
      createdAt: new Date(),
      summary: { ...markerState.summary, workflowRunId: "wf-real-2", startState: "started" },
    }]);
    mocks.getRun.mockReturnValue({ exists: Promise.resolve(true), status: Promise.resolve("failed") });
    const reconciled = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T09:00:00.000Z"));
    expect(reconciled.markerStatus).toBe("NOTIFICATION_WORKFLOW_RECONCILIATION_REQUIRED");
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("creates a new marker for a new UTC day", async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: "marker-4" });
    mocks.start.mockResolvedValue({ runId: "wf-run-4" });

    const first = await ensureDailyNotificationsWorkflow(new Date("2026-08-02T23:00:00.000Z"));
    mocks.findMany.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: "marker-5" });
    const second = await ensureDailyNotificationsWorkflow(new Date("2026-08-03T00:30:00.000Z"));

    expect(first.dateKey).toBe("2026-08-02");
    expect(second.dateKey).toBe("2026-08-03");
    expect(second.markerRunId).toBe("marker-5");
  });
});
