// server/utils/ssrf-guard.ts
/**
 * SSRF (Server-Side Request Forgery) protection utility.
 *
 * Provides:
 *  1. Hostname format validation (strict DNS-safe regex)
 *  2. Banned hostname patterns (localhost, *.local, *.internal)
 *  3. DNS resolution + IP range validation against all private/link-local/metadata ranges
 *  4. safeFetch – a drop-in replacement for fetch() that:
 *     - validates DNS before every request
 *     - uses redirect:'manual' and validates each redirect hop
 *     - enforces same-domain / subdomain redirect policy
 */
import dns from 'node:dns/promises'

/* ------------------------------------------------------------------ */
/*  ERROR CLASS                                                        */
/* ------------------------------------------------------------------ */

export class SSRFError extends Error {
  /** Detailed message for server-side logging (never sent to client). */
  readonly detail: string

  constructor(detail: string) {
    // The public message is generic — callers should NOT expose `detail` to users.
    super('Request blocked by security policy')
    this.name = 'SSRFError'
    this.detail = detail
  }
}

/* ------------------------------------------------------------------ */
/*  CONSTANTS                                                          */
/* ------------------------------------------------------------------ */

/** Strict DNS hostname regex – max 253 chars, valid labels only. */
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/** Hostnames that are always rejected regardless of IP.
 *  Includes RFC 6761 reserved TLDs (.local, .internal, .localhost, .example,
 *  .invalid, .test) and reverse-DNS (.arpa) which are never public websites.
 */
const BANNED_HOSTNAME_RE = /^(localhost|.*\.local|.*\.internal|.*\.localhost|.*\.example|.*\.invalid|.*\.test|.*\.arpa)$/i

/** Detect raw IPv4 / IPv6 literals. */
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const IPV6_RE = /^[0-9a-f:]+$/i

/** Only these URL schemes are permitted. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** Max redirects to follow before aborting. */
const MAX_REDIRECTS = 5

/* ------------------------------------------------------------------ */
/*  IP RANGE CHECKS                                                    */
/* ------------------------------------------------------------------ */

/**
 * Normalise IPv4-mapped IPv6 to plain IPv4 where possible.
 * e.g. "::ffff:127.0.0.1" → "127.0.0.1"
 */
function normaliseIp(ip: string): string {
  const lower = ip.toLowerCase().trim()
  if (lower.startsWith('::ffff:')) return lower.slice(7)
  return lower
}

function isBlockedIpv6(clean: string): boolean {
  if (clean === '::1' || clean === '0:0:0:0:0:0:0:1') return true // loopback
  if (clean === '::' || clean === '0:0:0:0:0:0:0:0') return true  // unspecified
  if (/^(fe80|fc00|fd00):/i.test(clean)) return true               // link-local / ULA
  if (/^ff/i.test(clean)) return true                              // multicast
  if (/^2001:db8:/i.test(clean)) return true                       // documentation
  if (/^2001:0:/i.test(clean)) return true                         // Teredo / special-use
  return false
}

/** Check whether an IP address falls inside a blocked (private/metadata) range. */
export function isBlockedIp(ip: string): boolean {
  const clean = normaliseIp(ip)

  // --- IPv6 checks ---
  if (clean.includes(':') && IPV6_RE.test(clean)) {
    return isBlockedIpv6(clean)
  }

  // --- IPv4 checks ---
  const parts = clean.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return false // not valid IPv4, let DNS handle it

  const [a, b] = parts

  // 127.0.0.0/8  (loopback)
  if (a === 127) return true
  // 10.0.0.0/8   (private)
  if (a === 10) return true
  // 172.16.0.0/12 (private)
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 169 && b === 254) return true
  // 0.0.0.0/8 (unspecified / current network)
  if (a === 0) return true

  return false
}

/* ------------------------------------------------------------------ */
/*  HOSTNAME VALIDATION                                                */
/* ------------------------------------------------------------------ */

/**
 * Validate that a hostname is a safe, public, DNS-routable name.
 * Throws SSRFError on failure.
 */
