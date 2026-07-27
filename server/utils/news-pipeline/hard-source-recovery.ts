/**
 * Deterministic recovery suggestion engine for hard-source profiles.
 *
 * Inspects hard-source profile evidence (link filter reasons, detail rejection
 * reasons, browser status, failure count) and produces a compact, actionable
 * recovery suggestion. No LLM/API call required — all rules are deterministic
 * and testable.
 *
 * ## Architecture
 * This module is the "brain" that turns passive hard-source profile evidence
 * into actionable next steps. It sits between the profile creation layer
 * (hard-source-profile.ts) and the discovery profile layer
 * (agent2-discovery-profile.ts).
 *
 * ## Safety
 * - Suggestions are deterministic: same input → same output.
 * - No publisher-specific special casing.
 * - No auto-application of risky suggestions (that happens in
 *   agent2-discovery-profile.ts with explicit draft/active states).
 * - Bounded reason arrays to keep payloads compact.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type HardSourceRecoveryAction =
  | "relax_category_scope"
  | "prefer_listing_links"
  | "use_browser_detail_dates"
  | "increase_browser_detail_limit"
  | "respect_cooldown"
  | "mark_unsupported"
  | "needs_ai_inspection";

export type HardSourceRecoveryConfidence = "low" | "medium" | "high";

export type HardSourceRecoverySuggestion = {
  action: HardSourceRecoveryAction;
  confidence: HardSourceRecoveryConfidence;
  reasons: string[];
  proposedProfilePatch?: Record<string, unknown>;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_REASONS = 8;

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readReasonMap(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof key === "string" && typeof val === "number" && Number.isFinite(val)) {
      result[key] = val;
    }
  }
  return result;
}

function sumValues(map: Record<string, number>): number {
  return Object.values(map).reduce((a, b) => a + b, 0);
}

function dominantKey(map: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of Object.entries(map)) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

// ─── Input normalization ────────────────────────────────────────────────────

export type HardSourceRecoveryInput = {
  /** Profile lifecycle state. Profiles that are resolved/ignored/stale should not get new suggestions. */
  lifecycleState?: string | null;
  /** Static discovery quality label. */
  staticQuality: "failed" | "weak" | "blocked" | null;
  /** Browser fallback status. */
  browserStatus: "BROWSER_NO_CANDIDATES" | "BROWSER_RUNTIME_UNAVAILABLE" | "BROWSER_FALLBACK_DISABLED" | null;
  /** Accumulated dominant failure reasons from past runs. */
  dominantReasons: string[];
  /** Link-level filter rejection reason counts. */
  linkFilterReasons: Record<string, number>;
  /** Detail-level rejection reason counts. */
  detailRejectionReasons: Record<string, number>;
  /** Total failure count for this target. */
  failureCount: number;
  /** Number of candidates the browser shortlisted (from link extraction). */
  browserShortlistedLinks?: number | null;
  /** Number of candidates the browser actually evaluated in detail. */
  browserEvaluated?: number | null;
  /** Number of candidates the browser accepted. */
  browserAccepted?: number | null;
  /** Top shortlisted link URL samples from the browser run. */
  browserShortlistedLinkSamples?: Array<{ url: string; score: number; scoreReasons: string[]; utilityPath: boolean }> | null;
  /** Browser detail evaluation stopped reason. */
  browserDetailEvaluationStoppedReason?: string | null;
};

/**
 * Normalize an unknown payload into a HardSourceRecoveryInput.
 * Returns null if the input is fundamentally unprocessable.
 */
export function normalizeRecoveryInput(payload: unknown): HardSourceRecoveryInput | null {
  if (!isPlainObject(payload)) return null;

  const staticQuality = readString(payload.staticQuality);
  const browserStatus = readString(payload.browserStatus);

  // Accept known quality values or null
  const validQualities = new Set(["failed", "weak", "blocked"]);
  const sq = staticQuality && validQualities.has(staticQuality)
    ? staticQuality as "failed" | "weak" | "blocked"
    : null;

  // Accept known browser statuses or null
  const validBrowserStatuses = new Set([
    "BROWSER_NO_CANDIDATES",
    "BROWSER_RUNTIME_UNAVAILABLE",
    "BROWSER_FALLBACK_DISABLED",
  ]);
  const bs = browserStatus && validBrowserStatuses.has(browserStatus)
    ? browserStatus as "BROWSER_NO_CANDIDATES" | "BROWSER_RUNTIME_UNAVAILABLE" | "BROWSER_FALLBACK_DISABLED"
    : null;

  // If both are null, there's no evidence to work with
  if (sq === null && bs === null) return null;

  const dominantReasons = Array.isArray(payload.dominantReasons)
    ? payload.dominantReasons.filter((r: unknown) => typeof r === "string").slice(0, 20)
    : [];

  return {
    lifecycleState: readString(payload.lifecycleState) ?? readString(payload.profileLifecycleState),
    staticQuality: sq,
    browserStatus: bs,
    dominantReasons,
    linkFilterReasons: readReasonMap(payload.linkFilterReasons),
    detailRejectionReasons: readReasonMap(payload.detailRejectionReasons),
    failureCount: readNumber(payload.failureCount) ?? 1,
    browserShortlistedLinks: readNumber(payload.browserShortlistedLinks),
    browserEvaluated: readNumber(payload.browserEvaluated),
    browserAccepted: readNumber(payload.browserAccepted),
    browserShortlistedLinkSamples: Array.isArray(payload.browserShortlistedLinkSamples)
      ? payload.browserShortlistedLinkSamples.slice(0, 10)
      : null,
    browserDetailEvaluationStoppedReason: readString(payload.browserDetailEvaluationStoppedReason),
  };
}

