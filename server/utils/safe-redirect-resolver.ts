// server/utils/safe-redirect-resolver.ts
/**
 * Safe redirect-resolution utility living at the safe-fetch/security
 * boundary.
 *
 * Resolves redirector / aggregator URLs (e.g. `https://agg.example/rd.cfm?…`
 * that hop to a publisher article) ONE HOP AT A TIME. Every intermediate and
 * final URL is validated with the same security checks as a direct request:
 *
 *  - protocol gate (http/https only, no protocol downgrade)
 *  - hostname format validation
 *  - DNS resolution + private/link-local/metadata IP rejection
 *  - bounded redirect depth and loop detection
 *  - no credentials or sensitive headers are ever forwarded across hosts
 *
 * It records bounded redirect evidence and distinguishes failure kinds so
 * callers can apply different policies:
 *
 *  - `security_rejected`  — the chain hit a security policy violation
 *  - `transient_network`  — timeout / DNS / network error, retryable later
 *  - `rate_limited`       — HTTP 429, retryable with cooldown
 *  - `invalid_redirect`   — malformed, looping, or too-deep chain
 *
 * This module does NOT create an allowlist of open redirectors: every
 * destination is validated like any other URL, and known-unsafe chains are
 * rejected so they never reach Agent 3 enrichment.
 */
import { SSRFError, isBlockedIp, resolveAndValidate } from "./ssrf-guard";

/* ------------------------------------------------------------------ */
/*  CONSTANTS                                                          */
/* ------------------------------------------------------------------ */

/** Only these schemes are permitted for every hop. */
const ALLOWED_REDIRECT_PROTOCOLS = new Set(["http:", "https:"]);

/** Strict maximum redirect hops (stricter than generic safeFetch). */
export const MAX_SAFE_REDIRECT_HOPS = 3;

/** Default per-hop timeout. */
const DEFAULT_REDIRECT_TIMEOUT_MS = 10_000;

/** Raw IP literal detectors (reused for IP-only URLs). */
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;

/* ------------------------------------------------------------------ */
/*  TYPES                                                              */
/* ------------------------------------------------------------------ */

export type SafeRedirectFailureKind =
  | "security_rejected"
  | "transient_network"
  | "rate_limited"
  | "invalid_redirect";

export type SafeRedirectHop = {
  url: string;
  httpStatus: number | null;
};

export type SafeRedirectEvidence = {
  /** Original URL handed to the resolver (never rewritten). */
  originalUrl: string;
  /** Final canonical URL when resolution succeeded, otherwise null. */
  finalUrl: string | null;
  /** Number of redirect hops followed (0 when the original URL is final). */
  redirectCount: number;
  /** Unique normalized hosts visited across the chain. */
  normalizedHosts: string[];
  /** Human-readable rejection reason (bounded, server-side). */
  rejectionReason: string | null;
  /** HTTP status of the final response (or last response seen). */
  httpStatus: number | null;
  /** Bounded Retry-After delay from a rate-limited hop, when supplied. */
  retryAfterMs: number | null;
  /** Wall-clock duration of the whole resolution attempt. */
  durationMs: number;
  failureKind: SafeRedirectFailureKind | null;
  /** Bounded hop list (each hop: URL + status). */
  hops: SafeRedirectHop[];
};

export type SafeRedirectResolution =
  | { ok: true; finalUrl: string; evidence: SafeRedirectEvidence }
  | { ok: false; evidence: SafeRedirectEvidence };

export type SafeRedirectResolverOptions = {
  maxHops?: number;
  timeoutMs?: number;
};

/* ------------------------------------------------------------------ */
/*  HELPERS                                                            */
/* ------------------------------------------------------------------ */

const normalizeHost = (hostname: string) =>
  hostname.replace(/^www\./, "").toLowerCase();

/**
 * Validate one URL exactly like a direct safeFetch request would:
 * protocol gate, hostname/DNS/IP validation. Throws SSRFError.
 */