export function validateHostname(hostname: string): void {
  const h = hostname.toLowerCase()

  // Reject banned patterns
  if (BANNED_HOSTNAME_RE.test(h)) {
    throw new SSRFError(`Banned hostname: ${h}`)
  }

  // Reject raw IP literals for user-facing endpoints
  if (IPV4_RE.test(h) || IPV6_RE.test(h) || h.startsWith('[')) {
    throw new SSRFError('Direct IP addresses are not allowed')
  }

  // Strict DNS format
  if (!HOSTNAME_RE.test(h)) {
    throw new SSRFError(`Invalid hostname format: ${h}`)
  }

  // Reject suspicious characters that could enable injection
  if (h.includes('/') || h.includes('?') || h.includes('&') || h.includes('#') || h.includes('@')) {
    throw new SSRFError(`Unsafe characters in hostname: ${h}`)
  }
}

/* ------------------------------------------------------------------ */
/*  DNS RESOLUTION + IP VALIDATION                                     */
/* ------------------------------------------------------------------ */

/**
 * Resolve hostname via DNS and verify that ALL resolved IPs are public.
 * Returns the resolved addresses (for logging / diagnostics).
 */
export async function resolveAndValidate(hostname: string): Promise<string[]> {
  validateHostname(hostname)

  let addresses: { address: string; family: number }[]
  try {
    addresses = await dns.lookup(hostname, { all: true, family: 0 })
  } catch {
    throw new SSRFError(`DNS resolution failed for: ${hostname}`)
  }

  if (addresses.length === 0) {
    throw new SSRFError(`No DNS records for: ${hostname}`)
  }

  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new SSRFError(
        `Hostname "${hostname}" resolves to blocked IP: ${address}`
      )
    }
  }

  return addresses.map(a => a.address)
}

/* ------------------------------------------------------------------ */
/*  SAFE FETCH (SSRF-resistant)                                        */
/* ------------------------------------------------------------------ */

export interface SafeFetchTelemetry {
  /** One logical safeFetch invocation, including all internally validated redirects. */
  recordNetworkRequest(count?: number): void
  /** Start/end hook for the complete logical invocation, including failures. */
  beginLogicalRequest?(): () => void
  /** Duration of the complete logical invocation, including failures. */
  recordLogicalRequestDuration?(ms: number): void
  /** Legacy hook retained for callers that still distinguish generic fetch timing. */
  recordFetch?(ms: number): void
  /** Optional timeout counter; failures remain visible without changing behavior. */
  recordTimeout?(): void
}

export interface SafeFetchOptions extends RequestInit {
  /** Optional observation-only telemetry; omitted callers retain existing behavior. */
  telemetry?: SafeFetchTelemetry
  /**
   * Allow raw IP address literals in the URL (default: false).
   *
   * **Use only for DB-stored URLs** (e.g. discovery engine) where the URL
   * was originally validated but the database may have been poisoned.
   * Even with `allowIp: true`, all private/metadata/link-local IPs are
   * still blocked by `isBlockedIp`.
   *
   * **Never enable for user-supplied input** — prefer hostname-only URLs.
   * @default false
   */
  allowIp?: boolean
  allowCrossDomainRedirects?: boolean
  /** Internal lifecycle hooks used by the pipeline domain-governance adapter. */
  transportHooks?: SafeFetchTransportHooks
}

/**
 * Per-transport lifecycle hooks. The safe-fetch core invokes `beforeTransport`
 * only after the current URL has passed protocol, hostname, DNS, and IP checks.
 * Redirect hops therefore receive a fresh permit without changing the one-slot
 * logical request-budget rule.
 */
export interface SafeFetchTransportHooks {
  beforeTransport(url: string, isFirstTransport: boolean): Promise<unknown> | unknown
  onRedirectResponse?(url: string, response: Response, lease: unknown): Promise<void> | void
  onFinalResponse?(url: string, response: Response, lease: unknown, parseError: unknown | null): Promise<void> | void
  onTransportError?(url: string, error: unknown, lease: unknown): Promise<void> | void
}

const responseHeader = (response: Pick<Response, "headers">, name: string): string | null => {
  const headers = response.headers as Headers & Record<string, unknown>
  if (typeof headers.get === "function") return headers.get(name)
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase())
  const value = key ? headers[key] : undefined
  return typeof value === "string" ? value : null
}

