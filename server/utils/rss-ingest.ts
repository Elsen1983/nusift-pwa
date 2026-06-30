import { IngestStatus, RssStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { parseFeedXml, type ParsedFeedItem } from "./rss-parser";
import { normalizeCanonicalUrl } from "./rss-url";
import { safeFetch, SSRFError } from "./ssrf-guard";

export interface FeedTarget {
  feedUrl: string;
  sourceId: string;
  categoryId?: string | null;
}

export interface PollFeedResult {
  items: ParsedFeedItem[];
  etag?: string | null;
  lastModified?: string | null;
}

export interface IngestStats {
  sourcesTried: number;
  articlesNew: number;
  articlesSkipped: number;
  errors: number;
  errorLines: string[];
}

export async function pollFeed(
  feedUrl: string,
  cursor?: { etag?: string | null; lastModified?: string | null },
): Promise<PollFeedResult> {
  const headers: Record<string, string> = {
    "User-Agent": "NuSift/1.0 RSS-Ingest",
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
  };
  if (cursor?.etag) headers["If-None-Match"] = cursor.etag;
  if (cursor?.lastModified) headers["If-Modified-Since"] = cursor.lastModified;

  const response = await safeFetch(feedUrl, { headers });

  if (response.status === 304) {
    return { items: [], etag: cursor?.etag, lastModified: cursor?.lastModified };
  }

  if (!response.ok) {
    throw new Error(`Feed HTTP ${response.status}`);
  }

  const xml = await response.text();
  return {
    items: parseFeedXml(xml, feedUrl),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

export async function upsertFeedArticles(
  target: FeedTarget,
  items: ParsedFeedItem[],
  since?: Date,
): Promise<{ newCount: number; skippedCount: number }> {
  let newCount = 0;
  let skippedCount = 0;

  const sorted = [...items].sort(
    (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
  );

  for (const item of sorted) {
    if (since && item.publishedAt < since) continue;

    let canonicalUrl: string;
    try {
      canonicalUrl = normalizeCanonicalUrl(item.link);
    } catch {
      skippedCount += 1;
      continue;
    }

    const existing = await prisma.article.findUnique({
      where: { canonicalUrl },
      select: { id: true },
    });
    if (existing) {
      skippedCount += 1;
      continue;
    }

    await prisma.article.create({
      data: {
        title: item.title.slice(0, 500),
        canonicalUrl,
        guid: item.guid?.slice(0, 500),
        summary: item.summary?.slice(0, 4000),
        author: item.author?.slice(0, 200),
        imageUrl: item.imageUrl?.slice(0, 2000),
        sourceId: target.sourceId,
        categoryId: target.categoryId ?? null,
        date: item.publishedAt,
        isPaywall: false,
        ingestStatus: IngestStatus.NEEDS_RANKING,
        tags: [],
        signals: [],
        reasoning: null,
        score: 5,
      },
    });
    newCount += 1;
  }

  return { newCount, skippedCount };
}

export async function listActiveFeedTargets(limit = 100): Promise<FeedTarget[]> {
  const targets: FeedTarget[] = [];

  const roots = await prisma.newsSource.findMany({
    where: {
      rssStatus: RssStatus.ACTIVE,
      rssFeedUrl: { not: null },
    },
    take: limit,
    select: { id: true, rssFeedUrl: true },
  });

  for (const root of roots) {
    if (root.rssFeedUrl) {
      targets.push({ feedUrl: root.rssFeedUrl, sourceId: root.id });
    }
  }

  const categories = await prisma.sourceCategory.findMany({
    where: {
      rssStatus: RssStatus.ACTIVE,
      rssFeedUrl: { not: null },
    },
    take: limit,
    select: { id: true, rssFeedUrl: true, newsSourceId: true },
  });

  for (const category of categories) {
    if (category.rssFeedUrl) {
      targets.push({
        feedUrl: category.rssFeedUrl,
        sourceId: category.newsSourceId,
        categoryId: category.id,
      });
    }
  }

  return targets;
}

export async function ingestActiveFeeds(options?: {
  limit?: number;
  lookbackHours?: number;
}): Promise<IngestStats> {
  const limit = options?.limit ?? 50;
  const lookbackHours = options?.lookbackHours ?? 72;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const stats: IngestStats = {
    sourcesTried: 0,
    articlesNew: 0,
    articlesSkipped: 0,
    errors: 0,
    errorLines: [],
  };

  const targets = await listActiveFeedTargets(limit);

  for (const target of targets) {
    stats.sourcesTried += 1;
    const cursor = await prisma.feedItemCursor.findUnique({
      where: { feedUrl: target.feedUrl },
    });

    try {
      const polled = await pollFeed(target.feedUrl, cursor ?? undefined);
      const { newCount, skippedCount } = await upsertFeedArticles(
        target,
        polled.items,
        since,
      );

      stats.articlesNew += newCount;
      stats.articlesSkipped += skippedCount;

      const latestDate = polled.items.reduce<Date | null>((max, item) => {
        if (!max || item.publishedAt > max) return item.publishedAt;
        return max;
      }, null);

      await prisma.feedItemCursor.upsert({
        where: { feedUrl: target.feedUrl },
        create: {
          feedUrl: target.feedUrl,
          sourceId: target.sourceId,
          categoryId: target.categoryId ?? null,
          lastFetchedAt: new Date(),
          lastItemDate: latestDate,
          etag: polled.etag,
          lastModified: polled.lastModified,
        },
        update: {
          lastFetchedAt: new Date(),
          lastItemDate: latestDate ?? undefined,
          etag: polled.etag ?? undefined,
          lastModified: polled.lastModified ?? undefined,
        },
      });

      await prisma.newsSource.update({
        where: { id: target.sourceId },
        data: { lastRssCheckAt: new Date() },
      }).catch(() => null);
    } catch (error: any) {
      stats.errors += 1;
      const message = error instanceof SSRFError
        ? `SSRF blocked ${target.feedUrl}`
        : `${target.feedUrl}: ${error?.message ?? error}`;
      stats.errorLines.push(message);

      const retryAt = new Date(Date.now() + 60 * 60 * 1000);
      await prisma.newsSource.update({
        where: { id: target.sourceId },
        data: { nextRetryAt: retryAt, lastRssCheckAt: new Date() },
      }).catch(() => null);
    }
  }

  return stats;
}