// ─── Core suggestion logic ──────────────────────────────────────────────────

/**
 * Determine a deterministic recovery suggestion from hard-source profile
 * evidence. Returns null if the profile is in a terminal state (resolved,
 * ignored, stale) or if there is insufficient evidence.
 */
export function suggestRecovery(input: HardSourceRecoveryInput): HardSourceRecoverySuggestion | null {
  // Terminal lifecycle states should not receive new suggestions.
  const terminalStates = new Set(["resolved", "ignored", "stale"]);
  if (input.lifecycleState && terminalStates.has(input.lifecycleState)) {
    return null;
  }

  const { staticQuality, browserStatus, dominantReasons, linkFilterReasons, detailRejectionReasons, failureCount } = input;
  const reasons: string[] = [];

  // 1. Browser runtime unavailable → not a source problem
  if (browserStatus === "BROWSER_RUNTIME_UNAVAILABLE") {
    return {
      action: "needs_ai_inspection",
      confidence: "low",
      reasons: ["Browser runtime unavailable — environment issue, not source failure."],
      proposedProfilePatch: undefined,
    };
  }

  // 2. Browser fallback disabled
  if (browserStatus === "BROWSER_FALLBACK_DISABLED") {
    return {
      action: "needs_ai_inspection",
      confidence: "low",
      reasons: ["Browser fallback disabled by environment variable."],
      proposedProfilePatch: undefined,
    };
  }

  // 3. Cooldown dominated
  const totalLinkReasons = sumValues(linkFilterReasons);
  const totalDetailReasons = sumValues(detailRejectionReasons);
  const totalReasons = totalLinkReasons + totalDetailReasons;

  const rateLimitCount =
    (detailRejectionReasons["rate_limited"] || 0) +
    (detailRejectionReasons["http_429"] || 0);
  if (totalReasons > 0 && rateLimitCount / totalReasons > 0.4) {
    reasons.push(`Rate-limit rejections dominate (${rateLimitCount}/${totalReasons}).`);
    return {
      action: "respect_cooldown",
      confidence: "high",
      reasons,
    };
  }

  // 4. out_of_category_scope dominates with article-like URLs
  const outOfScopeCount =
    (linkFilterReasons["out_of_category_scope"] || 0) +
    (linkFilterReasons["different_domain"] || 0) +
    (detailRejectionReasons["rejected_out_of_scope"] || 0);
  if (totalReasons > 0 && outOfScopeCount / totalReasons > 0.5) {
    reasons.push(`Out-of-scope rejections dominate (${outOfScopeCount}/${totalReasons}).`);

    // Check if shortlisted links look article-like (have good scores)
    const samples = input.browserShortlistedLinkSamples ?? [];
    const articleLikeSamples = samples.filter((s) => s.score >= 50 && !s.utilityPath);
    if (articleLikeSamples.length > 0) {
      const pathPrefixes = extractPathPrefixes(articleLikeSamples.map((s) => s.url));
      return {
        action: "relax_category_scope",
        confidence: "high",
        reasons: [...reasons, `${articleLikeSamples.length} shortlisted links look article-like.`],
        proposedProfilePatch: {
          relaxCategoryScope: true,
          allowedPathPrefixes: pathPrefixes,
        },
      };
    }

    return {
      action: "relax_category_scope",
      confidence: "medium",
      reasons,
    };
  }

  // 5. Missing/invalid dates with good titles
  const dateIssues =
    (detailRejectionReasons["missing_published_at"] || 0) +
    (detailRejectionReasons["invalid_published_at"] || 0) +
    (detailRejectionReasons["future_published_at"] || 0);
  const hasGoodTitles = dominantReasons.some(
    (r) => r.includes("title") || r.includes("wouldAcceptWithWeakDate"),
  );
  if (totalReasons > 0 && dateIssues / totalReasons > 0.4 && hasGoodTitles) {
    reasons.push(`Date-related rejections dominate (${dateIssues}/${totalReasons}) with article-like titles.`);
    return {
      action: "use_browser_detail_dates",
      confidence: "medium",
      reasons,
      proposedProfilePatch: {
        allowWeakDateFromListingContext: true,
      },
    };
  }

  // 6. Browser rendered but evaluated=0 with listing links
  if (
    browserStatus === "BROWSER_NO_CANDIDATES" &&
    input.browserEvaluated === 0 &&
    (input.browserShortlistedLinks ?? 0) > 0
  ) {
    const listingPageCount = (linkFilterReasons["listing_page"] || 0) +
      (linkFilterReasons["utility_path"] || 0);
    if (totalLinkReasons > 0 && listingPageCount / totalLinkReasons > 0.3) {
      reasons.push(`Browser found ${input.browserShortlistedLinks} shortlisted links but evaluated 0; listing/utility paths dominate.`);
      return {
        action: "prefer_listing_links",
        confidence: "medium",
        reasons,
      };
    }
    reasons.push(`Browser found ${input.browserShortlistedLinks} shortlisted links but evaluated 0 detail pages.`);
    return {
      action: "needs_ai_inspection",
      confidence: "medium",
      reasons,
    };
  }

  // 7. Browser hit detail evaluation limit
  if (input.browserDetailEvaluationStoppedReason === "detail_limit") {
    reasons.push("Browser stopped after hitting the detail evaluation limit.");
    return {
      action: "increase_browser_detail_limit",
      confidence: "low",
      reasons,
      proposedProfilePatch: {
        maxBrowserDetailEvaluations: 20,
      },
    };
  }

  // 8. Dynamic/empty HTML + browser no candidates → AI inspection
  const hasDynamicHtml = dominantReasons.some(
    (r) => r.includes("dynamic_or_empty_html") || r.includes("blocked_by_robots"),
  );
  if (hasDynamicHtml && browserStatus === "BROWSER_NO_CANDIDATES") {
    reasons.push("Dynamic/empty HTML detected and browser found no candidates.");
    return {
      action: "needs_ai_inspection",
      confidence: "medium",
      reasons,
    };
  }

  // 9. Repeated failures with no clear deterministic fix
  if (failureCount >= 3 && browserStatus === "BROWSER_NO_CANDIDATES") {
    reasons.push(`${failureCount} failures with no clear deterministic fix.`);
    return {
      action: "needs_ai_inspection",
      confidence: failureCount >= 5 ? "high" : "medium",
      reasons,
    };
  }

  // 10. Source appears unsupported
  if (failureCount >= 5 && staticQuality === "failed") {
    const domReason = dominantKey(detailRejectionReasons) ?? dominantKey(linkFilterReasons);
    reasons.push(`${failureCount} failures; dominant reason: ${domReason ?? "unknown"}.`);
    return {
      action: "mark_unsupported",
      confidence: "low",
      reasons,
    };
  }

  // 11. High failure count with no clear pattern and no browser attempt
  if (failureCount >= 3 && browserStatus === null) {
    reasons.push(`${failureCount} failures with no browser fallback attempted.`);
    return {
      action: "needs_ai_inspection",
      confidence: "low",
      reasons,
    };
  }

  // Default: not enough evidence for a deterministic suggestion
  return null;
}

// ─── Path prefix extraction ─────────────────────────────────────────────────

/**
 * Extract common path prefixes from a list of URLs.
 * Used to propose allowedPathPrefixes for relax_category_scope.
 */
function extractPathPrefixes(urls: string[]): string[] {
  const pathCounts: Record<string, number> = {};
  for (const url of urls) {
    try {
      const path = new URL(url).pathname;
      // Extract up to 3 path segments
      const segments = path.split("/").filter(Boolean);
      for (let depth = 1; depth <= Math.min(segments.length, 3); depth++) {
        const prefix = "/" + segments.slice(0, depth).join("/");
        pathCounts[prefix] = (pathCounts[prefix] || 0) + 1;
      }
    } catch {
      // invalid URL — skip
    }
  }

  // Return prefixes that appear in at least 50% of URLs, sorted by depth (longest first)
  const threshold = Math.max(1, Math.floor(urls.length * 0.5));
  return Object.entries(pathCounts)
    .filter(([, count]) => count >= threshold)
    .map(([prefix]) => prefix)
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
}
