import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  rateLimit: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  readBody: vi.fn(),
}));

vi.mock("../../utils/require-admin", () => ({ requireAdminId: mocks.requireAdmin }));
vi.mock("../../utils/rate-limit", () => ({ assertRateLimit: mocks.rateLimit }));
vi.mock("../../utils/prisma", () => ({
  prisma: { pipelineRun: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } },
}));
vi.mock("h3", () => ({
  createError: (input: Record<string, unknown>) => Object.assign(new Error(String(input.statusMessage)), input),
  readBody: mocks.readBody,
}));

const loadHandler = async () => (await import("./daily-pipeline-lock-recovery.post")).default;

beforeAll(() => {
  vi.stubGlobal("defineEventHandler", (handler: unknown) => handler);
});

describe("daily pipeline stale lock recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue("admin-1");
    mocks.readBody.mockResolvedValue({
      runId: "run-stale",
      confirmation: "RELEASE_STALE_DAILY_PIPELINE_LOCK",
    });
  });

  it("rejects recovery while the heartbeat is recent", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "run-stale",
      status: "DAILY_PIPELINE_WORKFLOW_RUNNING",
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
      summary: {},
    });

    await expect((await loadHandler())({} as never)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("releases an unchanged stale lock with an audited CAS update", async () => {
    const updatedAt = new Date(Date.now() - 60 * 60 * 1000);
    mocks.findUnique.mockResolvedValue({
      id: "run-stale",
      status: "DAILY_PIPELINE_WORKFLOW_RUNNING",
      updatedAt,
      summary: { kind: "daily_news_pipeline_workflow" },
    });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect((await loadHandler())({} as never)).resolves.toMatchObject({
      ok: true,
      changed: true,
      reason: "released",
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-stale", status: "DAILY_PIPELINE_WORKFLOW_RUNNING", updatedAt },
      data: expect.objectContaining({ status: "DAILY_PIPELINE_WORKFLOW_STALE" }),
    }));
  });

  it("reports a concurrent heartbeat without releasing the lock", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "run-stale",
      status: "DAILY_PIPELINE_WORKFLOW_RUNNING",
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      summary: {},
    });
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect((await loadHandler())({} as never)).resolves.toMatchObject({
      changed: false,
      reason: "concurrent_heartbeat",
    });
  });

  it("requires the exact confirmation token", async () => {
    mocks.readBody.mockResolvedValue({ runId: "run-stale", confirmation: "release" });
    await expect((await loadHandler())({} as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
