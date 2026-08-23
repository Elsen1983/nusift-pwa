import { describe, expect, it } from "vitest";
import { buildFeedUrlCandidates, extractVerifiedFeedEntryUrls } from "./import-rss";

describe("buildFeedUrlCandidates", () => {
  it("adds bounded working RTE root-feed recoveries after the configured feed", () => {
    expect(buildFeedUrlCandidates("https://rte.ie/?service=rss", "https://rte.ie")).toEqual([
      "https://rte.ie/?service=rss",
      "https://www.rte.ie/feeds/rss/?index=/news/",
      "https://www.rte.ie/feeds/rss/?index=/news/world/",
    ]);
  });

  it("does not add RTE-specific feeds for other publishers", () => {
    expect(buildFeedUrlCandidates(null, "https://example.test")).toEqual([
      "https://example.test/?service=rss",
    ]);
  });
});

describe("extractVerifiedFeedEntryUrls", () => {
  it("extracts bounded RSS and Atom article links and resolves relative URLs", () => {
    const body = `
      <rss><channel>
        <item><link><![CDATA[https://news.sky.com/story/first?x=1&amp;y=2]]></link></item>
        <item><link>/story/second</link></item>
      </channel></rss>
      <feed><entry><link href="https://news.sky.com/story/third" /></entry></feed>
    `;

    expect(extractVerifiedFeedEntryUrls(
      body,
      "https://feeds.skynews.com/feeds/rss/technology.xml",
      2,
    )).toEqual([
      "https://news.sky.com/story/first?x=1&y=2",
      "https://feeds.skynews.com/story/second",
    ]);
  });

  it("ignores non-HTTP and malformed entry links", () => {
    expect(extractVerifiedFeedEntryUrls(
      "<rss><item><link>javascript:alert(1)</link></item><item><link>http://[::1</link></item></rss>",
      "https://feeds.example.com/rss.xml",
    )).toEqual([]);
  });
});
