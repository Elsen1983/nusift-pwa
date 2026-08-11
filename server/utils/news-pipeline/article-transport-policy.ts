const HTTP_FALLBACK_HOSTS_ENV = "NUSIFT_AGENT3_HTTP_FALLBACK_ALLOWED_HOSTS";

const parseHostname = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Return the HTTPS equivalent without changing path, query, or fragment. */
export const getHttpsArticleUrl = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" || url.username || url.password) return null;
    if (url.port && url.port !== "80") return null;
    url.protocol = "https:";
    if (url.port === "80") url.port = "";
    return url.toString();
  } catch {
    return null;
  }
};

/**
 * Make HTTP and HTTPS versions of the same article share one identity key.
 * This is intentionally limited to scheme equivalence; host/path/query
 * identity remains unchanged.
 */
export const getArticleTransportIdentity = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.protocol = "https:";
    if (url.port === "80") url.port = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

/**
 * HTTP fallback is opt-in per hostname. The value is a comma-separated list
 * such as `legacy.example.com,news.example.org`; no host is allowed by
 * default.
 */
export const isExplicitHttpFallbackAllowed = (
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const hostname = parseHostname(rawUrl);
  if (!hostname || !rawUrl.trim().toLowerCase().startsWith("http://")) return false;
  const configured = (env[HTTP_FALLBACK_HOSTS_ENV] || "")
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
  return configured.includes(hostname);
};

export const ARTICLE_HTTP_FALLBACK_HOSTS_ENV = HTTP_FALLBACK_HOSTS_ENV;
