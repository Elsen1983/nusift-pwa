import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminId: vi.fn(),
  getRunFunnelPage: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  getQuery: vi.fn(),
}));

vi.mock("../../utils/require-admin", () => ({ requireAdminId: mocks.requireAdminId }));
vi.mock("../../utils/news-pipeline/run-funnel", () => ({ getRunFunnelPage: mocks.getRunFunnelPage }));
vi.mock("../../utils/prisma", () => ({
  prisma: { pipelineRun: { findUnique: mocks.findUnique, findMany: mocks.findMany } },
}));
vi.mock("h3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("h3")>()),
  getQuery: mocks.getQuery,
}));

describe("GET /api/dev/run-funnels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminId.mockResolvedValue("admin-1");
    mocks.getRunFunnelPage.mockResolvedValue({ items: [], nextCursor: null, truncated: false, limit: 25 });
    mocks.findUnique.mockResolvedValue(null);
    mocks.findMany.mockResolvedValue([]);
    mocks.getQuery.mockReturnValue({ orchestrationRunId: "run-1", limit: "500" });
    vi.stubGlobal("defineEventHandler", (handler: unknown) => handler);
  });

  it("requires admin authorization and returns a bounded page", async () => {
    const handler = (await import("./run-funnels.get")).default as (event: unknown) => Promise<any>;
    const result = await handler({});
    expect(mocks.requireAdminId).toHaveBeenCalled();
    expect(mocks.getRunFunnelPage).toHaveBeenCalledWith({
      orchestrationRunId: "run-1",
      cursor: null,
      limit: 500,
    });
    expect(result.funnels.items).toEqual([]);
  });
});
