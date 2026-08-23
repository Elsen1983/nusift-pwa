import { describe, expect, it } from "vitest";
import {
  assessFeedPublisherCompatibility,
  getPublisherDomain,
  isSamePublisherDomain,
} from "./publisher-domain";

describe("publisher domain policy", () => {
  it("normalizes www and sibling feed subdomains to one publisher domain", () => {
    expect(getPublisherDomain("https://www.example.com/news")).toBe("example.com");
    expect(isSamePublisherDomain(
      "https://news.example.com/category/local",
      "https://feeds.example.com/local.xml",
    )).toBe(true);
    expect(isSamePublisherDomain(
      "https://bignewsnetwork.com/category/arizona-news",
      "https://feeds.bignewsnetwork.com/category/example-feed-id",
    )).toBe(true);
  });

  it("uses the public suffix list for multi-label suffixes", () => {
    expect(getPublisherDomain("https://news.publisher.co.uk/latest")).toBe("publisher.co.uk");
    expect(isSamePublisherDomain(
      "https://news.publisher.co.uk/latest",
      "https://feeds.publisher.co.uk/rss.xml",
    )).toBe(true);
    expect(isSamePublisherDomain("https://foo.co.uk", "https://bar.co.uk/feed")).toBe(false);
  });

  it("keeps private-suffix tenants isolated", () => {
    expect(isSamePublisherDomain("https://alice.github.io", "https://bob.github.io/feed.xml")).toBe(false);
  });

  it("rejects unrelated, malformed, non-HTTP, and IP-literal URLs", () => {
    expect(isSamePublisherDomain("https://example.com", "https://example.net/feed")).toBe(false);
    expect(isSamePublisherDomain("not-a-url", "https://example.com/feed")).toBe(false);
    expect(isSamePublisherDomain("ftp://example.com", "https://example.com/feed")).toBe(false);
    expect(isSamePublisherDomain("http://127.0.0.1", "http://127.0.0.1/feed")).toBe(false);
  });

  it("accepts a separate feed publisher domain when verified entries belong to the target", () => {
    expect(assessFeedPublisherCompatibility({
      feedUrl: "https://feeds.skynews.com/feeds/rss/technology.xml",
      targetUrl: "https://news.sky.com/science-climate-tech",
      entryUrls: [
        "https://news.sky.com/story/first-article-123",
        "https://news.sky.com/story/second-article-456",
      ],
    })).toMatchObject({
      allowed: true,
      reason: "verified_entry_domain",
      feedDomain: "skynews.com",
      targetDomain: "sky.com",
      matchingEntryCount: 2,
      foreignEntryCount: 0,
    });
  });

  it("accepts explicitly configured multi-domain publishers with matching entry evidence", () => {
    expect(assessFeedPublisherCompatibility({
      feedUrl: "https://feeds.bbci.co.uk/news/technology/rss.xml",
      targetUrl: "https://www.bbc.com/technology",
      entryUrls: [
        "https://www.bbc.co.uk/news/articles/first",
        "https://www.bbc.com/news/articles/second",
      ],
    })).toMatchObject({
      allowed: true,
      reason: "verified_domain_group",
      feedDomain: "bbci.co.uk",
      targetDomain: "bbc.com",
      matchingEntryCount: 2,
      foreignEntryCount: 0,
    });
  });

  it("rejects foreign entries even when feed and target are configured aliases", () => {
    expect(assessFeedPublisherCompatibility({
      feedUrl: "https://feeds.bbci.co.uk/news/technology/rss.xml",
      targetUrl: "https://www.bbc.com/technology",
      entryUrls: [
        "https://www.bbc.co.uk/news/articles/first",
        "https://unrelated.example.org/article/second",
      ],
    })).toMatchObject({
      allowed: false,
      reason: "entry_domain_mismatch",
      matchingEntryCount: 1,
      foreignEntryCount: 1,
    });
  });

  it("rejects an external feed without target-domain evidence or with foreign entries", () => {
    expect(assessFeedPublisherCompatibility({
      feedUrl: "https://feeds.example.net/rss.xml",
      targetUrl: "https://news.example.com/tech",
      entryUrls: [],
    }).reason).toBe("missing_entry_evidence");

    expect(assessFeedPublisherCompatibility({
      feedUrl: "https://feeds.example.net/rss.xml",
      targetUrl: "https://news.example.com/tech",
      entryUrls: [
        "https://news.example.com/article/1",
        "https://unrelated.example.org/article/2",
      ],
    })).toMatchObject({
      allowed: false,
      reason: "entry_domain_mismatch",
      matchingEntryCount: 1,
      foreignEntryCount: 1,
    });
  });
});
