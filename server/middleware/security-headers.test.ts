import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const setResponseHeaderMock = vi.hoisted(() => vi.fn());

vi.mock("h3", () => ({
  setResponseHeader: (...args: unknown[]) => setResponseHeaderMock(...args),
}));

let handler: (event: { path: string }) => unknown;

beforeAll(async () => {
  vi.stubGlobal("defineEventHandler", (fn: typeof handler) => fn);
  handler = (await import("./security-headers")).default as typeof handler;
});

beforeEach(() => {
  setResponseHeaderMock.mockReset();
});

describe("security headers", () => {
  it("protects dotted application routes", () => {
    const event = { path: "/api/report.v2" };
    handler(event);

    expect(setResponseHeaderMock).toHaveBeenCalledWith(
      event,
      "X-Content-Type-Options",
      "nosniff",
    );
  });

  it("denies framing in the CSP", () => {
    handler({ path: "/dashboard" });

    const cspCall = setResponseHeaderMock.mock.calls.find((call) => call[1] === "Content-Security-Policy");
    expect(cspCall?.[2]).toContain("frame-ancestors 'none'");
  });
});
