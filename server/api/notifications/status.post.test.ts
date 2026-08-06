import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
}));

(globalThis as typeof globalThis & { defineEventHandler: (handler: unknown) => unknown }).defineEventHandler = (handler) => handler;

vi.mock("../../utils/prisma", () => ({
  prisma: {
    pushSubscription: { count: mocks.count, findFirst: mocks.findFirst, updateMany: mocks.updateMany },
    user: { findUnique: mocks.findUnique },
  },
}));
vi.mock("../../utils/require-user", () => ({ requireUserId: () => "user-1" }));
vi.mock("h3", async (importOriginal) => {
  const original = await importOriginal<typeof import("h3")>();
  return { ...original, readBody: vi.fn(async () => ({ currentEndpoint: "https://push.example/current" })) };
});

describe("POST /api/notifications/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.count.mockResolvedValue(2);
    mocks.findFirst.mockResolvedValue({ isActive: true });
    mocks.findUnique.mockResolvedValue({ notificationScheduleSlot: "MORNING", allowBreakingNotifications: true });
  });

  it("returns only aggregate and current-endpoint state", async () => {
    const handler = (await import("./status.post")).default;
    const result = await handler({} as never);
    expect(result).toEqual({
      enabled: true,
      activeCount: 2,
      currentEndpointActive: true,
      scheduleSlot: "MORNING",
      allowBreakingNotifications: true,
    });
    expect(JSON.stringify(result)).not.toContain("push.example");
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1", endpoint: "https://push.example/current", isActive: true },
    }));
  });
});
