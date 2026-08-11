import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireDomainPermit,
  applyDomainOutcome,
  DOMAIN_REQUEST_DEFAULT_LEASE_TTL_MS,
  DOMAIN_REQUEST_MAX_LEASE_TTL_MS,
  DOMAIN_REQUEST_MIN_LEASE_TTL_MS,
  DOMAIN_REQUEST_DEFAULT_RECOVERY_LIMIT,
  DOMAIN_REQUEST_MAX_RECOVERY_LIMIT,
  createInitialDomainGovernorState,
  normalizeDomainKey,
  parseDomainGovernorMode,
  parseDomainGovernorRecoveryLimit,
  recordDomainOutcome,
  recoverExpiredDomainLeases,
  releaseDomainPermit,
  type DomainGovernorDb,
  type DomainGovernorState,
} from "./domain-request-governor";

const NOW = new Date("2026-08-10T12:00:00.000Z");

const makeState = (overrides: Partial<DomainGovernorState> = {}): DomainGovernorState => ({
  ...createInitialDomainGovernorState("example.com", NOW),
  ...overrides,
});

const makeDb = (initial: DomainGovernorState | null = null) => {
  let state = initial;
  const db: DomainGovernorDb = {
    domainRequestGovernor: {
      findUnique: vi.fn(async () => state),
      findMany: vi.fn(async () => state ? [state] : []),
      create: vi.fn(async ({ data }) => {
        state = { ...makeState({ domainKey: String(data.domainKey) }), ...data } as DomainGovernorState;
        return state;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const matchesExpiry = (predicate: unknown): boolean => {
          if (!predicate || typeof predicate !== "object") return true;
          const condition = predicate as Record<string, unknown>;
          const expiry = state?.activeLeaseExpiresAt?.getTime() ?? Number.NaN;
          if (condition.gt instanceof Date && !(expiry > condition.gt.getTime())) return false;
          if (condition.lte instanceof Date && !(expiry <= condition.lte.getTime())) return false;
          return true;
        };
        if (!state || state.domainKey !== where.domainKey ||
            (where.version !== undefined && state.version !== where.version) ||
            (where.circuitState !== undefined && state.circuitState !== where.circuitState) ||
            (where.activeLeaseToken !== undefined && state.activeLeaseToken !== where.activeLeaseToken) ||
            !matchesExpiry(where.activeLeaseExpiresAt)) {
          return { count: 0 };
        }
        const next = { ...state } as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          if (isIncrement(value)) next[key] = Number(next[key] ?? 0) + value.increment;
          else next[key] = value;
        }
        state = next as DomainGovernorState;
        return { count: 1 };
      }),
    },
  };
  return { db, getState: () => state };
};

const isIncrement = (value: unknown): value is { increment: number } =>
  typeof value === "object" && value !== null && "increment" in value && typeof (value as any).increment === "number";

describe("domain request governor normalization", () => {
  it("normalizes HTTP(S) hostnames, terminal dots, and www consistently", () => {
    expect(normalizeDomainKey("HTTPS://WWW.Example.COM.:443/story?x=1#fragment")).toBe("example.com");
    expect(normalizeDomainKey("https://news.Example.com/story")).toBe("news.example.com");
  });

  it("rejects malformed, unsupported, reserved, and literal-IP domains", () => {
    for (const value of ["", "not a url", "ftp://example.com", "https://localhost/a", "https://127.0.0.1/a", "https://[::1]/a"]) {
      expect(() => normalizeDomainKey(value)).toThrow();
    }
  });

  it("defaults unknown configuration to off and accepts only supported modes", () => {
    expect(parseDomainGovernorMode(undefined)).toBe("off");
    expect(parseDomainGovernorMode("shadow")).toBe("shadow");
    expect(parseDomainGovernorMode("enforce")).toBe("enforce");
    expect(parseDomainGovernorMode("ON")).toBe("off");
  });
});

