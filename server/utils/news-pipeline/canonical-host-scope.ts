/**
 * Agent 2 verified canonical host scope.
 *
 * This is the single host-trust authority used by static discovery, browser
 * discovery, metadata evaluation, URL scoring, and diagnostics. A host is
 * trusted only when it is configured directly or when bounded evidence proves
 * it is a strict parent/subdomain transition of the configured publisher.
 *
 * We intentionally do not infer ownership from a shared suffix. In particular,
 * `publisher.co.uk` and `other.co.uk` are unrelated: neither is a parent or a
 * subdomain of the other. This avoids requiring a new dependency while still
 * avoiding the unsafe "last two labels" public-suffix heuristic.
 */

import { isIP } from "node:net";

export type HostEstablishmentKind =
  | "configured_target"
  | "redirect"
  | "final_url"
  | "document_canonical";

export type VerifiedHostEntry = {
  /** Normalized host (lowercase, www stripped). */
  host: string;
  establishedBy: HostEstablishmentKind;
  /** Short evidence reference (truncated URL with query values redacted). */
  via: string;
  /** Whether this host may be used to accept candidate links. */
  trusted: boolean;
};

export type VerifiedHostScope = {
  configuredHost: string;
  effectiveHost: string;
  hosts: VerifiedHostEntry[];
  transitioned: boolean;
};

export type BuildVerifiedHostScopeInput = {
  configuredTargetUrl: string;
  /** Redirect URLs in traversal order, not hostname strings. */
  redirectUrls?: string[];
  /** Final URL after redirects. */
  finalUrl?: string | null;
  /** Additional final URLs observed for bounded listing pages. */
  observedFinalUrls?: string[];
  /** Canonical URL exposed by the document. */
  canonicalUrl?: string | null;
  maxEntries?: number;
};

const NON_PUBLISHER_HOST_PATTERNS: RegExp[] = [
  // Social
  /(?:^|\.)facebook\.com$/i, /(?:^|\.)fb\.me$/i,
  /(?:^|\.)twitter\.com$/i, /(?:^|\.)x\.com$/i, /(?:^|\.)t\.co$/i,
  /(?:^|\.)instagram\.com$/i, /(?:^|\.)youtube\.com$/i, /(?:^|\.)youtu\.be$/i,
  /(?:^|\.)linkedin\.com$/i, /(?:^|\.)tiktok\.com$/i, /(?:^|\.)reddit\.com$/i,
  // Analytics / advertising
  /(?:^|\.)google-analytics\.com$/i, /(?:^|\.)googletagmanager\.com$/i,
  /(?:^|\.)doubleclick\.net$/i, /(?:^|\.)criteo\.com$/i,
  /(?:^|\.)taboola\.com$/i, /(?:^|\.)outbrain\.com$/i,
  // Generic publishing platforms (ownership is not established by a hosted
  // page appearing in a redirect chain).
  /(?:^|\.)blogspot\.com$/i, /(?:^|\.)wordpress\.com$/i,
  /(?:^|\.)medium\.com$/i, /(?:^|\.)substack\.com$/i,
  /(?:^|\.)github\.io$/i,
  // URL shorteners
  /(?:^|\.)bit\.ly$/i, /(?:^|\.)tinyurl\.com$/i, /(?:^|\.)ow\.ly$/i,
  /(?:^|\.)is\.gd$/i, /(?:^|\.)buff\.ly$/i, /(?:^|\.)goo\.gl$/i,
  // Generic infrastructure
  /(?:^|\.)amazonaws\.com$/i, /(?:^|\.)cloudfront\.net$/i,
  /(?:^|\.)akamaihd\.net$/i, /(?:^|\.)fastly\.net$/i,
  /(?:^|\.)cloudflare\.com$/i, /(?:^|\.)cloudflare\.net$/i,
];

const MAX_EVIDENCE_ENTRIES = 10;
const MAX_VIA_LENGTH = 120;

export function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./i, "").replace(/\.$/, "").toLowerCase();
}

