import { normalizeFeedTextDetailed } from "./normalize-feed-text";

export const decodeHtmlEntities = (input: string) =>
  normalizeFeedTextDetailed(input).value;

export const stripCdata = (input: string) =>
  input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");

export const repairMojibake = (input: string) =>
  normalizeFeedTextDetailed(input).value;

export const normalizeFeedText = (input: string) =>
  normalizeFeedTextDetailed(input).value;

export const cleanFeedValue = (input: string) => normalizeFeedText(input);

export const normalizeUrl = (rawUrl: string) => {
  const url = new URL(rawUrl);
  url.hash = "";
  url.searchParams.delete("utm_source");
  url.searchParams.delete("utm_medium");
  url.searchParams.delete("utm_campaign");
  url.searchParams.delete("utm_term");
  url.searchParams.delete("utm_content");
  url.searchParams.delete("fbclid");
  url.searchParams.delete("gclid");
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
};

export const stripHtml = (input: string) =>
  normalizeFeedText(
    input
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

/**
 * Normalize a target URL for stable target-key identity comparison.
 *
 * Builds on the existing normalizeUrl() (which strips hash, tracking params,
 * and trailing slashes) and additionally:
 * - lowercases the hostname
 * - strips default ports (:80 for http, :443 for https)
 *
 * Returns null for invalid URLs so callers can safely skip them.
 */
export const normalizeTargetUrl = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }
    url.hash = "";
    url.searchParams.delete("utm_source");
    url.searchParams.delete("utm_medium");
    url.searchParams.delete("utm_campaign");
    url.searchParams.delete("utm_term");
    url.searchParams.delete("utm_content");
    url.searchParams.delete("fbclid");
    url.searchParams.delete("gclid");
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
};

/**
 * Build a deterministic stable target key for Agent 2 queue items.
 *
 * The key is derived from normalized target identity:
 * - sourceId (required)
 * - categoryId (empty string if null)
 * - normalized target URL (host-cased, default ports stripped, trailing slashes,
 *   hashes, and tracking params removed)
 *
 * Returns null if sourceId or targetUrl is missing/invalid.
 *
 * IMPORTANT: This is the single source of truth for queue target identity.
 * All modules that determine queue identity (deduplication, cooldown,
 * hard-source tracking, health, admin API) must use this helper.
 */
export const stableTargetKey = (
  sourceId: string | null | undefined,
  categoryId: string | null | undefined,
  targetUrl: string | null | undefined,
): string | null => {
  if (!sourceId || !targetUrl) return null;
  const normalized = normalizeTargetUrl(targetUrl);
  if (!normalized) return null;
  return `${sourceId}|${categoryId ?? ""}|${normalized}`;
};

export const hashText = async (input: string) => {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};
