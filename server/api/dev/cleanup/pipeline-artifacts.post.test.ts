import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRequireAdminId = vi.fn();
const mockAssertRateLimit = vi.fn();
const mockReadBody = vi.fn();
const mockProcessCleanup = vi.fn();

(globalThis as any).defineEventHandler = (fn: any) => fn;
(globalThis as any).readBody = (...args: any[]) => mockReadBody(...args);

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
  createError: ({ statusCode, statusMessage }: { statusCode: number; statusMessage: string }) => {
    const err = new Error(statusMessage) as Error & { statusCode: number };
    err.statusCode = statusCode;
    return err;
  },
}));

vi.mock("../../../utils/require-admin", () => ({
  requireAdminId: (...args: any[]) => mockRequireAdminId(...args),
}));

vi.mock("../../../utils/rate-limit", () => ({
  assertRateLimit: (...args: any[]) => mockAssertRateLimit(...args),
}));

vi.mock("../../../utils/news-pipeline/pipeline-artifact-cleanup", () => ({
  processPipelineArtifactCleanup: (...args: any[]) => mockProcessCleanup(...args),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/dev/cleanup/pipeline-artifacts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.NODE_ENV = "test";
    delete process.env.NUXT_ALLOW_PRODUCTION_CLEANUP_RUN;
    mockRequireAdminId.mockResolvedValue("admin-1");
    mockAssertRateLimit.mockResolvedValue(undefined);
    mockReadBody.mockResolvedValue({});
    mockProcessCleanup.mockResolvedValue({
      ok: true,
      dryRun: true,
      olderThanDays: 14,
      cutoff: "2026-07-13T12:00:00.000Z",
      inspected: 10,
      eligibleForDeletion: 4,
      deleted: 0,
      protected: 5,
      skipped: 1,
      limit: 200,
      durationMs: 18,
      byArtifactType: { article_discovery_headless_required: 10 },
      byStatus: { RESOLVED: 4, BROWSER_NO_CANDIDATES: 5, HEADLESS_PROCESSING: 1 },
      protectedReasons: { active_inflight_status: 1, no_newer_success_for_target: 4 },
      skippedReasons: { protected: 5, unhandled_status_conservative_skip: 1 },
      sampleDeletedOrWouldDelete: [],
    });
  });

  async function loadHandler() {
    const mod = await import("./pipeline-artifacts.post");
    return mod.default;
  }

  it("requires admin access", async () => {
    mockRequireAdminId.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    );
    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 403 });
  });

  // ── Production policy tests ─────────────────────────────────────────────

  it("allows dryRun=false in non-production", async () => {
    process.env.NODE_ENV = "test";
    mockReadBody.mockResolvedValue({ dryRun: false });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
  });

  it("allows dryRun=true in production", async () => {
    process.env.NODE_ENV = "production";
    mockReadBody.mockResolvedValue({ dryRun: true });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("allows omitted dryRun (defaults to true) in production", async () => {
    process.env.NODE_ENV = "production";
    mockReadBody.mockResolvedValue({});
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("blocks dryRun=false in production when env flag missing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.NUXT_ALLOW_PRODUCTION_CLEANUP_RUN;
    mockReadBody.mockResolvedValue({ dryRun: false });
    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({
      statusCode: 403,
      message: "Production cleanup deletion is disabled.",
    });
    expect(mockAssertRateLimit).not.toHaveBeenCalled();
    expect(mockProcessCleanup).not.toHaveBeenCalled();
  });

  it("allows dryRun=false in production when NUXT_ALLOW_PRODUCTION_CLEANUP_RUN=true", async () => {
    process.env.NODE_ENV = "production";
    process.env.NUXT_ALLOW_PRODUCTION_CLEANUP_RUN = "true";
    mockReadBody.mockResolvedValue({ dryRun: false });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
  });

  // ── Rate limit + admin ──────────────────────────────────────────────────

  it("calls assertRateLimit with cleanup-pipeline-artifacts-run / 3 / 10min", async () => {
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockAssertRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "cleanup-pipeline-artifacts-run",
      3,
      10 * 60 * 1000,
    );
  });

  // ── Body param parsing ──────────────────────────────────────────────────

  it("defaults dryRun=true when body has no dryRun field", async () => {
    mockReadBody.mockResolvedValue({});
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("defaults dryRun=true when body.dryRun is not exactly false", async () => {
    mockReadBody.mockResolvedValue({ dryRun: true });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("passes dryRun=false through to the utility when explicitly false", async () => {
    mockReadBody.mockResolvedValue({ dryRun: false });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
  });

  it("defaults olderThanDays=14 and limit=200", async () => {
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ olderThanDays: 14, limit: 200 }),
    );
  });

  it("parses and clamps body params", async () => {
    mockReadBody.mockResolvedValue({ olderThanDays: 30, limit: 500 });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ olderThanDays: 30, limit: 500 }),
    );
  });

  it("clamps olderThanDays to max 365", async () => {
    mockReadBody.mockResolvedValue({ olderThanDays: 99999 });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ olderThanDays: 365 }),
    );
  });

  it("clamps limit to max 1000", async () => {
    mockReadBody.mockResolvedValue({ limit: 99999 });
    const handler = await loadHandler();
    await handler({} as any);
    expect(mockProcessCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000 }),
    );
  });

  it("returns the utility result directly (compact)", async () => {
    const handler = await loadHandler();
    const result = await handler({} as any);
    expect(result.ok).toBe(true);
    expect(result.byStatus).toEqual({
      RESOLVED: 4,
      BROWSER_NO_CANDIDATES: 5,
      HEADLESS_PROCESSING: 1,
    });
    expect(result).not.toHaveProperty("payload");
  });
});
