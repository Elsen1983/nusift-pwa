import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitialDomainGovernorState,
  type DomainGovernorDb,
  type DomainGovernorState,
} from "./domain-request-governor";
import {
  governedSafeFetch,
  governedSafeFetchAndParse,
  GovernedFetchDeferredError,
} from "./governed-fetch";

const safeFetchWithParserMock = vi.hoisted(() => vi.fn());

vi.mock("../ssrf-guard", () => ({
  safeFetchWithParser: safeFetchWithParserMock,
  validateHostname: vi.fn(),
}));

const NOW = new Date("2026-08-10T12:00:00.000Z");

const makeResponse = (status: number, headers: Record<string, string> = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  url: "https://example.com/final",
  headers: new Headers(headers),
  text: vi.fn(async () => "body"),
}) as unknown as Response;

const matches = (state: DomainGovernorState, where: Record<string, unknown>): boolean => {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "version" && typeof expected === "object" && expected !== null && "increment" in expected) continue;
    if (key === "activeLeaseExpiresAt" && typeof expected === "object" && expected !== null && "gt" in expected) {
      if (!(state.activeLeaseExpiresAt && state.activeLeaseExpiresAt > (expected as { gt: Date }).gt)) return false;
      continue;
    }
    if (key === "activeLeaseExpiresAt" && typeof expected === "object" && expected !== null && "lte" in expected) {
      if (!(state.activeLeaseExpiresAt && state.activeLeaseExpiresAt <= (expected as { lte: Date }).lte)) return false;
      continue;
    }
    if (state[key as keyof DomainGovernorState] !== expected) return false;
  }
  return true;
};

const applyData = (state: DomainGovernorState, data: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(data)) {
    if (key === "version" && typeof value === "object" && value !== null && "increment" in value) {
      state.version += Number((value as { increment: number }).increment);
    } else {
      (state as unknown as Record<string, unknown>)[key] = value;
    }
  }
};

const makeDb = (overrides: Partial<DomainGovernorState> = {}) => {
  let state = { ...createInitialDomainGovernorState("example.com", NOW), ...overrides };
  const failNextUpdate = { value: false };
  const db: DomainGovernorDb = {
    domainRequestGovernor: {
      findUnique: vi.fn(async () => ({ ...state })),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }) => {
        applyData(state, data);
        return { ...state };
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (failNextUpdate.value) {
          failNextUpdate.value = false;
          return { count: 0 };
        }
        if (!matches(state, where)) return { count: 0 };
        applyData(state, data);
        return { count: 1 };
      }),
    },
  };
  return { db, getState: () => ({ ...state }), failNextUpdate };
};

const installParser = (response: Response) => {
  safeFetchWithParserMock.mockImplementation(async (url: string, options: any, parse: (r: Response) => Promise<unknown>) => {
    const lease = await options.transportHooks.beforeTransport(url, true);
    const result = response;
    let parseError: unknown = null;
    try {
      return await parse(result);
    } catch (error) {
      parseError = error;
      throw error;
    } finally {
      await options.transportHooks.onFinalResponse(url, result, lease, parseError);
    }
  });
};