const validateRedirectHopUrl = async (rawUrl: string, context: string): Promise<URL> => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SSRFError(`Malformed redirect target (${context})`);
  }

  if (!ALLOWED_REDIRECT_PROTOCOLS.has(parsed.protocol)) {
    throw new SSRFError(`Redirect to blocked protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;
  if (IPV4_RE.test(hostname) || hostname.startsWith("[")) {
    const clean = hostname.replace(/[[\]]/g, "");
    if (isBlockedIp(clean)) {
      throw new SSRFError(`Redirect to blocked IP address: ${hostname}`);
    }
  } else if (IPV6_RE.test(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SSRFError(`Redirect to blocked IP address: ${hostname}`);
    }
  } else {
    await resolveAndValidate(hostname);
  }

  return parsed;
};

const buildMinimalHeaders = (): HeadersInit => ({
  "User-Agent": "NuSift/1.0 SafeRedirectResolver",
  Accept: "text/html,application/xhtml+xml",
});

/* ------------------------------------------------------------------ */
/*  RESOLVER                                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve a redirector / aggregator URL to its final validated canonical
 * URL. Never forwards credentials or sensitive headers across hosts —
 * every hop is fetched with a fresh, minimal header set.
 */
export async function resolveSafeRedirectChain(
  originalUrl: string,
  options: SafeRedirectResolverOptions = {},
): Promise<SafeRedirectResolution> {
  const maxHops = options.maxHops ?? MAX_SAFE_REDIRECT_HOPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REDIRECT_TIMEOUT_MS;
  const startedAt = Date.now();

  const evidence: SafeRedirectEvidence = {
    originalUrl,
    finalUrl: null,
    redirectCount: 0,
    normalizedHosts: [],
    rejectionReason: null,
    httpStatus: null,
    retryAfterMs: null,
    durationMs: 0,
    failureKind: null,
    hops: [],
  };

  const fail = (kind: SafeRedirectFailureKind, reason: string): SafeRedirectResolution => {
    evidence.failureKind = kind;
    evidence.rejectionReason = reason;
    evidence.durationMs = Date.now() - startedAt;
    return { ok: false, evidence };
  };

  let currentUrl = originalUrl;
  const visited = new Set<string>();

  try {
    for (let hop = 0; ; hop++) {
      // Loop detection: terminate deterministic redirect loops.
      const visitKey = currentUrl.split("#")[0] || currentUrl;
      if (visited.has(visitKey)) {
        return fail("invalid_redirect", `Redirect loop detected at: ${currentUrl}`);
      }
      visited.add(visitKey);

      // Validate this hop exactly like a direct request.
      const parsed = await validateRedirectHopUrl(currentUrl, `hop ${hop}`);
      const cleanHost = normalizeHost(parsed.hostname);
      if (!evidence.normalizedHosts.includes(cleanHost)) {
        evidence.normalizedHosts.push(cleanHost);
      }

      // Fetch this hop with a minimal header set (never forward credentials).
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          headers: buildMinimalHeaders(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error: any) {
        const name = error?.name || "";
        const message = error?.message || String(error);
        if (/abort|timeout/i.test(`${name} ${message}`)) {
          return fail("transient_network", `Redirect hop timed out: ${currentUrl}`);
        }
        return fail("transient_network", `Redirect hop network error: ${message}`);
      }

      evidence.httpStatus = response.status;
      evidence.hops.push({ url: currentUrl, httpStatus: response.status });
      // Never read the body — release the connection for redirect hops.
      response.body?.cancel().catch(() => {});

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return fail("invalid_redirect", `Redirect response without Location: ${currentUrl}`);
        }

        const nextUrl = new URL(location, currentUrl);

        // Protocol gate + downgrade protection on the redirect target.
        if (!ALLOWED_REDIRECT_PROTOCOLS.has(nextUrl.protocol)) {
          return fail(
            "security_rejected",
            `Redirect to blocked protocol: ${nextUrl.protocol}`,
          );
        }
        if (parsed.protocol === "https:" && nextUrl.protocol === "http:") {
          return fail("security_rejected", "Redirect protocol downgrade blocked (https → http)");
        }

        evidence.redirectCount += 1;
        if (evidence.redirectCount > maxHops) {
          return fail("invalid_redirect", `Too many redirects (max ${maxHops})`);
        }

        currentUrl = nextUrl.toString();
        continue;
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after")?.trim() || "";
        const seconds = Number(retryAfter);
        const parsedRetryAt = Number.isFinite(seconds) && seconds >= 0
          ? Date.now() + seconds * 1000
          : Date.parse(retryAfter);
        const retryAfterMs = Number.isFinite(parsedRetryAt)
          ? Math.min(60 * 60 * 1000, Math.max(0, parsedRetryAt - Date.now()))
          : null;
        evidence.retryAfterMs = retryAfterMs;
        return fail("rate_limited", `Redirect chain rate-limited (HTTP 429) at: ${currentUrl}`);
      }
      if (response.status >= 400) {
        return fail("invalid_redirect", `Final redirect response status ${response.status} at: ${currentUrl}`);
      }

      // Success: final validated URL.
      const finalUrl = response.url || currentUrl;
      evidence.finalUrl = finalUrl;
      evidence.durationMs = Date.now() - startedAt;
      return { ok: true, finalUrl, evidence };
    }
  } catch (error) {
    if (error instanceof SSRFError) {
      return fail("security_rejected", error.detail);
    }
    return fail("transient_network", error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------------------------------------ */
/*  GENERIC REDIRECTOR-URL DETECTION                                   */
/* ------------------------------------------------------------------ */

/**
 * Generic (hostname-agnostic) signal that a URL is likely a redirector /
 * aggregator link rather than the final publisher article URL.
 *
 * Signals:
 *  - path tokens: rd, redirect, redirector, go, out, click, away, jump,
 *    visit, link, track, fetch, proxy, gateway, url, u
 *  - query parameter names commonly used for the destination: url, u,
 *    dest, destination, target, redirect, goto, next, rurl, href, out
 *
 * This is intentionally NOT an allowlist of specific aggregator hosts and
 * must not be used as the only gate — the safe redirect chain still
 * validates every destination before anything is trusted.
 */
const REDIRECTOR_PATH_TOKEN_RE =
  /\/[^/]*(?:rd|redirect|redirector|click|away|jump|visit|track|fetch|proxy|gateway|go|out|link|url|u)\.[a-z0-9]+(?:\?|$|\/)/i;

const REDIRECTOR_QUERY_PARAM_RE =
  /(?:^|[?&])(?:url|u|dest|destination|target|redirect|goto|next|rurl|href|out|link)=/i;

export function isLikelyRedirectorUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (!ALLOWED_REDIRECT_PROTOCOLS.has(parsed.protocol)) return false;
    if (REDIRECTOR_PATH_TOKEN_RE.test(parsed.pathname)) return true;
    if (REDIRECTOR_QUERY_PARAM_RE.test(parsed.search)) return true;
    return false;
  } catch {
    return false;
  }
}
