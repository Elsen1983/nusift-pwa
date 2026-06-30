import { describe, it, expect } from "vitest";
import { parseFeedXml } from "./rss-parser";
import { normalizeCanonicalUrl } from "./rss-url";

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test</title>
    <item>
      <title>First Story</title>
      <link>https://example.com/news/first?utm_source=x</link>
      <guid>guid-1</guid>
      <pubDate>Mon, 30 Jun 2026 10:00:00 GMT</pubDate>
      <description>Summary text</description>
    </item>
  </channel>
</rss>`;

describe("parseFeedXml", () => {
  it("parses RSS items", () => {
    const items = parseFeedXml(RSS_FIXTURE, "https://example.com/feed.xml");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("First Story");
    expect(items[0]?.link).toBe("https://example.com/news/first?utm_source=x");
    expect(items[0]?.summary).toBe("Summary text");
  });
});

describe("normalizeCanonicalUrl", () => {
  it("strips tracking params and www", () => {
    expect(
      normalizeCanonicalUrl("https://www.Example.com/path/?utm_source=x"),
    ).toBe("https://example.com/path");
  });
});