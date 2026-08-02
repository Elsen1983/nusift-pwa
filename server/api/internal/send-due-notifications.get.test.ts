import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHeader: vi.fn(),
  send: vi.fn(),
}));

(globalThis as typeof globalThis & { defineEventHandler: (handler: unknown) => unknown })
  .defineEventHandler = (handler) => handler;

vi.mock("h3", async (importOriginal) => {
  const original = await importOriginal<typeof import("h3")>();
  return { ...original, getHeader: mocks.getHeader };
});
vi.mock("../../utils/notification-sender", () => ({
  sendDueDailyNotifications: mocks.send,
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
    mocks.send.mockResolvedValue([
      { userId: "user-1", sent: 2 },
      { userId: "user-2", sent: 0 },
    ]);
    const handler = (await import("./send-due-notifications.get")).default;
    const result = await handler({} as never);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![0]).toBeInstanceOf(Date);
    expect(result).toMatchObject({ ok: true, usersProcessed: 2, pushesSent: 2 });
  });
});
