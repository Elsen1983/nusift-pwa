import { beforeEach, describe, expect, it, vi } from "vitest";

const safeFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../ssrf-guard", () => ({
  safeFetch: safeFetchMock,
}));

const makeResponse = (body: string, ok = true) => ({
  ok,
  text: async () => body,
});

describe("article-discovery-helpers", () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  // ── Sitemap Discovery ──────────────────────────────────────────────────

  describe("discoverSitemapUrls", () => {
    it("extracts URLs from a plain sitemap.xml", async () => {
      const { discoverSitemapUrls } = await import("./article-discovery-helpers");

      const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/news/2026/07/16/alpha-story</loc><lastmod>2026-07-16</lastmod></url>
          <url><loc>https://example.com/news/2026/07/15/bravo-story</loc><lastmod>2026-07-15</lastmod></url>
        </urlset>`;

      safeFetchMock.mockImplementation(async (url: string) => {
        if (url === "https://example.com/sitemap.xml") return makeResponse(sitemapXml);
        return makeResponse("", false);
      });

      const entries = await discoverSitemapUrls("https://example.com/");
      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(entries[0]?.url).toBe("https://example.com/news/2026/07/16/alpha-story");
      expect(entries[0]?.lastmod).toBe("2026-07-16");
    });

    it("follows sitemap index to child sitemaps", async () => {
      const { discoverSitemapUrls } = await import("./article-discovery-helpers");

      const sitemapIndex = `<?xml version="1.0"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
        </sitemapindex>`;

      const childSitemap = `<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/news/2026/07/16/child-story</loc></url>
        </urlset>`;

      safeFetchMock.mockImplementation(async (url: string) => {
        if (url === "https://example.com/sitemap.xml") return makeResponse(sitemapIndex);
        if (url === "https://example.com/sitemap-posts.xml") return makeResponse(childSitemap);
        return makeResponse("", false);
      });

      const entries = await discoverSitemapUrls("https://example.com/");
      expect(entries.some((e) => e.url.includes("child-story"))).toBe(true);
    });

    it("discovers sitemap references from robots.txt", async () => {
      const { discoverSitemapUrls } = await import("./article-discovery-helpers");

      const robotsTxt = "User-agent: *\nSitemap: https://example.com/custom-sitemap.xml";
      const customSitemap = `<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/news/robot-discovered</loc></url>
        </urlset>`;

      safeFetchMock.mockImplementation(async (url: string) => {
        if (url === "https://example.com/robots.txt") return makeResponse(robotsTxt);
        if (url === "https://example.com/custom-sitemap.xml") return makeResponse(customSitemap);
        if (url === "https://example.com/sitemap.xml") return makeResponse("", false);
        return makeResponse("", false);
      });

      const entries = await discoverSitemapUrls("https://example.com/");
      expect(entries.some((e) => e.url.includes("robot-discovered"))).toBe(true);
    });

    it("handles missing sitemaps gracefully", async () => {
      const { discoverSitemapUrls } = await import("./article-discovery-helpers");

      safeFetchMock.mockResolvedValue(makeResponse("", false));

      const entries = await discoverSitemapUrls("https://example.com/");
      expect(entries).toEqual([]);
    });

    it("respects same-domain policy when combined with filterSitemapArticleUrls", async () => {
      const { discoverSitemapUrls, filterSitemapArticleUrls } = await import("./article-discovery-helpers");

      const sitemapXml = `<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://evil.com/news/2026/07/16/hijack</loc></url>
          <url><loc>https://example.com/news/2026/07/16/real-story</loc></url>
        </urlset>`;

      safeFetchMock.mockImplementation(async (url: string) => {
        if (url === "https://example.com/sitemap.xml") return makeResponse(sitemapXml);
        return makeResponse("", false);
      });

      const entries = await discoverSitemapUrls("https://example.com/");
      const filtered = filterSitemapArticleUrls(entries, "https://example.com/");
      expect(filtered.some((e) => e.url.includes("evil.com"))).toBe(false);
      expect(filtered.some((e) => e.url.includes("real-story"))).toBe(true);
    });
  });

  describe("filterSitemapArticleUrls", () => {
    it("keeps article-like URLs and rejects utility pages", async () => {
      const { filterSitemapArticleUrls } = await import("./article-discovery-helpers");

      const entries = [
        { url: "https://example.com/news/2026/07/16/alpha-story" },
        { url: "https://example.com/about" },
        { url: "https://example.com/contact" },
        { url: "https://example.com/news/2026/07/15/bravo-story" },
        { url: "https://example.com/tag/politics" },
        { url: "https://example.com/feed" },
      ];

      const filtered = filterSitemapArticleUrls(entries, "https://example.com/");
      expect(filtered).toHaveLength(2);
      expect(filtered[0]?.url).toContain("alpha-story");
      expect(filtered[1]?.url).toContain("bravo-story");
    });

    it("rejects cross-domain URLs", async () => {
      const { filterSitemapArticleUrls } = await import("./article-discovery-helpers");

      const entries = [
        { url: "https://evil.com/news/2026/07/16/hijack" },
        { url: "https://example.com/news/2026/07/16/real-story" },
      ];

      const filtered = filterSitemapArticleUrls(entries, "https://example.com/");
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.url).toContain("real-story");
    });

    it("keeps matching and rejects non-matching URLs when categoryPathUrl is provided", async () => {
      const { filterSitemapArticleUrls } = await import("./article-discovery-helpers");

      const entries = [
        { url: "https://example.com/sports/2026/07/16/match-report" },
        { url: "https://example.com/sports/2026/07/15/transfer-news" },
        { url: "https://example.com/tech/2026/07/16/gadget-review" },
        { url: "https://example.com/politics/2026/07/16/election-update" },
      ];

      const filtered = filterSitemapArticleUrls(
        entries,
        "https://example.com/",
        "https://example.com/sports",
      );

      expect(filtered).toHaveLength(2);
      expect(filtered[0]?.url).toContain("match-report");
      expect(filtered[1]?.url).toContain("transfer-news");
    });

    it("includes category root itself when categoryPathUrl matches", async () => {
      const { filterSitemapArticleUrls } = await import("./article-discovery-helpers");

      // A sitemap entry that IS the category path with an article-like slug would
      // only pass if the path itself is long enough. This tests the equality check.
      const entries = [
        { url: "https://example.com/sports/2026/07/16/match-report" },
        { url: "https://example.com/entertainment/2026/07/16/review" },
      ];

      const filtered = filterSitemapArticleUrls(
        entries,
        "https://example.com/",
        "https://example.com/sports/2026/07/16/match-report",
      );

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.url).toContain("match-report");
    });

    it("behaves identically to no-categoryPathUrl when categoryPathUrl is null", async () => {
      const { filterSitemapArticleUrls } = await import("./article-discovery-helpers");

      const entries = [
        { url: "https://example.com/sports/2026/07/16/match-report" },
        { url: "https://example.com/tech/2026/07/16/gadget-review" },
      ];

      const withoutCategory = filterSitemapArticleUrls(entries, "https://example.com/");
      const withNull = filterSitemapArticleUrls(entries, "https://example.com/", null);

      expect(withoutCategory).toEqual(withNull);
    });
  });

  // ── JSON-LD Extraction ────────────────────────────────────────────────

  describe("extractJsonLdArticles", () => {
    it("extracts NewsArticle from JSON-LD script blocks", async () => {
      const { extractJsonLdArticles } = await import("./article-discovery-helpers");

      const html = `
        <html><head>
          <script type="application/ld+json">
            {
              "@type": "NewsArticle",
              "url": "/news/2026/07/16/structured-story",
              "headline": "Breaking: Important Event",
              "datePublished": "2026-07-16T09:00:00Z",
              "description": "A structured data article"
            }
          </script>
        </head></html>`;

      const articles = extractJsonLdArticles(html, "https://example.com/");
      expect(articles).toHaveLength(1);
      expect(articles[0]?.url).toBe("https://example.com/news/2026/07/16/structured-story");
      expect(articles[0]?.headline).toBe("Breaking: Important Event");
      expect(articles[0]?.datePublished).toBe("2026-07-16T09:00:00Z");
      expect(articles[0]?.type).toBe("NewsArticle");
    });

    it("handles @graph arrays", async () => {
      const { extractJsonLdArticles } = await import("./article-discovery-helpers");

      const html = `
        <script type="application/ld+json">
          {
            "@graph": [
              { "@type": "WebSite", "url": "https://example.com/" },
              {
                "@type": "Article",
                "url": "https://example.com/news/graph-article",
                "headline": "Graph Article"
              }
            ]
          }
        </script>`;

      const articles = extractJsonLdArticles(html, "https://example.com/");
      expect(articles).toHaveLength(1);
      expect(articles[0]?.url).toBe("https://example.com/news/graph-article");
    });

    it("handles schema: namespace prefix", async () => {
      const { extractJsonLdArticles } = await import("./article-discovery-helpers");

      const html = `
        <script type="application/ld+json">
          { "@type": "schema:BlogPosting", "url": "/blog/namespaced", "headline": "Blog Post" }
        </script>`;

      const articles = extractJsonLdArticles(html, "https://example.com/");
      expect(articles).toHaveLength(1);
      expect(articles[0]?.type).toBe("BlogPosting");
    });

    it("skips non-article types like Organization", async () => {
      const { extractJsonLdArticles } = await import("./article-discovery-helpers");

      const html = `
        <script type="application/ld+json">
          { "@type": "Organization", "url": "https://example.com/", "name": "Example" }
        </script>`;

      const articles = extractJsonLdArticles(html, "https://example.com/");
      expect(articles).toHaveLength(0);
    });

    it("handles malformed JSON gracefully", async () => {
      const { extractJsonLdArticles } = await import("./article-discovery-helpers");

      const html = `
        <script type="application/ld+json">
          { this is not valid json
        </script>`;

      const articles = extractJsonLdArticles(html, "https://example.com/");
      expect(articles).toEqual([]);
    });

    it("resolves relative URLs against pageUrl", async () => {
      const { extractJsonLdArticles } = await import("./article-discovery-helpers");

      const html = `
        <script type="application/ld+json">
          { "@type": "Article", "url": "/relative/path", "headline": "Relative" }
        </script>`;

      const articles = extractJsonLdArticles(html, "https://example.com/page");
      expect(articles[0]?.url).toBe("https://example.com/relative/path");
    });
  });

  // ── Outcome Tracker ──────────────────────────────────────────────────

  describe("ArticleDiscoveryOutcomeTracker", () => {
    it("records accepted outcomes", async () => {
      const { ArticleDiscoveryOutcomeTracker } = await import("./article-discovery-helpers");
      const tracker = new ArticleDiscoveryOutcomeTracker();

      tracker.record({ url: "https://example.com/a", sourceKind: "listing", status: "accepted", score: 80 });
      tracker.record({ url: "https://example.com/b", sourceKind: "sitemap", status: "accepted", score: 70 });

      const summary = tracker.getSummary();
      expect(summary.accepted).toBe(2);
      expect(summary.rejected).toBe(0);
      expect(summary.totalEvaluated).toBe(2);
      expect(tracker.getAccepted()).toHaveLength(2);
    });

    it("records rejected outcomes with cap", async () => {
      const { ArticleDiscoveryOutcomeTracker } = await import("./article-discovery-helpers");
      const tracker = new ArticleDiscoveryOutcomeTracker();

      // Record more than 100 rejected outcomes
      for (let i = 0; i < 150; i++) {
        tracker.record({ url: `https://example.com/${i}`, sourceKind: "sitemap", status: "rejected_low_score", score: 10 });
      }

      const summary = tracker.getSummary();
      expect(summary.rejected).toBe(150);
      // But stored rejected outcomes are capped at 100
      expect(tracker.getRejected()).toHaveLength(100);
      // Summary still tracks full counts
      expect(summary.byStatus["rejected_low_score"]).toBe(150);
    });

    it("tracks outcomes by source kind", async () => {
      const { ArticleDiscoveryOutcomeTracker } = await import("./article-discovery-helpers");
      const tracker = new ArticleDiscoveryOutcomeTracker();

      tracker.record({ url: "a", sourceKind: "listing", status: "accepted" });
      tracker.record({ url: "b", sourceKind: "sitemap", status: "rejected_low_score" });
      tracker.record({ url: "c", sourceKind: "jsonld", status: "accepted" });

      const summary = tracker.getSummary();
      expect(summary.bySourceKind["listing"]).toBe(1);
      expect(summary.bySourceKind["sitemap"]).toBe(1);
      expect(summary.bySourceKind["jsonld"]).toBe(1);
    });

    it("computes top rejection reasons", async () => {
      const { ArticleDiscoveryOutcomeTracker } = await import("./article-discovery-helpers");
      const tracker = new ArticleDiscoveryOutcomeTracker();

      for (let i = 0; i < 10; i++) tracker.record({ url: `a${i}`, sourceKind: "sitemap", status: "rejected_low_score", reason: "low_score" });
      for (let i = 0; i < 5; i++) tracker.record({ url: `b${i}`, sourceKind: "listing", status: "rejected_stale", reason: "stale" });
      tracker.record({ url: "c", sourceKind: "jsonld", status: "accepted" });

      const summary = tracker.getSummary();
      expect(summary.topRejectionReasons[0]?.reason).toBe("low_score");
      expect(summary.topRejectionReasons[0]?.count).toBe(10);
      expect(summary.topRejectionReasons[1]?.reason).toBe("stale");
      expect(summary.topRejectionReasons[1]?.count).toBe(5);
    });
  });

  // ── Quality Classification ─────────────────────────────────────────────

  describe("assessArticleDiscoveryQuality", () => {
    it("classifies productive when candidates are found with reasonable acceptance rate", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 5,
        totalEvaluated: 20,
        pagesVisited: 2,
        failed: 0,
        byStatus: { accepted: 5, rejected_low_score: 10, rejected_stale: 3, rejected_missing_title: 2 },
      });

      expect(result.quality).toBe("productive");
      expect(result.shouldEscalateToHeadless).toBe(false);
      expect(result.confidence).toBe("high");
      expect(result.explanation).toContain("5 article(s)");
      expect(result.explanation).toContain("25%");
    });

    it("classifies productive with high confidence when many candidates found", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 3,
        totalEvaluated: 10,
        pagesVisited: 1,
        failed: 0,
        byStatus: { accepted: 3, rejected_low_score: 5, rejected_stale: 2 },
      });

      expect(result.quality).toBe("productive");
      expect(result.confidence).toBe("high");
    });

    it("classifies failed when zero candidates are accepted but URLs were evaluated", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 0,
        totalEvaluated: 10,
        pagesVisited: 2,
        failed: 1,
        byStatus: { rejected_low_score: 6, rejected_stale: 3, rejected_missing_title: 1 },
      });

      expect(result.quality).toBe("failed");
      expect(result.shouldEscalateToHeadless).toBe(true);
      expect(result.escalationReasons).toContain("no_candidates");
      expect(result.explanation).toContain("10 URL(s) were evaluated");
    });

    it("classifies blocked when fetch failures dominate", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 0,
        totalEvaluated: 10,
        pagesVisited: 1,
        failed: 1,
        byStatus: { fetch_failed: 8, rejected_low_score: 2 },
      });

      expect(result.quality).toBe("blocked");
      expect(result.shouldEscalateToHeadless).toBe(true);
      expect(result.escalationReasons).toContain("blocked_or_forbidden");
      expect(result.escalationReasons).toContain("mostly_fetch_failed");
      expect(result.confidence).toBe("high");
    });

    it("classifies weak when accepted > 0 but fetch failures dominate", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      // 1 accepted, 20 fetch_failed out of 21 → fetchRate=95% >= 60%
      // accepted > 0 → weak (not blocked)
      const result = assessArticleDiscoveryQuality({
        acceptedCount: 1,
        totalEvaluated: 21,
        pagesVisited: 1,
        failed: 0,
        byStatus: { accepted: 1, fetch_failed: 20 },
      });

      expect(result.quality).toBe("weak");
      expect(result.shouldEscalateToHeadless).toBe(true);
      expect(result.escalationReasons).toContain("mostly_fetch_failed");
      expect(result.escalationReasons).toContain("insufficient_static_signals");
      expect(result.confidence).toBe("medium");
      expect(result.explanation).toContain("found 1 article(s)");
      expect(result.explanation).toContain("20/21 fetches failed");
    });

    it("classifies weak when acceptance rate is very low", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      // 1 accepted out of 30 = 3.3% — below 5% threshold
      const result = assessArticleDiscoveryQuality({
        acceptedCount: 1,
        totalEvaluated: 30,
        pagesVisited: 3,
        failed: 0,
        byStatus: { accepted: 1, rejected_low_score: 20, rejected_stale: 5, rejected_missing_title: 4 },
      });

      expect(result.quality).toBe("weak");
      expect(result.shouldEscalateToHeadless).toBe(true);
      expect(result.escalationReasons).toContain("low_acceptance_rate");
    });

    it("classifies weak without escalation when acceptance rate is moderate", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      // 2 accepted out of 25 = 8% — between 5% and 10%
      const result = assessArticleDiscoveryQuality({
        acceptedCount: 2,
        totalEvaluated: 25,
        pagesVisited: 2,
        failed: 0,
        byStatus: { accepted: 2, rejected_low_score: 15, rejected_stale: 5, rejected_missing_title: 3 },
      });

      expect(result.quality).toBe("weak");
      expect(result.shouldEscalateToHeadless).toBe(false);
    });

    it("classifies failed with dynamic_or_empty_html when no URLs evaluated and no pages visited", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 0,
        totalEvaluated: 0,
        pagesVisited: 0,
        failed: 1,
        byStatus: {},
      });

      expect(result.quality).toBe("failed");
      expect(result.shouldEscalateToHeadless).toBe(true);
      expect(result.escalationReasons).toContain("dynamic_or_empty_html");
      expect(result.confidence).toBe("medium");
    });

    it("classifies failed with dynamic_or_empty_html when pages visited but no URLs evaluated", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 0,
        totalEvaluated: 0,
        pagesVisited: 2,
        failed: 1,
        byStatus: {},
      });

      expect(result.quality).toBe("failed");
      expect(result.shouldEscalateToHeadless).toBe(true);
      expect(result.escalationReasons).toContain("dynamic_or_empty_html");
      expect(result.confidence).toBe("high");
      expect(result.explanation).toContain("2 listing page(s)");
    });

    it("classifies failed with mostly_low_score when low-score rejections dominate", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 0,
        totalEvaluated: 10,
        pagesVisited: 1,
        failed: 1,
        byStatus: { rejected_low_score: 9, rejected_stale: 1 },
      });

      expect(result.quality).toBe("failed");
      expect(result.shouldEscalateToHeadless).toBe(true);
      expect(result.escalationReasons).toContain("mostly_low_score");
      expect(result.escalationReasons).toContain("insufficient_static_signals");
    });

    it("gives productive medium confidence for single accepted candidate", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      // 1 accepted out of 5 = 20% (strong rate) but only 1 candidate → medium
      const result = assessArticleDiscoveryQuality({
        acceptedCount: 1,
        totalEvaluated: 5,
        pagesVisited: 1,
        failed: 0,
        byStatus: { accepted: 1, rejected_low_score: 2, rejected_stale: 2 },
      });

      expect(result.quality).toBe("productive");
      expect(result.shouldEscalateToHeadless).toBe(false);
      expect(result.confidence).toBe("medium");
    });

    it("uses 'Static discovery' as default sourceLabel in explanation", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 5,
        totalEvaluated: 20,
        pagesVisited: 2,
        failed: 0,
        byStatus: { accepted: 5, rejected_low_score: 10, rejected_stale: 3, rejected_missing_title: 2 },
      });

      expect(result.explanation).toContain("Static discovery is effective");
      expect(result.explanation).not.toContain("Browser fallback");
    });

    it("uses 'Browser fallback' as sourceLabel when passed explicitly", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 3,
        totalEvaluated: 10,
        pagesVisited: 1,
        failed: 0,
        byStatus: { accepted: 3, rejected_low_score: 5, rejected_stale: 2 },
        sourceLabel: "Browser fallback",
      });

      expect(result.quality).toBe("productive");
      expect(result.explanation).toContain("Browser fallback is effective");
      expect(result.explanation).not.toContain("Static discovery");
    });

    it("uses browser sourceLabel in failed quality explanation", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 0,
        totalEvaluated: 10,
        pagesVisited: 1,
        failed: 1,
        byStatus: { rejected_low_score: 6, rejected_stale: 3, rejected_missing_title: 1 },
        sourceLabel: "Browser fallback",
      });

      expect(result.quality).toBe("failed");
      expect(result.explanation).toContain("Browser fallback is insufficient for this target");
      expect(result.explanation).not.toContain("Static discovery");
    });

    it("uses browser sourceLabel in weak quality explanation", async () => {
      const { assessArticleDiscoveryQuality } = await import("./article-discovery-helpers");

      const result = assessArticleDiscoveryQuality({
        acceptedCount: 1,
        totalEvaluated: 30,
        pagesVisited: 3,
        failed: 0,
        byStatus: { accepted: 1, rejected_low_score: 20, rejected_stale: 5, rejected_missing_title: 4 },
        sourceLabel: "Browser fallback",
      });

      expect(result.quality).toBe("weak");
      expect(result.explanation).toContain("Browser fallback coverage may be incomplete");
      expect(result.explanation).not.toContain("Static discovery");
    });
  });

  // ── Date Extraction Provenance ─────────────────────────────────────────

  describe("extractDateFromHtml", () => {
    it("extracts article:published_time as highest priority source", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head>
        <meta property="article:published_time" content="2026-07-16T09:00:00Z" />
        <meta property="article:modified_time" content="2026-07-17T10:00:00Z" />
      </head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-16T09:00:00Z");
      expect(result.source).toBe("article:published_time");
    });

    it("falls back to article:modified_time when no publish date exists", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head>
        <meta property="article:modified_time" content="2026-07-17T10:00:00Z" />
      </head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-17T10:00:00Z");
      expect(result.source).toBe("article:modified_time");
    });

    it("falls back to og:updated_time when no publish date exists", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head>
        <meta property="og:updated_time" content="2026-07-15T08:00:00Z" />
      </head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-15T08:00:00Z");
      expect(result.source).toBe("og:updated_time");
    });

    it("extracts datePublished from JSON-LD when no meta publish tags exist", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head>
        <script type="application/ld+json">
          { "datePublished": "2026-07-14T12:00:00Z", "@type": "NewsArticle" }
        </script>
      </head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-14T12:00:00Z");
      expect(result.source).toBe("datePublished");
    });

    it("prefers og:published_time over article:modified_time", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head>
        <meta property="og:published_time" content="2026-07-20T09:00:00Z" />
        <meta property="article:modified_time" content="2020-01-15T00:00:00Z" />
      </head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-20T09:00:00Z");
      expect(result.source).toBe("og:published_time");
    });

    it("prefers JSON-LD datePublished over article:modified_time", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head>
        <meta property="article:modified_time" content="2020-01-15T00:00:00Z" />
        <script type="application/ld+json">
          { "datePublished": "2026-07-18T09:00:00Z", "@type": "NewsArticle" }
        </script>
      </head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-18T09:00:00Z");
      expect(result.source).toBe("datePublished");
    });

    it("prefers meta itemprop=datePublished over article:modified_time", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head>
        <meta property="article:modified_time" content="2020-01-15T00:00:00Z" />
        <meta itemprop="datePublished" content="2026-07-19T09:00:00Z" />
      </head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-19T09:00:00Z");
      expect(result.source).toBe("meta[itemprop=datePublished]");
    });

    it("falls back to time[datetime]", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><body><time datetime="2026-07-13">July 13</time></body></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-13");
      expect(result.source).toBe("time[datetime]");
    });

    it("falls back to meta[name=date]", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head><meta name="date" content="2026-07-12" /></head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-12");
      expect(result.source).toBe("meta[name=date]");
    });

    it("falls back to meta[itemprop=datePublished]", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head><meta itemprop="datePublished" content="2026-07-11" /></head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-11");
      expect(result.source).toBe("meta[itemprop=datePublished]");
    });

    it("falls back to URL date pattern when no HTML date found", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head><title>No date here</title></head></html>`;

      const result = extractDateFromHtml(html, "https://example.com/news/2026/07/10/some-story");
      expect(result.rawDate).toBe("2026-07-10");
      expect(result.source).toBe("url_date");
    });

    it("falls back to compact URL date only for plausible 19xx/20xx dates", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head><title>No date here</title></head></html>`;

      const result = extractDateFromHtml(html, "https://example.com/news/20260710-some-story");
      expect(result.rawDate).toBe("2026-07-10");
      expect(result.source).toBe("url_date");
    });

    it("does not treat numeric article IDs as URL dates", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head><title>No date here</title></head></html>`;

      const result = extractDateFromHtml(
        html,
        "https://www.bignewsnetwork.com/news/279204889/struggling-blue-jays-look-to-salvage-series-finale-vs-rays",
      );
      expect(result.rawDate).toBeNull();
      expect(result.source).toBe("unknown");
    });

    it("returns unknown source when no date found anywhere", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head><title>No date</title></head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBeNull();
      expect(result.source).toBe("unknown");
    });
  });

  describe("NBA-style date extraction regression", () => {
    it("prefers JSON-LD datePublished over article:modified_time for NBA-style pages", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      // NBA-style HTML: has modified_time (old, page layout change) but datePublished
      // in JSON-LD is the actual article publish date (recent).
      // No article:published_time meta tag present.
      const html = `
        <html><head>
          <meta property="og:title" content="NBA News Article" />
          <meta property="article:modified_time" content="2020-03-15T00:00:00Z" />
          <meta property="og:updated_time" content="2020-03-15T00:00:00Z" />
          <script type="application/ld+json">
            {
              "@type": "NewsArticle",
              "headline": "NBA Trade News",
              "datePublished": "2026-07-18T14:00:00Z",
              "dateModified": "2026-07-18T16:00:00Z"
            }
          </script>
        </head><body></body></html>`;

      const result = extractDateFromHtml(html, "https://www.nba.com/news/trade-story");
      // JSON-LD datePublished (recent) should win over modified_time (old)
      expect(result.rawDate).toBe("2026-07-18T14:00:00Z");
      expect(result.source).toBe("datePublished");
    });

    it("treats the extracted date as fresh when JSON-LD datePublished is recent", async () => {
      const { extractDateFromHtml, isWithinFreshnessWindow, normalizePublishedAt } = await import("./article-discovery-helpers");

      // Simulate: NBA page has old modified_time but recent JSON-LD datePublished
      const html = `
        <html><head>
          <meta property="article:modified_time" content="2020-01-01T00:00:00Z" />
          <script type="application/ld+json">
            { "@type": "NewsArticle", "datePublished": "${new Date().toISOString()}" }
          </script>
        </head></html>`;

      const extraction = extractDateFromHtml(html);
      expect(extraction.source).toBe("datePublished");

      const normalizedDate = normalizePublishedAt(new Date(extraction.rawDate!));
      expect(isWithinFreshnessWindow(normalizedDate)).toBe(true);
    });

    it("falls back to article:modified_time only when no publish date exists at all", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      // No publish-side sources at all — only modified_time
      const html = `
        <html><head>
          <meta property="article:modified_time" content="2020-01-01T00:00:00Z" />
        </head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.source).toBe("article:modified_time");
      expect(result.rawDate).toBe("2020-01-01T00:00:00Z");
    });

    it("does not use og:updated_time when og:published_time exists", async () => {
      const { extractDateFromHtml } = await import("./article-discovery-helpers");

      const html = `<html><head>
        <meta property="og:published_time" content="2026-07-20T09:00:00Z" />
        <meta property="og:updated_time" content="2020-01-01T00:00:00Z" />
      </head></html>`;

      const result = extractDateFromHtml(html);
      expect(result.rawDate).toBe("2026-07-20T09:00:00Z");
      expect(result.source).toBe("og:published_time");
    });

    it("stale audit correctly reports datePublished source for NBA-style pages", async () => {
      const { extractDateFromHtml, buildStaleAuditMeta, normalizePublishedAt } = await import("./article-discovery-helpers");

      // NBA page: old modified_time, recent datePublished in JSON-LD
      const html = `
        <html><head>
          <meta property="article:modified_time" content="2020-01-01T00:00:00Z" />
          <script type="application/ld+json">
            { "@type": "NewsArticle", "datePublished": "2026-07-18T14:00:00Z" }
          </script>
        </head></html>`;

      const extraction = extractDateFromHtml(html);
      const normalized = normalizePublishedAt(new Date(extraction.rawDate!));
      const freshnessMs = 14 * 24 * 60 * 60 * 1000;
      const now = new Date("2026-07-20T12:00:00Z");

      const audit = buildStaleAuditMeta(extraction, normalized, freshnessMs, now);
      // The datePublished is 2 days old — within 14-day window, so NOT stale
      expect(audit.staleReason).not.toBe("published_at_before_cutoff");
      expect(audit.publishedAtSource).toBe("datePublished");
      expect(audit.normalizedPublishedAt).toBe("2026-07-18T14:00:00.000Z");
    });

    it("parseable ISO date without timezone suffix is treated as valid (not invalid_published_at)", async () => {
      const { extractDateFromHtml, buildStaleAuditMeta, normalizeRawDateString } = await import("./article-discovery-helpers");

      // JSON-LD datePublished without Z suffix — common in some CMS platforms
      const html = `
        <html><head>
          <script type="application/ld+json">
            { "@type": "NewsArticle", "datePublished": "2020-06-01T10:00:00" }
          </script>
        </head></html>`;

      const extraction = extractDateFromHtml(html);
      expect(extraction.rawDate).toBe("2020-06-01T10:00:00");
      expect(extraction.source).toBe("datePublished");

      // normalizeRawDateString should handle ISO without timezone by appending Z
      const parsed = normalizeRawDateString(extraction.rawDate!);
      expect(parsed).not.toBeNull();
      expect(parsed!.toISOString()).toBe("2020-06-01T10:00:00.000Z");

      // With a valid parsed date, buildStaleAuditMeta should NOT report invalid
      const freshnessMs = 14 * 24 * 60 * 60 * 1000;
      const now = new Date("2026-07-20T12:00:00Z");
      const audit = buildStaleAuditMeta(extraction, parsed, freshnessMs, now);
      expect(audit.staleReason).not.toBe("invalid_published_at");
      // The date is old (6+ years) — well outside the 14-day window
      expect(audit.staleReason).toBe("published_at_before_cutoff");
      expect(audit.publishedAtSource).toBe("datePublished");
      expect(audit.normalizedPublishedAt).toBe("2020-06-01T10:00:00.000Z");
    });

    it("fallback date parsing closes the gap when extractPageMetadata misses JSON-LD date", async () => {
      const { extractPageMetadata, extractDateFromHtml, normalizePublishedAt, normalizeRawDateString, isWithinFreshnessWindow } = await import("./article-discovery-helpers");

      // Page with only JSON-LD datePublished — extractPageMetadata doesn't check JSON-LD
      const html = `
        <html><head>
          <title>Breaking NBA Trade News Story Here</title>
          <script type="application/ld+json">
            {
              "@type": "NewsArticle",
              "headline": "Breaking NBA Trade News Story Here",
              "datePublished": "2026-07-18T14:00:00Z"
            }
          </script>
        </head><body></body></html>`;

      // extractPageMetadata doesn't find a date (no meta tags)
      const meta = extractPageMetadata(html);
      const normalizedFromMeta = normalizePublishedAt(meta.publishedAt);
      expect(normalizedFromMeta).toBeNull();

      // extractDateFromHtml DOES find it from JSON-LD
      const dateExtraction = extractDateFromHtml(html);
      expect(dateExtraction.rawDate).toBe("2026-07-18T14:00:00Z");
      expect(dateExtraction.source).toBe("datePublished");

      // Fallback: try parsing the raw date from extractDateFromHtml
      const fallbackDate = normalizeRawDateString(dateExtraction.rawDate!);
      expect(fallbackDate).not.toBeNull();
      expect(isWithinFreshnessWindow(fallbackDate)).toBe(true);
    });
  });

  describe("extractDateFromUrl", () => {
    it("extracts YYYY/MM/DD pattern", async () => {
      const { extractDateFromUrl } = await import("./article-discovery-helpers");
      expect(extractDateFromUrl("https://example.com/news/2026/07/16/story")).toBe("2026-07-16");
    });

    it("extracts compact YYYYMMDD in slug", async () => {
      const { extractDateFromUrl } = await import("./article-discovery-helpers");
      expect(extractDateFromUrl("https://example.com/20260716/story")).toBe("2026-07-16");
    });

    it("extracts YYYY/MM pattern", async () => {
      const { extractDateFromUrl } = await import("./article-discovery-helpers");
      expect(extractDateFromUrl("https://example.com/news/2026/07/")).toBe("2026-07-01");
    });

    it("returns null for URLs without date patterns", async () => {
      const { extractDateFromUrl } = await import("./article-discovery-helpers");
      expect(extractDateFromUrl("https://example.com/news/breaking-story")).toBeNull();
    });

    it("returns null for invalid URLs", async () => {
      const { extractDateFromUrl } = await import("./article-discovery-helpers");
      expect(extractDateFromUrl("not-a-url")).toBeNull();
    });
  });

  describe("normalizeRawDateString", () => {
    it("parses standard ISO-8601 with timezone", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      const result = normalizeRawDateString("2026-07-18T14:00:00Z");
      expect(result).not.toBeNull();
      expect(result!.toISOString()).toBe("2026-07-18T14:00:00.000Z");
    });

    it("parses ISO datetime without timezone suffix by treating as UTC", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      const result = normalizeRawDateString("2026-07-18T14:00:00");
      expect(result).not.toBeNull();
      expect(result!.toISOString()).toBe("2026-07-18T14:00:00.000Z");
    });

    it("parses ISO datetime with milliseconds but no timezone", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      const result = normalizeRawDateString("2026-07-18T14:00:00.000");
      expect(result).not.toBeNull();
      expect(result!.toISOString()).toBe("2026-07-18T14:00:00.000Z");
    });

    it("trims whitespace", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      const result = normalizeRawDateString("  2026-07-18T14:00:00Z  ");
      expect(result).not.toBeNull();
      expect(result!.toISOString()).toBe("2026-07-18T14:00:00.000Z");
    });

    it("parses date-only ISO string", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      const result = normalizeRawDateString("2026-07-18");
      expect(result).not.toBeNull();
    });

    it("parses ISO with positive timezone offset", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      const result = normalizeRawDateString("2026-07-18T14:00:00+05:30");
      expect(result).not.toBeNull();
    });

    it("parses ISO with negative timezone offset", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      const result = normalizeRawDateString("2026-07-18T14:00:00-04:00");
      expect(result).not.toBeNull();
    });

    it("returns null for empty string", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      expect(normalizeRawDateString("")).toBeNull();
    });

    it("returns null for whitespace-only", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      expect(normalizeRawDateString("   ")).toBeNull();
    });

    it("returns null for completely unparseable strings", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      expect(normalizeRawDateString("not a date at all")).toBeNull();
    });

    it("returns null for empty object-like strings", async () => {
      const { normalizeRawDateString } = await import("./article-discovery-helpers");
      expect(normalizeRawDateString("{}" )).toBeNull();
    });
  });

  describe("buildStaleAuditMeta", () => {
    it("returns missing_published_at when no raw date", async () => {
      const { buildStaleAuditMeta } = await import("./article-discovery-helpers");
      const freshnessMs = 14 * 24 * 60 * 60 * 1000;
      const now = new Date("2026-07-20T12:00:00Z");

      const result = buildStaleAuditMeta(
        { rawDate: null, source: "unknown" },
        null,
        freshnessMs,
        now,
      );

      expect(result.staleReason).toBe("missing_published_at");
      expect(result.rawPublishedAt).toBeNull();
      expect(result.normalizedPublishedAt).toBeNull();
      expect(result.publishedAtSource).toBe("unknown");
      expect(result.ageDays).toBeNull();
      expect(result.freshnessCutoffIso).toBeTruthy();
    });

    it("returns invalid_published_at when raw date exists but normalization failed", async () => {
      const { buildStaleAuditMeta } = await import("./article-discovery-helpers");
      const freshnessMs = 14 * 24 * 60 * 60 * 1000;
      const now = new Date("2026-07-20T12:00:00Z");

      const result = buildStaleAuditMeta(
        { rawDate: "not-a-date", source: "meta[name=date]" },
        null,
        freshnessMs,
        now,
      );

      expect(result.staleReason).toBe("invalid_published_at");
      expect(result.rawPublishedAt).toBe("not-a-date");
      expect(result.normalizedPublishedAt).toBeNull();
      expect(result.publishedAtSource).toBe("meta[name=date]");
      expect(result.ageDays).toBeNull();
    });

    it("returns invalid_published_at when raw date exists but cannot be parsed", async () => {
      const { buildStaleAuditMeta } = await import("./article-discovery-helpers");
      const freshnessMs = 14 * 24 * 60 * 60 * 1000;
      const now = new Date("2026-07-20T12:00:00Z");

      const result = buildStaleAuditMeta(
        { rawDate: "not-a-parseable-date", source: "meta[name=date]" },
        null, // normalizedDate is null because new Date("not-a-parseable-date") is Invalid Date
        freshnessMs,
        now,
      );

      expect(result.staleReason).toBe("invalid_published_at");
      expect(result.rawPublishedAt).toBe("not-a-parseable-date");
      expect(result.normalizedPublishedAt).toBeNull();
      expect(result.publishedAtSource).toBe("meta[name=date]");
      expect(result.ageDays).toBeNull();
    });

    it("returns published_at_before_cutoff for old dates", async () => {
      const { buildStaleAuditMeta } = await import("./article-discovery-helpers");
      const freshnessMs = 14 * 24 * 60 * 60 * 1000;
      const now = new Date("2026-07-20T12:00:00Z");
      const oldDate = new Date("2020-01-01T00:00:00Z");

      const result = buildStaleAuditMeta(
        { rawDate: "2020-01-01T00:00:00Z", source: "article:published_time" },
        oldDate,
        freshnessMs,
        now,
      );

      expect(result.staleReason).toBe("published_at_before_cutoff");
      expect(result.rawPublishedAt).toBe("2020-01-01T00:00:00Z");
      expect(result.normalizedPublishedAt).toBe(oldDate.toISOString());
      expect(result.publishedAtSource).toBe("article:published_time");
      expect(result.ageDays).toBeGreaterThan(2000);
    });

    it("returns future_published_at for dates in the future", async () => {
      const { buildStaleAuditMeta } = await import("./article-discovery-helpers");
      const freshnessMs = 14 * 24 * 60 * 60 * 1000;
      const now = new Date("2026-07-20T12:00:00Z");
      const futureDate = new Date("2099-12-31T00:00:00Z");

      const result = buildStaleAuditMeta(
        { rawDate: "2099-12-31T00:00:00Z", source: "og:updated_time" },
        futureDate,
        freshnessMs,
        now,
      );

      expect(result.staleReason).toBe("future_published_at");
      expect(result.ageDays).toBeLessThan(0);
    });

    it("computes freshnessCutoffIso correctly from freshnessMs", async () => {
      const { buildStaleAuditMeta } = await import("./article-discovery-helpers");
      const freshnessMs = 14 * 24 * 60 * 60 * 1000;
      const now = new Date("2026-07-20T12:00:00Z");
      const expectedCutoff = new Date(now.getTime() - freshnessMs);

      const result = buildStaleAuditMeta(
        { rawDate: null, source: "unknown" },
        null,
        freshnessMs,
        now,
      );

      expect(result.freshnessCutoffIso).toBe(expectedCutoff.toISOString());
    });
  });

  describe("buildStaleSampleLog", () => {
    it("returns empty string when no stale rejections", async () => {
      const { buildStaleSampleLog } = await import("./article-discovery-helpers");

      const result = buildStaleSampleLog([
        { url: "https://example.com/1", sourceKind: "listing", status: "accepted" },
        { url: "https://example.com/2", sourceKind: "listing", status: "rejected_low_score" },
      ]);

      expect(result).toBe("");
    });

    it("returns up to 3 stale samples with dates and truncated URLs", async () => {
      const { buildStaleSampleLog } = await import("./article-discovery-helpers");

      const result = buildStaleSampleLog([
        { url: "https://example.com/news/2020/01/01/story-a", sourceKind: "listing", status: "rejected_stale", normalizedPublishedAt: "2020-01-01T00:00:00Z" },
        { url: "https://example.com/news/2020/02/15/story-b", sourceKind: "sitemap", status: "rejected_stale", normalizedPublishedAt: "2020-02-15T00:00:00Z" },
        { url: "https://example.com/news/2020/03/20/story-c", sourceKind: "listing", status: "rejected_stale", normalizedPublishedAt: "2020-03-20T00:00:00Z" },
        { url: "https://example.com/news/2020/04/10/story-d-extra", sourceKind: "listing", status: "rejected_stale", normalizedPublishedAt: "2020-04-10T00:00:00Z" },
      ]);

      expect(result).toContain("2020-01-01");
      expect(result).toContain("2020-02-15");
      expect(result).toContain("2020-03-20");
      expect(result).not.toContain("2020-04-10"); // 4th entry should be capped
    });

    it("shows missing-date when normalizedPublishedAt is absent", async () => {
      const { buildStaleSampleLog } = await import("./article-discovery-helpers");

      const result = buildStaleSampleLog([
        { url: "https://example.com/news/story-no-date", sourceKind: "listing", status: "rejected_stale" },
      ]);

      expect(result).toContain("missing-date");
    });
  });

  // ── evaluateArticleLinkCandidateFromExtractedMetadata — canonicalUrlOverride ──

  describe("evaluateArticleLinkCandidateFromExtractedMetadata — canonicalUrlOverride", () => {
    const baseInput = () => ({
      articleUrl: "https://example.com/news/2026/07/20/some-article",
      sourcePageUrl: "browser:https://example.com/news/2026/07/20/some-article",
      targetUrl: "https://example.com",
      sourceId: "src-1",
      title: "A Valid Article Title For Testing",
      description: "Description text",
      keywords: ["news"],
      publishedAtRaw: new Date().toISOString(),
      publishedAtSource: "datePublished" as const,
      bodyFallback: "Body text for testing.",
    });

    it("uses same-domain canonicalUrlOverride in accepted candidate", async () => {
      const { evaluateArticleLinkCandidateFromExtractedMetadata } = await import("./article-discovery-helpers");

      const canonicalOverride = "https://example.com/news/2026/07/20/canonical-slug";
      const result = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        canonicalUrlOverride: canonicalOverride,
      });

      expect(result.accepted).toBe(true);
      expect(result.candidate!.canonicalUrl).toBe(canonicalOverride);
    });

    it("falls back to articleUrl when canonicalUrlOverride is invalid", async () => {
      const { evaluateArticleLinkCandidateFromExtractedMetadata } = await import("./article-discovery-helpers");

      const result = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        canonicalUrlOverride: "not-a-valid-url",
      });

      expect(result.accepted).toBe(true);
      expect(result.candidate!.canonicalUrl).toBe(baseInput().articleUrl);
    });

    it("falls back to articleUrl when canonicalUrlOverride is empty string", async () => {
      const { evaluateArticleLinkCandidateFromExtractedMetadata } = await import("./article-discovery-helpers");

      const result = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        canonicalUrlOverride: "",
      });

      expect(result.accepted).toBe(true);
      expect(result.candidate!.canonicalUrl).toBe(baseInput().articleUrl);
    });

    it("falls back to articleUrl when canonicalUrlOverride is null", async () => {
      const { evaluateArticleLinkCandidateFromExtractedMetadata } = await import("./article-discovery-helpers");

      const result = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        canonicalUrlOverride: null,
      });

      expect(result.accepted).toBe(true);
      expect(result.candidate!.canonicalUrl).toBe(baseInput().articleUrl);
    });

    it("rejects cross-domain canonicalUrlOverride as rejected_cross_domain", async () => {
      const { evaluateArticleLinkCandidateFromExtractedMetadata } = await import("./article-discovery-helpers");

      const result = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        canonicalUrlOverride: "https://evil.com/news/2026/07/20/hijack-slug-here",
      });

      expect(result.accepted).toBe(false);
      expect(result.outcome.status).toBe("rejected_cross_domain");
    });

    it("rejects utility-path canonicalUrlOverride as rejected_utility_path", async () => {
      const { evaluateArticleLinkCandidateFromExtractedMetadata } = await import("./article-discovery-helpers");

      const result = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        canonicalUrlOverride: "https://example.com/about",
      });

      expect(result.accepted).toBe(false);
      expect(result.outcome.status).toBe("rejected_utility_path");
    });

    it("uses canonicalUrlOverride for dedupe identity (same canonical from different article URLs)", async () => {
      const { evaluateArticleLinkCandidateFromExtractedMetadata } = await import("./article-discovery-helpers");

      const canonical = "https://example.com/news/2026/07/20/the-canonical-article";

      const r1 = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        articleUrl: "https://example.com/news/2026/07/20/the-canonical-article?ref=rss",
        canonicalUrlOverride: canonical,
      });
      const r2 = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        articleUrl: "https://example.com/news/2026/07/20/the-canonical-article?ref=sitemap",
        canonicalUrlOverride: canonical,
      });

      expect(r1.accepted).toBe(true);
      expect(r2.accepted).toBe(true);
      expect(r1.candidate!.canonicalUrl).toBe(canonical);
      expect(r2.candidate!.canonicalUrl).toBe(canonical);
      expect(r1.candidate!.canonicalUrl).toBe(r2.candidate!.canonicalUrl);
    });

    it("accepts listing_context dates that are only slightly in the future", async () => {
      const { evaluateArticleLinkCandidateFromExtractedMetadata } = await import("./article-discovery-helpers");

      const nearFuture = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      const result = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        publishedAtRaw: nearFuture,
        publishedAtSource: "listing_context",
      });

      expect(result.accepted).toBe(true);
      expect(result.candidate!.rawSignals).toContain("accepted_with_listing_future_tolerance");
      expect(result.outcome.scoreReasons).toContain("accepted_with_listing_future_tolerance");
      expect(result.outcome.reason).toBe("accepted with listing-context future-date tolerance");
    });

    it("does not apply future-date tolerance to non-listing date sources", async () => {
      const { evaluateArticleLinkCandidateFromExtractedMetadata } = await import("./article-discovery-helpers");

      const nearFuture = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      const result = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        publishedAtRaw: nearFuture,
        publishedAtSource: "datePublished",
      });

      expect(result.accepted).toBe(false);
      expect(result.outcome.status).toBe("rejected_stale");
      expect(result.outcome.staleReason).toBe("future_published_at");
    });

    it("does not accept listing_context dates beyond the future tolerance", async () => {
      const { evaluateArticleLinkCandidateFromExtractedMetadata } = await import("./article-discovery-helpers");

      const farFuture = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const result = await evaluateArticleLinkCandidateFromExtractedMetadata({
        ...baseInput(),
        publishedAtRaw: farFuture,
        publishedAtSource: "listing_context",
      });

      expect(result.accepted).toBe(false);
      expect(result.outcome.status).toBe("rejected_stale");
      expect(result.outcome.staleReason).toBe("future_published_at");
    });
  });

  // ── Candidate Scoring ─────────────────────────────────────────────────

  describe("scoreCandidateUrl", () => {
    it("scores article-like URLs above threshold", async () => {
      const { scoreCandidateUrl } = await import("./article-discovery-helpers");

      const result = scoreCandidateUrl(
        "https://example.com/news/2026/07/16/breaking-story-headline",
        "https://example.com/",
        { title: "Breaking Story Headline", dateText: "2026-07-16" },
      );

      expect(result.rejected).toBe(false);
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.reasons).toContain("same_domain");
      expect(result.reasons).toContain("has_title");
    });

    it("rejects utility pages with zero score", async () => {
      const { scoreCandidateUrl } = await import("./article-discovery-helpers");

      const result = scoreCandidateUrl(
        "https://example.com/about",
        "https://example.com/",
      );

      expect(result.rejected).toBe(true);
      expect(result.score).toBe(0);
      expect(result.rejectionReason).toBe("about_page");
    });

    it("rejects cross-domain URLs", async () => {
      const { scoreCandidateUrl } = await import("./article-discovery-helpers");

      const result = scoreCandidateUrl(
        "https://evil.com/news/story",
        "https://example.com/",
      );

      expect(result.rejected).toBe(true);
      expect(result.rejectionReason).toBe("different_domain");
    });

    it("gives bonus for category path match", async () => {
      const { scoreCandidateUrl } = await import("./article-discovery-helpers");

      const withCategory = scoreCandidateUrl(
        "https://example.com/sports/2026/07/16/match-report",
        "https://example.com/",
        { categoryPathUrl: "https://example.com/sports", title: "Match Report" },
      );

      const withoutCategory = scoreCandidateUrl(
        "https://example.com/tech/2026/07/16/gadget-review",
        "https://example.com/",
        { title: "Gadget Review" },
      );

      expect(withCategory.score).toBeGreaterThan(withoutCategory.score);
      expect(withCategory.reasons).toContain("category_match");
    });

    it("gives bonus for date in URL", async () => {
      const { scoreCandidateUrl } = await import("./article-discovery-helpers");

      const withDate = scoreCandidateUrl(
        "https://example.com/news/2026/07/16/story",
        "https://example.com/",
      );

      const withoutDate = scoreCandidateUrl(
        "https://example.com/news/story",
        "https://example.com/",
      );

      expect(withDate.score).toBeGreaterThan(withoutDate.score);
      expect(withDate.reasons).toContain("date_in_url");
    });

    it("rejects homepage", async () => {
      const { scoreCandidateUrl } = await import("./article-discovery-helpers");

      const result = scoreCandidateUrl(
        "https://example.com/",
        "https://example.com/",
      );

      expect(result.rejected).toBe(true);
      expect(result.rejectionReason).toBe("homepage");
    });

    it("handles invalid URLs gracefully", async () => {
      const { scoreCandidateUrl } = await import("./article-discovery-helpers");

      const result = scoreCandidateUrl("not-a-url", "https://example.com/");
      expect(result.rejected).toBe(true);
      expect(result.rejectionReason).toBe("invalid_url");
    });
  });
});
