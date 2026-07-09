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

/** Check whether an IP address falls inside a blocked (private/metadata) range. */
export function isBlockedIp(ip: string): boolean {
  const clean = normaliseIp(ip)

  // --- IPv6 checks ---
  if (clean === '::1' || clean === '0:0:0:0:0:0:0:1') return true // loopback
  if (clean === '::' || clean === '0:0:0:0:0:0:0:0') return true  // unspecified
  if (/^(fe80|fc00|fd00):/i.test(clean)) return true               // link-local / ULA
  // Catch any remaining IPv4-in-IPv6 representations
  if (clean.includes(':') && IPV6_RE.test(clean)) {
    // If it's an IPv6 address that isn't a public global unicast, block it.
    // Only allow if it doesn't match known-private prefixes.
    // fe80::/10, fc00::/7, ::1 already handled above. Block the rest of non-global space conservatively.
    // Simple heuristic: if it starts with anything other than known-safe patterns, block.
    // For a news-reader app, IPv6 literals are extremely rare — safest to block all IPv6 IPs.
    return true
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

export interface SafeFetchOptions extends RequestInit {
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
export async function safeFetch(
  url: string,
  fetchOptions: SafeFetchOptions = {},
  maxRedirects: number = MAX_REDIRECTS,
): Promise<Response> {
  const { allowIp, allowCrossDomainRedirects, ...nativeOptions } = fetchOptions

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

    // --- Make the request with redirect: 'manual' ---
    const response = await fetch(currentUrl, {
      ...nativeOptions,
      redirect: 'manual',
    })

    // --- Handle 3xx redirects manually ---
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return response // Malformed redirect, return as-is

      // Resolve relative redirects against the current URL
      const nextUrl = new URL(location, currentUrl)

      // Protocol gate on redirect target
      if (!ALLOWED_PROTOCOLS.has(nextUrl.protocol)) {
        throw new SSRFError(`Redirect to blocked protocol: ${nextUrl.protocol}`)
      }

      // Block protocol downgrade (https → http) — data exfiltration vector
      if (originalProtocol === 'https:' && nextUrl.protocol === 'http:') {
        throw new SSRFError('Protocol downgrade blocked (https → http)')
      }

      const nextCleanHost = nextUrl.hostname.replace(/^www\./, '').toLowerCase()

      // Enforce same-domain / subdomain redirect policy
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

    // --- Post-fetch DNS rebind check ---
    // Verify the final response URL still resolves to safe IPs
    if (response.url) {
      try {
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
      } catch (err) {
        // If SSRFError, propagate. If DNS failure on the final URL, it's suspicious but the request already completed.
        if (err instanceof SSRFError) throw err
      }
    }

    return response
  }

  throw new SSRFError('Too many redirects')
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
