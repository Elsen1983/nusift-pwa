import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h3Mocks = vi.hoisted(() => ({
  getCookie: vi.fn(),
  getHeader: vi.fn(),
  getRequestIP: vi.fn(),
}));

vi.mock("h3", () => ({
  createError: (input: Record<string, unknown>) => Object.assign(new Error(String(input.statusMessage)), input),
  getCookie: (...args: unknown[]) => h3Mocks.getCookie(...args),
  getHeader: (...args: unknown[]) => h3Mocks.getHeader(...args),
  getRequestIP: (...args: unknown[]) => h3Mocks.getRequestIP(...args),
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
  h3Mocks.getRequestIP.mockReset();
  h3Mocks.getHeader.mockReturnValue(undefined);
  h3Mocks.getCookie.mockReturnValue(undefined);
  h3Mocks.getRequestIP.mockReturnValue("203.0.113.10");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CSRF guard workflow runner boundary", () => {
  it.each([
    "/api/internal/run-agent2-headless",
    "/api/internal/run-agent3",
  ])("allows the secret-authenticated server POST to %s", (path) => {
    expect(() => handler({ method: "POST", path })).not.toThrow();
  });

  it.each([
    "/.well-known/workflow/v1/flow",
    "/.well-known/workflow/v1/step",
  ])("allows the self-hosted workflow worker to POST locally to %s", (path) => {
    vi.stubEnv("NUSIFT_SELF_HOSTED", "true");
    h3Mocks.getRequestIP.mockReturnValue("::ffff:127.0.0.1");

    expect(() => handler({ method: "POST", path })).not.toThrow();
  });

  it.each([
    "/.well-known/workflow/v1/flow",
    "/.well-known/workflow/v1/step",
  ])("does not expose the self-hosted workflow route remotely at %s", (path) => {
    vi.stubEnv("NUSIFT_SELF_HOSTED", "true");

    expect(() => handler({ method: "POST", path })).toThrowError(
      expect.objectContaining({ statusCode: 403, statusMessage: "Missing request origin." }),
    );
  });

  it("does not exempt a local workflow route outside self-hosted mode", () => {
    h3Mocks.getRequestIP.mockReturnValue("127.0.0.1");

    expect(() => handler({ method: "POST", path: "/.well-known/workflow/v1/flow" })).toThrowError(
      expect.objectContaining({ statusCode: 403, statusMessage: "Missing request origin." }),
    );
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
