import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdminId = vi.fn();
const mockAssertRateLimit = vi.fn();
const mockGetRequestPrisma = vi.fn();

vi.stubGlobal("defineEventHandler", (handler: any) => handler);
vi.stubGlobal("getQuery", (event: any) => event?.query ?? {});

vi.mock("h3", () => ({
  defineEventHandler: (handler: any) => handler,
  createError: (input: any) => Object.assign(new Error(input.statusMessage), input),
}));
vi.mock("../../utils/require-admin", () => ({ requireAdminId: (...args: any[]) => mockRequireAdminId(...args) }));
vi.mock("../../utils/rate-limit", () => ({ assertRateLimit: (...args: any[]) => mockAssertRateLimit(...args) }));
vi.mock("../../utils/request-prisma", () => ({ getRequestPrisma: (...args: any[]) => mockGetRequestPrisma(...args) }));

describe("GET /api/dev/domain-governance", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireAdminId.mockResolvedValue("admin-1");
    mockAssertRateLimit.mockResolvedValue(undefined);
    mockGetRequestPrisma.mockReturnValue({
      domainRequestGovernor: { findMany: async () => [] },
      publisherRobotsPolicy: { findMany: async () => [] },
      pipelineArtifact: { findMany: async () => [] },
    });
  });

  async function loadHandler() {
    const mod = await import("./domain-governance.get");
    return mod.default;
  }

  it("requires admin access before reading diagnostics", async () => {
    mockRequireAdminId.mockRejectedValue(Object.assign(new Error("Forbidden"), { statusCode: 403 }));
    const handler = await loadHandler();
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockGetRequestPrisma).not.toHaveBeenCalled();
  });

  it("returns a bounded read-only diagnostics shape", async () => {
    const handler = await loadHandler();
    const result = await handler({ query: { limit: "1", scanCap: "5" } } as any);
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty("domains");
    expect(result).toHaveProperty("network.stageTransport");
    expect(result).toHaveProperty("evidence.scanCap", 5);
    expect(mockAssertRateLimit).toHaveBeenCalledWith(expect.anything(), "domain-governance-diagnostics", 10, 60 * 1000);
  });
});