/**
 * Return true only for a syntactically valid public hostname. IP literals,
 * localhost, loopback, link-local, private, and otherwise special names are
 * never publisher hosts.
 */
export function isPublicHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")) return false;
  if (normalized.endsWith(".local") || normalized.endsWith(".internal")) return false;

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split(".").map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }
  if (ipVersion === 6) {
    const compact = normalized.replace(/^\[|\]$/g, "");
    if (compact === "::1" || compact === "::" || compact.startsWith("fe8") || compact.startsWith("fe9") || compact.startsWith("fea") || compact.startsWith("feb") || compact.startsWith("fc") || compact.startsWith("fd")) return false;
    return true;
  }

  // URL.hostname may contain non-ASCII presentation forms, but empty labels,
  // whitespace, and labels exceeding DNS bounds are never valid publisher IDs.
  if (normalized.includes("/") || /\s/.test(normalized) || normalized.includes("..")) return false;
  const labels = normalized.split(".");
  if (labels.length < 2 || normalized.length > 253) return false;
  return labels.every((label) =>
    label.length > 0 && label.length <= 63 &&
    !label.startsWith("-") && !label.endsWith("-") &&
    /^[a-z0-9-]+$/i.test(label),
  );
}

/** Extract a normalized, public hostname from a URL. */
export function hostOfUrl(url: string): string | null {
  try {
    const hostname = normalizeHostname(new URL(url).hostname);
    return isPublicHostname(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

/** Redact query values from a URL and truncate it for compact evidence. */
export function sanitizeHostEvidenceUrl(url: string, maxLen = MAX_VIA_LENGTH): string {
  try {
    const parsed = new URL(url);
    const keys = [...new Set([...parsed.searchParams.keys()])];
    const redactedQuery = keys.map((key) => `${encodeURIComponent(key)}=[redacted]`).join("&");
    const base = `${parsed.origin}${parsed.pathname}`;
    const withQuery = redactedQuery ? `${base}?${redactedQuery}` : base;
    return withQuery.length > maxLen ? `${withQuery.slice(0, maxLen)}…` : withQuery;
  } catch {
    // Even malformed evidence must not preserve query values. This fallback
    // intentionally keeps only a bounded redacted representation.
    const redacted = url.replace(/([?&][^=&#\s]+)=([^&#\s]*)/g, "$1=[redacted]");
    return redacted.length > maxLen ? `${redacted.slice(0, maxLen)}…` : redacted;
  }
}

/**
 * Same publisher family for evidence capture only. This is deliberately a
 * strict parent/subdomain relation, not registrable-domain suffix matching.
 */
export function isSamePublisherFamily(hostA: string, hostB: string): boolean {
  const a = normalizeHostname(hostA);
  const b = normalizeHostname(hostB);
  if (!isPublicHostname(a) || !isPublicHostname(b)) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function isNonPublisherHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return NON_PUBLISHER_HOST_PATTERNS.some((pattern) => pattern.test(normalized));
}

function rawHostOfUrl(url: string): string | null {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Add bounded evidence, retaining rejected public hosts for diagnostics. */
function addEvidence(
  hosts: VerifiedHostEntry[],
  seen: Set<string>,
  host: string | null,
  establishedBy: HostEstablishmentKind,
  viaUrl: string,
  trusted: boolean,
) {
  if (!host || seen.has(`${host}|${establishedBy}`)) return;
  seen.add(`${host}|${establishedBy}`);
  hosts.push({ host, establishedBy, via: sanitizeHostEvidenceUrl(viaUrl), trusted });
}

export function buildVerifiedHostScope(input: BuildVerifiedHostScopeInput): VerifiedHostScope | null {
  const configuredHost = hostOfUrl(input.configuredTargetUrl);
  if (!configuredHost) return null;

  const hosts: VerifiedHostEntry[] = [];
  const seen = new Set<string>();
  addEvidence(hosts, seen, configuredHost, "configured_target", input.configuredTargetUrl, true);

  const establishable = (host: string | null) => Boolean(
    host && isPublicHostname(host) && !isNonPublisherHost(host) && isSamePublisherFamily(configuredHost, host),
  );
  const addTransition = (url: string, kind: HostEstablishmentKind) => {
    const rawHost = rawHostOfUrl(url);
    const trusted = establishable(rawHost);
    // Keep public rejected hosts in diagnostics, but never in the trusted set.
    if (rawHost && isPublicHostname(rawHost)) addEvidence(hosts, seen, rawHost, kind, url, trusted);
  };

  for (const url of input.redirectUrls ?? []) addTransition(url, "redirect");
  for (const url of input.observedFinalUrls ?? []) addTransition(url, "final_url");
  if (input.finalUrl) addTransition(input.finalUrl, "final_url");

  const finalHost = input.finalUrl ? hostOfUrl(input.finalUrl) : null;
  const effectiveHost = establishable(finalHost) ? finalHost! : configuredHost;

  if (input.canonicalUrl) {
    const canonicalHost = rawHostOfUrl(input.canonicalUrl);
    const trusted = Boolean(
      canonicalHost && isPublicHostname(canonicalHost) && !isNonPublisherHost(canonicalHost) &&
      isSamePublisherFamily(canonicalHost, effectiveHost),
    );
    if (canonicalHost && isPublicHostname(canonicalHost)) {
      addEvidence(hosts, seen, canonicalHost, "document_canonical", input.canonicalUrl, trusted);
    }
  }

  const max = Math.min(Math.max(input.maxEntries ?? MAX_EVIDENCE_ENTRIES, 1), MAX_EVIDENCE_ENTRIES);
  const trustedEffective = hosts.some((entry) => entry.host === effectiveHost && entry.trusted);
  return {
    configuredHost,
    effectiveHost: trustedEffective ? effectiveHost : configuredHost,
    hosts: hosts.slice(0, max),
    transitioned: trustedEffective && effectiveHost !== configuredHost,
  };
}

/** Extend one authoritative scope with new bounded response/canonical evidence. */
export function extendVerifiedHostScope(
  scope: VerifiedHostScope | null,
  input: Pick<BuildVerifiedHostScopeInput, "finalUrl" | "redirectUrls" | "canonicalUrl" | "observedFinalUrls">,
): VerifiedHostScope | null {
  if (!scope) return null;
  const additional = buildVerifiedHostScope({
    configuredTargetUrl: `https://${scope.configuredHost}/`,
    ...input,
  });
  if (!additional) return scope;
  const hosts = [...scope.hosts];
  const seen = new Set(hosts.map((entry) => `${entry.host}|${entry.establishedBy}`));
  for (const entry of additional.hosts) {
    if (entry.host === scope.configuredHost || (entry.trusted && isSamePublisherFamily(scope.configuredHost, entry.host))) {
      addEvidence(hosts, seen, entry.host, entry.establishedBy, entry.via, entry.trusted);
    }
  }
  const effectiveHost = additional.transitioned ? additional.effectiveHost : scope.effectiveHost;
  return {
    configuredHost: scope.configuredHost,
    effectiveHost,
    hosts: hosts.slice(0, MAX_EVIDENCE_ENTRIES),
    transitioned: effectiveHost !== scope.configuredHost,
  };
}

export function isHostVerified(scope: VerifiedHostScope | null, linkUrl: string): boolean {
  if (!scope) return false;
  const linkHost = hostOfUrl(linkUrl);
  if (!linkHost) return false;
  return scope.hosts.some((entry) => entry.trusted && entry.host === linkHost);
}

export function trustedHostsSet(scope: VerifiedHostScope | null): Set<string> {
  const set = new Set<string>();
  if (!scope) return set;
  for (const entry of scope.hosts) if (entry.trusted) set.add(entry.host);
  return set;
}

export function serializeHostScope(scope: VerifiedHostScope | null): VerifiedHostEntry[] {
  if (!scope) return [];
  return scope.hosts.map((entry) => ({ ...entry }));
}
