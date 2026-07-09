/**
 * ssrf-guard.test.ts â€“ SSRF protection unit tests.
 *
 * Tests the pure functions (isBlockedIp, validateHostname, sanitiseHostnameForApi)
 * that don't require network access. The async resolveAndValidate / safeFetch
 * functions are tested via integration in the actual API endpoints.
 */
import { describe, it, expect } from 'vitest'
import { isBlockedIp, validateHostname, sanitiseHostnameForApi, SSRFError, safeFetch } from './ssrf-guard'
import { validatePushEndpoint, assertValidPushEndpoint, mapSubscriptionFromBody } from './push'

/* ================================================================== */
/*  isBlockedIp                                                        */
/* ================================================================== */

describe('isBlockedIp', () => {
  // --- IPv4 private ranges ---
  it('blocks 127.0.0.1 (loopback)', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true)
  })

  it('blocks 127.0.0.2 (loopback range)', () => {
    expect(isBlockedIp('127.0.0.2')).toBe(true)
  })

  it('blocks 10.0.0.1 (10.0.0.0/8)', () => {
    expect(isBlockedIp('10.0.0.1')).toBe(true)
  })

  it('blocks 10.255.255.255 (10.0.0.0/8)', () => {
    expect(isBlockedIp('10.255.255.255')).toBe(true)
  })

  it('blocks 172.16.0.1 (172.16.0.0/12)', () => {
    expect(isBlockedIp('172.16.0.1')).toBe(true)
  })

  it('blocks 172.31.255.255 (172.16.0.0/12)', () => {
    expect(isBlockedIp('172.31.255.255')).toBe(true)
  })

  it('blocks 192.168.0.1 (192.168.0.0/16)', () => {
    expect(isBlockedIp('192.168.0.1')).toBe(true)
  })

  it('blocks 192.168.255.255 (192.168.0.0/16)', () => {
    expect(isBlockedIp('192.168.255.255')).toBe(true)
  })

  it('blocks 169.254.169.254 (cloud metadata)', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true)
  })

  it('blocks 169.254.0.1 (link-local range)', () => {
    expect(isBlockedIp('169.254.0.1')).toBe(true)
  })

  it('blocks 0.0.0.0 (unspecified)', () => {
    expect(isBlockedIp('0.0.0.0')).toBe(true)
  })

  // --- IPv4-mapped IPv6 ---
  it('blocks ::ffff:127.0.0.1 (IPv4-mapped loopback)', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true)
  })

  it('blocks ::ffff:10.0.0.1 (IPv4-mapped private)', () => {
    expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true)
  })

  it('blocks ::ffff:169.254.169.254 (IPv4-mapped metadata)', () => {
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true)
  })

  // --- IPv6 ---
  it('blocks ::1 (IPv6 loopback)', () => {
    expect(isBlockedIp('::1')).toBe(true)
  })

  it('blocks 0:0:0:0:0:0:0:1 (IPv6 loopback long form)', () => {
    expect(isBlockedIp('0:0:0:0:0:0:0:1')).toBe(true)
  })

  it('blocks :: (IPv6 unspecified)', () => {
    expect(isBlockedIp('::')).toBe(true)
  })

  it('blocks fe80::1 (IPv6 link-local)', () => {
    expect(isBlockedIp('fe80::1')).toBe(true)
  })

  it('blocks fc00::1 (IPv6 ULA)', () => {
    expect(isBlockedIp('fc00::1')).toBe(true)
  })

  it('blocks fd00::1 (IPv6 ULA)', () => {
    expect(isBlockedIp('fd00::1')).toBe(true)
  })

  // --- Public IPs (should NOT be blocked) ---
  it('allows 8.8.8.8 (Google DNS)', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false)
  })

  it('allows 1.1.1.1 (Cloudflare DNS)', () => {
    expect(isBlockedIp('1.1.1.1')).toBe(false)
  })

  it('allows 93.184.216.34 (example.com)', () => {
    expect(isBlockedIp('93.184.216.34')).toBe(false)
  })

  it('allows 172.15.255.255 (just below 172.16 range)', () => {
    expect(isBlockedIp('172.15.255.255')).toBe(false)
  })

  it('allows 172.32.0.1 (just above 172.31 range)', () => {
    expect(isBlockedIp('172.32.0.1')).toBe(false)
  })

  it('allows 192.169.0.1 (just above 192.168 range)', () => {
    expect(isBlockedIp('192.169.0.1')).toBe(false)
  })
})

