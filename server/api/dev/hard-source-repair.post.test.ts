import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminId: vi.fn(),
  assertRateLimit: vi.fn(),
  readBody: vi.fn(),
  repair: vi.fn(),
}));

vi.mock("h3", () => ({
  createError: ({ statusCode, statusMessage }: { statusCode: number; statusMessage: string }) => {
    const error = new Error(statusMessage) as Error & { statusCode: number };
    error.statusCode = statusCode;
    return error;
  },
  readBody: (...args: any[]) => mocks.readBody(...args),
}));
vi.mock("../../utils/require-admin", () => ({ requireAdminId: (...args: any[]) => mocks.requireAdminId(...args) }));
vi.mock("../../utils/rate-limit", () => ({ assertRateLimit: (...args: any[]) => mocks.assertRateLimit(...args) }));
vi.mock("../../utils/news-pipeline/hard-source-repair", () => ({
  findRuntimeEvidenceOnlyProfiles: vi.fn(),
  repairRuntimeEvidenceOnlyProfiles: (...args: any[]) => mocks.repair(...args),
}));

(globalThis as any).defineEventHandler = (handler: any) => handler;

const loadHandler = async () => (await import("./hard-source-repair.post")).default;
const profile = {
  id: "p1",
  sourceId: "s1",
  categoryId: null,
  targetUrl: "https://example.com/news",
  staticQuality: "failed",
  browserStatus: "BROWSER_RUNTIME_UNAVAILABLE",
  failureCount: 1,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminId.mockResolvedValue("admin-1");
  mocks.assertRateLimit.mockResolvedValue(undefined);
  mocks.readBody.mockResolvedValue({});
  mocks.repair.mockResolvedValue({
    dryRun: true,
    scanned: 1,
    matched: 1,
    updated: 0,
    failed: 0,
    profiles: [profile],
  });
});

describe("POST /api/dev/hard-source-repair", () => {
  it("rejects unauthorized callers before scanning or writing", async () => {
    mocks.requireAdminId.mockRejectedValue(Object.assign(new Error("Admin access required."), { statusCode: 403 }));
    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.assertRateLimit).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("requires admin authorization and rate limiting", async () => {
    const handler = await loadHandler();
    await handler({} as any);
    expect(mocks.requireAdminId).toHaveBeenCalled();
    expect(mocks.assertRateLimit).toHaveBeenCalledWith(expect.anything(), "hard-source-repair", 5, 60_000);
  });

  it("defaults to a bounded dry-run", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);
    expect(result.dryRun).toBe(true);
    expect(mocks.repair).toHaveBeenCalledWith({ dryRun: true, scanLimit: undefined });
  });

  it.each([undefined, "", "WRONG_TOKEN"])('rejects destructive request with confirmation=%s', async (confirmation) => {
    mocks.readBody.mockResolvedValue({ dryRun: false, confirmation });
    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("accepts the exact confirmation token and clamps scanLimit", async () => {
    mocks.readBody.mockResolvedValue({
      dryRun: false,
      confirmation: "REPAIR_RUNTIME_ONLY_HARD_SOURCE_PROFILES",
      scanLimit: 9999,
    });
    mocks.repair.mockResolvedValue({ ...mocks.repair.mock.results[0]?.value, dryRun: false, scanned: 1, matched: 1, updated: 1, failed: 0, profiles: [profile] });
    const handler = await loadHandler();
    const result = await handler({} as any);
    expect(mocks.repair).toHaveBeenCalledWith({ dryRun: false, scanLimit: 500 });
    expect(result).toMatchObject({ ok: true, dryRun: false, matched: 1, updated: 1 });
  });

  it("never mutates unrelated profiles through the endpoint", async () => {
    const handler = await loadHandler();
    await handler({} as any);
    expect(mocks.repair).toHaveBeenCalledTimes(1);
    expect(mocks.repair.mock.calls[0]?.[0]).toEqual({ dryRun: true, scanLimit: undefined });
  });
});
