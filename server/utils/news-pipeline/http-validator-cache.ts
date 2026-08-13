import { prisma } from "../prisma";

/**
 * Bounded, durable ETag/Last-Modified conditional-request memory for
 * selected static resource classes (Repair 13). Stores only validator
 * headers and the minimum parsed result needed to reconstruct a 304
 * truthfully — never raw unbounded HTML/XML.
 *
 * Concurrency: a plain optimistic CAS write (read-version, version-guarded
 * `updateMany`, log/skip on conflict) is sufficient here, unlike the robots
 * cache's lease-based single-flight refresh — losing a write race just means
 * the cache isn't updated this cycle (a stale-but-still-valid entry, or a
 * plain miss next time), never corrupted state.
 */

export const HTTP_VALIDATOR_CACHE_MAX_PAYLOAD_BYTES = 200_000;
export const HTTP_VALIDATOR_CACHE_MIN_TTL_MS = 60_000;
export const HTTP_VALIDATOR_CACHE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type HttpValidatorCacheRow = {
  resourceKey: string;
  resourceClass: string;
  etag: string | null;
  lastModified: string | null;
  parsedPayload: unknown;
  payloadBytes: number;
  fetchedAt: Date;
  expiresAt: Date;
  lastHttpStatus: number | null;
  version: number;
};

type HttpValidatorCacheModel = {
  findUnique(args: { where: { resourceKey: string } }): Promise<HttpValidatorCacheRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<HttpValidatorCacheRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
};

export type HttpValidatorCacheDb = { httpValidatorCache: HttpValidatorCacheModel };

const cacheModel = (db?: unknown): HttpValidatorCacheModel | null => {
  const candidate = (db as { httpValidatorCache?: HttpValidatorCacheModel } | undefined)?.httpValidatorCache
    ?? (process.env.VITEST ? undefined : (prisma as unknown as { httpValidatorCache?: HttpValidatorCacheModel }).httpValidatorCache);
  return candidate && typeof candidate.findUnique === "function" && typeof candidate.updateMany === "function"
    ? candidate
    : null;
};

const boundedTtlMs = (value: number): number =>
  Math.max(HTTP_VALIDATOR_CACHE_MIN_TTL_MS, Math.min(Math.floor(value) || HTTP_VALIDATOR_CACHE_MIN_TTL_MS, HTTP_VALIDATOR_CACHE_MAX_TTL_MS));

const isUniqueConflict = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";

/** Bounded lookup: missing, expired, or DB-unavailable are all a uniform "no cached validators." */
export async function lookupHttpValidatorCache(
  resourceKey: string,
  db?: unknown,
  now: Date = new Date(),
): Promise<HttpValidatorCacheRow | null> {
  const model = cacheModel(db);
  if (!model) return null;
  try {
    const row = await model.findUnique({ where: { resourceKey } });
    if (!row || row.expiresAt <= now) return null;
    return row;
  } catch {
    return null;
  }
}

export type RecordHttpValidatorSuccessInput = {
  resourceKey: string;
  resourceClass: string;
  etag?: string | null;
  lastModified?: string | null;
  parsedPayload: unknown;
  ttlMs: number;
  httpStatus?: number | null;
  db?: unknown;
  now?: Date;
};

export type RecordHttpValidatorResult = {
  recorded: boolean;
  reason: "recorded" | "payload_too_large" | "cas_conflict" | "cache_unavailable" | "no_validators";
};

/**
 * Persist fresh validators + a bounded parsed result on a real 2xx response.
 * Never called on 403/429/5xx/timeout, so a prior valid entry is never
 * overwritten by a bad outcome — the caller simply doesn't call this.
 */
export async function recordHttpValidatorSuccess(
  input: RecordHttpValidatorSuccessInput,
): Promise<RecordHttpValidatorResult> {
  if (!input.etag && !input.lastModified) return { recorded: false, reason: "no_validators" };

  let serialized: string;
  try {
    serialized = JSON.stringify(input.parsedPayload);
  } catch {
    return { recorded: false, reason: "payload_too_large" };
  }
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  if (payloadBytes > HTTP_VALIDATOR_CACHE_MAX_PAYLOAD_BYTES) {
    return { recorded: false, reason: "payload_too_large" };
  }

  const model = cacheModel(input.db);
  if (!model) return { recorded: false, reason: "cache_unavailable" };

  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + boundedTtlMs(input.ttlMs));
  const data = {
    resourceClass: input.resourceClass,
    etag: input.etag ?? null,
    lastModified: input.lastModified ?? null,
    parsedPayload: input.parsedPayload,
    payloadBytes,
    fetchedAt: now,
    expiresAt,
    lastHttpStatus: input.httpStatus ?? null,
  };

  try {
    let row = await model.findUnique({ where: { resourceKey: input.resourceKey } });
    if (!row) {
      try {
        await model.create({ data: { resourceKey: input.resourceKey, version: 0, ...data } });
        return { recorded: true, reason: "recorded" };
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
        row = await model.findUnique({ where: { resourceKey: input.resourceKey } });
      }
    }
    if (!row) return { recorded: false, reason: "cache_unavailable" };
    const updated = await model.updateMany({
      where: { resourceKey: input.resourceKey, version: row.version },
      data: { ...data, version: { increment: 1 } },
    });
    return updated.count === 1
      ? { recorded: true, reason: "recorded" }
      : { recorded: false, reason: "cas_conflict" };
  } catch {
    return { recorded: false, reason: "cache_unavailable" };
  }
}

/**
 * Extend freshness on a 304 without touching validators or the parsed
 * payload. No-op (cache_unavailable) when no prior entry exists — the
 * caller must treat that as a truthful cache miss, never fabricate content.
 */
export async function recordHttpValidatorNotModified(
  resourceKey: string,
  ttlMs: number,
  db?: unknown,
  now: Date = new Date(),
): Promise<RecordHttpValidatorResult> {
  const model = cacheModel(db);
  if (!model) return { recorded: false, reason: "cache_unavailable" };
  try {
    const row = await model.findUnique({ where: { resourceKey } });
    if (!row) return { recorded: false, reason: "cache_unavailable" };
    const expiresAt = new Date(now.getTime() + boundedTtlMs(ttlMs));
    const updated = await model.updateMany({
      where: { resourceKey, version: row.version },
      data: { fetchedAt: now, expiresAt, version: { increment: 1 } },
    });
    return updated.count === 1
      ? { recorded: true, reason: "recorded" }
      : { recorded: false, reason: "cas_conflict" };
  } catch {
    return { recorded: false, reason: "cache_unavailable" };
  }
}