/**
 * Drop-in replacement for `fetch()` that:
 *  - validates the target hostname + resolved IP before every request
 *  - follows redirects manually with a same-domain / subdomain policy
 *  - rejects redirects to private/metadata IPs
 *
 * Returns the Response object of the final destination.
 * Throws SSRFError on any security violation.
 */
async function safeFetchCore<T>(
  url: string,
  fetchOptions: SafeFetchOptions = {},
  maxRedirects: number = MAX_REDIRECTS,
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  const { allowIp, allowCrossDomainRedirects, telemetry, transportHooks, ...nativeOptions } = fetchOptions
  let logicalRequestRecorded = false

  // --- Initial URL validation ---
  let originalUrl: URL
  try {
    originalUrl = new URL(url)
  } catch {
    throw new SSRFError('Malformed URL')
  }

  // Protocol gate: only http and https are permitted
  if (!ALLOWED_PROTOCOLS.has(originalUrl.protocol)) {
    throw new SSRFError(`Blocked protocol: ${originalUrl.protocol}`)
  }

  const originalProtocol = originalUrl.protocol
  const originalCleanHost = originalUrl.hostname.replace(/^www\./, '').toLowerCase()

  let currentUrl = url
  let redirectCount = 0

  while (redirectCount <= maxRedirects) {
    const parsed = new URL(currentUrl)
    const hostname = parsed.hostname

    // --- Pre-request validation ---
    if (allowIp) {
      // For DB-originated URLs: validate format, then DNS + IP check
      // (raw IPs are allowed but still checked against blocked ranges)
      if (IPV4_RE.test(hostname) || hostname.startsWith('[')) {
        // It's an IP literal — check directly
        if (isBlockedIp(hostname.replace(/[[\]]/g, ''))) {
          throw new SSRFError(`Blocked IP address: ${hostname}`)
        }
      } else {
        await resolveAndValidate(hostname)
      }
    } else {
      // For user-facing endpoints: hostname validation + DNS + IP check
      await resolveAndValidate(hostname)
    }

    // SSRF/DNS validation above is the mandatory preflight boundary. Only
    // after it succeeds may governance acquire a permit or consume budget.
    const lease = transportHooks
      ? await transportHooks.beforeTransport(currentUrl, !logicalRequestRecorded)
      : null

    if (!logicalRequestRecorded) {
      telemetry?.recordNetworkRequest()
      logicalRequestRecorded = true
    }

    let response: Response
    try {
      response = await fetch(currentUrl, {
        ...nativeOptions,
        redirect: 'manual',
      })
    } catch (error) {
      await transportHooks?.onTransportError?.(currentUrl, error, lease)
      throw error
    }

    // Every redirect response belongs to the domain that returned it. Release
    // that hop before the next URL is preflighted and governed independently.
    if (response.status >= 300 && response.status < 400) {
      const location = responseHeader(response, 'location')
      if (!location) {
        // A redirect without Location is the final response we can return.
        // Keep the lease through parsing just like any other final response.
        let parseError: unknown | null = null
        try {
          return await parse(response)
        } catch (error) {
          parseError = error
          throw error
        } finally {
          await transportHooks?.onFinalResponse?.(currentUrl, response, lease, parseError)
        }
      }

      await transportHooks?.onRedirectResponse?.(currentUrl, response, lease)

      let nextUrl: URL
      try {
        nextUrl = new URL(location, currentUrl)
      } catch {
        throw new SSRFError('Malformed redirect URL')
      }

      if (!ALLOWED_PROTOCOLS.has(nextUrl.protocol)) {
        throw new SSRFError(`Redirect to blocked protocol: ${nextUrl.protocol}`)
      }
      if (originalProtocol === 'https:' && nextUrl.protocol === 'http:') {
        throw new SSRFError('Protocol downgrade blocked (https → http)')
      }

      const nextCleanHost = nextUrl.hostname.replace(/^www\./, '').toLowerCase()
      const isSubdomainRedirect = nextCleanHost.endsWith(`.${originalCleanHost}`)
      if (!allowCrossDomainRedirects && originalCleanHost !== nextCleanHost && !isSubdomainRedirect) {
        throw new SSRFError(
          `Cross-domain redirect blocked: ${originalCleanHost} → ${nextCleanHost}`
        )
      }

      currentUrl = nextUrl.toString()
      redirectCount++
      continue
    }

    // Final-response DNS rebind validation remains part of the SSRF boundary.
    try {
      if (response.url) {
        const finalHostname = new URL(response.url).hostname
        if (IPV4_RE.test(finalHostname) || finalHostname.startsWith('[')) {
          if (isBlockedIp(finalHostname.replace(/[[\]]/g, ''))) {
            throw new SSRFError(`Final redirect target resolves to blocked IP: ${finalHostname}`)
          }
        } else if (BANNED_HOSTNAME_RE.test(finalHostname)) {
          throw new SSRFError(`Final redirect target is a banned hostname: ${finalHostname}`)
        } else {
          await resolveAndValidate(finalHostname)
        }
      }
    } catch (error) {
      await transportHooks?.onTransportError?.(currentUrl, error, lease)
      throw error
    }

    let parseError: unknown | null = null
    try {
      return await parse(response)
    } catch (error) {
      parseError = error
      throw error
    } finally {
      await transportHooks?.onFinalResponse?.(currentUrl, response, lease, parseError)
    }
  }

  throw new SSRFError('Too many redirects')
}

