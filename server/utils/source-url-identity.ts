export const normalizeSourceIdentityUrl = (
  rawUrl: string,
  options?: { rootOnly?: boolean },
) => {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Unsupported source URL protocol.");
  }
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";
  if (options?.rootOnly) {
    url.pathname = "/";
    url.search = "";
  } else if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/\/$/, "");
};

export const sourceIdentityKey = (rawUrl: string) =>
  normalizeSourceIdentityUrl(rawUrl).toLowerCase();

export type SourceUrlIdentity = {
  normalizedUrl: string;
  rootUrl: string;
  isRoot: boolean;
};

export const resolveSourceUrlIdentity = (rawUrl: string): SourceUrlIdentity => {
  const normalizedUrl = normalizeSourceIdentityUrl(rawUrl);
  const rootUrl = normalizeSourceIdentityUrl(rawUrl, { rootOnly: true });
  return {
    normalizedUrl,
    rootUrl,
    isRoot: normalizedUrl === rootUrl,
  };
};
