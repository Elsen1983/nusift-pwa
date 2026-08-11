import { describe, expect, it } from "vitest";
import {
  isBrowserFallbackEligible,
  isBrowserFallbackEligibleForFailure,
} from "./article-content-browser-extractor";

// Direct tests of the REAL eligibility function (enrichment-runtime.test.ts
// mocks this module, so this file is the only place the actual switch cases
// are exercised).
describe("isBrowserFallbackEligibleForFailure — real implementation", () => {
  it("INTERSTITIAL_OR_CHALLENGE static failures are browser-recoverable", () => {
    expect(isBrowserFallbackEligibleForFailure({
      rejectedReason: "interstitial_or_challenge",
      statusCode: 202,
      detail: "HTTP 202 interstitial/challenge page.",
      qualitySignals: ["http_202_interstitial"],
    })).toBe(true);
    // Backward-compatible wrapper keeps the same decision.
    expect(isBrowserFallbackEligible("interstitial_or_challenge", 202)).toBe(true);
  });

  it("preserves bounded eligibility semantics (403/429/no_article_text/empty_html/too_short)", () => {
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "http_error", statusCode: 403 })).toBe(true);
    // HTTP 429 is a hard no-browser boundary; retry/cooldown handles it.
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "http_error", statusCode: 429 })).toBe(false);
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "http_error", statusCode: 500 })).toBe(false);
    expect(isBrowserFallbackEligibleForFailure({
      rejectedReason: "interstitial_or_challenge",
      statusCode: 200,
      detail: "Cookie challenge rendered with HTTP 200",
    })).toBe(true);
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "no_article_text", statusCode: 200 })).toBe(true);
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "empty_html", statusCode: 200 })).toBe(true);
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "too_short", statusCode: 200 })).toBe(true);
  });

  it("keeps non-browser-recoverable failures ineligible", () => {
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "paywall_or_blocked", statusCode: 200 })).toBe(false);
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "missing_article_url", statusCode: null })).toBe(false);
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "non_html_response", statusCode: 200 })).toBe(false);
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "parse_error", statusCode: 200 })).toBe(false);
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "stale_or_invalid", statusCode: 200 })).toBe(false);
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "fetch_failed", statusCode: 0, detail: "DNS failure" })).toBe(false);
  });
});
