import { AGENT3_EXTRACTOR_VERSION } from "./enrichment";

export const MAX_AUTOMATIC_AGENT3_ATTEMPTS = 3;
/** Durable retry evidence must not park work for an unbounded period. */
export const MAX_AGENT3_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
export const AGENT3_RETRY_COOLDOWN_MS = {
  /** First 403 is retried promptly; repeated failures remain bounded by attempts and the host governor. */
  http403: 60 * 60 * 1000,
  http429: 60 * 60 * 1000,
  browserRuntimeUnavailable: 30 * 60 * 1000,
  /** Bounded pacing for INTERSTITIAL_OR_CHALLENGE while browser recovery is pending. */
  interstitialBrowserPending: 30 * 60 * 1000,
} as const;

export type Agent3RetryDisposition =
  | { state: "READY_NEW" | "READY_RETRY"; priority: number; attemptNumber: number }
  | {
      state: "DEFERRED";
      retryAfter: string;
      reasonCode: string;
      retryAfterSource: "persisted" | "derived";
      retryAfterCapped: boolean;
    }
  | { state: "QUARANTINED"; reasonCode: string; attemptNumber: number }
  | { state: "NON_RETRYABLE"; reasonCode: string };

export type Agent3RetryInput = {
  enrichmentStatus: string | null;
  enrichmentAttemptCount?: number | null;
  enrichmentFinishedAt?: Date | null;
  enrichmentOutcome?: unknown;
  now?: Date;
  forceReprocess?: boolean;
  explicitlyTargeted?: boolean;
  /** Admin/debug selector may intentionally include an active cooldown. */
  ignoreCooldown?: boolean;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const outcomeValue = (input: Pick<Agent3RetryInput, "enrichmentOutcome">, key: string): unknown => {
  const outcome = asRecord(input.enrichmentOutcome);
  if (!outcome) return undefined;
  return outcome[key];
};

const rejection = (input: Pick<Agent3RetryInput, "enrichmentOutcome">): Record<string, unknown> | null =>
  asRecord(outcomeValue(input, "rejection"));

export function getAgent3AttemptNumber(input: Agent3RetryInput): number {
  return Math.max(0, Number.isFinite(input.enrichmentAttemptCount ?? NaN)
    ? Math.floor(input.enrichmentAttemptCount as number)
    : 0);
}

export type Agent3RetryAfterResolution = {
  retryAfter: string;
  source: "persisted" | "derived";
  capped: boolean;
};

export function getAgent3RetryAfterResolution(
  input: Agent3RetryInput,
): Agent3RetryAfterResolution | null {
  // A corrupted future timestamp must be capped relative to the durable
  // failure time, not the current scan time. Otherwise every subsequent scan
  // would slide the cap forward and defer the same row forever.
  const retryAnchor = input.enrichmentFinishedAt ?? input.now ?? new Date();
  const explicit = [
    outcomeValue(input, "retryAfterAt"),
    outcomeValue(input, "retryAfter"),
    outcomeValue(input, "nextRetryAt"),
    rejection(input)?.retryAfter,
    rejection(input)?.retryAfterAt,
    asRecord(outcomeValue(input, "browserFallback"))?.retryAfterAt,
  ].find((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  if (explicit) {
    const parsedMs = Date.parse(explicit);
    const cappedMs = Math.min(parsedMs, retryAnchor.getTime() + MAX_AGENT3_RETRY_AFTER_MS);
    return {
      retryAfter: new Date(cappedMs).toISOString(),
      source: "persisted",
      capped: cappedMs !== parsedMs,
    };
  }

  const finishedAt = input.enrichmentFinishedAt;
  if (!finishedAt) return null;
  const status = getAgent3HttpStatus(input);
  const browser = asRecord(outcomeValue(input, "browserFallback"));
  const runtimeUnavailable = browser?.runtimeUnavailable === true
    || browser?.browserRejectedReason === "browser_runtime_unavailable";
  // INTERSTITIAL_OR_CHALLENGE stays recoverable: while browser recovery is
  // pending (disabled/unavailable/failed) it is paced by a bounded cooldown so
  // it is neither retried immediately nor parked forever. HTTP 403/429 always
  // take precedence so their cooldowns are never bypassed.
  const kind = outcomeValue(input, "kind");
  const code = reasonCode(input);
  const interstitial = kind === "INTERSTITIAL_OR_CHALLENGE" || code === "INTERSTITIAL_OR_CHALLENGE";
  const cooldown = status === 429
    ? AGENT3_RETRY_COOLDOWN_MS.http429
    : status === 403
      ? AGENT3_RETRY_COOLDOWN_MS.http403
      : runtimeUnavailable
        ? AGENT3_RETRY_COOLDOWN_MS.browserRuntimeUnavailable
        : interstitial
          ? AGENT3_RETRY_COOLDOWN_MS.interstitialBrowserPending
          : null;
  if (cooldown === null) return null;
  return {
    retryAfter: new Date(finishedAt.getTime() + cooldown).toISOString(),
    source: "derived",
    capped: false,
  };
}

export function getAgent3RetryAfter(input: Agent3RetryInput): string | null {
  return getAgent3RetryAfterResolution(input)?.retryAfter ?? null;
}

export function getAgent3HttpStatus(
  input: Pick<Agent3RetryInput, "enrichmentOutcome">,
): number | null {
  const rejectionValue = rejection(input);
  const status = rejectionValue?.httpStatus ?? outcomeValue(input, "rejectionHttpStatus")
    ?? asRecord(outcomeValue(input, "browserFallback"))?.statusCode;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function reasonCode(input: Agent3RetryInput): string {
  const rejectionValue = rejection(input);
  const code = rejectionValue?.code ?? outcomeValue(input, "rejectionCode");
  if (typeof code === "string" && code.length > 0) return code;
  const kind = outcomeValue(input, "kind");
  return typeof kind === "string" && kind.length > 0 ? kind : "LEGACY_UNKNOWN";
}

function isExplicitBypass(input: Agent3RetryInput): boolean {
  return input.forceReprocess === true || input.explicitlyTargeted === true;
}

export function decideAgent3RetryDisposition(input: Agent3RetryInput): Agent3RetryDisposition {
  const status = input.enrichmentStatus;
  const attemptNumber = getAgent3AttemptNumber(input);
  const now = input.now ?? new Date();

  if (isExplicitBypass(input)) {
    return status === "INGESTED"
      ? { state: "READY_NEW", priority: 0, attemptNumber }
      : { state: "READY_RETRY", priority: Math.min(attemptNumber, 2) + 1, attemptNumber };
  }

  if (status === "INGESTED") {
    return attemptNumber >= MAX_AUTOMATIC_AGENT3_ATTEMPTS
      ? { state: "QUARANTINED", reasonCode: "ATTEMPT_CAP_REACHED", attemptNumber }
      : { state: "READY_NEW", priority: 0, attemptNumber };
  }
  if (status !== "ENRICHMENT_FAILED") {
    return { state: "NON_RETRYABLE", reasonCode: status === "ENRICHMENT_QUEUED_HEADLESS"
      ? "HEADLESS_REQUIRED"
      : status ?? "UNKNOWN_STATUS" };
  }
  if (attemptNumber >= MAX_AUTOMATIC_AGENT3_ATTEMPTS) {
    return { state: "QUARANTINED", reasonCode: reasonCode(input), attemptNumber };
  }

  const kind = outcomeValue(input, "kind");
  const code = reasonCode(input);
  const version = outcomeValue(input, "extractorVersion");
  const browser = asRecord(outcomeValue(input, "browserFallback"));
  const runtimeUnavailable = browser?.runtimeUnavailable === true
    || browser?.browserRejectedReason === "browser_runtime_unavailable";
  const retryAfterResolution = getAgent3RetryAfterResolution(input);
  const retryAfter = retryAfterResolution?.retryAfter ?? null;
  if (!input.ignoreCooldown && retryAfter && Date.parse(retryAfter) > now.getTime()) {
    return {
      state: "DEFERRED",
      retryAfter,
      reasonCode: runtimeUnavailable ? "BROWSER_RUNTIME_UNAVAILABLE" : code,
      retryAfterSource: retryAfterResolution?.source ?? "derived",
      retryAfterCapped: retryAfterResolution?.capped ?? false,
    };
  }
  if (!input.ignoreCooldown && (kind === "HEADLESS_REQUIRED" || code === "HEADLESS_REQUIRED" || runtimeUnavailable)) {
    if (!retryAfter) {
      return { state: "NON_RETRYABLE", reasonCode: runtimeUnavailable
        ? "BROWSER_RUNTIME_UNAVAILABLE"
        : "HEADLESS_REQUIRED" };
    }
    return {
      state: "DEFERRED",
      retryAfter,
      reasonCode: runtimeUnavailable ? "BROWSER_RUNTIME_UNAVAILABLE" : "HEADLESS_REQUIRED",
      retryAfterSource: retryAfterResolution?.source ?? "derived",
      retryAfterCapped: retryAfterResolution?.capped ?? false,
    };
  }

  // A version change and legacy rows receive a bounded migration retry.
  if (!asRecord(input.enrichmentOutcome) || version !== AGENT3_EXTRACTOR_VERSION) {
    return { state: "READY_RETRY", priority: Math.min(attemptNumber, 2) + 1, attemptNumber };
  }
  if (kind === "RETRYABLE_FAILURE" || code === "FETCH_TIMEOUT" || code === "HTTP_FORBIDDEN" ||
      code === "HTTP_429" || getAgent3HttpStatus(input) === 403 || getAgent3HttpStatus(input) === 429) {
    return { state: "READY_RETRY", priority: Math.min(attemptNumber, 2) + 1, attemptNumber };
  }

  // INTERSTITIAL_OR_CHALLENGE is browser-recoverable in principle, so it stays
  // bounded-retryable rather than terminal: DEFERRED during the interstitial
  // cooldown (handled above), READY_RETRY afterwards, and QUARANTINED once the
  // automatic attempt budget is exhausted (handled before this branch).
  if (kind === "INTERSTITIAL_OR_CHALLENGE" || code === "INTERSTITIAL_OR_CHALLENGE") {
    return { state: "READY_RETRY", priority: Math.min(attemptNumber, 2) + 1, attemptNumber };
  }

  return { state: "NON_RETRYABLE", reasonCode: code };
}

export function getAgent3Tier(input: Agent3RetryInput): "NEW" | "RETRY_1" | "RETRY_2" | "LEGACY" | "DEFERRED" | "QUARANTINED" | "NON_RETRYABLE" {
  const disposition = decideAgent3RetryDisposition(input);
  if (disposition.state === "READY_NEW") return "NEW";
  if (disposition.state === "READY_RETRY") {
    const attemptNumber = getAgent3AttemptNumber(input);
    if (attemptNumber === 1) return "RETRY_1";
    if (attemptNumber === 2) return "RETRY_2";
    return "LEGACY";
  }
  return disposition.state;
}

export function isAgent3RetryableNow(input: Agent3RetryInput): boolean {
  const disposition = decideAgent3RetryDisposition(input);
  return disposition.state === "READY_NEW" || disposition.state === "READY_RETRY";
}