describe("domain request governor policy", () => {
  it("accepts bounded delta-seconds and HTTP-date Retry-After values", () => {
    const delta = applyDomainOutcome(makeState(), { kind: "rate_limited", status: 429, retryAfter: "60" }, { now: NOW });
    expect(delta.cooldownUntil!.getTime() - NOW.getTime()).toBe(60_000);
    const date = applyDomainOutcome(makeState(), { kind: "rate_limited", status: 429, retryAfter: new Date(NOW.getTime() + 120_000).toUTCString() }, { now: NOW });
    expect(date.cooldownUntil!.getTime() - NOW.getTime()).toBe(120_000);
  });

  it("opens immediately on 429 and bounds malformed Retry-After to the maintained maximum", () => {
    const next = applyDomainOutcome(makeState(), {
      kind: "rate_limited",
      status: 429,
      retryAfter: "not-a-date",
    }, { now: NOW });
    expect(next.circuitState).toBe("OPEN");
    expect(next.consecutive429Count).toBe(1);
    expect(next.cooldownUntil!.getTime() - NOW.getTime()).toBe(15 * 60 * 1000);
    expect(next.nextRequestAt).toEqual(next.cooldownUntil);
  });

  it("extends repeated 429 cooldowns but never beyond the hard maximum", () => {
    const first = applyDomainOutcome(makeState({ consecutive429Count: 1 }), {
      kind: "rate_limited", status: 429, retryAfter: "86400",
    }, { now: NOW });
    const second = applyDomainOutcome(first, {
      kind: "rate_limited", status: 429, retryAfter: "86400",
    }, { now: NOW });
    expect(first.circuitState).toBe("OPEN");
    expect(second.cooldownUntil!.getTime() - NOW.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("maintains genuinely consecutive 429 and 403 streaks", () => {
    const first429 = applyDomainOutcome(makeState(), { kind: "rate_limited", status: 429, retryAfter: "60" }, { now: NOW });
    const then403 = applyDomainOutcome(first429, { kind: "forbidden", status: 403 }, { now: NOW });
    const then429 = applyDomainOutcome(then403, { kind: "failure", status: 429, retryAfter: "60" }, { now: NOW });
    expect(first429).toMatchObject({ consecutive429Count: 1, consecutive403Count: 0 });
    expect(then403).toMatchObject({ consecutive429Count: 0, consecutive403Count: 1 });
    expect(then429).toMatchObject({ consecutive429Count: 1, consecutive403Count: 0, circuitState: "OPEN" });

    const first403 = applyDomainOutcome(makeState(), { kind: "forbidden", status: 403 }, { now: NOW });
    const then429Again = applyDomainOutcome(first403, { kind: "rate_limited", status: 429, retryAfter: "60" }, { now: NOW });
    const then403Again = applyDomainOutcome(then429Again, { kind: "forbidden", status: 403 }, { now: NOW });
    expect(then429Again).toMatchObject({ consecutive429Count: 1, consecutive403Count: 0 });
    expect(then403Again).toMatchObject({ consecutive429Count: 0, consecutive403Count: 1 });
  });

  it("breaks both publisher streaks on technical failures", () => {
    const after429 = applyDomainOutcome(makeState(), { kind: "rate_limited", status: 429, retryAfter: "60" }, { now: NOW });
    const afterFailure = applyDomainOutcome(after429, { kind: "failure", status: 503 }, { now: NOW });
    const after429Again = applyDomainOutcome(afterFailure, { kind: "rate_limited", status: 429, retryAfter: "60" }, { now: NOW });
    expect(afterFailure).toMatchObject({ consecutive429Count: 0, consecutive403Count: 0, circuitState: "CLOSED" });
    expect(after429Again.consecutive429Count).toBe(1);

    const after403 = applyDomainOutcome(makeState(), { kind: "forbidden", status: 403 }, { now: NOW });
    const afterSuccess = applyDomainOutcome(after403, { kind: "success", status: 200 }, { now: NOW });
    expect(afterSuccess).toMatchObject({ consecutive429Count: 0, consecutive403Count: 0, circuitState: "CLOSED" });
  });

  it("uses HTTP status as authoritative for contradictory outcomes", () => {
    expect(applyDomainOutcome(makeState({ circuitState: "OPEN" }), { kind: "success", status: 429 }, { now: NOW })).toMatchObject({ circuitState: "OPEN", consecutive429Count: 1 });
    expect(applyDomainOutcome(makeState(), { kind: "forbidden", status: 429, retryAfter: "60" }, { now: NOW })).toMatchObject({ circuitState: "OPEN", consecutive429Count: 1, consecutive403Count: 0 });
    expect(applyDomainOutcome(makeState({ circuitState: "OPEN" }), { kind: "success", status: 403 }, { now: NOW })).toMatchObject({ circuitState: "CLOSED", consecutive429Count: 0, consecutive403Count: 1 });
    expect(applyDomainOutcome(makeState({ circuitState: "OPEN" }), { kind: "failure", status: 429, retryAfter: "60" }, { now: NOW })).toMatchObject({ circuitState: "OPEN", consecutive429Count: 1 });
    expect(applyDomainOutcome(makeState({ circuitState: "OPEN" }), { kind: "failure", status: 500 }, { now: NOW })).toMatchObject({ circuitState: "CLOSED", consecutive429Count: 0, consecutive403Count: 0 });
  });

  it("records 403 without turning it into a 429 circuit", () => {
    const next = applyDomainOutcome(makeState(), { kind: "forbidden", status: 403 }, { now: NOW });
    expect(next.circuitState).toBe("CLOSED");
    expect(next.consecutive403Count).toBe(1);
    expect(next.consecutive429Count).toBe(0);
  });

  it("does not classify technical failures as publisher rate limits", () => {
    const next = applyDomainOutcome(makeState(), { kind: "failure", status: 503 }, { now: NOW });
    expect(next.circuitState).toBe("CLOSED");
    expect(next.consecutive429Count).toBe(0);
    expect(next.consecutive403Count).toBe(0);
  });

  it("closes a half-open circuit after a successful probe", () => {
    const next = applyDomainOutcome(makeState({ circuitState: "HALF_OPEN", consecutive429Count: 2 }), {
      kind: "success", status: 200,
    }, { now: NOW });
    expect(next.circuitState).toBe("CLOSED");
    expect(next.consecutive429Count).toBe(0);
    expect(next.lastSuccessAt).toEqual(NOW);
  });

  it("reopens a half-open circuit after another 429", () => {
    const next = applyDomainOutcome(makeState({ circuitState: "HALF_OPEN", consecutive403Count: 2 }), {
      kind: "rate_limited", status: 429, retryAfter: "60",
    }, { now: NOW });
    expect(next).toMatchObject({ circuitState: "OPEN", consecutive429Count: 1, consecutive403Count: 0 });
  });
});

describe("domain request governor persistence API", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("does no database activity in off mode", async () => {
    const { db } = makeDb();
    const result = await acquireDomainPermit({ url: "https://example.com/a", mode: "off", db });
    expect(result).toMatchObject({ allowed: true, reason: "off", domainKey: "example.com" });
    expect(db.domainRequestGovernor.findUnique).not.toHaveBeenCalled();
  });

  it("returns shadow-would-allow and persists the diagnostic without taking a lease", async () => {
    const { db } = makeDb();
    const result = await acquireDomainPermit({ url: "https://example.com/a", mode: "shadow", now: NOW, db });
    expect(result).toMatchObject({ allowed: true, shadow: true, reason: "shadow-would-allow" });
    expect(db.domainRequestGovernor.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { domainKey: "example.com", version: 0 },
      data: expect.objectContaining({ lastDecision: "shadow-would-allow" }),
    }));
  });

  it("returns shadow decisions without suppressing work when the minimum interval is not reached", async () => {
    const { db } = makeDb(makeState({ nextRequestAt: new Date(NOW.getTime() + 10_000) }));
    const result = await acquireDomainPermit({ url: "https://example.com/a", mode: "shadow", now: NOW, db });
    expect(result).toMatchObject({ allowed: true, shadow: true, reason: "shadow-would-defer" });
    expect(db.domainRequestGovernor.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { domainKey: "example.com", version: 0 },
      data: expect.objectContaining({ lastDecision: "shadow-would-defer" }),
    }));
  });

  it("returns the circuit-open and minimum-interval decisions", async () => {
    const open = makeDb(makeState({ circuitState: "OPEN", cooldownUntil: new Date(NOW.getTime() + 10_000) }));
    await expect(acquireDomainPermit({ url: "https://example.com/a", mode: "enforce", now: NOW, db: open.db })).resolves.toMatchObject({ allowed: false, reason: "circuit-open" });
    const interval = makeDb(makeState({ nextRequestAt: new Date(NOW.getTime() + 10_000) }));
    await expect(acquireDomainPermit({ url: "https://example.com/a", mode: "enforce", now: NOW, db: interval.db })).resolves.toMatchObject({ allowed: false, reason: "minimum-interval-not-reached" });
  });

  it("grants a single half-open probe and reports an unavailable competing probe", async () => {
    const state = makeState({ circuitState: "OPEN", cooldownUntil: new Date(NOW.getTime() - 1) });
    const { db } = makeDb(state);
    const first = await acquireDomainPermit({ url: "https://example.com/a", mode: "enforce", now: NOW, db });
    expect(first).toMatchObject({ allowed: true, reason: "half-open-probe-granted" });
    const second = await acquireDomainPermit({ url: "https://example.com/b", mode: "enforce", now: NOW, db });
    expect(second).toMatchObject({ allowed: false, reason: "active-lease-held" });

    const casDb = makeDb(makeState({ circuitState: "OPEN", cooldownUntil: new Date(NOW.getTime() - 1) }));
    casDb.db.domainRequestGovernor.updateMany = vi.fn().mockResolvedValue({ count: 0 });
    await expect(acquireDomainPermit({ url: "https://example.com/a", mode: "enforce", now: NOW, db: casDb.db })).resolves.toMatchObject({ allowed: false, reason: "half-open-probe-unavailable" });
  });

  it("grants one enforce lease and rejects the next active lease", async () => {
    const { db, getState } = makeDb();
    const first = await acquireDomainPermit({ url: "https://example.com/a", mode: "enforce", now: NOW, db });
    expect(first).toMatchObject({ allowed: true, reason: "allowed", domainKey: "example.com" });
    expect(first.leaseToken).toEqual(expect.any(String));
    const second = await acquireDomainPermit({ url: "https://example.com/b", mode: "enforce", now: NOW, db });
    expect(second).toMatchObject({ allowed: false, reason: "active-lease-held" });
    expect(getState()!.activeLeaseToken).toBe(first.leaseToken);
  });

  it("normalizes shadow outcome diagnostics authoritatively while isolating coordination state", async () => {
    const cases = [
      [{ kind: "success", status: 429 }, "shadow-outcome:rate_limited"],
      [{ kind: "failure", status: 429 }, "shadow-outcome:rate_limited"],
      [{ kind: "success", status: 403 }, "shadow-outcome:forbidden"],
      [{ kind: "rate_limited", status: 500 }, "shadow-outcome:failure"],
    ] as const;

    for (const [outcome, expectedDecision] of cases) {
      const initial = makeState({
        circuitState: "OPEN",
        cooldownUntil: new Date(NOW.getTime() + 20_000),
        nextRequestAt: new Date(NOW.getTime() + 20_000),
        activeLeaseToken: "enforce-token",
        activeLeaseExpiresAt: new Date(NOW.getTime() + 10_000),
        consecutive429Count: 3,
        consecutive403Count: 2,
        version: 4,
      });
      const { db, getState } = makeDb(initial);
      const result = await recordDomainOutcome({ url: "https://example.com/a", mode: "shadow", now: NOW, outcome, db });
      expect(result).toMatchObject({ recorded: true, reason: "recorded" });
      expect(getState()).toMatchObject({
        circuitState: initial.circuitState,
        cooldownUntil: initial.cooldownUntil,
        nextRequestAt: initial.nextRequestAt,
        consecutive429Count: initial.consecutive429Count,
        consecutive403Count: initial.consecutive403Count,
        activeLeaseToken: initial.activeLeaseToken,
        activeLeaseExpiresAt: initial.activeLeaseExpiresAt,
        version: initial.version,
        lastDecision: expectedDecision,
        lastDecisionAt: NOW,
      });
    }
  });

  it("keeps shadow recovery and token completion completely database-free", async () => {
    const { db } = makeDb(makeState({ activeLeaseToken: "enforce-token", activeLeaseExpiresAt: new Date(NOW.getTime() - 1) }));
    const recovery = await recoverExpiredDomainLeases({ mode: "shadow", now: NOW, db });
    expect(recovery).toMatchObject({ scanned: 0, recovered: 0, reason: "shadow-noop" });
    expect(db.domainRequestGovernor.findMany).not.toHaveBeenCalled();
    expect(db.domainRequestGovernor.updateMany).not.toHaveBeenCalled();
    const outcome = await recordDomainOutcome({ url: "https://example.com/a", mode: "shadow", now: NOW, leaseToken: "enforce-token", outcome: { kind: "success", status: 200 }, db });
    expect(outcome).toMatchObject({ recorded: false, reason: "shadow-noop" });
    expect(db.domainRequestGovernor.findUnique).not.toHaveBeenCalled();
    expect(db.domainRequestGovernor.create).not.toHaveBeenCalled();
  });

  it("does not release or complete coordination leases in shadow mode", async () => {
    const { db, getState } = makeDb(makeState({ activeLeaseToken: "enforce-token", activeLeaseExpiresAt: new Date(NOW.getTime() + 10_000), version: 4 }));
    const released = await releaseDomainPermit({ url: "https://example.com/a", mode: "shadow", now: NOW, leaseToken: "enforce-token", db });
    expect(released).toMatchObject({ released: false, reason: "shadow-noop" });
    const outcome = await recordDomainOutcome({ url: "https://example.com/a", mode: "shadow", now: NOW, leaseToken: "enforce-token", outcome: { kind: "success", status: 200 }, db });
    expect(outcome).toMatchObject({ recorded: false, reason: "shadow-noop" });
    expect(db.domainRequestGovernor.findUnique).not.toHaveBeenCalled();
    expect(db.domainRequestGovernor.findMany).not.toHaveBeenCalled();
    expect(db.domainRequestGovernor.create).not.toHaveBeenCalled();
    expect(db.domainRequestGovernor.updateMany).not.toHaveBeenCalled();
    expect(getState()).toMatchObject({ activeLeaseToken: "enforce-token", version: 4, circuitState: "CLOSED" });
  });

  it("enforces a strictly positive bounded lease TTL independent of minIntervalMs", async () => {
    for (const leaseTtlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { db } = makeDb();
      const result = await acquireDomainPermit({ url: "https://example.com/a", mode: "enforce", now: NOW, leaseTtlMs, minIntervalMs: 0, db });
      expect(result.allowed).toBe(true);
      expect(result.leaseExpiresAt!.getTime()).toBe(NOW.getTime() + DOMAIN_REQUEST_DEFAULT_LEASE_TTL_MS);
    }
    const minimum = makeDb();
    const minimumResult = await acquireDomainPermit({ url: "https://example.com/a", mode: "enforce", now: NOW, leaseTtlMs: DOMAIN_REQUEST_MIN_LEASE_TTL_MS, minIntervalMs: 0, db: minimum.db });
    expect(minimumResult.leaseExpiresAt!.getTime()).toBe(NOW.getTime() + DOMAIN_REQUEST_MIN_LEASE_TTL_MS);
    const maximum = makeDb();
    const maximumResult = await acquireDomainPermit({ url: "https://example.com/a", mode: "enforce", now: NOW, leaseTtlMs: DOMAIN_REQUEST_MAX_LEASE_TTL_MS * 2, db: maximum.db });
    expect(maximumResult.leaseExpiresAt!.getTime()).toBe(NOW.getTime() + DOMAIN_REQUEST_MAX_LEASE_TTL_MS);
  });

  it("requires the lease token for outcome recording and release", async () => {
    const { db } = makeDb();
    const permit = await acquireDomainPermit({ url: "https://example.com/a", mode: "enforce", now: NOW, db });
    const wrong = await recordDomainOutcome({ url: "https://example.com/a", mode: "enforce", now: NOW, leaseToken: "wrong", outcome: { kind: "success", status: 200 }, db });
    expect(wrong.reason).toBe("token-mismatch");
    const releasedWrong = await releaseDomainPermit({ url: "https://example.com/a", mode: "enforce", leaseToken: "wrong", db });
    expect(releasedWrong.reason).toBe("token-mismatch");
    const recorded = await recordDomainOutcome({ url: "https://example.com/a", mode: "enforce", now: NOW, leaseToken: permit.leaseToken, outcome: { kind: "success", status: 200 }, db });
    expect(recorded).toMatchObject({ recorded: true, reason: "recorded" });
  });

  it("rejects completion with an expired lease token", async () => {
    const expired = makeState({ activeLeaseToken: "expired", activeLeaseExpiresAt: new Date(NOW.getTime() - 1), version: 2 });
    const { db } = makeDb(expired);
    const result = await recordDomainOutcome({ url: "https://example.com/a", mode: "enforce", now: NOW, leaseToken: "expired", outcome: { kind: "success", status: 200 }, db });
    expect(result).toMatchObject({ recorded: false, reason: "token-mismatch" });
  });

  it("does not release an expired lease", async () => {
    const expired = makeState({ activeLeaseToken: "expired", activeLeaseExpiresAt: new Date(NOW.getTime() - 1), version: 2 });
    const { db } = makeDb(expired);
    const result = await releaseDomainPermit({ url: "https://example.com/a", mode: "enforce", now: NOW, leaseToken: "expired", db });
    expect(result).toMatchObject({ released: false, reason: "token-mismatch" });
  });

  it("recovers expired leases with a bounded, token-validated CAS update", async () => {
    const expired = makeState({ activeLeaseToken: "stale", activeLeaseExpiresAt: new Date(NOW.getTime() - 1_000), version: 3 });
    const { db, getState } = makeDb(expired);
    const result = await recoverExpiredDomainLeases({ mode: "enforce", now: NOW, limit: 10, db });
    expect(result).toMatchObject({ scanned: 1, recovered: 1 });
    expect(getState()!.activeLeaseToken).toBeNull();
    expect(getState()!.version).toBe(4);
    const staleUpdate = db.domainRequestGovernor.updateMany as ReturnType<typeof vi.fn>;
    expect(staleUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ activeLeaseExpiresAt: { lte: NOW } }),
    }));
  });

  it("bounds every recovery limit before passing it to Prisma", async () => {
    expect(parseDomainGovernorRecoveryLimit()).toBe(DOMAIN_REQUEST_DEFAULT_RECOVERY_LIMIT);
    expect(parseDomainGovernorRecoveryLimit(Number.NaN)).toBe(DOMAIN_REQUEST_DEFAULT_RECOVERY_LIMIT);
    expect(parseDomainGovernorRecoveryLimit(Number.POSITIVE_INFINITY)).toBe(DOMAIN_REQUEST_DEFAULT_RECOVERY_LIMIT);
    expect(parseDomainGovernorRecoveryLimit(Number.NEGATIVE_INFINITY)).toBe(DOMAIN_REQUEST_DEFAULT_RECOVERY_LIMIT);
    expect(parseDomainGovernorRecoveryLimit(0)).toBe(1);
    expect(parseDomainGovernorRecoveryLimit(-4)).toBe(1);
    expect(parseDomainGovernorRecoveryLimit(3.9)).toBe(3);
    expect(parseDomainGovernorRecoveryLimit(DOMAIN_REQUEST_MAX_RECOVERY_LIMIT + 1)).toBe(DOMAIN_REQUEST_MAX_RECOVERY_LIMIT);

    for (const [input, expectedTake] of [
      [undefined, DOMAIN_REQUEST_DEFAULT_RECOVERY_LIMIT],
      [Number.NaN, DOMAIN_REQUEST_DEFAULT_RECOVERY_LIMIT],
      [Number.POSITIVE_INFINITY, DOMAIN_REQUEST_DEFAULT_RECOVERY_LIMIT],
      [0, 1],
      [-2, 1],
      [3.9, 3],
      [DOMAIN_REQUEST_MAX_RECOVERY_LIMIT + 50, DOMAIN_REQUEST_MAX_RECOVERY_LIMIT],
    ] as const) {
      const expired = makeState({ activeLeaseToken: "stale", activeLeaseExpiresAt: new Date(NOW.getTime() - 1_000) });
      const { db } = makeDb(expired);
      await recoverExpiredDomainLeases({ mode: "enforce", now: NOW, limit: input, db });
      expect(db.domainRequestGovernor.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: expectedTake }));
    }
  });

  it("fails closed on governor persistence failure in enforce mode", async () => {
    const db = makeDb().db;
    vi.mocked(db.domainRequestGovernor.findUnique).mockRejectedValue(new Error("db unavailable"));
    const result = await acquireDomainPermit({ url: "https://example.com/a", mode: "enforce", db });
    expect(result).toMatchObject({ allowed: false, reason: "governor-persistence-unavailable" });
  });
});
