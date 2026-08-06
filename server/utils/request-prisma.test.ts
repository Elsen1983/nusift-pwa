import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  globalPrisma: { marker: "global" },
}));

vi.mock("./prisma", () => ({ prisma: mocks.globalPrisma }));

describe("request-scoped Prisma override contract", () => {
  it("returns the global client when no override exists", async () => {
    const { getRequestPrisma } = await import("./request-prisma");
    expect(getRequestPrisma({ context: {} })).toBe(mocks.globalPrisma);
    expect(getRequestPrisma({ context: undefined })).toBe(mocks.globalPrisma);
    expect(getRequestPrisma({})).toBe(mocks.globalPrisma);
  });

  it("honors only an object-valued server-created context override", async () => {
    const { getRequestPrisma } = await import("./request-prisma");
    const isolated = { marker: "isolated" };
    expect(getRequestPrisma({ context: { prisma: isolated } })).toBe(isolated);
    // Primitive, string, null and array overrides are never trusted.
    expect(getRequestPrisma({ context: { prisma: "not-a-client" } })).toBe(mocks.globalPrisma);
    expect(getRequestPrisma({ context: { prisma: null } })).toBe(mocks.globalPrisma);
    expect(getRequestPrisma({ context: { prisma: 42 } })).toBe(mocks.globalPrisma);
    expect(getRequestPrisma({ context: { prisma: ["not-a-client"] } })).toBe(mocks.globalPrisma);
  });

  it("never reads client-controlled input (query, body, headers)", async () => {
    const { getRequestPrisma } = await import("./request-prisma");
    const clientFake = { marker: "client-controlled" };
    const event = {
      context: {},
      query: { prisma: clientFake },
      body: { prisma: clientFake },
      headers: { get: (name: string) => (name === "x-prisma" ? JSON.stringify(clientFake) : null) },
      node: { req: { body: { prisma: clientFake } } },
    };
    expect(getRequestPrisma(event as any)).toBe(mocks.globalPrisma);
  });
});
