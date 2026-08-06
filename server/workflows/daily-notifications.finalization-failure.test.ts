import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("../utils/notification-sender", () => ({
  sendDueDailyNotificationsInternal: vi.fn().mockResolvedValue({
    results: [],
    stats: {
      telemetryVersion: 2,
      usersMatchedSchedule: 0,
      usersAlreadyNotified: 0,
      usersWithoutActiveScope: 0,
      usersWithEmptyFeed: 0,
      inboxNotificationsCreated: 0,
      inboxNotificationFailures: 0,
      usersWithActivePushSubscriptions: 0,
      pushSubscriptionsAttempted: 0,
      pushesDelivered: 0,
      pushesFailed: 0,
      stalePushSubscriptionsDeactivated: 0,
      lastError: null,
      usersProcessed: 0,
      pushesSent: 0,
      skippedEmpty: 0,
    },
  }),
}));
vi.mock("../utils/prisma", () => ({
  prisma: { pipelineRun: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } },
}));

import { runDailyNotificationsWorkflow } from "./daily-notifications";

describe("notification workflow finalization failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ summary: {} });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.sleep.mockResolvedValue(undefined);
  });

  it("returns a bounded visible error when final marker persistence fails", async () => {
    let updateCalls = 0;
    mocks.updateMany.mockImplementation(async (args: any) => {
      updateCalls += 1;
      // Evidence writes succeed; only the durable final status write fails.
      if (args?.data?.status) throw new Error("final marker unavailable");
      return { count: 1 };
    });

    const result = await runDailyNotificationsWorkflow({
      dateKey: "2026-08-02",
      triggeredAt: "2026-08-02T23:00:00.000Z",
      markerRunId: "marker-finalization-failure",
    });

    expect(result.lastError).toContain("final marker unavailable");
  });
});