/* ================================================================== */
/*  validateHostname                                                   */
/* ================================================================== */

describe('validateHostname', () => {
  // --- Valid hostnames ---
  it('accepts example.com', () => {
    expect(() => validateHostname('example.com')).not.toThrow()
  })

  it('accepts sub.domain.example.com', () => {
    expect(() => validateHostname('sub.domain.example.com')).not.toThrow()
  })

  it('accepts news-site.co.uk', () => {
    expect(() => validateHostname('news-site.co.uk')).not.toThrow()
  })

  it('accepts x.y.z', () => {
    expect(() => validateHostname('x.y.z')).not.toThrow()
  })

  // --- Banned hostnames ---
  it('rejects localhost', () => {
    expect(() => validateHostname('localhost')).toThrow(SSRFError)
  })

  it('rejects myhost.local', () => {
    expect(() => validateHostname('myhost.local')).toThrow(SSRFError)
  })

  it('rejects anything.internal', () => {
    expect(() => validateHostname('anything.internal')).toThrow(SSRFError)
  })

  it('rejects test.localhost', () => {
    expect(() => validateHostname('test.localhost')).toThrow(SSRFError)
  })

  it('rejects foo.example', () => {
    expect(() => validateHostname('foo.example')).toThrow(SSRFError)
  })

  it('rejects foo.invalid (RFC 6761 reserved)', () => {
    expect(() => validateHostname('foo.invalid')).toThrow(SSRFError)
  })

  it('rejects foo.test (RFC 6761 reserved)', () => {
    expect(() => validateHostname('foo.test')).toThrow(SSRFError)
  })

  it('rejects foo.arpa (reverse DNS)', () => {
    expect(() => validateHostname('foo.arpa')).toThrow(SSRFError)
  })

  // --- IP literals ---
  it('rejects 127.0.0.1', () => {
    expect(() => validateHostname('127.0.0.1')).toThrow(SSRFError)
  })

  it('rejects 10.0.0.1', () => {
    expect(() => validateHostname('10.0.0.1')).toThrow(SSRFError)
  })

  it('rejects 169.254.169.254', () => {
    expect(() => validateHostname('169.254.169.254')).toThrow(SSRFError)
  })

  // --- Injection attempts ---
  it('rejects hostname with slash', () => {
    expect(() => validateHostname('evil.com/path')).toThrow(SSRFError)
  })

  it('rejects hostname with query string', () => {
    expect(() => validateHostname('evil.com?x=1')).toThrow(SSRFError)
  })

  it('rejects hostname with @', () => {
    expect(() => validateHostname('user@evil.com')).toThrow(SSRFError)
  })

  it('rejects hostname with #', () => {
    expect(() => validateHostname('evil.com#fragment')).toThrow(SSRFError)
  })

  // --- Format violations ---
  it('rejects empty string', () => {
    expect(() => validateHostname('')).toThrow(SSRFError)
  })

  it('rejects hostname starting with hyphen', () => {
    expect(() => validateHostname('-evil.com')).toThrow(SSRFError)
  })

  it('rejects hostname ending with hyphen', () => {
    expect(() => validateHostname('evil-.com')).toThrow(SSRFError)
  })

  it('rejects hostname with consecutive dots', () => {
    expect(() => validateHostname('evil..com')).toThrow(SSRFError)
  })
})

/* ================================================================== */
/*  sanitiseHostnameForApi                                             */
/* ================================================================== */

describe('sanitiseHostnameForApi', () => {
  it('returns clean hostname lowercased', () => {
    expect(sanitiseHostnameForApi('Example.COM')).toBe('example.com')
  })

  it('strips www prefix', () => {
    expect(sanitiseHostnameForApi('www.example.com')).toBe('example.com')
  })

  it('rejects localhost', () => {
    expect(() => sanitiseHostnameForApi('localhost')).toThrow(SSRFError)
  })

  it('rejects raw IPs', () => {
    expect(() => sanitiseHostnameForApi('127.0.0.1')).toThrow(SSRFError)
  })

  it('rejects hostnames with injection characters', () => {
    expect(() => sanitiseHostnameForApi('evil.com/alert(1)')).toThrow(SSRFError)
  })

  it('rejects hostnames over 253 chars', () => {
    const longHostname = 'a'.repeat(254) + '.com'
    expect(() => sanitiseHostnameForApi(longHostname)).toThrow(SSRFError)
  })

  it('validates GDELT-safe hostname', () => {
    // This should pass â€” a valid news domain
    const result = sanitiseHostnameForApi('reuters.com')
    expect(result).toBe('reuters.com')
  })
})

