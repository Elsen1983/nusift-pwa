import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h3Mocks = vi.hoisted(() => ({
  getCookie: vi.fn(),
  getHeader: vi.fn(),
}));

vi.mock("h3", () => ({
  createError: (input: Record<string, unknown>) => Object.assign(new Error(String(input.statusMessage)), input),
  getCookie: (...args: unknown[]) => h3Mocks.getCookie(...args),
  getHeader: (...args: unknown[]) => h3Mocks.getHeader(...args),
}));

type TestEvent = { method: string; path: string };
let handler: (event: TestEvent) => unknown;

beforeAll(async () => {
  vi.stubGlobal("defineEventHandler", (fn: typeof handler) => fn);
  vi.stubGlobal("getRequestURL", (event: TestEvent) => new URL(event.path, "https://www.nusift.com"));
  vi.stubGlobal("useRuntimeConfig", () => ({ public: { appUrl: "https://www.nusift.com" } }));
  handler = (await import("./csrf-guard")).default as typeof handler;
});

beforeEach(() => {
  h3Mocks.getCookie.mockReset();
  h3Mocks.getHeader.mockReset();
  h3Mocks.getHeader.mockReturnValue(undefined);
  h3Mocks.getCookie.mockReturnValue(undefined);
});

describe("CSRF guard workflow runner boundary", () => {
  it.each([
    "/api/internal/run-agent2-headless",
    "/api/internal/run-agent3",
  ])("allows the secret-authenticated server POST to %s", (path) => {
    expect(() => handler({ method: "POST", path })).not.toThrow();
  });

  it("does not exempt arbitrary internal POST endpoints", () => {
    expect(() => handler({ method: "POST", path: "/api/internal/arbitrary" })).toThrowError(
      expect.objectContaining({ statusCode: 403, statusMessage: "Missing request origin." }),
    );
  });

  it("continues to allow same-origin browser POST requests", () => {
    h3Mocks.getHeader.mockImplementation((_event, name: string) =>
      name === "origin" ? "https://www.nusift.com" : undefined,
    );

    expect(() => handler({ method: "POST", path: "/api/dev/run-news-pipeline" })).not.toThrow();
  });
});