/**
 * Count one logical request per invocation. Redirect hops are intentionally
 * included in that invocation rather than counted as separate requests;
 * this rule is shared by Agent 1 telemetry and tests. Duration is retained
 * for successful, rejected, and thrown invocations.
 */
async function runLogicalSafeFetch<T>(
  url: string,
  fetchOptions: SafeFetchOptions,
  maxRedirects: number,
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  const telemetry = fetchOptions.telemetry
  const endLogicalRequest = telemetry?.beginLogicalRequest?.()
  const startedAt = Date.now()
  try {
    return await safeFetchCore(url, fetchOptions, maxRedirects, parse)
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : String(error)
    if (/timeout|timed out|abort/i.test(`${name} ${message}`)) telemetry?.recordTimeout?.()
    throw error
  } finally {
    if (endLogicalRequest) endLogicalRequest()
    else {
      const elapsedMs = Date.now() - startedAt
      if (telemetry?.recordLogicalRequestDuration) telemetry.recordLogicalRequestDuration(elapsedMs)
      else telemetry?.recordFetch?.(elapsedMs)
    }
  }
}

export async function safeFetch(
  url: string,
  fetchOptions: SafeFetchOptions = {},
  maxRedirects: number = MAX_REDIRECTS,
): Promise<Response> {
  return runLogicalSafeFetch(url, fetchOptions, maxRedirects, async response => response)
}

/** Run a parser while the final transport hook lease remains active. */
export async function safeFetchWithParser<T>(
  url: string,
  fetchOptions: SafeFetchOptions = {},
  parse: (response: Response) => Promise<T>,
  maxRedirects: number = MAX_REDIRECTS,
): Promise<T> {
  return runLogicalSafeFetch(url, fetchOptions, maxRedirects, parse)
}

/* ------------------------------------------------------------------ */
/*  GDELT / EXTERNAL API DOMAIN SANITISER                             */
/* ------------------------------------------------------------------ */

/**
 * Sanitise a hostname for safe interpolation into an external API URL.
 * Returns the canonical lowercase hostname if valid, otherwise throws.
 */
export function sanitiseHostnameForApi(rawHostname: string): string {
  const h = rawHostname.replace(/^www\./, '').toLowerCase().trim()

  // Must pass strict DNS validation
  if (!HOSTNAME_RE.test(h)) {
    throw new SSRFError(`Invalid hostname for API query: ${h}`)
  }
  if (BANNED_HOSTNAME_RE.test(h)) {
    throw new SSRFError(`Banned hostname for API query: ${h}`)
  }
  if (IPV4_RE.test(h) || IPV6_RE.test(h)) {
    throw new SSRFError('IP addresses not allowed in API queries')
  }
  // Extra length guard
  if (h.length > 253) {
    throw new SSRFError('Hostname too long for API query')
  }

  return h
}