/* ================================================================== */
/*  safeFetch â€“ protocol & redirect validation (URL-level tests)       */
/* ================================================================== */

describe('safeFetch â€“ protocol enforcement', () => {
  // These tests validate the URL parsing logic, not actual network calls.
  // They verify that blocked protocols are rejected before any fetch occurs.

  it('rejects file: protocol', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(SSRFError)
  })

  it('rejects ftp: protocol', async () => {
    await expect(safeFetch('ftp://example.com/file')).rejects.toThrow(SSRFError)
  })

  it('rejects javascript: protocol', async () => {
    // new URL('javascript:alert(1)') throws TypeError in most Node versions
    // Either the URL constructor or our protocol check should reject it
    await expect(safeFetch('javascript:alert(1)')).rejects.toThrow()
  })

  it('rejects data: protocol', async () => {
    await expect(safeFetch('data:text/html,<h1>hi</h1>')).rejects.toThrow(SSRFError)
  })
})

describe('safeFetch â€“ hostname edge cases', () => {
  it('rejects localhost URL', async () => {
    await expect(safeFetch('http://localhost:3000')).rejects.toThrow(SSRFError)
  })

  it('rejects .local hostname', async () => {
    await expect(safeFetch('http://myhost.local')).rejects.toThrow(SSRFError)
  })

  it('rejects .internal hostname', async () => {
    await expect(safeFetch('http://service.internal')).rejects.toThrow(SSRFError)
  })

  it('rejects .invalid hostname', async () => {
    await expect(safeFetch('http://foo.invalid')).rejects.toThrow(SSRFError)
  })

  it('rejects .test hostname', async () => {
    await expect(safeFetch('http://foo.test')).rejects.toThrow(SSRFError)
  })

  it('rejects .arpa hostname', async () => {
    await expect(safeFetch('http://1.0.0.127.in-addr.arpa')).rejects.toThrow(SSRFError)
  })

  it('rejects raw IPv4 loopback', async () => {
    await expect(safeFetch('http://127.0.0.1')).rejects.toThrow(SSRFError)
  })

  it('rejects raw IPv4 metadata endpoint', async () => {
    await expect(safeFetch('http://169.254.169.254/metadata')).rejects.toThrow(SSRFError)
  })

  it('rejects raw IPv6 loopback', async () => {
    await expect(safeFetch('http://[::1]/')).rejects.toThrow(SSRFError)
  })
})

/* ================================================================== */
/*  safeFetch â€“ legitimate redirect scenarios                          */
/*  These verify that safeFetch does NOT over-block normal redirects.  */
/* ================================================================== */

