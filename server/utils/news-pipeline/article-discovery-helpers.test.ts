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
