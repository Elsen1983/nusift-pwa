import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.fn();

afterEach(() => {
  vi.useRealTimers();
});

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

describe("loadPersistedHostCooldowns", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    findManyMock.mockReset();
  });

  it("returns active cooldown with its exact persisted expiry", async () => {
    findManyMock.mockResolvedValue([{
      sourceId: "source-1",
      categoryId: null,
      payload: {
        targetUrl: "https://EXAMPLE.com/news",
        browserRateLimited: true,
        browserRateLimitReason: "http_429",
        browserRateLimitedAt: "2026-07-30T11:50:00.000Z",
        browserRetryAfterAt: "2026-07-30T12:50:00.000Z",
      },
    }]);
    const { loadPersistedHostCooldowns } = await import("./host-cooldown-evidence");

    expect(await loadPersistedHostCooldowns()).toEqual(new Map([[
      "example.com",
      {
        retryAfterAt: "2026-07-30T12:50:00.000Z",
        rateLimitedAt: "2026-07-30T11:50:00.000Z",
        reason: "http_429",
      },
    ]]));
  });

  it("lets the newest successful target state supersede its older 429", async () => {
    findManyMock.mockResolvedValue([
      {
        sourceId: "source-1",
        categoryId: null,
        payload: {
          targetUrl: "https://example.com/news",
          browserRateLimited: false,
          browserAccepted: 1,
        },
      },
      {
        sourceId: "source-1",
        categoryId: null,
        payload: {
          targetUrl: "https://example.com/news",
          browserRateLimited: true,
          browserRetryAfterAt: "2026-07-30T12:50:00.000Z",
        },
      },
    ]);
    const { loadPersistedHostCooldowns } = await import("./host-cooldown-evidence");

    expect(await loadPersistedHostCooldowns()).toEqual(new Map());
  });

  it("ignores expired or malformed cooldown evidence", async () => {
    findManyMock.mockResolvedValue([
      {
        sourceId: "source-1",
        categoryId: null,
        payload: {
          targetUrl: "https://example.com/expired",
          browserRateLimited: true,
          browserRetryAfterAt: "2026-07-30T11:00:00.000Z",
        },
      },
      {
        sourceId: "source-2",
        categoryId: null,
        payload: {
          targetUrl: "https://example.org/bad",
          browserRateLimited: true,
          browserRetryAfterAt: "not-a-date",
        },
      },
    ]);
    const { loadPersistedHostCooldowns } = await import("./host-cooldown-evidence");

    expect(await loadPersistedHostCooldowns()).toEqual(new Map());
  });
});
