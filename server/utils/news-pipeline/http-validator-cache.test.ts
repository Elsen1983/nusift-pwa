import { describe, expect, it } from "vitest";
import {
  HTTP_VALIDATOR_CACHE_MAX_PAYLOAD_BYTES,
  lookupHttpValidatorCache,
  recordHttpValidatorNotModified,
  recordHttpValidatorSuccess,
  type HttpValidatorCacheRow,
} from "./http-validator-cache";

const NOW = new Date("2026-08-13T12:00:00.000Z");

const makeRow = (overrides: Partial<HttpValidatorCacheRow> = {}): HttpValidatorCacheRow => ({
  resourceKey: "sitemap:https://example.com/sitemap.xml",
  resourceClass: "sitemap",
  etag: "\"abc123\"",
  lastModified: null,
  parsedPayload: { entries: [{ url: "https://example.com/a", lastmod: null }] },
  payloadBytes: 64,
  fetchedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 60_000),
  lastHttpStatus: 200,
  version: 0,
  ...overrides,
});

const makeDb = (initial: HttpValidatorCacheRow | null = null) => {
  let state = initial;
  const db = {
    httpValidatorCache: {
      findUnique: async () => state,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state = { ...makeRow(), ...data } as HttpValidatorCacheRow;
        return state;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!state || state.resourceKey !== where.resourceKey || (where.version !== undefined && state.version !== where.version)) {
          return { count: 0 };
        }
        const next = { ...state } as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in (value as any)) {
            next[key] = Number(next[key] ?? 0) + (value as any).increment;
          } else {
            next[key] = value;
          }
        }
        state = next as HttpValidatorCacheRow;
        return { count: 1 };
      },
    },
  };
  return { db, getState: () => state };
};

describe("lookupHttpValidatorCache", () => {
  it("returns null when no db is available (pre-migration/test-safe fallback)", async () => {
    expect(await lookupHttpValidatorCache("sitemap:https://example.com/sitemap.xml")).toBeNull();
  });

  it("returns the cached row when fresh", async () => {
    const { db } = makeDb(makeRow());
    const row = await lookupHttpValidatorCache("sitemap:https://example.com/sitemap.xml", db, NOW);
    expect(row?.etag).toBe("\"abc123\"");
  });

  it("returns null when missing", async () => {
    const { db } = makeDb(null);
    expect(await lookupHttpValidatorCache("sitemap:https://example.com/sitemap.xml", db, NOW)).toBeNull();
  });

  it("returns null when expired", async () => {
    const { db } = makeDb(makeRow({ expiresAt: new Date(NOW.getTime() - 1) }));
    expect(await lookupHttpValidatorCache("sitemap:https://example.com/sitemap.xml", db, NOW)).toBeNull();
  });
});

describe("recordHttpValidatorSuccess", () => {
  it("creates a new entry when none exists", async () => {
    const { db, getState } = makeDb(null);
    const result = await recordHttpValidatorSuccess({
      resourceKey: "sitemap:https://example.com/sitemap.xml",
      resourceClass: "sitemap",
      etag: "\"v1\"",
      lastModified: null,
      parsedPayload: { entries: [] },
      ttlMs: 60_000,
      db,
      now: NOW,
    });
    expect(result).toEqual({ recorded: true, reason: "recorded" });
    expect(getState()?.etag).toBe("\"v1\"");
    expect(getState()?.expiresAt.getTime()).toBe(NOW.getTime() + 60_000);
  });

  it("updates an existing entry via CAS, incrementing version", async () => {
    const { db, getState } = makeDb(makeRow({ version: 3 }));
    const result = await recordHttpValidatorSuccess({
      resourceKey: "sitemap:https://example.com/sitemap.xml",
      resourceClass: "sitemap",
      etag: "\"v2\"",
      lastModified: null,
      parsedPayload: { entries: [{ url: "https://example.com/b", lastmod: null }] },
      ttlMs: 60_000,
      db,
      now: NOW,
    });
    expect(result).toEqual({ recorded: true, reason: "recorded" });
    expect(getState()?.etag).toBe("\"v2\"");
    expect(getState()?.version).toBe(4);
  });

  it("rejects a payload exceeding the bounded size cap", async () => {
    const { db } = makeDb(null);
    const result = await recordHttpValidatorSuccess({
      resourceKey: "sitemap:https://example.com/sitemap.xml",
      resourceClass: "sitemap",
      etag: "\"v1\"",
      parsedPayload: { entries: [{ url: "a".repeat(HTTP_VALIDATOR_CACHE_MAX_PAYLOAD_BYTES + 1) }] },
      ttlMs: 60_000,
      db,
      now: NOW,
    });
    expect(result).toEqual({ recorded: false, reason: "payload_too_large" });
  });

  it("does not record when no validator header is present", async () => {
    const { db } = makeDb(null);
    const result = await recordHttpValidatorSuccess({
      resourceKey: "sitemap:https://example.com/sitemap.xml",
      resourceClass: "sitemap",
      etag: null,
      lastModified: null,
      parsedPayload: { entries: [] },
      ttlMs: 60_000,
      db,
      now: NOW,
    });
    expect(result).toEqual({ recorded: false, reason: "no_validators" });
  });

  it("reports a CAS conflict without throwing when the version has moved on", async () => {
    const { db } = makeDb(makeRow({ version: 5 }));
    (db.httpValidatorCache as any).findUnique = async () => makeRow({ version: 3 }); // stale read
    const result = await recordHttpValidatorSuccess({
      resourceKey: "sitemap:https://example.com/sitemap.xml",
      resourceClass: "sitemap",
      etag: "\"v2\"",
      parsedPayload: { entries: [] },
      ttlMs: 60_000,
      db,
      now: NOW,
    });
    expect(result).toEqual({ recorded: false, reason: "cas_conflict" });
  });
});

describe("recordHttpValidatorNotModified", () => {
  it("extends expiresAt without touching validators or parsedPayload", async () => {
    const { db, getState } = makeDb(makeRow({ etag: "\"stable\"", version: 1 }));
    const result = await recordHttpValidatorNotModified("sitemap:https://example.com/sitemap.xml", 120_000, db, NOW);
    expect(result).toEqual({ recorded: true, reason: "recorded" });
    expect(getState()?.etag).toBe("\"stable\"");
    expect(getState()?.parsedPayload).toEqual(makeRow().parsedPayload);
    expect(getState()?.expiresAt.getTime()).toBe(NOW.getTime() + 120_000);
    expect(getState()?.version).toBe(2);
  });

  it("is a cache-unavailable no-op when no entry exists", async () => {
    const { db } = makeDb(null);
    const result = await recordHttpValidatorNotModified("sitemap:https://example.com/sitemap.xml", 60_000, db, NOW);
    expect(result).toEqual({ recorded: false, reason: "cache_unavailable" });
  });
});
