import { prisma } from "../prisma";
import { safeFetch } from "../ssrf-guard";
import { SSRFError } from "../ssrf-guard";
import { logAgentScan } from "./log";
import { hashText, normalizeUrl, stripHtml } from "./text";
import type { IngestCandidate } from "./types";
import { buildFeedUrlCandidates } from "./import-rss";

const parseRssItems = (xml: string) => {
  const items: Array<Record<string, string>> = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const readTag = (block: string, tag: string) =>
    block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ||
    "";

  for (const match of xml.matchAll(itemRegex)) {
    const block = match[0] || "";
    items.push({
      title: readTag(block, "title"),
      link: readTag(block, "link"),
      guid: readTag(block, "guid"),
      pubDate: readTag(block, "pubDate"),
      description: readTag(block, "description"),
    });
  }

  return items;
};

const parseAtomItems = (xml: string) => {
  const items: Array<Record<string, string>> = [];
  const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
  const readTag = (block: string, tag: string) =>
    block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ||
    "";

  for (const match of xml.matchAll(entryRegex)) {
    const block = match[0] || "";
    const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);
    items.push({
      title: readTag(block, "title"),
      link: linkMatch?.[1] || "",
      guid: readTag(block, "id"),
      pubDate: readTag(block, "updated") || readTag(block, "published"),
      description: readTag(block, "summary") || readTag(block, "content"),
    });
  }

  return items;
};

const parseFeedItems = (xml: string) => {
  const rssItems = parseRssItems(xml);
  if (rssItems.length > 0) {
    return { format: "rss" as const, items: rssItems };
  }

  const atomItems = parseAtomItems(xml);
  if (atomItems.length > 0) {
    return { format: "atom" as const, items: atomItems };
  }

  return { format: "unknown" as const, items: [] as Array<Record<string, string>> };
};

const getContentType = (response: Response) =>
  response.headers.get("content-type") || "unknown";

const getRootHost = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const isLikelyArticleLink = (href: string, sourceUrl: string) => {
  try {
    const url = new URL(href);
    if (url.hostname.replace(/^www\./, "") !== getRootHost(sourceUrl)) return false;
    const path = url.pathname.replace(/^\/|\/$/g, "");
    if (!path) return false;
    const segments = path.split("/").filter(Boolean);
    if (segments.length >= 2) return true;
    if (segments.length === 1) {
      const last = segments[0] || "";
      if (last.length >= 18) return true;
      if ((last.match(/-/g) || []).length >= 2) return true;
      if (/\d{4,}/.test(last)) return true;
    }
    return false;
  } catch {
    return false;
  }
};

const BLOCKED_HTML_FALLBACK_PATTERNS = [
  /^\/?$/,
  /^\/news\/?$/i,
  /^\/sport\/?$/i,
  /^\/business\/?$/i,
  /^\/showbiz\/?$/i,
  /^\/whatson\/?$/i,
  /^\/all-about\//i,
  /^\/tag\//i,
  /^\/topics?\//i,
  /^\/newsletter/i,
  /^\/newsletters/i,
  /^\/newsletter-preference/i,
  /^\/preferences/i,
  /^\/about/i,
  /^\/contact/i,
  /^\/privacy/i,
  /^\/terms/i,
  /^\/advertising/i,
  /^\/sitemap/i,
  /^\/auth/i,
];

const isBlockedFallbackPath = (href: string) => {
  try {
    const pathname = new URL(href).pathname.replace(/\/+$/, "") || "/";
    return BLOCKED_HTML_FALLBACK_PATTERNS.some((pattern) => pattern.test(pathname));
  } catch {
    return true;
  }
};

const extractPageMetadata = (html: string) => {
  const title =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    "";
  const description =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    "";
  return {
    title: stripHtml(title),
    description: stripHtml(description),
  };
};

