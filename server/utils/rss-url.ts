const STRIP_QUERY_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
]);

export function normalizeCanonicalUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (STRIP_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}