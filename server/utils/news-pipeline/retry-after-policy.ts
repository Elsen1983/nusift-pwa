export type StaticDiscoveryRetryAfterSource = "delta_seconds" | "http_date" | "fallback";

export const STATIC_RETRY_AFTER_FALLBACK_MS = 15 * 60 * 1000;
export const STATIC_RETRY_AFTER_MIN_MS = 30 * 1000;
export const STATIC_RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

/** Parse both Retry-After formats and clamp untrusted cooldowns to safe bounds. */
export function parseBoundedStaticRetryAfter(
  value: string | null | undefined,
  nowMs = Date.now(),
): { retryAfterAt: string; source: StaticDiscoveryRetryAfterSource } {
  const raw = value?.trim() ?? "";
  let delayMs: number | null = null;
  let source: StaticDiscoveryRetryAfterSource = "fallback";
  if (/^\d+$/.test(raw)) {
    delayMs = Number(raw) * 1000;
    source = "delta_seconds";
  } else if (raw) {
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
      delayMs = dateMs - nowMs;
      source = "http_date";
    }
  }
  const boundedDelay = Math.min(
    STATIC_RETRY_AFTER_MAX_MS,
    Math.max(STATIC_RETRY_AFTER_MIN_MS, Number.isFinite(delayMs ?? NaN) ? delayMs as number : STATIC_RETRY_AFTER_FALLBACK_MS),
  );
  return {
    retryAfterAt: new Date(nowMs + boundedDelay).toISOString(),
    source,
  };
}

/** Normalize persisted Retry-After evidence at a trust boundary. */
export function boundStaticRetryAfterTimestamp(
  value: string | null | undefined,
  source: StaticDiscoveryRetryAfterSource | null | undefined,
  nowMs = Date.now(),
): { retryAfterAt: string; source: StaticDiscoveryRetryAfterSource } {
  const parsedMs = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsedMs)) return parseBoundedStaticRetryAfter(null, nowMs);

  const boundedDelay = Math.min(
    STATIC_RETRY_AFTER_MAX_MS,
    Math.max(STATIC_RETRY_AFTER_MIN_MS, parsedMs - nowMs),
  );
  const normalizedSource = source === "delta_seconds" || source === "http_date" || source === "fallback"
    ? source
    : "fallback";
  return {
    retryAfterAt: new Date(nowMs + boundedDelay).toISOString(),
    source: normalizedSource,
  };
}
