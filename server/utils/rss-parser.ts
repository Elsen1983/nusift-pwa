import { XMLParser } from "fast-xml-parser";

export interface ParsedFeedItem {
  title: string;
  link: string;
  guid?: string;
  publishedAt: Date;
  summary?: string;
  author?: string;
  imageUrl?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseDate(raw: unknown): Date {
  if (!raw || typeof raw !== "string") return new Date();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object" && "#text" in value) {
    const text = (value as Record<string, unknown>)["#text"];
    return typeof text === "string" ? text.trim() || undefined : undefined;
  }
  return undefined;
}

function resolveLink(link: unknown, baseUrl?: string): string | undefined {
  const href = textOf(link) ?? (typeof link === "object" && link && "@_href" in link
    ? String((link as Record<string, unknown>)["@_href"])
    : undefined);
  if (!href) return undefined;
  try {
    return baseUrl ? new URL(href, baseUrl).toString() : new URL(href).toString();
  } catch {
    return undefined;
  }
}

function parseRssItems(channel: Record<string, unknown>, feedUrl: string): ParsedFeedItem[] {
  return asArray(channel.item).map((item) => {
    const record = item as Record<string, unknown>;
    const link = resolveLink(record.link, feedUrl);
    if (!link) return null;
    const title = textOf(record.title) ?? "Untitled";
    return {
      title,
      link,
      guid: textOf(record.guid) ?? link,
      publishedAt: parseDate(textOf(record.pubDate)),
      summary: textOf(record.description),
      author: textOf(record.author) ?? textOf(record["dc:creator"]),
    } satisfies ParsedFeedItem;
  }).filter((item): item is ParsedFeedItem => item !== null);
}

function parseAtomEntries(feed: Record<string, unknown>, feedUrl: string): ParsedFeedItem[] {
  return asArray(feed.entry).map((entry) => {
    const record = entry as Record<string, unknown>;
    const link =
      resolveLink(
        asArray(record.link).find((l) => {
          const rel = (l as Record<string, unknown>)["@_rel"];
          return !rel || rel === "alternate";
        }) ?? record.link,
        feedUrl,
      ) ?? resolveLink(record.id, feedUrl);
    if (!link) return null;
    const title = textOf(record.title) ?? "Untitled";
    return {
      title,
      link,
      guid: textOf(record.id) ?? link,
      publishedAt: parseDate(textOf(record.updated) ?? textOf(record.published)),
      summary: textOf(record.summary) ?? textOf(record.content),
      author: textOf((record.author as Record<string, unknown> | undefined)?.name),
    } satisfies ParsedFeedItem;
  }).filter((item): item is ParsedFeedItem => item !== null);
}

export function parseFeedXml(xml: string, feedUrl: string): ParsedFeedItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  if (doc.rss && typeof doc.rss === "object") {
    const channel = (doc.rss as Record<string, unknown>).channel as Record<string, unknown>;
    return parseRssItems(channel, feedUrl);
  }
  if (doc.feed && typeof doc.feed === "object") {
    return parseAtomEntries(doc.feed as Record<string, unknown>, feedUrl);
  }
  return [];
}