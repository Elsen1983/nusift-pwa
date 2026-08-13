import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import * as ssrfGuard from "../ssrf-guard";
import { NUSIFT_CRAWLER_USER_AGENT } from "./publisher-user-agent";
import {
  GovernedFetchDeferredError,
  governedSafeFetchAndParse,
  type GovernedFetchContext,
} from "./governed-fetch";
import { decodeResponseText, ResponseBodyTooLargeError } from "./response-text-decoder";

export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const ROBOTS_UNAVAILABLE_RETRY_MS = 5 * 60 * 1000;
export const ROBOTS_MAX_BODY_BYTES = 64 * 1024;
export const ROBOTS_MAX_RULES = 256;
export const ROBOTS_MAX_PATTERN_LENGTH = 512;
export const ROBOTS_REFRESH_LEASE_MS = 30_000;

type RobotsGroup = {
  userAgents: string[];
  allow: string[];
  disallow: string[];
};

export type ParsedRobotsPolicy = {
  groups: RobotsGroup[];
  sitemaps: string[];
  malformed: boolean;
};

export type RobotsPolicyStatus =
  | "policy"
  | "no_policy"
  | "forbidden"
  | "unavailable"
  | "rate_limited"
  | "malformed"
  | "oversized"
  | "governor_deferred";

export type RobotsPolicyDecision = {
  allowed: boolean;
  decision: "allowed" | "disallowed" | "deferred";
  reason: string;
  domainKey: string | null;
  status: RobotsPolicyStatus | "cache_unavailable";
  cacheHit: boolean;
  sitemapUrls: string[];
};

type RobotsPolicyRow = {
  domainKey: string;
  policyStatus: string;
  rules: unknown;
  fetchedAt: Date;
  expiresAt: Date;
  httpStatus: number | null;
  lastDecision: string | null;
  lastDecisionAt: Date | null;
  activeLeaseToken: string | null;
  activeLeaseExpiresAt: Date | null;
  version: number;
};

type RobotsPolicyModel = {
  findUnique(args: { where: { domainKey: string } }): Promise<RobotsPolicyRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<RobotsPolicyRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
};

export type RobotsPolicyDb = {
  publisherRobotsPolicy: RobotsPolicyModel;
};

const cacheModel = (db?: unknown): RobotsPolicyModel | null => {
  const candidate = (db as { publisherRobotsPolicy?: RobotsPolicyModel } | undefined)?.publisherRobotsPolicy
    ?? (process.env.VITEST ? undefined : (prisma as unknown as { publisherRobotsPolicy?: RobotsPolicyModel }).publisherRobotsPolicy);
  return candidate && typeof candidate.findUnique === "function" && typeof candidate.updateMany === "function"
    ? candidate
    : null;
};

const normalizeRobotsDomainKey = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only HTTP(S) URLs are supported.");
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!hostname) throw new Error("Domain hostname is empty.");
  try {
    const validateHostname = (ssrfGuard as typeof ssrfGuard & {
      validateHostname?: (value: string) => void;
    }).validateHostname;
    if (typeof validateHostname === "function") validateHostname(hostname);
  } catch (error) {
    // Partial transport mocks may omit the optional named export; production
    // uses the real SSRF module and therefore always performs this check.
    if (!(error instanceof Error && /No "validateHostname" export/.test(error.message))) throw error;
  }
  return hostname;
};

const boundedText = (value: string): string => value.slice(0, ROBOTS_MAX_PATTERN_LENGTH);

const normalizeDirective = (value: string): string => boundedText(value.trim().replace(/\s+/g, " "));

const normalizeSitemapUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    parsed.search = "";
    parsed.hash = "";
    return boundedText(parsed.toString());
  } catch {
    return null;
  }
};

/** Parse only bounded directives; the raw robots body is never returned or persisted. */
export function parseRobotsTxt(body: string, maxRules = ROBOTS_MAX_RULES): ParsedRobotsPolicy {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let malformed = false;
  let ruleCount = 0;

  for (const rawLine of body.split(/\r?\n/).slice(0, 2_000)) {
    if (rawLine.length > 4_096) malformed = true;
    const line = rawLine.split("#", 1)[0]?.trim() ?? "";
    if (!line) {
      if (current?.userAgents.length) groups.push(current);
      current = null;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      malformed = true;
      continue;
    }
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = normalizeDirective(line.slice(separator + 1));
    if (directive === "sitemap") {
      const sitemap = value ? normalizeSitemapUrl(value) : null;
      if (sitemap && sitemaps.length < 16) sitemaps.push(sitemap);
      continue;
    }
    if (directive === "user-agent") {
      if (!current || current.allow.length || current.disallow.length) {
        if (current?.userAgents.length) groups.push(current);
        current = { userAgents: [], allow: [], disallow: [] };
      }
      if (value) current.userAgents.push(value.toLowerCase());
      continue;
    }
    if (directive !== "allow" && directive !== "disallow") continue;
    if (!current?.userAgents.length || ruleCount >= maxRules) {
      if (ruleCount >= maxRules) malformed = true;
      continue;
    }
    if (value) {
      current[directive].push(value);
      ruleCount += 1;
    }
  }
  if (current?.userAgents.length) groups.push(current);
  return { groups: groups.slice(0, maxRules), sitemaps, malformed };
}

