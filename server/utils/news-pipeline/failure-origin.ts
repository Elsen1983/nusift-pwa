/**
 * Failure-origin classification.
 *
 * Distinguishes WHY a discovery/extraction attempt failed so that
 * infrastructure problems are never treated as evidence about the publisher:
 *
 *  - publisher_content_failure     — genuine evidence the publisher is hard
 *    (static weak/failed + browser no-candidates, LOW_CONTENT_QUALITY, etc.)
 *  - transient_publisher_response  — HTTP 429 / temporary timeouts
 *  - platform_runtime_failure      — BROWSER_RUNTIME_UNAVAILABLE, DNS/network
 *    infra failures outside the publisher's control
 *  - security_policy_block         — SSRF / redirect / URL policy rejections
 *  - configuration_failure         — BROWSER_FALLBACK_DISABLED, invalid runtime
 *    configuration, missing env
 *
 * BROWSER_RUNTIME_UNAVAILABLE is ALWAYS platform_runtime_failure: it provides
 * no evidence about the publisher and must not create or strengthen
 * hard-source profiles, must not reduce source health, and must not trigger
 * AI inspection of publisher HTML.
 */

export type FailureOrigin =
  | "publisher_content_failure"
  | "transient_publisher_response"
  | "platform_runtime_failure"
  | "security_policy_block"
  | "configuration_failure";

export type BrowserFailureStatus =
  | "BROWSER_NO_CANDIDATES"
  | "BROWSER_RUNTIME_UNAVAILABLE"
  | "BROWSER_FALLBACK_DISABLED"
  | "HEADLESS_PROCESSING_STALE"
  | (string & {});

const PUBLISHER_CONTENT_STATUSES: ReadonlySet<string> = new Set([
  "BROWSER_NO_CANDIDATES",
  "HEADLESS_PROCESSING_STALE",
]);

const CONFIGURATION_STATUSES: ReadonlySet<string> = new Set([
  "BROWSER_FALLBACK_DISABLED",
]);

/**
 * Classify the origin of a browser fallback failure status.
 */
export function classifyBrowserFailureOrigin(
  browserStatus: BrowserFailureStatus | null | undefined,
): FailureOrigin | null {
  if (!browserStatus) return null;
  if (browserStatus === "BROWSER_RUNTIME_UNAVAILABLE") return "platform_runtime_failure";
  if (CONFIGURATION_STATUSES.has(browserStatus)) return "configuration_failure";
  if (PUBLISHER_CONTENT_STATUSES.has(browserStatus)) return "publisher_content_failure";
  return "publisher_content_failure";
}

/**
 * Classify the origin of a static discovery quality assessment.
 *
 * "blocked" here means the PUBLISHER blocked access (robots / 403 anti-bot),
 * which is genuine evidence the publisher is technically difficult — not a
 * block by our own security policy (SSRF/URL-policy rejections live outside
 * this quality assessment and are classified separately by callers).
 */
export function classifyStaticFailureOrigin(
  staticQuality: string | null | undefined,
): FailureOrigin | null {
  if (!staticQuality) return null;
  if (staticQuality === "productive") return null;
  // "failed" / "weak" (with escalation) / "blocked" are genuine publisher
  // evidence when the browser side also produced genuine no-candidates.
  return "publisher_content_failure";
}

/**
 * A hard-source profile is only justified when the static failure AND the
 * browser failure are genuine publisher/content evidence. If the browser
 * failure is a platform/runtime or configuration failure, the profile must
 * not be created or strengthened.
 */
export function isGenuineHardSourceEvidence(input: {
  staticQuality: string | null | undefined;
  browserStatus: BrowserFailureStatus | null | undefined;
}): boolean {
  const browserOrigin = classifyBrowserFailureOrigin(input.browserStatus);
  if (browserOrigin === "platform_runtime_failure" || browserOrigin === "configuration_failure") {
    return false;
  }
  return classifyStaticFailureOrigin(input.staticQuality) === "publisher_content_failure";
}

/**
 * Health-label helper: when the latest browser outcome is a runtime/platform
 * failure, the source health text must say \"browser runtime unavailable\"
 * rather than implying the publisher is blocked.
 */
export function healthDescriptionForBrowserFailure(
  browserStatus: BrowserFailureStatus | null | undefined,
): string | null {
  const origin = classifyBrowserFailureOrigin(browserStatus);
  if (origin === "platform_runtime_failure") {
    return "browser runtime unavailable — environment issue, not a publisher failure";
  }
  if (origin === "configuration_failure") {
    return "browser runtime configuration invalid — enable or configure the browser fallback";
  }
  return null;
}
