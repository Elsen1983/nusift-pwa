import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserIdMock = vi.fn();
const userFindUniqueMock = vi.fn();

vi.mock("../../utils/require-user", () => ({ requireUserId: requireUserIdMock }));
vi.mock("../../utils/prisma", () => ({ prisma: { user: { findUnique: userFindUniqueMock } } }));
vi.stubGlobal("defineEventHandler", (handler: any) => handler);

describe("Prompt 13 inspection authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.NUXT_ADMIN_EMAILS = "Configured.Admin@Example.com";
    requireUserIdMock.mockReturnValue("user-1");
  });

  it("accepts configured email case-insensitively even without ADMIN role", async () => {
    userFindUniqueMock.mockResolvedValue({ email: "configured.admin@example.com" });
    const { requireInspectionAdmin } = await import("../../utils/require-inspection-admin");
    await expect(requireInspectionAdmin({ context: { user: { id: "spoofed" } } } as any)).resolves.toBe("user-1");
  });

  it("rejects ADMIN role without configured email and ignores spoofed request email", async () => {
    userFindUniqueMock.mockResolvedValue({ email: "ordinary@example.com", role: "ADMIN" });
    const { requireInspectionAdmin } = await import("../../utils/require-inspection-admin");
    await expect(requireInspectionAdmin({ headers: { get: () => "Configured.Admin@Example.com" }, body: { email: "Configured.Admin@Example.com" } } as any)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("preserves 401 for unauthenticated requests", async () => {
    requireUserIdMock.mockImplementation(() => { throw Object.assign(new Error("Unauthorized"), { statusCode: 401 }); });
    const { requireInspectionAdmin } = await import("../../utils/require-inspection-admin");
    await expect(requireInspectionAdmin({} as any)).rejects.toMatchObject({ statusCode: 401 });
  });
});