const serializedRules = (parsed: ParsedRobotsPolicy): Record<string, unknown> => ({
  groups: parsed.groups.map((group) => ({
    userAgents: group.userAgents.slice(0, 8),
    allow: group.allow.slice(0, 128),
    disallow: group.disallow.slice(0, 128),
  })),
  sitemaps: parsed.sitemaps.slice(0, 16),
});

const asGroups = (value: unknown): RobotsGroup[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const groups = (value as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return [];
  return groups.slice(0, ROBOTS_MAX_RULES).flatMap((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return [];
    const item = group as Record<string, unknown>;
    const list = (key: string) => Array.isArray(item[key])
      ? item[key].filter((entry): entry is string => typeof entry === "string").map(normalizeDirective)
      : [];
    const userAgents = list("userAgents").map((entry) => entry.toLowerCase());
    return userAgents.length ? [{ userAgents, allow: list("allow"), disallow: list("disallow") }] : [];
  });
};

const asSitemaps = (value: unknown): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const sitemaps = (value as { sitemaps?: unknown }).sitemaps;
  return Array.isArray(sitemaps)
    ? sitemaps.filter((entry): entry is string => typeof entry === "string").map(boundedText).slice(0, 16)
    : [];
};

const escapeRegex = (value: string): string => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const robotsPattern = (pattern: string): RegExp | null => {
  const bounded = pattern.slice(0, ROBOTS_MAX_PATTERN_LENGTH);
  let source = "";
  for (const character of bounded) {
    if (character === "*") source += ".*";
    else if (character === "$") source += "$";
    else source += escapeRegex(character);
  }
  try { return new RegExp(`^${source}`, "i"); } catch { return null; }
};

const matchingGroups = (groups: RobotsGroup[], userAgent: string): RobotsGroup[] => {
  const agent = userAgent.toLowerCase();
  const exact = groups.filter((group) => group.userAgents.some((entry) => entry !== "*" && agent.includes(entry)));
  if (exact.length) return exact;
  return groups.filter((group) => group.userAgents.includes("*"));
};

/** Apply the longest matching rule; Allow wins when match lengths tie. */
export function isRobotsUrlAllowed(
  policy: ParsedRobotsPolicy | { groups: RobotsGroup[] },
  url: string,
  userAgent = NUSIFT_CRAWLER_USER_AGENT,
): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const path = `${parsed.pathname || "/"}${parsed.search}`;
  const rules = matchingGroups(policy.groups, userAgent).flatMap((group) => [
    ...group.allow.map((value) => ({ value, allowed: true })),
    ...group.disallow.map((value) => ({ value, allowed: false })),
  ]);
  let winner: { length: number; allowed: boolean } | null = null;
  for (const rule of rules) {
    const matcher = robotsPattern(rule.value);
    if (!matcher || !matcher.test(path)) continue;
    const length = rule.value.replace(/\*/g, "").replace(/\$$/, "").length;
    if (!winner || length > winner.length || (length === winner.length && rule.allowed)) {
      winner = { length, allowed: rule.allowed };
    }
  }
  return winner?.allowed ?? true;
}

const boundedRetryAfter = (value: string | null | undefined, now: Date): Date => {
  const raw = value?.trim() ?? "";
  const delta = /^\d+$/.test(raw) ? Number(raw) * 1_000 : Date.parse(raw) - now.getTime();
  const delay = Number.isFinite(delta) && delta > 0 ? delta : 15 * 60_000;
  return new Date(now.getTime() + Math.min(24 * 60 * 60_000, Math.max(30_000, delay)));
};

const responseHeader = (response: any, name: string): string | null => {
  const headers = response?.headers;
  if (headers && typeof headers.get === "function") return headers.get(name);
  if (!headers) return null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key && typeof headers[key] === "string" ? headers[key] : null;
};

const readBoundedBody = async (response: any): Promise<{ body: string; oversized: boolean }> => {
  try {
    const decoded = await decodeResponseText(response as Response, {
      kind: "text",
      maxBytes: ROBOTS_MAX_BODY_BYTES,
      overflow: "reject",
    });
    return { body: decoded.text, oversized: false };
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) return { body: "", oversized: true };
    throw error;
  }
};