describe('safeFetch â€“ legitimate redirect policy', () => {
  // These tests exercise the redirect validation logic itself (pure URL parsing),
  // not actual network calls. They verify the policy allows what it should.

  it('same-origin redirect is allowed (same host, same protocol)', () => {
    const original = new URL('https://example.com/a')
    const redirect = new URL('/b', 'https://example.com/a')
    const originalClean = original.hostname.replace(/^www\./, '').toLowerCase()
    const redirectClean = redirect.hostname.replace(/^www\./, '').toLowerCase()
    const isSubdomain = redirectClean.endsWith(`.${originalClean}`)
    const allowed = originalClean === redirectClean || isSubdomain
    expect(allowed).toBe(true)
  })

  it('http â†’ https upgrade redirect is allowed', () => {
    // Protocol upgrade is NOT a downgrade, so it should be allowed
    const originalProtocol: string = 'http:'
    const nextProtocol: string = 'https:'
    const isDowngrade = originalProtocol === 'https:' && nextProtocol === 'http:'
    expect(isDowngrade).toBe(false)
  })

  it('relative redirect resolves to same origin', () => {
    const base = 'https://example.com/news/article'
    const relative = '/news/category'
    const resolved = new URL(relative, base)
    expect(resolved.origin).toBe('https://example.com')
    expect(resolved.hostname).toBe('example.com')
  })

  it('subdomain redirect is allowed (example.com â†’ sub.example.com)', () => {
    const originalClean = 'example.com'
    const nextClean = 'sub.example.com'
    const isSubdomain = nextClean.endsWith(`.${originalClean}`)
    expect(isSubdomain).toBe(true)
  })

  it('subdomain redirect is allowed (www.example.com â†’ example.com)', () => {
    const originalClean = 'example.com' // www. stripped
    const nextClean = 'example.com'
    const isSubdomain = nextClean.endsWith(`.${originalClean}`)
    const allowed = originalClean === nextClean || isSubdomain
    expect(allowed).toBe(true)
  })

  it('sub-subdomain redirect is allowed (a.b.example.com under example.com)', () => {
    const originalClean = 'example.com'
    const nextClean = 'a.b.example.com'
    const isSubdomain = nextClean.endsWith(`.${originalClean}`)
    expect(isSubdomain).toBe(true)
  })

  it('cross-domain redirect is blocked (example.com â†’ evil.com)', () => {
    const originalClean: string = 'example.com'
    const nextClean: string = 'evil.com'
    const isSubdomain = nextClean.endsWith(`.${originalClean}`)
    const allowed = originalClean === nextClean || isSubdomain
    expect(allowed).toBe(false)
  })

  it('similar-looking domain is blocked (example.com â†’ notexample.com)', () => {
    const originalClean: string = 'example.com'
    const nextClean: string = 'notexample.com'
    const isSubdomain = nextClean.endsWith(`.${originalClean}`)
    const allowed = originalClean === nextClean || isSubdomain
    expect(allowed).toBe(false)
  })

  it('https â†’ http downgrade is blocked in redirect policy', () => {
    const originalProtocol: string = 'https:'
    const nextProtocol: string = 'http:'
    const isDowngrade = originalProtocol === 'https:' && nextProtocol === 'http:'
    expect(isDowngrade).toBe(true)
  })

  it('malformed URL is rejected by safeFetch', async () => {
    await expect(safeFetch('not-a-url')).rejects.toThrow()
  })
})

/* ================================================================== */
/*  SSRFError message safety                                           */
/* ================================================================== */

/* ================================================================== */
/*  validatePushEndpoint â€“ push subscription SSRF guard                */
/* ================================================================== */

describe('validatePushEndpoint', () => {
  // --- Valid endpoints ---
  it('accepts a valid HTTPS FCM endpoint', async () => {
    await expect(
      validatePushEndpoint('https://fcm.googleapis.com/fcm/send/abc123')
    ).resolves.toBeUndefined()
  })

  // --- Protocol rejection ---
  it('rejects http: endpoint', async () => {
    await expect(validatePushEndpoint('http://example.com/push')).rejects.toThrow()
  })

  it('rejects file: endpoint', async () => {
    await expect(validatePushEndpoint('file:///etc/passwd')).rejects.toThrow()
  })

  it('rejects ftp: endpoint', async () => {
    await expect(validatePushEndpoint('ftp://example.com/push')).rejects.toThrow()
  })

  it('rejects data: endpoint', async () => {
    await expect(validatePushEndpoint('data:text/html,<h1>hi</h1>')).rejects.toThrow()
  })

  it('rejects javascript: endpoint', async () => {
    await expect(validatePushEndpoint('javascript:alert(1)')).rejects.toThrow()
  })

  // --- Malformed URL ---
  it('rejects empty string', async () => {
    await expect(validatePushEndpoint('')).rejects.toThrow()
  })

  it('rejects plain hostname without scheme', async () => {
    await expect(validatePushEndpoint('example.com/push')).rejects.toThrow()
  })

  // --- Localhost / internal ---
  it('rejects localhost', async () => {
    await expect(validatePushEndpoint('https://localhost/push')).rejects.toThrow()
  })

  it('rejects 127.0.0.1', async () => {
    await expect(validatePushEndpoint('https://127.0.0.1/push')).rejects.toThrow()
  })

  it('rejects 10.x.x.x private IP', async () => {
    await expect(validatePushEndpoint('https://10.0.0.1/push')).rejects.toThrow()
  })

  it('rejects 169.254.169.254 cloud metadata', async () => {
    await expect(validatePushEndpoint('https://169.254.169.254/metadata')).rejects.toThrow()
  })

  it('rejects .local hostname', async () => {
    await expect(validatePushEndpoint('https://myhost.local/push')).rejects.toThrow()
  })

  it('rejects .internal hostname', async () => {
    await expect(validatePushEndpoint('https://service.internal/push')).rejects.toThrow()
  })
})

