const SOURCE_REVALIDATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const LEGACY_PATH_HINTS: Record<string, string[]> = {
  "independent.ie": ["/regionals/"],
};

const normalizeHost = (rawUrl: string) => {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

const normalizePath = (rawUrl: string) => {
  try {
    return new URL(rawUrl).pathname.replace(/\/+$/, "").toLowerCase() || "/";
  } catch {
    return "/";
  }
};

const isLegacyPathHint = (rawUrl: string) => {
  const host = normalizeHost(rawUrl);
  const path = normalizePath(rawUrl);
  const hints = LEGACY_PATH_HINTS[host] || [];
  return hints.some((hint) => path === hint.slice(0, -1) || path.startsWith(hint));
};

export const shouldRevalidateExistingSource = (input: {
  frontPageUrl: string;
  rssFeedUrl?: string | null;
  rssStatus?: string | null;
  lastRssCheckAt?: Date | string | null;
  isSystemImported?: boolean | null;
}) => {
  const rssStatus = input.rssStatus || null;
  const lastCheckedAt = input.lastRssCheckAt ? new Date(input.lastRssCheckAt) : null;
  const lastCheckedMs = lastCheckedAt && !Number.isNaN(lastCheckedAt.getTime())
    ? lastCheckedAt.getTime()
    : null;
  const isStale =
    lastCheckedMs === null || Date.now() - lastCheckedMs > SOURCE_REVALIDATION_MAX_AGE_MS;

  if (!rssStatus) return true;
  if (rssStatus === "FAILED" || rssStatus === "DOMAIN_DEAD" || rssStatus === "PENDING_DISCOVERY") {
    return true;
  }
  if (!input.rssFeedUrl) return true;
  if (isLegacyPathHint(input.frontPageUrl)) return true;
  if (input.isSystemImported && isStale) return true;
  if (isStale && rssStatus !== "ACTIVE") return true;

  return false;
};