const extractHtmlCandidates = async (html: string, sourceUrl: string, sourceId: string) => {
  const candidates: IngestCandidate[] = [];
  const seen = new Set<string>();

  const linkMatches = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const links = linkMatches
    .map((match) => match[1] || "")
    .filter((href) => href && !href.startsWith("#") && !href.startsWith("javascript:"))
    .map((href) => {
      try {
        return new URL(href, sourceUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((href): href is string => Boolean(href))
    .filter((href) => isLikelyArticleLink(href, sourceUrl))
    .filter((href) => !isBlockedFallbackPath(href))
    .filter((href) => {
      try {
        const current = new URL(href);
        const root = new URL(sourceUrl).hostname.replace(/^www\./, "");
        return current.hostname.replace(/^www\./, "") === root;
      } catch {
        return false;
      }
    })
    .filter((href) => {
      if (seen.has(href)) return false;
      seen.add(href);
      return true;
    })
    .slice(0, 8);

  for (const link of links) {
    const detailResponse = await safeFetch(link, {
      headers: {
        "User-Agent": "NuSift/1.0 Ingest-Agent",
        Accept: "text/html,application/xhtml+xml",
      },
    }).catch(() => null);

    if (!detailResponse || !detailResponse.ok) continue;

    const detailHtml = await detailResponse.text();
    const meta = extractPageMetadata(detailHtml);
    const canonicalUrl = normalizeUrl(link);
    if (!canonicalUrl || isBlockedFallbackPath(canonicalUrl)) continue;
    const itemTitle = meta.title || canonicalUrl;
    if (!itemTitle || itemTitle.length < 12) continue;
    const bodyText = meta.description || stripHtml(detailHtml).slice(0, 600);
    const contentHash = await hashText([itemTitle, canonicalUrl, bodyText].filter(Boolean).join("|"));

    candidates.push({
      sourceId,
      sourceUrl,
      canonicalUrl,
      rssGuid: null,
      title: itemTitle,
      publishedAt: null,
      bodyText: bodyText || null,
      contentHash,
      isPaywall: /paywall|subscribe|premium/i.test(html),
      rawTags: [],
      rawSignals: [],
      reasoning: `HTML detail fallback from ${link}`,
    });
  }

  return candidates;
};

const toDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const canonicalFromLink = (link: string) => normalizeUrl(link);

const formatPrismaError = (error: any) => {
  if (!error) return "Unknown Prisma error";
  const code = error.code ? `code=${error.code}` : null;
  const meta = error.meta ? `meta=${JSON.stringify(error.meta)}` : null;
  const name = error.name ? `name=${error.name}` : null;
  const message = error.message ? `message=${error.message}` : null;
  return [name, code, meta, message].filter(Boolean).join(" | ");
};

export async function ingestSource(sourceId: string) {
  const startedAt = Date.now();
  const source = await prisma.newsSource.findUnique({
    where: { id: sourceId },
    select: {
      id: true,
      frontPageUrl: true,
      rssFeedUrl: true,
      mediaName: true,
    },
  });

  if (!source) {
    await logAgentScan({
      sourceId,
      status: "SOURCE_NOT_FOUND",
      executionTimeMs: Date.now() - startedAt,
      errorLog: "No matching NewsSource record.",
    });
    return { sourceId, candidates: [], failed: 1 };
  }

  await logAgentScan({
    sourceId,
    status: "SOURCE_FETCH_STARTED",
    executionTimeMs: 0,
    errorLog: `Fetching from ${source.rssFeedUrl || source.frontPageUrl} (rss=${Boolean(source.rssFeedUrl)})`,
  });

  const feedUrls = buildFeedUrlCandidates(source.rssFeedUrl || null, source.frontPageUrl);
  try {
    let response: Response | null = null;
    let xml = "";
    let feedUrl = feedUrls[0] || source.frontPageUrl;
    let lastFeedFetchError = "";

    for (const candidateFeedUrl of feedUrls) {
      try {
        const candidateResponse = await safeFetch(candidateFeedUrl, {
          headers: {
            "User-Agent": "NuSift/1.0 Ingest-Agent",
            Accept: "application/rss+xml, application/xml, text/xml, text/html",
          },
        });

        if (!candidateResponse.ok) {
          lastFeedFetchError = `Fetch failed for ${candidateFeedUrl} with HTTP ${candidateResponse.status}.`;
          continue;
        }

        const candidateXml = await candidateResponse.text();
        const parsedCandidateFeed = parseFeedItems(candidateXml);
        await logAgentScan({
          sourceId,
          status: parsedCandidateFeed.format === "rss" ? "RSS_PARSED" : parsedCandidateFeed.format === "atom" ? "ATOM_PARSED" : "FEED_EMPTY",
          executionTimeMs: Date.now() - startedAt,
          errorLog: `Parsed ${parsedCandidateFeed.items.length} ${parsedCandidateFeed.format.toUpperCase()} item(s) from ${candidateFeedUrl}. contentType=${getContentType(candidateResponse)} bodyLength=${candidateXml.length}.`,
        });

        if (parsedCandidateFeed.items.length > 0) {
          response = candidateResponse;
          xml = candidateXml;
          feedUrl = candidateFeedUrl;
          break;
        }

        lastFeedFetchError = `No RSS/Atom items found for ${candidateFeedUrl}.`;
      } catch (error: any) {
        lastFeedFetchError = `${error?.message || String(error)} for ${candidateFeedUrl}`;
      }
    }

    if (!response) {
      await logAgentScan({
        sourceId,
        status: "FEED_EMPTY",
        executionTimeMs: Date.now() - startedAt,
        errorLog: lastFeedFetchError || `No usable feed response from ${feedUrls.join(", ")}.`,
      });
      throw new Error(lastFeedFetchError || "No usable feed response.");
    }

    const candidates: IngestCandidate[] = [];
    const parsedFeed = parseFeedItems(xml);

    for (const item of parsedFeed.items) {
      const rawLink = item.link.trim();
      if (!rawLink) {
        await logAgentScan({
          sourceId,
          status: "ITEM_SKIPPED_EMPTY_LINK",
          executionTimeMs: 0,
          errorLog: `Skipped feed item without link: ${item.title || "(untitled)"}.`,
        });
        continue;
      }

      const canonicalUrl = canonicalFromLink(rawLink);
      const title = stripHtml(item.title || canonicalUrl);
      const bodyText = stripHtml(item.description || "");
      const contentHash = await hashText(
        [title, canonicalUrl, bodyText].filter(Boolean).join("|"),
      );

      candidates.push({
        sourceId: source.id,
        sourceUrl: source.frontPageUrl,
        canonicalUrl,
        rssGuid: item.guid.trim() || null,
        title,
        publishedAt: toDate(item.pubDate),
        bodyText: bodyText || null,
        contentHash,
        isPaywall: /paywall|subscribe|premium/i.test(xml),
        rawTags: [],
        rawSignals: [],
        reasoning: `${parsedFeed.format.toUpperCase()} ingest from ${source.mediaName || source.frontPageUrl}`,
      });
    }

    if (candidates.length === 0) {
      await logAgentScan({
        sourceId,
        status: "HTML_FALLBACK_ATTEMPTED",
        executionTimeMs: Date.now() - startedAt,
        errorLog: `No RSS/Atom candidates found for ${feedUrl}. Trying HTML fallback at ${source.frontPageUrl}.`,
      });

      try {
        const htmlResponse = feedUrl === source.frontPageUrl
          ? response
          : await safeFetch(source.frontPageUrl, {
              headers: {
                "User-Agent": "NuSift/1.0 Ingest-Agent",
                Accept: "text/html,application/xhtml+xml",
              },
            });

        if (!htmlResponse.ok) {
          await logAgentScan({
            sourceId,
            status: `HTML_FALLBACK_FAILED_${htmlResponse.status}`,
            executionTimeMs: Date.now() - startedAt,
            errorLog: `HTML fallback failed for ${source.frontPageUrl} with HTTP ${htmlResponse.status}.`,
          });
          return { sourceId, candidates: [], failed: 1 };
        }

        const html = await htmlResponse.text();
        const htmlCandidates = await extractHtmlCandidates(html, source.frontPageUrl, source.id);
        candidates.push(...htmlCandidates);

        await logAgentScan({
          sourceId,
          status: "HTML_FALLBACK_COMPLETED",
          executionTimeMs: Date.now() - startedAt,
          errorLog: `Prepared ${htmlCandidates.length} HTML fallback candidate(s) from ${source.frontPageUrl}.`,
        });
      } catch (fallbackError: any) {
        await logAgentScan({
          sourceId,
          status: "HTML_FALLBACK_EXCEPTION",
          executionTimeMs: Date.now() - startedAt,
          errorLog: fallbackError?.message || String(fallbackError),
        });
        return { sourceId, candidates: [], failed: 1 };
      }
    }

    await logAgentScan({
      sourceId,
      status: "SOURCE_FETCH_COMPLETED",
      executionTimeMs: Date.now() - startedAt,
      errorLog: `Prepared ${candidates.length} candidate(s).`,
    });

    return { sourceId, candidates, failed: 0 };
  } catch (error: any) {
    const isSecurityError = error instanceof SSRFError;
    await logAgentScan({
      sourceId,
      status: isSecurityError ? "SOURCE_FETCH_BLOCKED_SECURITY" : "SOURCE_FETCH_EXCEPTION",
      executionTimeMs: Date.now() - startedAt,
      errorLog: error?.message || String(error),
    });

    if (source.rssFeedUrl && source.frontPageUrl) {
      try {
        const htmlResponse = await safeFetch(source.frontPageUrl, {
          headers: {
            "User-Agent": "NuSift/1.0 Ingest-Agent",
            Accept: "text/html,application/xhtml+xml",
          },
        });

        if (htmlResponse.ok) {
          const html = await htmlResponse.text();
          const htmlCandidates = await extractHtmlCandidates(html, source.frontPageUrl, source.id);
          if (htmlCandidates.length > 0) {
            await logAgentScan({
              sourceId,
              status: "HTML_FALLBACK_COMPLETED",
              executionTimeMs: Date.now() - startedAt,
              errorLog: `Security/RSS path failed, HTML fallback produced ${htmlCandidates.length} candidate(s).`,
            });
            return { sourceId, candidates: htmlCandidates, failed: 0 };
          }
        }
      } catch (fallbackError: any) {
        await logAgentScan({
          sourceId,
          status: "HTML_FALLBACK_EXCEPTION",
          executionTimeMs: Date.now() - startedAt,
          errorLog: fallbackError?.message || String(fallbackError),
        });
      }
    }

    return { sourceId, candidates: [], failed: 1 };
  }
}

export async function persistCandidates(candidates: IngestCandidate[]) {
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const duplicate = await prisma.article.findFirst({
      where: {
        OR: [
          candidate.rssGuid ? { rssGuid: candidate.rssGuid } : undefined,
          { canonicalUrl: candidate.canonicalUrl },
          { contentHash: candidate.contentHash },
        ].filter(Boolean) as any,
      },
      select: { id: true },
    });

    if (duplicate) {
      skipped += 1;
      await logAgentScan({
        sourceId: candidate.sourceId,
        status: "ARTICLE_DUPLICATE_SKIPPED",
        executionTimeMs: 0,
        errorLog: `Skipped duplicate article: ${candidate.title} | ${candidate.canonicalUrl}`,
      });
      continue;
    }

    try {
      await prisma.article.create({
        data: {
          title: candidate.title,
          sourceId: candidate.sourceId,
          sourceUrl: candidate.sourceUrl,
          canonicalUrl: candidate.canonicalUrl,
          rssGuid: candidate.rssGuid,
          contentHash: candidate.contentHash,
          bodyText: candidate.bodyText,
          publishedAt: candidate.publishedAt,
          date: candidate.publishedAt || new Date(),
          processingStage: "INGESTED",
          processingStatus: "SUCCESS",
          isPaywall: candidate.isPaywall,
          tags: candidate.rawTags,
          signals: candidate.rawSignals,
          reasoning: candidate.reasoning,
        },
      });
      inserted += 1;
      await logAgentScan({
        sourceId: candidate.sourceId,
        status: "ARTICLE_INSERTED",
        executionTimeMs: 0,
        errorLog: `Inserted article: ${candidate.title} | ${candidate.canonicalUrl}`,
      });
    } catch (error: any) {
      failed += 1;
      const prismaErrorDetails = formatPrismaError(error);
      await logAgentScan({
        sourceId: candidate.sourceId,
        status: "ARTICLE_INSERT_FAILED",
        executionTimeMs: 0,
        errorLog: `Insert failed for article: ${candidate.title} | ${candidate.canonicalUrl} | ${prismaErrorDetails}`,
      });
    }
  }

  return { inserted, skipped, failed };
}
