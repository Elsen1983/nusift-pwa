const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
]);

/**
 * Stable destination identity for an Article canonical URL.
 *
 * HTTP and HTTPS are transport variants of one identity. AMP/mobile paths are
 * deliberately not rewritten: they converge only when publisher canonical
 * evidence supplies the same URL. No network resolution occurs here.
 */
export const normalizeArticleCanonicalIdentity = (rawUrl: string | null | undefined): string | null => {
  if (!rawUrl?.trim()) return null;
  try {
    const url = new URL(rawUrl.trim());
    if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password) return null;
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.port === "80" || url.port === "443") url.port = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
};

/** Scope an opaque publisher GUID to its collection source. */
export const normalizeScopedRssGuid = (rawGuid: string | null | undefined): string | null => {
  const value = rawGuid?.trim();
  if (!value || value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (["null", "none", "undefined", "n/a"].includes(value.toLowerCase())) return null;
  return value;
};

export const scopedRssGuidIdentity = (
  sourceId: string,
  rawGuid: string | null | undefined,
): string | null => {
  const guid = normalizeScopedRssGuid(rawGuid);
  return guid ? `${sourceId}\u0000${guid}` : null;
};

export type ArticleDuplicateKind =
  | "same_canonical"
  | "same_source_guid"
  | "syndicated_canonical"
  | "concurrent_unique_conflict";

export type ArticleDuplicateSummary = Record<ArticleDuplicateKind, number>;

export const emptyArticleDuplicateSummary = (): ArticleDuplicateSummary => ({
  same_canonical: 0,
  same_source_guid: 0,
  syndicated_canonical: 0,
  concurrent_unique_conflict: 0,
});
