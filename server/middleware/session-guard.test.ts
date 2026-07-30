import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueMock = vi.fn();
const verifySessionTokenMock = vi.fn();
const deleteCookieMock = vi.fn();
const sendRedirectMock = vi.fn();

vi.mock("../utils/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
  },
}));

vi.mock("../utils/auth", () => ({
  verifySessionToken: (...args: unknown[]) => verifySessionTokenMock(...args),
}));

type TestEvent = {
  context: Record<string, unknown>;
};

let handler: (event: TestEvent) => Promise<unknown>;

beforeAll(async () => {
  vi.stubGlobal("defineEventHandler", (fn: typeof handler) => fn);
  vi.stubGlobal("getRequestURL", () => new URL("https://www.nusift.com/api/dev/agent-source-count"));
  vi.stubGlobal("getCookie", () => "session-token");
  vi.stubGlobal("deleteCookie", (...args: unknown[]) => deleteCookieMock(...args));
  vi.stubGlobal("sendRedirect", (...args: unknown[]) => sendRedirectMock(...args));

  const mod = await import("./session-guard");
  handler = mod.default as typeof handler;
});

beforeEach(() => {
  findUniqueMock.mockReset();
  verifySessionTokenMock.mockReset();
  deleteCookieMock.mockReset();
  sendRedirectMock.mockReset();
  verifySessionTokenMock.mockReturnValue({
    userId: "user-1",
    email: "admin@example.com",
    onboardingStep: 3,
    tokenVersion: 2,
  });
});

describe("session guard failure classification", () => {
  it("attaches a valid session to the event context", async () => {
    findUniqueMock.mockResolvedValue({ id: "user-1", tokenVersion: 2 });
    const event: TestEvent = { context: {} };

    await handler(event);

    expect(event.context.user).toEqual({ id: "user-1" });
    expect(deleteCookieMock).not.toHaveBeenCalled();
  });

  it("clears cookies for an invalid token", async () => {
    verifySessionTokenMock.mockImplementation(() => {
      throw new Error("jwt expired");
    });

    await handler({ context: {} });

    expect(deleteCookieMock).toHaveBeenCalledWith(expect.anything(), "auth_token");
    expect(deleteCookieMock).toHaveBeenCalledWith(expect.anything(), "session_status");
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("clears cookies for a revoked token version", async () => {
    findUniqueMock.mockResolvedValue({ id: "user-1", tokenVersion: 3 });

    await handler({ context: {} });

    expect(deleteCookieMock).toHaveBeenCalledTimes(2);
  });

  it("returns 503 and preserves cookies when session authority times out", async () => {
    findUniqueMock.mockRejectedValue(new Error("timeout exceeded when trying to connect"));

    await expect(handler({ context: {} })).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: "Session authority temporarily unavailable.",
    });
    expect(deleteCookieMock).not.toHaveBeenCalled();
  });
});