describe("governed adapter + real governor lease contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeFetchWithParserMock.mockReset();
  });

  it("completes an enforce HTTP 200 lease exactly once and leaves no lease", async () => {
    const { db, getState } = makeDb();
    installParser(makeResponse(200));

    const result = await governedSafeFetch("https://example.com/start", {}, {
      agent: "agent1", stage: "contract", purpose: "feed", mode: "enforce", robotsPolicy: "skip", db,
    });

    expect(result.status).toBe(200);
    expect(getState().activeLeaseToken).toBeNull();
    expect(getState().version).toBe(2);
  });

  it("returns an enforce HTTP 429 response while the real governor opens the circuit", async () => {
    const { db, getState } = makeDb();
    installParser(makeResponse(429, { "retry-after": "60" }));

    const result = await governedSafeFetch("https://example.com/start", {}, {
      agent: "agent1", stage: "contract", purpose: "feed", mode: "enforce", robotsPolicy: "skip", db,
    });

    expect(result.status).toBe(429);
    expect(getState()).toMatchObject({
      circuitState: "OPEN",
      consecutive429Count: 1,
      activeLeaseToken: null,
      lastHttpStatus: 429,
    });
  });

  it("counts two independent 403 attempts against the same domain exactly once each, never double", async () => {
    // Simulates a static request followed by a repair-14 browser fallback to
    // the same URL: both are real, independent transport attempts against the
    // same governor-tracked domain and must each contribute exactly one
    // consecutive403Count increment, not a duplicate count of either attempt.
    const { db, getState } = makeDb();
    installParser(makeResponse(403));
    vi.useFakeTimers();
    try {
      const first = await governedSafeFetch("https://example.com/article", {}, {
        agent: "agent1", stage: "contract", purpose: "feed", mode: "enforce", robotsPolicy: "skip", db,
      });
      expect(first.status).toBe(403);
      expect(getState().consecutive403Count).toBe(1);
      expect(getState().circuitState).toBe("CLOSED");

      // Clear the same-domain minimum-request-interval defer between the two
      // independent attempts; unrelated to the 403 accounting under test.
      await vi.advanceTimersByTimeAsync(1_001);

      const second = await governedSafeFetch("https://example.com/article", {}, {
        agent: "agent3", stage: "contract", purpose: "article_extraction", mode: "enforce", robotsPolicy: "skip", db,
      });
      expect(second.status).toBe(403);
      expect(getState().consecutive403Count).toBe(2);
      expect(getState().circuitState).toBe("CLOSED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes redirect hops without false defer and records each real domain", async () => {
    const first = makeDb();
    const second = makeDb();
    const third = makeDb();
    // One fake DB represents all domains while retaining the real governor.
    const states = new Map<string, DomainGovernorState>();
    const db: DomainGovernorDb = {
      domainRequestGovernor: {
        findUnique: vi.fn(async ({ where }) => states.get(where.domainKey) ? { ...states.get(where.domainKey)! } : null),
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }) => {
          const domainKey = String(data.domainKey);
          const created = { ...createInitialDomainGovernorState(domainKey, NOW), ...data } as DomainGovernorState;
          states.set(domainKey, created);
          return { ...created };
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const current = states.get(String(where.domainKey));
          if (!current || !matches(current, where)) return { count: 0 };
          applyData(current, data);
          return { count: 1 };
        }),
      },
    };
    void first; void second; void third;
    safeFetchWithParserMock.mockImplementation(async (url: string, options: any, parse: (r: Response) => Promise<unknown>) => {
      const leases = [];
      leases.push(await options.transportHooks.beforeTransport(url, true));
      await options.transportHooks.onRedirectResponse(url, makeResponse(302), leases[0]);
      const next = "https://sub.example.com/next";
      leases.push(await options.transportHooks.beforeTransport(next, false));
      await options.transportHooks.onRedirectResponse(next, makeResponse(301), leases[1]);
      const finalUrl = "https://other.example.net/final";
      leases.push(await options.transportHooks.beforeTransport(finalUrl, false));
      const finalResponse = makeResponse(200);
      let parseError: unknown = null;
      try {
        return await parse(finalResponse);
      } catch (error) {
        parseError = error;
        throw error;
      } finally {
        await options.transportHooks.onFinalResponse(finalUrl, finalResponse, leases[2], parseError);
      }
    });

    const result = await governedSafeFetchAndParse("https://example.com/start", {}, {
      agent: "agent1", stage: "contract", purpose: "feed", mode: "enforce", robotsPolicy: "skip", db,
    }, async (response) => {
      expect(states.get("other.example.net")?.activeLeaseToken).toBeTruthy();
      return response.status;
    });

    expect(result).toBe(200);
    expect(states.get("example.com")?.activeLeaseToken).toBeNull();
    expect(states.get("sub.example.com")?.activeLeaseToken).toBeNull();
    expect(states.get("other.example.net")?.activeLeaseToken).toBeNull();
  });

  it("keeps a parser failure primary after successful real outcome completion", async () => {
    const { db, getState } = makeDb();
    installParser(makeResponse(200));

    await expect(governedSafeFetchAndParse("https://example.com/start", {}, {
      agent: "agent1", stage: "contract", purpose: "feed", mode: "enforce", robotsPolicy: "skip", db,
    }, async () => {
      throw new Error("parser-primary");
    })).rejects.toThrow("parser-primary");
    expect(getState().activeLeaseToken).toBeNull();
  });

  it("rejects a stale token after an expired lease is replaced", async () => {
    const { db, getState } = makeDb({
      activeLeaseToken: "old-token",
      activeLeaseExpiresAt: new Date(NOW.getTime() - 1),
      version: 4,
    });
    const governor = await import("./domain-request-governor");
    const replacement = await governor.acquireDomainPermit({
      url: "https://example.com/new", mode: "enforce", now: NOW, db,
    });
    expect(replacement.allowed).toBe(true);
    const before = getState();
    const staleRelease = await governor.releaseDomainPermit({
      url: "https://example.com/old", mode: "enforce", leaseToken: "old-token", now: NOW, db,
    });
    const staleOutcome = await governor.recordDomainOutcome({
      url: "https://example.com/old", mode: "enforce", leaseToken: "old-token", now: NOW,
      outcome: { kind: "success", status: 200 }, db,
    });
    expect(staleRelease.reason).toBe("token-mismatch");
    expect(staleOutcome.reason).toBe("token-mismatch");
    expect(getState().activeLeaseToken).toBe(before.activeLeaseToken);
    expect(getState().version).toBe(before.version);
  });

  it("keeps real CAS conflict as a typed defer and does not globally forgive stale tokens", async () => {
    const { db, failNextUpdate } = makeDb();
    installParser(makeResponse(200));
    // The first update is acquisition; the next is authoritative completion.
    const originalUpdate = db.domainRequestGovernor.updateMany;
    let calls = 0;
    db.domainRequestGovernor.updateMany = vi.fn(async (args) => {
      calls += 1;
      if (calls === 2) return { count: 0 };
      return originalUpdate(args);
    });
    failNextUpdate.value = false;

    await expect(governedSafeFetch("https://example.com/start", {}, {
      agent: "agent1", stage: "contract", purpose: "feed", mode: "enforce", db,
    })).rejects.toBeInstanceOf(GovernedFetchDeferredError);

    // A subsequent stale token remains rejected by the real governor.
    const stale = await (await import("./domain-request-governor")).releaseDomainPermit({
      url: "https://example.com/start", mode: "enforce", leaseToken: "stale-token", db,
    });
    expect(stale.reason).toBe("token-mismatch");
  });
});
