import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdminId = vi.fn();
const mockAssertRateLimit = vi.fn();
const mockReadBody = vi.fn();
const mockTransaction = vi.fn();
const mockArticleDeleteMany = vi.fn();
const mockLogDeleteMany = vi.fn();
const mockArtifactDeleteMany = vi.fn();
const mockRunDeleteMany = vi.fn();

(globalThis as any).defineEventHandler = (fn: any) => fn;
(globalThis as any).readBody = (...args: any[]) => mockReadBody(...args);

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
  createError: ({
    statusCode,
    statusMessage,
  }: {
    statusCode: number;
    statusMessage: string;
  }) => Object.assign(new Error(statusMessage), { statusCode, statusMessage }),
}));

vi.mock("../../utils/require-admin", () => ({
  requireAdminId: (...args: any[]) => mockRequireAdminId(...args),
}));

vi.mock("../../utils/rate-limit", () => ({
  assertRateLimit: (...args: any[]) => mockAssertRateLimit(...args),
}));

vi.mock("../../utils/prisma", () => ({
  prisma: {
    article: { deleteMany: (...args: any[]) => mockArticleDeleteMany(...args) },
    agentScanLog: { deleteMany: (...args: any[]) => mockLogDeleteMany(...args) },
    pipelineArtifact: { deleteMany: (...args: any[]) => mockArtifactDeleteMany(...args) },
    pipelineRun: { deleteMany: (...args: any[]) => mockRunDeleteMany(...args) },
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

describe("DELETE /api/dev/agent-logs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.NODE_ENV = "production";
    mockRequireAdminId.mockResolvedValue("admin-1");
    mockAssertRateLimit.mockResolvedValue(undefined);
    mockReadBody.mockResolvedValue({ confirmation: "DELETE_ALL_PIPELINE_DATA" });
    mockArticleDeleteMany.mockReturnValue("articles");
    mockLogDeleteMany.mockReturnValue("logs");
    mockArtifactDeleteMany.mockReturnValue("artifacts");
    mockRunDeleteMany.mockReturnValue("runs");
    mockTransaction.mockResolvedValue([
      { count: 12 },
      { count: 5 },
      { count: 8 },
      { count: 3 },
    ]);
  });

  it("requires admin access", async () => {
    mockRequireAdminId.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    );
    const handler = (await import("./agent-logs.delete")).default;

    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects deletion without the exact confirmation", async () => {
    mockReadBody.mockResolvedValue({ confirmation: "DELETE" });
    const handler = (await import("./agent-logs.delete")).default;

    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("allows a confirmed admin reset in production", async () => {
    const handler = (await import("./agent-logs.delete")).default;

    await expect(handler({} as any)).resolves.toEqual({
      ok: true,
      deletedCount: 5,
      articleCount: 12,
      artifactCount: 8,
      runCount: 3,
    });
    expect(mockAssertRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "agent-logs-delete",
      3,
      10 * 60 * 1000,
    );
    expect(mockTransaction).toHaveBeenCalledWith([
      "articles",
      "logs",
      "artifacts",
      "runs",
    ]);
  });
});
