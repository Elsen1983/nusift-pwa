import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdminId = vi.fn();

(globalThis as any).defineEventHandler = (fn: any) => fn;

vi.mock("../../utils/require-admin", () => ({
  requireAdminId: (...args: any[]) => mockRequireAdminId(...args),
}));

describe("GET /api/dev/access", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.NODE_ENV = "production";
    delete process.env.NUXT_ALLOW_PRODUCTION_CLEANUP_RUN;
    mockRequireAdminId.mockResolvedValue("admin-1");
  });

  it("exposes only the confirmed pipeline reset in production", async () => {
    const handler = (await import("./access.get")).default;
    const result = await handler({} as any);

    expect(result).toMatchObject({
      canAccess: true,
      destructiveActionsEnabled: false,
      pipelineResetEnabled: true,
      cleanupDeletionEnabled: false,
    });
  });
});
