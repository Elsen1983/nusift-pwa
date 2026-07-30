import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueMock = vi.fn();
const verifySessionTokenMock = vi.fn();
const getAdminStatusMock = vi.fn();
const deleteCookieMock = vi.fn();
let cookieValue: string | undefined = "session-token";

vi.mock("../../utils/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
  },
}));

vi.mock("../../utils/auth", () => ({
  verifySessionToken: (...args: unknown[]) => verifySessionTokenMock(...args),
}));

vi.mock("../../utils/admin", () => ({
  getAdminStatusByUserId: (...args: unknown[]) => getAdminStatusMock(...args),
}));

type TestEvent = Record<string, never>;
let handler: (event: TestEvent) => Promise<unknown>;

beforeAll(async () => {
  vi.stubGlobal("defineEventHandler", (fn: typeof handler) => fn);
  vi.stubGlobal("getCookie", () => cookieValue);
  vi.stubGlobal("deleteCookie", (...args: unknown[]) => deleteCookieMock(...args));

  const mod = await import("./user-validate.get");
  handler = mod.default as unknown as typeof handler;
});

beforeEach(() => {
  cookieValue = "session-token";
  findUniqueMock.mockReset();
  verifySessionTokenMock.mockReset();
  getAdminStatusMock.mockReset();
  deleteCookieMock.mockReset();
  verifySessionTokenMock.mockReturnValue({
    userId: "user-1",
    email: "admin@example.com",
    onboardingStep: 3,
    tokenVersion: 2,
  });
});

describe("GET /api/auth/user-validate", () => {
  it("returns validation state for a valid session", async () => {
    findUniqueMock.mockResolvedValue({ id: "user-1", tokenVersion: 2 });
    getAdminStatusMock.mockResolvedValue({ isAdmin: true });

    await expect(handler({})).resolves.toEqual({
      success: true,
      valid: true,
      isAdmin: true,
    });
    expect(deleteCookieMock).not.toHaveBeenCalled();
  });

  it("clears cookies for an invalid token", async () => {
    verifySessionTokenMock.mockImplementation(() => {
      throw new Error("jwt expired");
    });

    await expect(handler({})).rejects.toMatchObject({ statusCode: 401 });
    expect(deleteCookieMock).toHaveBeenCalledTimes(2);
  });

  it("returns 503 without clearing cookies when the user lookup times out", async () => {
    findUniqueMock.mockRejectedValue(new Error("timeout exceeded when trying to connect"));

    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 });
    expect(deleteCookieMock).not.toHaveBeenCalled();
  });

  it("returns 503 without clearing cookies when admin lookup times out", async () => {
    findUniqueMock.mockResolvedValue({ id: "user-1", tokenVersion: 2 });
    getAdminStatusMock.mockRejectedValue(new Error("connection pool exhausted"));

    await expect(handler({})).rejects.toMatchObject({ statusCode: 503 });
    expect(deleteCookieMock).not.toHaveBeenCalled();
  });
});