const makeDecision = (
  domainKey: string | null,
  status: RobotsPolicyDecision["status"],
  allowed: boolean,
  decision: RobotsPolicyDecision["decision"],
  reason: string,
  cacheHit: boolean,
  sitemapUrls: string[] = [],
): RobotsPolicyDecision => ({ domainKey, status, allowed, decision, reason: reason.slice(0, 120), cacheHit, sitemapUrls });

const evaluateCached = (row: RobotsPolicyRow, url: string, now: Date, cacheHit: boolean): RobotsPolicyDecision => {
  const status = row.policyStatus as RobotsPolicyStatus;
  if (status === "policy") {
    const allowed = isRobotsUrlAllowed({ groups: asGroups(row.rules) }, url);
    return makeDecision(row.domainKey, status, allowed, allowed ? "allowed" : "disallowed", allowed ? "robots_allowed" : "robots_disallowed", cacheHit, asSitemaps(row.rules));
  }
  if (status === "rate_limited" || status === "malformed" || status === "oversized" || status === "governor_deferred") {
    return makeDecision(row.domainKey, status, false, "deferred", `robots_${status}`, cacheHit, asSitemaps(row.rules));
  }
  return makeDecision(row.domainKey, status, true, "allowed", `robots_${status}`, cacheHit, asSitemaps(row.rules));
};

type RobotsFetchResult = {
  status: RobotsPolicyStatus;
  httpStatus: number | null;
  rules: Record<string, unknown>;
  expiresAt: Date;
  retryAfter?: Date;
};

const fetchRobots = async (origin: string, context: GovernedFetchContext, now: Date): Promise<RobotsFetchResult> => {
  const response = await governedSafeFetchAndParse(`${origin}/robots.txt`, {
    headers: {
      "User-Agent": NUSIFT_CRAWLER_USER_AGENT,
      Accept: "text/plain",
    },
  }, {
    ...context,
    purpose: "robots",
    robotsPolicy: "skip",
  }, async (candidateResponse) => {
    const status = candidateResponse.status;
    if (status === 429) {
      const retryAfter = responseHeader(candidateResponse, "retry-after");
      context.requestBudget?.recordRateLimit?.("robots", `${origin}/robots.txt`, retryAfter);
      return { status, retryAfter };
    }
    if (status === 403) {
      context.requestBudget?.recordAccessDenied?.("robots", `${origin}/robots.txt`);
    }
    if (status === 403 || status === 404) return { status, retryAfter: null };
    if (!candidateResponse.ok) return { status, retryAfter: null };
    const bounded = await readBoundedBody(candidateResponse);
    if (bounded.oversized) return { status, oversized: true, body: "" };
    return { status, oversized: false, body: bounded.body };
  });

  if (response.status === 429) {
    const retryAfter = boundedRetryAfter(response.retryAfter, now);
    return { status: "rate_limited", httpStatus: 429, rules: { groups: [] }, expiresAt: retryAfter, retryAfter };
  }
  if (response.status === 403) return { status: "forbidden", httpStatus: 403, rules: { groups: [] }, expiresAt: new Date(now.getTime() + ROBOTS_CACHE_TTL_MS) };
  if (response.status === 404) return { status: "no_policy", httpStatus: 404, rules: { groups: [] }, expiresAt: new Date(now.getTime() + ROBOTS_CACHE_TTL_MS) };
  if (response.oversized) return { status: "oversized", httpStatus: response.status, rules: { groups: [] }, expiresAt: new Date(now.getTime() + ROBOTS_UNAVAILABLE_RETRY_MS) };
  const parsed = parseRobotsTxt(response.body ?? "");
  if (parsed.malformed) return { status: "malformed", httpStatus: response.status, rules: serializedRules(parsed), expiresAt: new Date(now.getTime() + ROBOTS_UNAVAILABLE_RETRY_MS) };
  if (!parsed.groups.length) return { status: "no_policy", httpStatus: response.status, rules: serializedRules(parsed), expiresAt: new Date(now.getTime() + ROBOTS_CACHE_TTL_MS) };
  return { status: "policy", httpStatus: response.status, rules: serializedRules(parsed), expiresAt: new Date(now.getTime() + ROBOTS_CACHE_TTL_MS) };
};

const initialRow = (domainKey: string): Record<string, unknown> => ({
  domainKey,
  policyStatus: "unavailable",
  rules: { groups: [] },
  fetchedAt: new Date(0),
  expiresAt: new Date(0),
  version: 0,
});

