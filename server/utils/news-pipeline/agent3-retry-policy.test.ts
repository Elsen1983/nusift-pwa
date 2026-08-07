import { describe, expect, it } from "vitest";
import { AGENT3_EXTRACTOR_VERSION } from "./enrichment";
import {
  decideAgent3RetryDisposition,
  getAgent3RetryAfter,
} from "./agent3-retry-policy";

const finishedAt = new Date("2026-08-01T10:00:00.000Z");
const now = new Date("2026-08-01T10:15:00.000Z");

const failed = (overrides: Record<string, unknown> = {}) => ({
  enrichmentStatus: "ENRICHMENT_FAILED",
  enrichmentAttemptCount: 1,
  enrichmentFinishedAt: finishedAt,
  enrichmentOutcome: {
    extractorVersion: AGENT3_EXTRACTOR_VERSION,
    kind: "RETRYABLE_FAILURE",
    rejectionCode: "FETCH_TIMEOUT",
  },
  now,
  ...overrides,
});

describe("Agent 3 retry policy", () => {
  it("classifies new and bounded retry tiers deterministically", () => {
    expect(decideAgent3RetryDisposition({
      enrichmentStatus: "INGESTED",
      enrichmentAttemptCount: 0,
      now,
    })).toMatchObject({ state: "READY_NEW", attemptNumber: 0 });
    expect(decideAgent3RetryDisposition(failed())).toMatchObject({ state: "READY_RETRY", attemptNumber: 1 });
    expect(decideAgent3RetryDisposition(failed({ enrichmentAttemptCount: 2 })))
      .toMatchObject({ state: "READY_RETRY", attemptNumber: 2 });
    expect(decideAgent3RetryDisposition(failed({ enrichmentAttemptCount: 3 })))
      .toMatchObject({ state: "QUARANTINED", attemptNumber: 3 });
  });

  it("allows explicit and force-reprocess attempt-cap bypasses", () => {
    expect(decideAgent3RetryDisposition(failed({ enrichmentAttemptCount: 3, explicitlyTargeted: true })).state)
      .toBe("READY_RETRY");
    expect(decideAgent3RetryDisposition(failed({ enrichmentAttemptCount: 3, forceReprocess: true })).state)
      .toBe("READY_RETRY");
  });

  it("keeps HTTP cooldown timestamps anchored to the failure", () => {
    const input = failed({
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionHttpStatus: 429,
        rejectionCode: "HTTP_429",
      },
    });
    const first = getAgent3RetryAfter(input);
    const second = getAgent3RetryAfter({ ...input, now: new Date("2026-08-01T10:30:00.000Z") });
    expect(first).toBe("2026-08-01T11:00:00.000Z");
    expect(second).toBe(first);
    expect(decideAgent3RetryDisposition(input).state).toBe("DEFERRED");
    expect(decideAgent3RetryDisposition({ ...input, now: new Date("2026-08-01T11:01:00.000Z") }).state)
      .toBe("READY_RETRY");
  });

  it("anchors HTTP 403 fallback cooldown to enrichmentFinishedAt", () => {
    const input = failed({
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionHttpStatus: 403,
        rejectionCode: "HTTP_FORBIDDEN",
      },
    });
    expect(getAgent3RetryAfter(input)).toBe("2026-08-02T10:00:00.000Z");
  });

  it("does not manufacture a sliding HEADLESS_REQUIRED retry time", () => {
    const input = failed({
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HEADLESS_REQUIRED",
        rejectionCode: "HEADLESS_REQUIRED",
      },
    });
    expect(getAgent3RetryAfter(input)).toBeNull();
    expect(decideAgent3RetryDisposition(input)).toEqual({
      state: "NON_RETRYABLE",
      reasonCode: "HEADLESS_REQUIRED",
    });
  });

  it("uses a stable browser-runtime cooldown when failure time exists", () => {
    const input = failed({
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "RETRYABLE_FAILURE",
        browserFallback: { runtimeUnavailable: true },
      },
    });
    expect(getAgent3RetryAfter(input)).toBe("2026-08-01T10:30:00.000Z");
    expect(decideAgent3RetryDisposition(input).state).toBe("DEFERRED");
  });

  it("keeps permanent current-version failures non-retryable and legacy retries bounded", () => {
    expect(decideAgent3RetryDisposition(failed({
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "LOW_CONTENT_QUALITY",
        rejectionCode: "LOW_CONTENT_QUALITY",
      },
    })).state).toBe("NON_RETRYABLE");
    expect(decideAgent3RetryDisposition(failed({ enrichmentOutcome: null })).state).toBe("READY_RETRY");
    expect(decideAgent3RetryDisposition(failed({ enrichmentOutcome: null, enrichmentAttemptCount: 3 })).state)
      .toBe("QUARANTINED");
  });

  it("paces INTERSTITIAL_OR_CHALLENGE with a bounded cooldown instead of terminal failure", () => {
    const input = failed({
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "INTERSTITIAL_OR_CHALLENGE",
        rejectionCode: "INTERSTITIAL_OR_CHALLENGE",
        rejectionHttpStatus: 202,
        browserFallback: {
          attempted: false,
          browserFallbackSkippedReason: "browser_disabled",
        },
      },
    });
    // finishedAt 10:00 + 30min interstitial cooldown → 10:30
    expect(getAgent3RetryAfter(input)).toBe("2026-08-01T10:30:00.000Z");
    // Inside the cooldown window it is deferred (no immediate retry loop)…
    expect(decideAgent3RetryDisposition(input).state).toBe("DEFERRED");
    // …and after the cooldown it becomes bounded-retryable, never terminal.
    expect(decideAgent3RetryDisposition({
      ...input,
      now: new Date("2026-08-01T10:45:00.000Z"),
    }).state).toBe("READY_RETRY");
    // The deterministic interstitial must not be retried forever: the attempt
    // budget still caps it at QUARANTINED.
    expect(decideAgent3RetryDisposition({
      ...input,
      enrichmentAttemptCount: 3,
      now: new Date("2026-08-01T10:45:00.000Z"),
    }).state).toBe("QUARANTINED");
  });

  it("does not let INTERSTITIAL_OR_CHALLENGE bypass HTTP 429/403 cooldowns", () => {
    const input = failed({
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "INTERSTITIAL_OR_CHALLENGE",
        rejectionCode: "INTERSTITIAL_OR_CHALLENGE",
        rejectionHttpStatus: 429,
      },
    });
    // HTTP 429 cooldown (1h) wins over the interstitial 30min cooldown.
    expect(getAgent3RetryAfter(input)).toBe("2026-08-01T11:00:00.000Z");
    expect(decideAgent3RetryDisposition(input).state).toBe("DEFERRED");
  });

  it("keeps browser-runtime-unavailable interstitial deferred with runtime reason", () => {
    const input = failed({
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "INTERSTITIAL_OR_CHALLENGE",
        browserFallback: { runtimeUnavailable: true },
      },
    });
    expect(decideAgent3RetryDisposition(input)).toMatchObject({
      state: "DEFERRED",
      reasonCode: "BROWSER_RUNTIME_UNAVAILABLE",
    });
    expect(getAgent3RetryAfter(input)).toBe("2026-08-01T10:30:00.000Z");
  });
});