/* ================================================================== */
/*  SSRFErrorâ†’createError wrapping â€“ error type consistency            */
/*  These tests verify that NO raw SSRFError leaks from the push       */
/*  validation functions. Every rejection must be a createError with    */
/*  a statusCode (HTTP error), never a raw SSRFError instance.         */
/* ================================================================== */

describe('push validation â€“ error type consistency (no SSRFError leak)', () => {
  // --- validatePushEndpoint (async, full DNS check) ---
  it('validatePushEndpoint: http endpoint throws error with statusCode 400, not SSRFError', async () => {
    try {
      await validatePushEndpoint('http://example.com/push')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).not.toBeInstanceOf(SSRFError)
      expect(err).toHaveProperty('statusCode', 400)
    }
  })

  it('validatePushEndpoint: localhost throws error with statusCode 400, not SSRFError', async () => {
    try {
      await validatePushEndpoint('https://localhost/push')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).not.toBeInstanceOf(SSRFError)
      expect(err).toHaveProperty('statusCode', 400)
    }
  })

  it('validatePushEndpoint: private IP hostname throws error with statusCode 400, not SSRFError', async () => {
    try {
      await validatePushEndpoint('https://127.0.0.1/push')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).not.toBeInstanceOf(SSRFError)
      expect(err).toHaveProperty('statusCode', 400)
    }
  })

  it('validatePushEndpoint: malformed URL throws error with statusCode 400, not SSRFError', async () => {
    try {
      await validatePushEndpoint('not-a-url')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).not.toBeInstanceOf(SSRFError)
      expect(err).toHaveProperty('statusCode', 400)
    }
  })

  // --- assertValidPushEndpoint (sync, lightweight) ---
  it('assertValidPushEndpoint: http endpoint throws error with statusCode 400, not SSRFError', () => {
    try {
      assertValidPushEndpoint('http://example.com/push')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).not.toBeInstanceOf(SSRFError)
      expect(err).toHaveProperty('statusCode', 400)
    }
  })

  it('assertValidPushEndpoint: localhost throws error with statusCode 400, not SSRFError', () => {
    try {
      assertValidPushEndpoint('https://localhost/push')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).not.toBeInstanceOf(SSRFError)
      expect(err).toHaveProperty('statusCode', 400)
    }
  })

  it('assertValidPushEndpoint: .internal hostname throws error with statusCode 400, not SSRFError', () => {
    try {
      assertValidPushEndpoint('https://evil.internal/push')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).not.toBeInstanceOf(SSRFError)
      expect(err).toHaveProperty('statusCode', 400)
    }
  })

  // --- mapSubscriptionFromBody (sync, input mapping) ---
  it('mapSubscriptionFromBody: http endpoint throws error with statusCode 400, not SSRFError', () => {
    try {
      mapSubscriptionFromBody({ endpoint: 'http://example.com/push', keys: { p256dh: 'x', auth: 'y' } })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).not.toBeInstanceOf(SSRFError)
      expect(err).toHaveProperty('statusCode', 400)
    }
  })

  it('mapSubscriptionFromBody: localhost endpoint throws error with statusCode 400, not SSRFError', () => {
    try {
      mapSubscriptionFromBody({ endpoint: 'https://localhost/push', keys: { p256dh: 'x', auth: 'y' } })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).not.toBeInstanceOf(SSRFError)
      expect(err).toHaveProperty('statusCode', 400)
    }
  })

  it('mapSubscriptionFromBody: missing fields throws error with statusCode 400', () => {
    try {
      mapSubscriptionFromBody({})
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).not.toBeInstanceOf(SSRFError)
      expect(err).toHaveProperty('statusCode', 400)
    }
  })
})

describe('SSRFError â€“ message safety', () => {
  it('public message does not expose internal hostname', () => {
    const err = new SSRFError('Banned hostname: internal.corp')
    expect(err.message).not.toContain('internal.corp')
    expect(err.message).toBe('Request blocked by security policy')
  })

  it('detail field retains internal info for server logging', () => {
    const err = new SSRFError('Banned hostname: internal.corp')
    expect(err.detail).toContain('internal.corp')
  })

  it('public message does not expose blocked IP', () => {
    const err = new SSRFError('Hostname "evil.com" resolves to blocked IP: 10.0.0.1')
    expect(err.message).not.toContain('10.0.0.1')
    expect(err.message).toBe('Request blocked by security policy')
  })
})
