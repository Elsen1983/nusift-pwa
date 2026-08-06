import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHeader: vi.fn(),
  send: vi.fn(),
  sendInternal: vi.fn(),
}));

(globalThis as typeof globalThis & { defineEventHandler: (handler: unknown) => unknown })
  .defineEventHandler = (handler) => handler;

vi.mock("h3", async (importOriginal) => {
  const original = await importOriginal<typeof import("h3")>();
  return { ...original, getHeader: mocks.getHeader };
});
vi.mock("../../utils/notification-sender", () => ({
  sendDueDailyNotificationsInternal: mocks.sendInternal,
}));

describe("GET /api/internal/send-due-notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret";
    mocks.getHeader.mockImplementation((_event, name) =>
      name === "authorization" ? "Bearer cron-secret" : undefined,
    );
  });

  it("rejects an invalid cron secret", async () => {
    mocks.getHeader.mockReturnValue("Bearer wrong-secret");
    const handler = (await import("./send-due-notifications.get")).default;
    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("sends only currently due digests and returns bounded counts", async () => {
    mocks.sendInternal.mockResolvedValue({
      results: [],
      stats: {
        telemetryVersion: 2,
        usersMatchedSchedule: 2,
        usersAlreadyNotified: 0,
        usersWithoutActiveScope: 0,
        usersWithEmptyFeed: 0,
        inboxNotificationsCreated: 2,
        inboxNotificationFailures: 0,
        usersWithActivePushSubscriptions: 1,
        pushSubscriptionsAttempted: 2,
        pushesDelivered: 2,
        pushesFailed: 0,
        stalePushSubscriptionsDeactivated: 0,
        lastError: null,
        usersProcessed: 2,
        pushesSent: 2,
        skippedEmpty: 0,
      },
    });
    const handler = (await import("./send-due-notifications.get")).default;
    const result = await handler({} as never);

    expect(mocks.sendInternal).toHaveBeenCalledTimes(1);
    expect(mocks.sendInternal.mock.calls[0]![0]).toBeInstanceOf(Date);
    expect(result).toMatchObject({ ok: true, telemetryVersion: 2, inboxNotificationsCreated: 2, pushesDelivered: 2 });
  });
});
