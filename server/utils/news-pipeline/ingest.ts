import { prisma } from "../prisma";
import { safeFetch } from "../ssrf-guard";
import { SSRFError } from "../ssrf-guard";
import { logAgentScan } from "./log";
import { cleanFeedValue, hashText, normalizeUrl, stripHtml } from "./text";
import type { IngestCandidate } from "./types";
import { buildFeedUrlCandidates } from "./import-rss";

const parseRssItems = (xml: string) => {
  const items: Array<Record<string, string>> = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const readTag = (block: string, tag: string) =>
    cleanFeedValue(
      block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ||
        "",
    );

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
    cleanFeedValue(
      block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ||
        "",
    );

  for (const match of xml.matchAll(entryRegex)) {
    const block = match[0] || "";
    const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);
    items.push({
      title: readTag(block, "title"),
      link: cleanFeedValue(linkMatch?.[1] || ""),
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
  const publishedAtRaw =
    html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+name=["']publishdate["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] ||
    "";
  return {
    title: stripHtml(title),
    description: stripHtml(description),
    publishedAt: toDate(publishedAtRaw),
  };
};

const MAX_ARTICLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const isWithinFreshnessWindow = (publishedAt: Date | null, now = new Date()) => {
  if (!publishedAt) return false;
  const diff = now.getTime() - publishedAt.getTime();
  return diff >= 0 && diff <= MAX_ARTICLE_AGE_MS;
};

const extractHtmlCandidates = async (html: string, sourceUrl: string, sourceId: string) => {
  const candidates: IngestCandidate[] = [];
  const seen = new Set<string>();
  const now = new Date();

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
    if (!isWithinFreshnessWindow(meta.publishedAt, now)) continue;
    const bodyText = meta.description || stripHtml(detailHtml).slice(0, 600);
    const contentHash = await hashText([itemTitle, canonicalUrl, bodyText].filter(Boolean).join("|"));

    candidates.push({
      sourceId,
      sourceUrl,
      canonicalUrl,
      rssGuid: null,
      title: itemTitle,
      publishedAt: meta.publishedAt,
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

type SourceCategoryMatcher = {
  id: string;
  normalizedPath: string;
};

const normalizePathForCategoryMatch = (url: string) => {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "") || "/";
    return pathname.toLowerCase();
  } catch {
    return "/";
  }
};

export const matchCategoryIdForUrl = (
  canonicalUrl: string,
  categories: SourceCategoryMatcher[],
) => {
  const articlePath = normalizePathForCategoryMatch(canonicalUrl);
  const orderedCategories = [...categories].sort(
    (a, b) => b.normalizedPath.length - a.normalizedPath.length,
  );

  for (const category of orderedCategories) {
    if (category.normalizedPath === "/") continue;
    if (
      articlePath === category.normalizedPath ||
      articlePath.startsWith(`${category.normalizedPath}/`)
    ) {
      return category.id;
    }
  }

  return null;
};

const attachCategoryIds = async (candidates: IngestCandidate[]) => {
  const sourceIds = [...new Set(candidates.map((candidate) => candidate.sourceId))];
  if (sourceIds.length === 0) return candidates;

  const categories = await prisma.sourceCategory.findMany({
    where: {
      newsSourceId: { in: sourceIds },
    },
    select: {
      id: true,
      newsSourceId: true,
      pathUrl: true,
    },
  });

  const categoriesBySource = new Map<string, SourceCategoryMatcher[]>();
  for (const category of categories) {
    const normalizedPath = normalizePathForCategoryMatch(category.pathUrl);
    if (!normalizedPath || normalizedPath === "/") continue;

    const existing = categoriesBySource.get(category.newsSourceId) || [];
    existing.push({
      id: category.id,
      normalizedPath,
    });
    categoriesBySource.set(category.newsSourceId, existing);
  }

  for (const entry of categoriesBySource.values()) {
    entry.sort((a, b) => b.normalizedPath.length - a.normalizedPath.length);
  }

  return candidates.map((candidate) => ({
    ...candidate,
    categoryId:
      candidate.categoryId ||
      matchCategoryIdForUrl(
        candidate.canonicalUrl,
        categoriesBySource.get(candidate.sourceId) || [],
      ),
  }));
};

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
    const now = new Date();
    let skippedEmptyLink = 0;
    let skippedStale = 0;

    for (const item of parsedFeed.items) {
      const rawLink = item.link.trim();
      if (!rawLink) {
        skippedEmptyLink += 1;
        continue;
      }

      const canonicalUrl = canonicalFromLink(rawLink);
      const publishedAt = toDate(item.pubDate);
      if (!isWithinFreshnessWindow(publishedAt, now)) {
        skippedStale += 1;
        continue;
      }
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
        publishedAt,
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
      errorLog: `Prepared ${candidates.length} candidate(s). skippedEmptyLink=${skippedEmptyLink}, skippedStale=${skippedStale}.`,
    });

    return { sourceId, candidates: await attachCategoryIds(candidates), failed: 0 };
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
            return {
              sourceId,
              candidates: await attachCategoryIds(htmlCandidates),
              failed: 0,
            };
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
  if (candidates.length === 0) {
    return { inserted: 0, skipped: 0, failed: 0 };
  }

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  const dedupedCandidates: IngestCandidate[] = [];
  const seenKeys = new Set<string>();

  for (const candidate of candidates) {
    const dedupeKey = [
      candidate.rssGuid || "",
      candidate.canonicalUrl || "",
      candidate.contentHash || "",
    ].join("|");

    if (seenKeys.has(dedupeKey)) {
      skipped += 1;
      continue;
    }

    seenKeys.add(dedupeKey);
    dedupedCandidates.push(candidate);
  }

  const rssGuids = [...new Set(dedupedCandidates.map((candidate) => candidate.rssGuid).filter(Boolean))] as string[];
  const canonicalUrls = [...new Set(dedupedCandidates.map((candidate) => candidate.canonicalUrl).filter(Boolean))] as string[];
  const contentHashes = [...new Set(dedupedCandidates.map((candidate) => candidate.contentHash).filter(Boolean))] as string[];

  const existingArticles =
    rssGuids.length || canonicalUrls.length || contentHashes.length
      ? await prisma.article.findMany({
          where: {
            OR: [
              rssGuids.length ? { rssGuid: { in: rssGuids } } : undefined,
              canonicalUrls.length ? { canonicalUrl: { in: canonicalUrls } } : undefined,
              contentHashes.length ? { contentHash: { in: contentHashes } } : undefined,
            ].filter(Boolean) as any,
          },
          select: {
            rssGuid: true,
            canonicalUrl: true,
            contentHash: true,
          },
        })
      : [];

  const existingRssGuids = new Set(existingArticles.map((article) => article.rssGuid).filter(Boolean));
  const existingCanonicalUrls = new Set(existingArticles.map((article) => article.canonicalUrl).filter(Boolean));
  const existingContentHashes = new Set(existingArticles.map((article) => article.contentHash).filter(Boolean));

  const newCandidates = dedupedCandidates.filter((candidate) => {
    const isDuplicate =
      (candidate.rssGuid && existingRssGuids.has(candidate.rssGuid)) ||
      (candidate.canonicalUrl && existingCanonicalUrls.has(candidate.canonicalUrl)) ||
      (candidate.contentHash && existingContentHashes.has(candidate.contentHash));

    if (isDuplicate) {
      skipped += 1;
      return false;
    }

    return true;
  });

  if (newCandidates.length === 0) {
    return { inserted, skipped, failed };
  }

  try {
    const result = await prisma.article.createMany({
      data: newCandidates.map((candidate) => ({
        title: candidate.title,
        sourceId: candidate.sourceId,
        categoryId: candidate.categoryId,
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
      })),
      skipDuplicates: true,
    });
    inserted += result.count;
    skipped += newCandidates.length - result.count;
  } catch (error: any) {
    failed = newCandidates.length;
    const prismaErrorDetails = formatPrismaError(error);
    const sources = [...new Set(newCandidates.map((candidate) => candidate.sourceId))];
    await Promise.all(
      sources.map((sourceId) =>
        logAgentScan({
          sourceId,
          status: "ARTICLE_INSERT_FAILED",
          executionTimeMs: 0,
          errorLog: `Batch insert failed for ${newCandidates.length} article(s). ${prismaErrorDetails}`,
        }),
      ),
    );
  }

  return { inserted, skipped, failed };
}
