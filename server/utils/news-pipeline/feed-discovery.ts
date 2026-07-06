import { safeFetch } from "../ssrf-guard";
import { buildFeedUrlCandidates } from "./import-rss";

const FEED_LINK_REGEX =
  /<link[^>]+type=["']application\/(rss\+xml|atom\+xml)["'][^>]+href=["']([^"']+)["']/i;

const looksLikeFeed = (body: string) => {
  const sample = body.slice(0, 4000).toLowerCase();
  return (
    sample.includes("<rss") ||
    sample.includes("<feed") ||
    sample.includes("<rdf:rdf") ||
    sample.includes("<channel") ||
    sample.includes("<entry") ||
    sample.includes("<item")
  );
};

const resolveHtmlDeclaredFeed = (body: string, pageUrl: string) => {
  const match = body.match(FEED_LINK_REGEX);
  if (!match?.[2]) return null;

  if (match[2].startsWith("/")) {
    const urlObj = new URL(pageUrl);
    return `${urlObj.origin}${match[2]}`;
  }

  return match[2];
};

export const buildScopedFeedCandidates = (pageUrl: string, existingFeedUrl?: string | null) => {
  const candidates = new Set(buildFeedUrlCandidates(existingFeedUrl || null, pageUrl));

  try {
    const parsed = new URL(pageUrl);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    const base = `${parsed.origin}${normalizedPath}`;

    candidates.add(`${base}/rss/`);
    candidates.add(`${base}/rss`);
    candidates.add(`${base}/feed/`);
    candidates.add(`${base}/feed`);
    candidates.add(pageUrl);
  } catch {
    candidates.add(pageUrl);
  }

  return [...candidates].filter(Boolean);
};

export async function discoverFeedForUrl(input: {
  pageUrl: string;
  existingFeedUrl?: string | null;
  userAgent: string;
  acceptLanguage?: string;
  preferScopedDirectFeed?: boolean;
}) {
  let lastError = "No feed candidates succeeded.";
  const candidateUrls = buildScopedFeedCandidates(input.pageUrl, input.existingFeedUrl || null);
  let deferredHtmlDeclaredFeed: null | { feedUrl: string; discoveredVia: string } = null;

  for (const candidateUrl of candidateUrls) {
    try {
      const response = await safeFetch(candidateUrl, {
        headers: {
          "User-Agent": input.userAgent,
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html,application/xhtml+xml",
          ...(input.acceptLanguage ? { "Accept-Language": input.acceptLanguage } : {}),
        },
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status} from ${candidateUrl}`;
        continue;
      }

      const body = await response.text();
      if (looksLikeFeed(body)) {
        return {
          feedUrl: response.url,
          discoveredVia: candidateUrl,
          detection: "direct-feed" as const,
        };
      }

      const declaredFeedUrl = resolveHtmlDeclaredFeed(body, response.url || input.pageUrl);
      if (declaredFeedUrl) {
        if (input.preferScopedDirectFeed) {
          deferredHtmlDeclaredFeed = {
            feedUrl: declaredFeedUrl,
            discoveredVia: candidateUrl,
          };
          lastError = `Deferred HTML-declared feed ${declaredFeedUrl} from ${candidateUrl}`;
          continue;
        }

        return {
          feedUrl: declaredFeedUrl,
          discoveredVia: candidateUrl,
          detection: "html-link" as const,
        };
      }

      lastError = `No feed markers in ${candidateUrl}`;
    } catch (error: any) {
      lastError = `${error?.message || String(error)} via ${candidateUrl}`;
    }
  }

  if (deferredHtmlDeclaredFeed) {
    return {
      feedUrl: deferredHtmlDeclaredFeed.feedUrl,
      discoveredVia: deferredHtmlDeclaredFeed.discoveredVia,
      detection: "html-link" as const,
    };
  }

  return {
    feedUrl: null,
    discoveredVia: null,
    detection: "none" as const,
    lastError,
  };
}