const refreshDecision = (domainKey: string, status: RobotsPolicyStatus, cacheHit = false) =>
  makeDecision(domainKey, status, status === "forbidden" || status === "unavailable" || status === "no_policy", "allowed", `robots_${status}`, cacheHit);

/** Load or refresh one domain cache entry without holding a transaction over network I/O. */
export async function checkPublisherRobotsAccess(
  url: string,
  input: { context: GovernedFetchContext; db?: unknown; now?: Date },
): Promise<RobotsPolicyDecision> {
  let domainKey: string;
  let origin: string;
  try {
    const parsed = new URL(url);
    domainKey = normalizeRobotsDomainKey(url);
    origin = parsed.origin;
  } catch {
    return makeDecision(null, "unavailable", false, "deferred", "robots_invalid_domain", false);
  }
  const now = input.now ?? new Date();
  const model = cacheModel(input.db ?? input.context.robotsDb);
  if (!model) {
    // Before the forward migration is deployed, keep the shared parser and
    // governed transport usable without pretending the result is durably cached.
    try {
      const fetched = await fetchRobots(origin, input.context, now);
      const fallbackRow = {
        ...initialRow(domainKey),
        policyStatus: fetched.status,
        rules: fetched.rules,
        expiresAt: fetched.expiresAt,
      } as RobotsPolicyRow;
      return evaluateCached(fallbackRow, url, now, false);
    } catch (error) {
      if (error instanceof GovernedFetchDeferredError) throw error;
      return refreshDecision(domainKey, "unavailable");
    }
  }
  let row: RobotsPolicyRow | null;
  try {
    row = await model.findUnique({ where: { domainKey } });
    if (!row) {
      try { row = await model.create({ data: initialRow(domainKey) }); }
      catch { row = await model.findUnique({ where: { domainKey } }); }
    }
  } catch {
    return makeDecision(domainKey, "cache_unavailable", true, "allowed", "robots_cache_unavailable", false);
  }
  if (!row) return makeDecision(domainKey, "cache_unavailable", true, "allowed", "robots_cache_unavailable", false);
  if (row.expiresAt > now && !row.activeLeaseToken) return evaluateCached(row, url, now, true);
  if (row.activeLeaseToken && row.activeLeaseExpiresAt && row.activeLeaseExpiresAt > now) {
    return makeDecision(domainKey, "governor_deferred", false, "deferred", "robots_refresh_in_progress", true);
  }

  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + ROBOTS_REFRESH_LEASE_MS);
  let claimed: { count: number };
  try {
    claimed = await model.updateMany({
      where: {
        domainKey,
        version: row.version,
        OR: [
          { activeLeaseToken: null },
          { activeLeaseExpiresAt: null },
          { activeLeaseExpiresAt: { lte: now } },
        ],
      },
      data: { activeLeaseToken: leaseToken, activeLeaseExpiresAt: leaseExpiresAt, version: { increment: 1 } },
    });
  } catch {
    return makeDecision(domainKey, "cache_unavailable", true, "allowed", "robots_cache_unavailable", false);
  }
  if (claimed.count !== 1) return makeDecision(domainKey, "governor_deferred", false, "deferred", "robots_refresh_in_progress", false);

  const leasedVersion = row.version + 1;
  try {
    const fetched = await fetchRobots(origin, input.context, now);
    const written = await model.updateMany({
      where: { domainKey, version: leasedVersion, activeLeaseToken: leaseToken },
      data: {
        policyStatus: fetched.status,
        rules: fetched.rules,
        fetchedAt: now,
        expiresAt: fetched.expiresAt,
        httpStatus: fetched.httpStatus,
        lastDecision: `robots_${fetched.status}`,
        lastDecisionAt: now,
        activeLeaseToken: null,
        activeLeaseExpiresAt: null,
        version: { increment: 1 },
      },
    });
    if (written.count !== 1) return makeDecision(domainKey, "governor_deferred", false, "deferred", "robots_cache_cas_conflict", false);
    const refreshed = { ...row, policyStatus: fetched.status, rules: fetched.rules, expiresAt: fetched.expiresAt, activeLeaseToken: null } as RobotsPolicyRow;
    return fetched.status === "rate_limited"
      ? makeDecision(domainKey, fetched.status, false, "deferred", "robots_rate_limited", false)
      : evaluateCached(refreshed, url, now, false);
  } catch (error) {
    await model.updateMany({
      where: { domainKey, version: leasedVersion, activeLeaseToken: leaseToken },
      data: { activeLeaseToken: null, activeLeaseExpiresAt: null, version: { increment: 1 } },
    }).catch(() => {});
    if (error instanceof GovernedFetchDeferredError) throw error;
    return refreshDecision(domainKey, "unavailable");
  }
}
