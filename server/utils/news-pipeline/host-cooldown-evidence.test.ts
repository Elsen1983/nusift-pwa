import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.fn();

import { STATIC_RETRY_AFTER_MAX_MS } from "./retry-after-policy";

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

  it("loads Prompt 15A staticDiscovery, top-level aliases, and structured evidence", async () => {
    findManyMock.mockResolvedValue([
      {
        sourceId: "source-static",
        categoryId: null,
        payload: {
          targetUrl: "https://static.example/news",
          staticDiscovery: {
            stopReason: "rate_limited",
            rateLimitPhase: "article_detail",
            retryAfterAt: "2026-07-30T12:45:00.000Z",
            retryAfterSource: "delta_seconds",
            rateLimitEvidence: [{ status: 429, url: "https://static.example/news/a", retryAfterAt: "2026-07-30T12:45:00.000Z", retryAfterSource: "delta_seconds" }],
          },
        },
      },
      {
        sourceId: "source-alias",
        categoryId: null,
        payload: {
          targetUrl: "https://alias.example/news",
          stopReason: "rate_limited",
          retryAfterAt: "2026-07-30T12:40:00.000Z",
          retryAfterSource: "http_date",
        },
      },
      {
        sourceId: "source-evidence",
        categoryId: null,
        payload: {
          targetUrl: "https://evidence.example/news",
          rateLimitEvidence: [{ status: 429, url: "https://evidence.example/news/a", retryAfterAt: "2026-07-30T12:35:00.000Z", retryAfterSource: "fallback" }],
        },
      },
      {
        sourceId: "source-budget",
        categoryId: null,
        payload: {
          targetUrl: "https://budget.example/news",
          stopReason: "request_budget_exhausted",
          retryable: true,
          requestBudget: { exhausted: true },
        },
      },
    ]);
    const { loadPersistedHostCooldowns } = await import("./host-cooldown-evidence");
    const result = await loadPersistedHostCooldowns();

    expect(result.get("static.example")?.retryAfterAt).toBe("2026-07-30T12:45:00.000Z");
    expect(result.get("alias.example")?.retryAfterAt).toBe("2026-07-30T12:40:00.000Z");
    expect(result.get("evidence.example")?.retryAfterAt).toBe("2026-07-30T12:35:00.000Z");
    expect(result.has("budget.example")).toBe(false);
  });

  it("derives the bounded Prisma lookback from the maximum static cooldown policy", async () => {
    findManyMock.mockResolvedValue([]);
    const { loadPersistedHostCooldowns } = await import("./host-cooldown-evidence");

    await loadPersistedHostCooldowns();

    const query = findManyMock.mock.calls[0]?.[0] as { where: { updatedAt: { gte: Date } } };
    expect(query.where.updatedAt.gte.getTime()).toBe(
      Date.now() - STATIC_RETRY_AFTER_MAX_MS,
    );
    expect(query.where.updatedAt.gte.getTime()).not.toBe(Date.now() - 4 * 60 * 60 * 1000);
  });

  it("considers an eight-hour-old artifact with an active twelve-hour cooldown", async () => {
    findManyMock.mockResolvedValue([{
      id: "artifact-12h",
      sourceId: "source-12h",
      categoryId: null,
      updatedAt: new Date("2026-07-30T04:00:00.000Z"),
      payload: {
        targetUrl: "https://long.example/news",
        staticDiscovery: {
          stopReason: "rate_limited",
          retryAfterAt: "2026-07-31T00:00:00.000Z",
          retryAfterSource: "http_date",
        },
      },
    }]);
    const { loadPersistedHostCooldowns } = await import("./host-cooldown-evidence");

    expect((await loadPersistedHostCooldowns()).get("long.example")?.retryAfterAt)
      .toBe("2026-07-31T00:00:00.000Z");
  });

  it("does not consider an artifact older than the maximum bounded cooldown", async () => {
    findManyMock.mockResolvedValue([{
      id: "artifact-too-old",
      sourceId: "source-old",
      categoryId: null,
      updatedAt: new Date("2026-07-29T11:59:59.999Z"),
      payload: {
        targetUrl: "https://old.example/news",
        staticDiscovery: {
          stopReason: "rate_limited",
          retryAfterAt: "2026-07-31T00:00:00.000Z",
          retryAfterSource: "fallback",
        },
      },
    }]);
    const { loadPersistedHostCooldowns } = await import("./host-cooldown-evidence");

    expect((await loadPersistedHostCooldowns()).has("old.example")).toBe(false);
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
