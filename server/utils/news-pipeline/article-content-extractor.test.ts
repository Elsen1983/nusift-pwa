import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Mock safeFetch ─────────────────────────────────────────────────────────
const safeFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../ssrf-guard", () => ({
  safeFetch: safeFetchMock,
  SSRFError: class SSRFError extends Error {
    detail: string;
    constructor(detail: string) {
      super("Request blocked by security policy");
      this.name = "SSRFError";
      this.detail = detail;
    }
  },
}));

// ─── Test HTML fixtures ─────────────────────────────────────────────────────

const longPara = (text: string, repeats = 5) => `${text} ".repeat(repeats)}</p>`;

const defaultBody = () => [
  `<p>${"The first paragraph introduces the main topic of the article with sufficient detail to be meaningful content. ".repeat(3)}</p>`,
  `<p>${"The second paragraph elaborates on the key points and provides supporting evidence for the claims made earlier. ".repeat(3)}</p>`,
  `<p>${"The third paragraph concludes the discussion with additional context and perspective on the broader implications. ".repeat(3)}</p>`,
].join("\n  ");

const articleHtml = (overrides: Record<string, string> = {}) => {
  const title = overrides.title || "Test Article Title";
  const body = overrides.body || defaultBody();
  const meta = overrides.meta || "";
  const jsonLd = overrides.jsonLd || "";

  return `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <meta property="og:title" content="${overrides.ogTitle || title}" />
  <meta property="og:description" content="${overrides.ogDesc || "A test article description"}" />
  <meta property="og:image" content="${overrides.ogImage || "https://example.com/image.jpg"}" />
  <meta name="author" content="${overrides.author || "Test Author"}" />
  ${meta}
  ${jsonLd}
</head>
<body>
  <article>
    <h1>${title}</h1>
    ${body}
  </article>
</body>
</html>`;
};

const minimalHtml = `<!DOCTYPE html><html><head><title>Empty</title></head><body><nav>Menu</nav><footer>Copyright</footer></body></html>`;

const paywallHtml = `<!DOCTYPE html>
<html>
<head><title>Premium Article</title></head>
<body>
  <article>
    <p>Subscribe to continue reading this premium article content.</p>
    <p>This is just a teaser paragraph that is very short.</p>
  </article>
</body>
</html>`;

const jsonLdHtml = `<!DOCTYPE html>
<html>
<head>
  <title>JSON-LD Article</title>
  <script type="application/ld+json">
    {
      "@type": "NewsArticle",
      "headline": "JSON-LD Headline",
      "author": { "@type": "Person", "name": "John Doe" },
      "datePublished": "2026-07-20T10:00:00Z",
      "dateModified": "2026-07-21T12:00:00Z"
    }
  </script>
</head>
<body>
  <article>
    <p>${"This is a meaningful article body extracted from JSON-LD structured data that covers the main topic. ".repeat(5)}</p>
    <p>${"The article continues with additional details and analysis of the structured data findings. ".repeat(5)}</p>
    <p>${"Finally the article concludes with a summary of the JSON-LD structured data implications. ".repeat(5)}</p>
  </article>
</body>
</html>`;

const nonHtmlResponse = "This is not HTML at all, just plain text content.";

function makeResponse(body: string, ok = true, contentType = "text/html", status = 200, url = "https://example.com/article") {
  return {
    ok,
    status,
    url,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === "content-type") return contentType;
        return null;
      },
    },
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("extractArticleContentFromUrl", () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  it("extracts body text from article tag", async () => {
    const html = articleHtml();
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 1,
      articleUrl: "https://example.com/article",
      existingTitle: "Test Article Title",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText).toBeTruthy();
      expect(result.bodyText!.length).toBeGreaterThan(100);
      expect(result.title).toBe("Test Article Title");
      expect(result.method).toBe("http-dom");
      expect(result.excerpt).toBe("A test article description");
      expect(result.imageUrl).toBe("https://example.com/image.jpg");
      expect(result.author).toBe("Test Author");
    }
  });

  it("extracts body text from main/articleBody fallback", async () => {
    const para = "This is the main content area with enough text to pass the extraction threshold for body text. ";
    const html = `<!DOCTYPE html>
<html>
<head><title>Fallback Test</title></head>
<body>
  <main>
    <div itemprop="articleBody">
      <p>${"The opening section introduces the key concepts that will be explored in this article. ".repeat(5)}</p>
      <p>${"The middle section provides detailed analysis and supporting evidence for the main arguments. ".repeat(5)}</p>
      <p>${"The concluding section summarizes the findings and offers recommendations for further reading. ".repeat(5)}</p>
    </div>
  </main>
</body>
</html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 2,
      articleUrl: "https://example.com/fallback",
      existingTitle: "Fallback Test",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText).toBeTruthy();
      expect(result.bodyText!.length).toBeGreaterThan(100);
    }
  });

  it("rejects short navigation-only page", async () => {
    safeFetchMock.mockResolvedValue(makeResponse(minimalHtml));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 3,
      articleUrl: "https://example.com/nav-only",
      existingTitle: "Nav Only",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["no_article_text", "too_short"]).toContain(result.rejectedReason);
    }
  });

  it("rejects non-html response", async () => {
    safeFetchMock.mockResolvedValue(makeResponse(nonHtmlResponse, true, "application/json", 200));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 4,
      articleUrl: "https://example.com/api/data",
      existingTitle: "API Response",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejectedReason).toBe("non_html_response");
    }
  });

  it("detects paywall/blocker signals", async () => {
    safeFetchMock.mockResolvedValue(makeResponse(paywallHtml));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 5,
      articleUrl: "https://example.com/paywall",
      existingTitle: "Premium Article",
    });

    // With strong paywall signals and very short body, should be rejected
    if (!result.ok) {
      expect(result.rejectedReason).toBe("paywall_or_blocked");
    } else {
      // If it somehow succeeds, paywall should be detected
      expect(result.isPaywall).toBe(true);
    }
  });

  it("extracts JSON-LD date/author when present", async () => {
    safeFetchMock.mockResolvedValue(makeResponse(jsonLdHtml));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 6,
      articleUrl: "https://example.com/jsonld",
      existingTitle: "JSON-LD Article",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.author).toBe("John Doe");
      expect(result.publishedAt).toBeTruthy();
      expect(result.title).toBe("JSON-LD Headline");
    }
  });

  it("extracts body even when only main element is available", async () => {
    const html = `<!DOCTYPE html>
<html><head><title>Rich Meta</title>
<meta name="author" content="Test Author" />
<meta property="og:description" content="A test article description" />
<meta name="twitter:image" content="https://example.com/twitter-img.jpg" />
</head>
<body>
  <main>
    <p>${"The first main content paragraph introduces the primary topic with enough detail to be useful. ".repeat(4)}</p>
    <p>${"The second main content paragraph expands on the topic with supporting evidence and context. ".repeat(4)}</p>
    <p>${"The third main content paragraph wraps up the discussion with conclusions and key takeaways. ".repeat(4)}</p>
  </main>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 15,
      articleUrl: "https://example.com/main-only",
      existingTitle: "Rich Meta",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText).toBeTruthy();
      expect(result.excerpt).toBe("A test article description");
      expect(result.author).toBe("Test Author");
    }
  });

  it("normalizes and dedupes repeated paragraphs", async () => {
    const repeated = "This paragraph is repeated multiple times to test deduplication logic in the extractor. ".repeat(3);
    const unique = "Different paragraph with unique content that should also be extracted by the parser. It needs enough characters to pass the filter.";
    const html = `<!DOCTYPE html>
<html><head><title>Dedupe Test</title></head>
<body>
  <article>
    <p>${repeated}</p>
    <p>${repeated}</p>
    <p>${unique}</p>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 7,
      articleUrl: "https://example.com/dedupe",
      existingTitle: "Dedupe Test",
    });

    if (result.ok && result.bodyText) {
      // The repeated paragraph should appear only once
      const occurrences = (result.bodyText.match(/This paragraph is repeated/g) || []).length;
      expect(occurrences).toBe(1);
    }
  });

  it("caps bodyText length at 50,000 characters", async () => {
    const longParagraph = `<p>${"A".repeat(2000)}</p>`;
    const manyParagraphs = Array(30).fill(longParagraph).join("\n");
    const html = `<!DOCTYPE html>
<html><head><title>Long Article</title></head>
<body><article>${manyParagraphs}</article></body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 8,
      articleUrl: "https://example.com/long",
      existingTitle: "Long Article",
    });

    if (result.ok && result.bodyText) {
      expect(result.bodyText.length).toBeLessThanOrEqual(50000);
    }
  });

  it("handles malformed HTML safely", async () => {
    const malformedHtml = `<!DOCTYPE html><html><head><title>Broken</title></head><body><article><p><div><span>${"Content with unclosed tags. ".repeat(10)}</span></div></article></body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(malformedHtml));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 9,
      articleUrl: "https://example.com/malformed",
      existingTitle: "Broken",
    });

    // Should not throw; either succeeds or fails gracefully
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
  });

  it("rejects missing article URL", async () => {
    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 10,
      articleUrl: "",
      existingTitle: "No URL",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejectedReason).toBe("missing_article_url");
    }
  });

  it("returns fetch_failed when safeFetch throws", async () => {
    safeFetchMock.mockRejectedValue(new Error("Network timeout"));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 11,
      articleUrl: "https://example.com/timeout",
      existingTitle: "Timeout",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejectedReason).toBe("fetch_failed");
    }
  });

  it("returns http_error for 4xx status codes", async () => {
    safeFetchMock.mockResolvedValue(makeResponse("", false, "text/html", 403));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 12,
      articleUrl: "https://example.com/forbidden",
      existingTitle: "Forbidden",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejectedReason).toBe("http_error");
      expect(result.statusCode).toBe(403);
    }
  });

  it("retries an HTTP 403 once over HTTPS on the same host and path", async () => {
    const html = articleHtml();
    safeFetchMock
      .mockResolvedValueOnce(makeResponse("", false, "text/html", 403, "http://example.com/news/42?edition=uk"))
      .mockResolvedValueOnce(makeResponse(html, true, "text/html", 200, "https://example.com/news/42?edition=uk"));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 120,
      articleUrl: "http://example.com/news/42?edition=uk",
      existingTitle: "Test Article Title",
    });

    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(safeFetchMock.mock.calls[1]![0]).toBe("https://example.com/news/42?edition=uk");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedUrl).toBe("https://example.com/news/42?edition=uk");
      expect(result.qualitySignals).toContain("http_to_https_upgrade_succeeded");
    }
  });

  it.each([
    ["https://example.com/forbidden", 403],
    ["http://example.com/rate-limited", 429],
    ["http://example.com:8080/forbidden", 403],
  ])("does not upgrade ineligible request %s with status %i", async (articleUrl, status) => {
    safeFetchMock.mockResolvedValue(makeResponse("", false, "text/html", status, articleUrl));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 121,
      articleUrl,
      existingTitle: "Blocked",
    });

    expect(result.ok).toBe(false);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses existing bodyText as fallback when extraction produces nothing", async () => {
    // Page has a title but no article body
    const html = `<!DOCTYPE html>
<html><head><title>Title Only</title><meta property="og:title" content="Title Only" /></head>
<body><nav>Just navigation</nav></body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    // Create a realistic existing body with multiple paragraphs
    const existingBody = [
      "The first paragraph of the existing body text provides meaningful content about the topic.",
      "The second paragraph of the existing body text continues with additional details and analysis.",
      "The third paragraph concludes the existing body text with final thoughts and summary.",
    ].map(p => p.repeat(3)).join("\n\n");
    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 13,
      articleUrl: "https://example.com/title-only",
      existingTitle: "Title Only",
      existingBodyText: existingBody,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText).toBe(existingBody);
      expect(result.diagnostics.bodySource).toBe("existing-fallback");
    }
  });

  it("computes higher confidence for articles with rich metadata", async () => {
    const longBody = [
      `<p>${"This is a meaningful opening paragraph with enough text to pass the minimum threshold for extraction. ".repeat(5)}</p>`,
      `<p>${"This is a meaningful middle paragraph that continues the article with additional substantive content. ".repeat(5)}</p>`,
      `<p>${"This is a meaningful concluding paragraph that wraps up the article with final thoughts and analysis. ".repeat(5)}</p>`,
    ].join("\n    ");
    const html = articleHtml({
      author: "Rich Author",
      ogDesc: "A detailed article description for testing confidence scoring",
      body: longBody,
      jsonLd: `<script type="application/ld+json">{"datePublished":"2026-07-20T10:00:00Z","author":{"name":"Rich Author"}}</script>`,
    });
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 14,
      articleUrl: "https://example.com/rich",
      existingTitle: "Test Article Title",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should have high confidence: has title, excerpt, author, date, body text
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.qualitySignals.length).toBeGreaterThan(0);
      expect(result.author).toBe("Rich Author");
      expect(result.publishedAt).toBeTruthy();
    }
  });
});

describe("quality hardening regressions", () => {
  it("Test A: full body preferred over intro — multi-paragraph article body is extracted", async () => {
    const intro = "This brief introduction sets the stage for the detailed analysis that follows in this comprehensive article.";
    const body1 = "The first major section of the article explores the historical context and background of the topic in considerable depth.";
    const body2 = "The second section examines current trends and data, providing evidence-based insights into the present situation.";
    const body3 = "The third section analyzes potential future implications and what experts predict will happen next.";
    const body4 = "The fourth section discusses counterarguments and alternative perspectives on the issue at hand.";
    const body5 = "The fifth section presents case studies that illustrate the practical applications of the concepts discussed.";
    const body6 = "The final section concludes with actionable recommendations and a summary of key takeaways for readers.";

    const html = `<!DOCTYPE html>
<html><head><title>Full Article</title>
<meta property="og:description" content="A brief social preview description" />
</head>
<body>
  <article>
    <h1>Full Article</h1>
    <p class="lead">${intro.repeat(2)}</p>
    <div class="body">
      <p>${body1.repeat(3)}</p>
      <p>${body2.repeat(3)}</p>
      <p>${body3.repeat(3)}</p>
      <p>${body4.repeat(3)}</p>
      <p>${body5.repeat(3)}</p>
      <p>${body6.repeat(3)}</p>
    </div>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 100,
      articleUrl: "https://example.com/full-article",
      existingTitle: "Full Article",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // bodyText should contain the body paragraphs, not just the intro
      expect(result.bodyText).toBeTruthy();
      expect(result.bodyText!.length).toBeGreaterThan(intro.length * 2);
      expect(result.bodyText).toContain("historical context");
      expect(result.bodyText).toContain("actionable recommendations");
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(3);
      expect(result.diagnostics.bodySource).toMatch(/dom|expanded-dom/);
    }
  });

  it("Test B: meta description must not become bodyText — excerpt-only page rejected", async () => {
    const html = `<!DOCTYPE html>
<html><head><title>Preview Only</title>
<meta name="description" content="This is only a social preview description for sharing on social media platforms." />
<meta property="og:description" content="This is only a social preview description for sharing on social media platforms." />
</head>
<body>
  <nav>Navigation menu</nav>
  <footer>Footer content</footer>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 101,
      articleUrl: "https://example.com/preview-only",
      existingTitle: "Preview Only",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["no_article_text", "too_short"]).toContain(result.rejectedReason);
    }
    // excerpt should be available in diagnostics even though body is rejected
    expect(result.diagnostics.excerptLength).toBeGreaterThan(0);
  });

  it("Test C: bodyText equal to excerpt is rejected", async () => {
    // Excerpt must be long enough to pass the quality gate (>= 1200 chars for single paragraph)
    // so the excerpt-vs-body guard actually triggers
    const excerptText = "This exact text appears as both the meta description and the only paragraph content on the page and it needs to be long enough to pass the quality gate for single paragraphs. ".repeat(8);
    const html = `<!DOCTYPE html>
<html><head><title>Duplicate Content</title>
<meta name="description" content="${excerptText}" />
</head>
<body>
  <article>
    <p>${excerptText}</p>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 102,
      articleUrl: "https://example.com/duplicate-content",
      existingTitle: "Duplicate Content",
    });

    // Should be rejected because body equals excerpt
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejectedReason).toBe("no_article_text");
    }
    expect(result.diagnostics.bodyEqualsExcerpt).toBe(true);
  });

  it("Test D: related/footer content excluded from body extraction", async () => {
    const realPara = "The main article discusses an important topic that affects many people around the world today and provides detailed analysis.";
    const html = `<!DOCTYPE html>
<html><head><title>Article With Related</title>
<meta property="og:description" content="A real article" />
</head>
<body>
  <article>
    <h1>Article With Related</h1>
    <p>${realPara.repeat(4)}</p>
    <p>${realPara.replace("important", "significant").repeat(4)}</p>
    <p>${realPara.replace("detailed", "comprehensive").repeat(4)}</p>
  </article>
  <aside class="related-posts">
    <a href="/story1">Related Story One</a>
    <a href="/story2">Related Story Two</a>
    <a href="/story3">Related Story Three</a>
    <a href="/story4">Related Story Four</a>
    <a href="/story5">Related Story Five</a>
  </aside>
  <footer>
    <a href="/about">About Us</a>
    <a href="/contact">Contact</a>
    <a href="/privacy">Privacy Policy</a>
  </footer>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 103,
      articleUrl: "https://example.com/article-with-related",
      existingTitle: "Article With Related",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Body should contain real article paragraphs
      expect(result.bodyText).toContain("important topic");
      // Should NOT contain related/footer text
      expect(result.bodyText).not.toContain("Related Story");
      expect(result.bodyText).not.toContain("About Us");
      expect(result.bodyText).not.toContain("Privacy Policy");
      // Link text ratio should be low
      expect(result.diagnostics.linkTextRatio).toBeLessThan(0.5);
    }
  });

  it("Test E: parent/sibling expansion collects full story from thin lead", async () => {
    const leadPara = "A brief introduction to the topic.";
    const fullPara1 = "The first major point of the article expands on the introduction with substantial evidence and reasoning.";
    const fullPara2 = "The second major point builds upon the first, adding depth and nuance to the overall argument presented.";
    const fullPara3 = "The conclusion ties everything together and presents the final analysis of the topic discussed throughout.";

    const html = `<!DOCTYPE html>
<html><head><title>Thin Lead Article</title>
<meta property="og:description" content="An article with a thin lead" />
</head>
<body>
  <article>
    <h1>Thin Lead Article</h1>
    <p class="lead">${leadPara}</p>
    <p>${fullPara1.repeat(3)}</p>
    <p>${fullPara2.repeat(3)}</p>
    <p>${fullPara3.repeat(3)}</p>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 104,
      articleUrl: "https://example.com/thin-lead",
      existingTitle: "Thin Lead Article",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should include the full paragraphs, not just the lead
      expect(result.bodyText).toContain("first major point");
      expect(result.bodyText).toContain("second major point");
      expect(result.bodyText).toContain("conclusion ties");
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(3);
    }
  });

  it("Test F: short lead-only page is rejected", async () => {
    const html = `<!DOCTYPE html>
<html><head><title>Lead Only</title>
<meta property="og:description" content="Just a lead" />
</head>
<body>
  <article>
    <h1>Lead Only</h1>
    <p>This is just one short lead paragraph with no additional content to extract from the page.</p>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 105,
      articleUrl: "https://example.com/lead-only",
      existingTitle: "Lead Only",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["too_short", "no_article_text"]).toContain(result.rejectedReason);
    }
    expect(result.diagnostics.bodySource).toBe("none");
  });

  it("includes compact diagnostics in successful results", async () => {
    const html = articleHtml();
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 106,
      articleUrl: "https://example.com/diagnostics-test",
      existingTitle: "Test Article Title",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics.selectedContainerSelector).toBeTruthy();
      expect(result.diagnostics.candidateContainerCount).toBeGreaterThan(0);
      expect(result.diagnostics.excerptLength).toBeGreaterThan(0);
      expect(result.diagnostics.bodyEqualsExcerpt).toBe(false);
      expect(result.diagnostics.bodySource).toMatch(/dom|expanded-dom/);
      expect(result.diagnostics.scoreReasons.length).toBeGreaterThan(0);
    }
  });
});

describe("real-world failure shape regressions", () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  it("Test 1: Lead + full body — prefers full body over lead", async () => {
    // Each paragraph is a unique string so deduplication doesn't collapse them
    const leadText = "The opening lead paragraph provides a brief overview of the breaking news story today.";
    const bodyP1 = "The first body paragraph discusses the detailed analysis and findings of the investigation into the matter of public concern.".repeat(2);
    const bodyP2 = "The second body paragraph examines the evidence collected from multiple sources during the course of the year-long inquiry.".repeat(2);
    const bodyP3 = "The third body paragraph presents the expert testimony and scientific data that supports the conclusions of the report.".repeat(2);
    const bodyP4 = "The fourth body paragraph considers the broader implications for policy and governance in the affected communities.".repeat(2);
    const bodyP5 = "The fifth body paragraph reviews the historical precedent and compares similar cases from the recent past.".repeat(2);
    const bodyP6 = "The sixth body paragraph outlines the recommendations made by the commission for future action and reform.".repeat(2);

    const bodyParagraphs = [bodyP1, bodyP2, bodyP3, bodyP4, bodyP5, bodyP6]
      .map((t) => `<p>${t}</p>`)
      .join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Investigation Report</title>
<meta name="description" content="${leadText}" />
</head>
<body>
  <article>
    <div class="lead">
      <p>${leadText}</p>
    </div>
    <div class="article-content">
      ${bodyParagraphs}
    </div>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 200,
      articleUrl: "https://example.com/investigation",
      existingTitle: "Investigation Report",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText!.length).toBeGreaterThan(leadText.length * 3);
      expect(result.bodyText).toContain("detailed analysis");
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(3);
      expect(result.diagnostics.bodySource).toMatch(/dom|expanded-dom/);
    }
  });

  it("Test 2: RTE-like layout — lead paragraph + body in separate content wrapper", async () => {
    const lead = "The government announced new measures today to address the growing concerns raised by citizens across the country.";
    const bodyP1 = "The first policy paragraph elaborates on the details and implications for the public sector and government agencies.".repeat(2);
    const bodyP2 = "The second policy paragraph provides additional context about the timeline for implementation of the new measures.".repeat(2);
    const bodyP3 = "The third policy paragraph discusses the expected economic impact and budget implications of the announced changes.".repeat(2);
    const bodyP4 = "The fourth policy paragraph covers the reactions from opposition parties and independent analysts regarding the announcement.".repeat(2);
    const bodyP5 = "The fifth policy paragraph outlines the specific departments and agencies that will be responsible for carrying out the reforms.".repeat(2);
    const bodyP6 = "The sixth policy paragraph summarizes the public response and stakeholder feedback received during the consultation period.".repeat(2);

    const bodyPs = [bodyP1, bodyP2, bodyP3, bodyP4, bodyP5, bodyP6]
      .map((t) => `<p>${t}</p>`)
      .join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Policy Announcement</title>
<meta property="og:description" content="${lead}" />
</head>
<body>
  <article>
    <div class="story-header">
      <h1>Policy Announcement</h1>
      <p class="subtitle">${lead}</p>
      <div class="byline">By Staff Reporter</div>
    </div>
    <div class="story-body">
      ${bodyPs}
    </div>
    <div class="social-share">
      <a href="/share">Share</a>
      <a href="/tweet">Tweet</a>
    </div>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 201,
      articleUrl: "https://example.com/policy",
      existingTitle: "Policy Announcement",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText).toContain("policy paragraph");
      expect(result.bodyText).not.toContain("Share");
      expect(result.bodyText).not.toContain("Tweet");
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(3);
    }
  });

  it("Test 3: NBA-like official release — subtitle + long body with paragraphs", async () => {
    const subtitle = "The league today announced major rule changes for the upcoming season affecting all teams.";
    const bodyP1 = "The first major rule change affects the way games are officiated during the regular season and the playoffs period.".repeat(2);
    const bodyP2 = "The implementation timeline spans a two-year period with careful monitoring of the impact on competitive balance.".repeat(2);
    const bodyP3 = "Players and coaches have expressed mixed reactions to the announced changes with some supporting the reforms.".repeat(2);
    const bodyP4 = "Additional analysis from team executives and league officials suggests the changes will have a significant positive impact.".repeat(2);
    const bodyP5 = "The financial implications of these rule changes are expected to affect salary cap calculations for multiple seasons.".repeat(2);

    const bodyContent = [bodyP1, bodyP2, bodyP3, bodyP4, bodyP5]
      .map((t) => `<p>${t}</p>`)
      .join("\n      ");

    const html = `<!DOCTYPE html>
<html><head><title>League Rule Changes</title>
<meta property="og:description" content="${subtitle}" />
</head>
<body>
  <article>
    <h1>League Rule Changes</h1>
    <p class="summary">${subtitle}</p>
    ${bodyContent}
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 202,
      articleUrl: "https://example.com/nba-rules",
      existingTitle: "League Rule Changes",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Body should contain the full body paragraphs, not just the subtitle
      expect(result.bodyText).toContain("rule change affects");
      expect(result.bodyText).toContain("mixed reactions");
      expect(result.bodyText!.length).toBeGreaterThan(subtitle.length * 3);
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(3);
    }
  });

  it("Test 4: Bullet summary + full body — bullets do not win over article body", async () => {
    const bulletItems = [
      "Revenue increased by 15 percent year over year",
      "New product launched successfully in the third quarter",
      "Market share expanded across all major geographic regions",
      "Employee count grew by twenty percent during the fiscal year",
      "Customer satisfaction ratings improved significantly over the period",
    ].map((t) => `<li>${t}</li>`).join("\n      ");

    const bodyP1 = "The quarterly earnings report reveals strong performance across all business segments and geographic regions worldwide.".repeat(2);
    const bodyP2 = "Revenue growth was driven primarily by expansion into new markets and increased adoption of existing product lines.".repeat(2);
    const bodyP3 = "Operating margins improved due to cost optimization initiatives and operational efficiency gains across departments.".repeat(2);
    const bodyP4 = "The company announced plans for further investment in research and development to maintain competitive advantages.".repeat(2);
    const bodyP5 = "Analysts have responded positively to the results, with several upgrading their price targets for the stock.".repeat(2);

    const bodyPs = [bodyP1, bodyP2, bodyP3, bodyP4, bodyP5]
      .map((t) => `<p>${t}</p>`)
      .join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Quarterly Earnings</title>
<meta property="og:description" content="Key highlights from the quarterly earnings report" />
</head>
<body>
  <article>
    <h1>Quarterly Earnings</h1>
    <ul class="key-points">
      ${bulletItems}
    </ul>
    <div class="article-body">
      ${bodyPs}
    </div>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 203,
      articleUrl: "https://example.com/earnings",
      existingTitle: "Quarterly Earnings",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should include the full body paragraphs, not just bullet points
      expect(result.bodyText).toContain("quarterly earnings report");
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(3);
    }
  });

  it("Test 5: extended diagnostics include topCandidates and expansion info", async () => {
    const html = articleHtml();
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 204,
      articleUrl: "https://example.com/diag-extended",
      existingTitle: "Test Article Title",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics.topCandidates).toBeDefined();
      expect(Array.isArray(result.diagnostics.topCandidates)).toBe(true);
      expect(result.diagnostics.topCandidates.length).toBeGreaterThan(0);
      // Each top candidate has the expected shape
      const first = result.diagnostics.topCandidates[0]!;
      expect(first.selector).toBeTruthy();
      expect(typeof first.score).toBe("number");
      expect(typeof first.paragraphCount).toBe("number");
      expect(typeof first.textLength).toBe("number");
      // New diagnostics fields exist
      expect(typeof result.diagnostics.usedExpansion).toBe("boolean");
      expect(typeof result.diagnostics.leadLikePenaltyApplied).toBe("boolean");
    }
  });

  it("Test 6: lead-like container gets penalized in scoring", async () => {
    const leadText = "A brief introduction to the topic that sets the stage for the article about public policy.";
    const bodyP1 = "The detailed body content continues with extensive analysis of the situation and its implications for the future.".repeat(2);
    const bodyP2 = "Further analysis reveals additional patterns and trends that were not immediately apparent in the initial review.".repeat(2);
    const bodyP3 = "The investigation uncovered several key findings that change our understanding of the underlying causes involved.".repeat(2);
    const bodyP4 = "Expert commentary suggests these results are consistent with broader trends observed across similar industries globally.".repeat(2);
    const bodyP5 = "The final section provides recommendations for stakeholders based on the evidence and analysis presented throughout.".repeat(2);

    const bodyPs = [bodyP1, bodyP2, bodyP3, bodyP4, bodyP5]
      .map((t) => `<p>${t}</p>`)
      .join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Penalty Test</title>
<meta property="og:description" content="A brief summary of the article" />
</head>
<body>
  <article>
    <div class="intro">
      <p>${leadText}</p>
    </div>
    <div class="content">
      ${bodyPs}
    </div>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 205,
      articleUrl: "https://example.com/penalty-test",
      existingTitle: "Penalty Test",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The content div should be selected, not the intro div
      expect(result.bodyText).toContain("detailed body content");
      expect(result.bodyText!.length).toBeGreaterThan(leadText.length * 5);
    }
  });
});

describe("boundary detection regressions", () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  it("Test A: Pecaverzum-like — lead + many body paragraphs, excludes tags/related/footer", async () => {
    const lead = "The investigation reveals significant findings about public infrastructure and governance across the region.";
    const bodyP1 = "The first major finding concerns the allocation of public funds and the oversight mechanisms in place for infrastructure projects.".repeat(2);
    const bodyP2 = "The second finding examines the role of local authorities in monitoring compliance with national standards and regulations.".repeat(2);
    const bodyP3 = "The third finding details the impact on affected communities and the response from civil society organizations working on the ground.".repeat(2);
    const bodyP4 = "The fourth finding addresses the systemic issues identified during the course of the investigation into public sector accountability.".repeat(2);
    const bodyP5 = "The fifth finding presents recommendations for reform based on international best practices and comparative analysis of similar cases.".repeat(2);
    const bodyP6 = "The sixth and final finding outlines the timeline for implementation of the proposed changes and the monitoring framework to be established.".repeat(2);

    const bodyPs = [bodyP1, bodyP2, bodyP3, bodyP4, bodyP5, bodyP6].map((t) => `<p>${t}</p>`).join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Infrastructure Investigation</title>
<meta name="description" content="${lead}" />
</head>
<body>
  <article>
    <h1>Infrastructure Investigation</h1>
    <div class="lead">
      <p><strong>${lead}</strong></p>
    </div>
    <div class="article-content">
      ${bodyPs}
    </div>
    <div class="tags">
      <a href="/tag/infrastructure">Infrastructure</a>
      <a href="/tag/governance">Governance</a>
    </div>
  </article>
  <aside class="related">
    <h3>Related articles</h3>
    <a href="/story1">Similar investigation in another region</a>
    <a href="/story2">Government responds to findings</a>
  </aside>
  <footer>Copyright 2026</footer>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 300,
      articleUrl: "https://pecaverzum.example.com/investigation",
      existingTitle: "Infrastructure Investigation",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // bodyText should include many body paragraphs, not just lead
      expect(result.bodyText!.length).toBeGreaterThan(lead.length * 3);
      expect(result.bodyText).toContain("first major finding");
      expect(result.bodyText).toContain("sixth and final finding");
      // Should exclude tags/related/footer
      expect(result.bodyText).not.toContain("Infrastructure"); // tag link text
      expect(result.bodyText).not.toContain("Similar investigation");
      expect(result.bodyText).not.toContain("Copyright");
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(5);
    }
  });

  it("Test B: NBA-like — subtitle + official release with long body", async () => {
    const subtitle = "The league today announced major rule changes for the upcoming season affecting all thirty teams.";
    const bodyP1 = "The first major rule change affects the way games are officiated during the regular season and the playoff period for all teams.".repeat(2);
    const bodyP2 = "The implementation timeline spans a two-year period with careful monitoring of the impact on competitive balance and player safety.".repeat(2);
    const bodyP3 = "Players and coaches have expressed mixed reactions to the announced changes with some supporting the reforms and others raising concerns.".repeat(2);
    const bodyP4 = "Additional analysis from team executives and league officials suggests the changes will have a significant positive impact on the game.".repeat(2);
    const bodyP5 = "The financial implications of these rule changes are expected to affect salary cap calculations for multiple seasons going forward.".repeat(2);
    const bodyP6 = "The league also announced changes to the draft lottery system that will take effect beginning with the next offseason period.".repeat(2);

    const bodyPs = [bodyP1, bodyP2, bodyP3, bodyP4, bodyP5, bodyP6].map((t) => `<p>${t}</p>`).join("\n      ");

    const html = `<!DOCTYPE html>
<html><head><title>League Rule Changes</title>
<meta property="og:description" content="${subtitle}" />
</head>
<body>
  <article>
    <h1>League Rule Changes</h1>
    <p class="summary">${subtitle}</p>
    <p class="byline">Official release from league offices</p>
    ${bodyPs}
  </article>
  <div class="more-stories">
    <h3>More stories</h3>
    <a href="/story1">Team previews for the upcoming season</a>
    <a href="/story2">Player rankings updated for new rules</a>
  </div>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 301,
      articleUrl: "https://nba.example.com/rule-changes",
      existingTitle: "League Rule Changes",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should include long body, not just subtitle
      expect(result.bodyText!.length).toBeGreaterThan(subtitle.length * 5);
      expect(result.bodyText).toContain("rule change affects");
      expect(result.bodyText).toContain("draft lottery");
      // Should NOT include more-stories content
      expect(result.bodyText).not.toContain("More stories");
      expect(result.bodyText).not.toContain("Team previews");
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(5);
    }
  });

  it("Test C: RTE-like — article body + More by section stops collection", async () => {
    const bodyP1 = "The government announced new measures today to address the growing concerns raised by citizens across the country about public services.".repeat(2);
    const bodyP2 = "The first policy measure focuses on increasing funding for healthcare services in underserved communities throughout the nation.".repeat(2);
    const bodyP3 = "The second measure addresses education reform with particular emphasis on improving access to technology in rural schools.".repeat(2);
    const bodyP4 = "The third measure introduces new environmental protections that will affect industrial operations near residential neighborhoods.".repeat(2);
    const bodyP5 = "Opposition parties have criticized the announcement as insufficient and called for more comprehensive reforms to the existing system.".repeat(2);

    const bodyPs = [bodyP1, bodyP2, bodyP3, bodyP4, bodyP5].map((t) => `<p>${t}</p>`).join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Government Policy Announcement</title>
<meta property="og:description" content="New measures announced today" />
</head>
<body>
  <article>
    <h1>Government Policy Announcement</h1>
    <div class="story-header">
      <p class="subtitle">New measures to address public concerns</p>
      <div class="byline">By Paul Reynolds, Political Correspondent</div>
    </div>
    <div class="story-body">
      ${bodyPs}
    </div>
    <div class="social-share">
      <a href="/share">Share</a>
    </div>
    <div class="more-by-author">
      <h3>More by Paul Reynolds</h3>
      <a href="/story-a">Victims describe their experiences with the previous policy framework</a>
      <a href="/story-b">Investigation after allegations of misconduct surface in ministry</a>
      <a href="/story-c">Analysis of the political implications for the ruling coalition</a>
    </div>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 302,
      articleUrl: "https://rte.example.com/policy",
      existingTitle: "Government Policy Announcement",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should include body paragraphs
      expect(result.bodyText).toContain("policy measure focuses");
      expect(result.bodyText).toContain("Opposition parties");
      // Should NOT include more-by-author content
      expect(result.bodyText).not.toContain("More by Paul Reynolds");
      expect(result.bodyText).not.toContain("Victims describe");
      expect(result.bodyText).not.toContain("Investigation after");
      // Should NOT include share links
      expect(result.bodyText).not.toContain("Share");
      // Should NOT include more-by-author content
      expect(result.bodyText).not.toContain("More by Paul Reynolds");
      // Body should include all the policy paragraphs
      expect(result.bodyText).toContain("policy measure focuses");
      expect(result.bodyText).toContain("Opposition parties");
    }
  });

  it("Test D: Most Read sidebar does not contaminate body", async () => {
    const bodyP1 = "The central bank announced a new interest rate policy that will affect lending markets across the eurozone for the foreseeable future.".repeat(2);
    const bodyP2 = "Economists have broadly welcomed the decision saying it provides much needed stability for financial markets during uncertain times.".repeat(2);
    const bodyP3 = "The policy will take effect next month and is expected to influence mortgage rates and business lending terms significantly.".repeat(2);

    const bodyPs = [bodyP1, bodyP2, bodyP3].map((t) => `<p>${t}</p>`).join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Central Bank Policy</title>
<meta property="og:description" content="Interest rate decision" />
</head>
<body>
  <main>
    <article>
      <h1>Central Bank Policy</h1>
      ${bodyPs}
    </article>
    <aside>
      <h3>Most Read</h3>
      <ul>
        <li><a href="/popular1">Celebrity wedding photos go viral</a></li>
        <li><a href="/popular2">Sports team wins championship final</a></li>
        <li><a href="/popular3">Weather warning issued for the weekend</a></li>
      </ul>
    </aside>
  </main>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 303,
      articleUrl: "https://news.example.com/central-bank",
      existingTitle: "Central Bank Policy",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should include article body
      expect(result.bodyText).toContain("central bank");
      expect(result.bodyText).toContain("interest rate");
      // Should NOT include Most Read sidebar
      expect(result.bodyText).not.toContain("Most Read");
      expect(result.bodyText).not.toContain("Celebrity wedding");
      expect(result.bodyText).not.toContain("Sports team wins");
      expect(result.bodyText).not.toContain("Weather warning");
    }
  });

  it("Test E: Related heading after body — collection stops before related section", async () => {
    const bodyP1 = "The research team published their findings today after three years of extensive fieldwork across multiple continents and diverse ecosystems.".repeat(2);
    const bodyP2 = "The study found significant correlations between climate patterns and biodiversity loss in tropical regions of the world today.".repeat(2);
    const bodyP3 = "Conservation efforts have been stepped up in response to the findings with several governments pledging additional funding for research.".repeat(2);
    const bodyP4 = "The lead researcher said the results exceeded expectations and provide a solid foundation for future policy development globally.".repeat(2);
    const bodyP5 = "The full dataset will be made available to other researchers through an open access portal later this year for further analysis.".repeat(2);

    const bodyPs = [bodyP1, bodyP2, bodyP3, bodyP4, bodyP5].map((t) => `<p>${t}</p>`).join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Biodiversity Study</title>
<meta property="og:description" content="Major research findings" />
</head>
<body>
  <article>
    <h1>Biodiversity Study</h1>
    ${bodyPs}
    <section class="related">
      <h2>Related articles</h2>
      <a href="/rel1">Climate change impact on marine life</a>
      <a href="/rel2">New conservation zones established</a>
      <a href="/rel3">Interview with lead researcher</a>
    </section>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 304,
      articleUrl: "https://science.example.com/biodiversity",
      existingTitle: "Biodiversity Study",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should include body paragraphs
      expect(result.bodyText).toContain("research team published");
      expect(result.bodyText).toContain("open access portal");
      // Should NOT include related section
      expect(result.bodyText).not.toContain("Related articles");
      expect(result.bodyText).not.toContain("Climate change impact");
      expect(result.bodyText).not.toContain("conservation zones");
    }
  });

  it("Test F: Valid section heading inside article is not treated as boundary", async () => {
    const bodyP1 = "The company released its annual report today showing strong growth across all major business segments and geographic regions worldwide.".repeat(2);
    const bodyP2 = "Revenue increased by twelve percent year over year driven by expansion into new markets and increased customer adoption rates.".repeat(2);
    const bodyP3 = "The board of directors approved a new share buyback program worth several billion dollars to return value to shareholders.".repeat(2);
    const bodyP4 = "Looking ahead the company plans to invest heavily in artificial intelligence and machine learning capabilities for its core products.".repeat(2);
    const bodyP5 = "The chief executive officer expressed confidence in the company's strategic direction and long term growth prospects for the future.".repeat(2);

    const bodyPs = [bodyP1, bodyP2].map((t) => `<p>${t}</p>`).join("\n    ");
    const afterHeading = [bodyP3, bodyP4, bodyP5].map((t) => `<p>${t}</p>`).join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Annual Report</title>
<meta property="og:description" content="Strong growth reported" />
</head>
<body>
  <article>
    <h1>Annual Report</h1>
    ${bodyPs}
    <h2>Financial Highlights</h2>
    ${afterHeading}
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 305,
      articleUrl: "https://finance.example.com/annual-report",
      existingTitle: "Annual Report",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should include ALL body paragraphs including those after the section heading
      expect(result.bodyText).toContain("company released its annual report");
      expect(result.bodyText).toContain("share buyback program");
      expect(result.bodyText).toContain("artificial intelligence");
      expect(result.bodyText).toContain("chief executive officer");
      // Financial Highlights heading should not cause a boundary stop
      expect(result.bodyText!.length).toBeGreaterThan(500);
    }
  });

  it("uses Mozilla Readability when custom DOM extraction finds no usable body", async () => {
    vi.resetModules();
    vi.doMock("@mozilla/readability", () => ({
      Readability: class {
        parse() {
          const paragraphs = Array.from({ length: 5 }, (_, index) =>
            `<p>${`Readability paragraph ${index + 1} contains detailed article body text with enough substance to pass the quality gate and represent real content. `.repeat(3)}</p>`,
          ).join("");
          return {
            title: "Readability Article",
            content: paragraphs,
            textContent: paragraphs.replace(/<[^>]+>/g, " "),
          };
        }
      },
    }));

    const html = `<!DOCTYPE html><html><head>
      <title>Readability Article</title>
      <meta property="og:description" content="Short teaser only" />
    </head><body>
      <main><span>Menu</span><span>Share</span><span>Advert</span></main>
    </body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 401,
      articleUrl: "https://example.com/readability-only",
      existingTitle: "Readability Article",
    });

    vi.doUnmock("@mozilla/readability");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics.bodySource).toBe("readability");
      expect(result.bodyText).toContain("Readability paragraph 1");
      expect(result.qualitySignals).toContain("selector:readability");
    }
  });

  it("does not replace a strong custom DOM body with shorter Readability output", async () => {
    vi.resetModules();
    vi.doMock("@mozilla/readability", () => ({
      Readability: class {
        parse() {
          return {
            title: "Short Readability Article",
            content: `<p>${"Short readability paragraph with enough words to be meaningful but not enough to beat the custom extraction. ".repeat(8)}</p>`,
            textContent: "Short readability paragraph with enough words to be meaningful but not enough to beat the custom extraction. ".repeat(8),
          };
        }
      },
    }));

    const html = articleHtml();
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 402,
      articleUrl: "https://example.com/custom-wins",
      existingTitle: "Test Article Title",
    });

    vi.doUnmock("@mozilla/readability");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics.bodySource).not.toBe("readability");
      expect(result.bodyText).toContain("The first paragraph introduces");
    }
  });
});

describe("lead/credit/truncation hardening regressions", () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  it("Test G: lead+credit container followed by real body — extracts full body, not truncated lead", async () => {
    // Scenario: container has credit/byline at top, followed by real paragraphs.
    // The extractor must not stop after the credit line.
    const credit = "By Staff Reporter, National Affairs Correspondent";
    const summary = "The government today unveiled a comprehensive package of measures designed to address long-standing concerns about public infrastructure across the country.";
    const bodyP1 = "The first major component of the package focuses on expanding healthcare access in rural communities where residents have historically struggled to receive adequate medical attention and treatment options.".repeat(2);
    const bodyP2 = "The second component introduces new funding mechanisms for education reform including technology upgrades in schools and teacher training programs that will begin next academic year.".repeat(2);
    const bodyP3 = "The third component addresses transportation infrastructure with a multi-year plan to upgrade bridges highways and public transit systems in major metropolitan areas.".repeat(2);
    const bodyP4 = "The fourth component introduces environmental safeguards that will require impact assessments before major construction projects can proceed in ecologically sensitive areas.".repeat(2);
    const bodyP5 = "Opposition lawmakers criticized the package as insufficient arguing that the proposed funding levels fall short of what is needed to address the scale of the infrastructure challenges facing the nation.".repeat(2);

    const bodyPs = [bodyP1, bodyP2, bodyP3, bodyP4, bodyP5].map((t) => `<p>${t}</p>`).join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Infrastructure Package</title>
<meta property="og:description" content="${summary}" />
</head>
<body>
  <article>
    <div class="story-header">
      <h1>Infrastructure Package Announced</h1>
      <p class="byline">${credit}</p>
      <p class="lead">${summary}</p>
    </div>
    <div class="story-body">
      ${bodyPs}
    </div>
    <div class="related">
      <h3>Related Stories</h3>
      <a href="/s1">Previous infrastructure report</a>
    </div>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 500,
      articleUrl: "https://example.com/infrastructure-package",
      existingTitle: "Infrastructure Package",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must contain ALL body paragraphs, not just the credit/lead
      expect(result.bodyText).toContain("healthcare access");
      expect(result.bodyText).toContain("education reform");
      expect(result.bodyText).toContain("transportation infrastructure");
      expect(result.bodyText).toContain("environmental safeguards");
      expect(result.bodyText).toContain("Opposition lawmakers");
      // Must NOT contain related stories
      expect(result.bodyText).not.toContain("Related Stories");
      expect(result.bodyText).not.toContain("Previous infrastructure");
      // Body should be much longer than just the credit + summary
      expect(result.bodyText!.length).toBeGreaterThan(summary.length * 3);
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(3);
    }
  });

  it("Test H: extractor prefers substantive multi-paragraph content over short lead fragment", async () => {
    // Two containers: one is a short lead div, the other is the real body div.
    // The real body should win even if the lead div has a semantic advantage.
    const leadText = "A brief overview of the situation.";
    const bodyP1 = "The detailed investigation reveals significant patterns in how public funds were allocated across multiple agencies and departments over the past several years.".repeat(2);
    const bodyP2 = "Witnesses described a systematic process whereby decisions were made without proper oversight or accountability mechanisms in place to prevent misuse of resources.".repeat(2);
    const bodyP3 = "The commission recommends sweeping changes to the governance structure including new reporting requirements and independent auditing procedures for all public expenditures.".repeat(2);
    const bodyP4 = "Legal experts say the findings could have far reaching implications for similar investigations currently underway in other jurisdictions across the country.".repeat(2);

    const bodyPs = [bodyP1, bodyP2, bodyP3, bodyP4].map((t) => `<p>${t}</p>`).join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Investigation Findings</title>
<meta property="og:description" content="${leadText}" />
</head>
<body>
  <main>
    <div class="lead-summary">
      <p>${leadText}</p>
    </div>
    <div class="article-body">
      ${bodyPs}
    </div>
  </main>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 501,
      articleUrl: "https://example.com/investigation-findings",
      existingTitle: "Investigation Findings",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must include the full body paragraphs
      expect(result.bodyText).toContain("detailed investigation");
      expect(result.bodyText).toContain("systematic process");
      expect(result.bodyText).toContain("sweeping changes");
      expect(result.bodyText).toContain("far reaching implications");
      expect(result.bodyText!.length).toBeGreaterThan(leadText.length * 10);
    }
  });

  it("Test I: valid short article still passes — genuinely complete small article not rejected", async () => {
    // A short but complete article: 3 substantive paragraphs, no hidden content.
    // Must NOT be rejected as lead-dominated or truncated.
    const p1 = "The local council voted unanimously tonight to approve the new community center project that residents have been requesting for over five years.".repeat(2);
    const p2 = "Construction is expected to begin in the spring with an estimated completion date of eighteen months from the start of work on the facility.".repeat(2);
    const p3 = "The center will include meeting rooms a gymnasium and a library space that can be used by community groups and organizations throughout the year.".repeat(2);

    const html = `<!DOCTYPE html>
<html><head><title>Community Center Approved</title>
<meta property="og:description" content="Council approves new community center" />
</head>
<body>
  <article>
    <h1>Community Center Approved</h1>
    <p>${p1}</p>
    <p>${p2}</p>
    <p>${p3}</p>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 502,
      articleUrl: "https://example.com/community-center",
      existingTitle: "Community Center Approved",
    });

    // Must succeed — this is a legitimate short article
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText).toContain("local council voted");
      expect(result.bodyText).toContain("Construction is expected");
      expect(result.bodyText).toContain("meeting rooms");
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(3);
      // No skipped candidates — first candidate should pass all checks
      expect(result.diagnostics.skippedCandidateReasons).toEqual([]);
    }
  });

  it("Test J: diagnostics include textYieldRatio and skippedCandidateReasons", async () => {
    const html = articleHtml();
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 503,
      articleUrl: "https://example.com/diag-yield",
      existingTitle: "Test Article Title",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // New diagnostics fields exist
      expect(Array.isArray(result.diagnostics.skippedCandidateReasons)).toBe(true);
      // topCandidates should include textYieldRatio
      if (result.diagnostics.topCandidates.length > 0) {
        expect(typeof result.diagnostics.topCandidates[0]!.textYieldRatio).toBe("number");
        expect(result.diagnostics.topCandidates[0]!.textYieldRatio).toBeGreaterThan(0);
        expect(result.diagnostics.topCandidates[0]!.textYieldRatio).toBeLessThanOrEqual(1);
      }
    }
  });

  it("Test K: container with lead-dominant opening gets penalized in scoring", async () => {
    // A container where the first paragraph is very short (credit line) and the
    // rest are normal. The lead_dominant_opening penalty should reduce its score.
    const credit = "By Jonathan Smith, Senior Investigative Reporter for the National Affairs Desk";
    const p1 = "The investigation spans multiple years of research and analysis into the matter at hand and reveals important patterns.".repeat(4);
    const p2 = "Additional findings reveal systemic issues that extend beyond the initial scope of the inquiry into public accountability and governance.".repeat(4);
    const p3 = "The final report recommends significant reforms to prevent similar problems from occurring in the future of public administration policy.".repeat(4);

    const html = `<!DOCTYPE html>
<html><title>Report</title>
<meta property="og:description" content="Investigation report" />
<body>
  <article>
    <p>${credit}</p>
    <p>${p1}</p>
    <p>${p2}</p>
    <p>${p3}</p>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 504,
      articleUrl: "https://example.com/lead-penalty",
      existingTitle: "Report",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should still extract the full body despite the credit line
      expect(result.bodyText).toContain("investigation spans");
      expect(result.bodyText).toContain("systemic issues");
      expect(result.bodyText).toContain("significant reforms");
      // The lead_dominant_opening penalty should have been applied
      expect(result.diagnostics.scoreReasons).toContain("lead_dominant_opening");
    }
  });

  it("Test L: retry loop skips failing candidate and selects the next valid one", async () => {
    // Deterministic retry-loop test:
    // - The <article> is wrapped in <div class="intro"> to isolate it from
    //   sibling expansion. This prevents the article's sibling expansion from
    //   absorbing the div's paragraphs, and prevents the div's sibling expansion
    //   from absorbing the article's paragraphs (isLeadLikeContainer skips
    //   /intro/i matched elements).
    // - candidate 0: <div class="intro"> wrapper — 5 paragraphs total, scores
    //   highest, but fails isLeadDominatedBody (matched by /intro/i).
    // - candidate 1: <article> — 2 unique paragraphs (~420 chars). Semantic
    //   +15 bonus, but fails isUsableBody (2 < 800 for Gate 2).
    // - candidate 2: <div class="story-text"> — 3 long paragraphs (~960 chars).
    //   Passes isUsableBody Gate 1 (3+ paragraphs, >= 500 chars).
    // Two DIFFERENT paragraphs (avoid dedup) totaling ~420 chars.
    const articleP1 = "The opening paragraph of this report provides a comprehensive overview of the key findings discovered during the investigation and sets the stage for the detailed analysis that follows in subsequent sections of this document.";
    const articleP2 = "The second introductory paragraph summarizes the methodology used in the investigation and highlights the most significant evidence uncovered during the extensive research phase conducted over several months.";

    const longP1 = "The first real article paragraph provides detailed analysis of the current situation and its implications for the broader community of stakeholders involved in the process.".repeat(2);
    const longP2 = "The second real article paragraph continues with additional evidence and expert commentary on the significance of recent developments in the field of study.".repeat(2);
    const longP3 = "The third real article paragraph concludes with recommendations and a summary of key findings from the investigation into the matter at hand.".repeat(2);

    // Wrap the article in a non-lead-like <div> so that:
    // 1. The article's sibling expansion cannot reach the story-text div
    //    (the article is the only child of its wrapper)
    // 2. The wrapper div is not a semantic candidate (no matching selector)
    //    and has the same 2 paragraphs as the article, so it scores lower
    //    and is skipped first as not_usable
    // 3. The story-text div's sibling expansion tries the wrapper, but
    //    isLeadLikeContainer skips it (class contains /intro/i)
    const html = `<!DOCTYPE html>
<html><head><title>Retry Test</title>
<meta property="og:description" content="Test retry loop" />
</head>
<body>
  <div class="article-intro">
    <article>
      <p>${articleP1}</p>
      <p>${articleP2}</p>
    </article>
  </div>
  <div class="story-text">
    <p>${longP1}</p>
    <p>${longP2}</p>
    <p>${longP3}</p>
  </div>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 505,
      articleUrl: "https://example.com/retry-test",
      existingTitle: "Retry Test",
    });

    // Must succeed — the retry loop selects candidate 1
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Body should contain the div content, not the article content
      expect(result.bodyText).toContain("first real article paragraph");
      expect(result.bodyText).toContain("third real article paragraph");
      expect(result.bodyText).not.toContain("opening paragraph of this report");
      // skippedCandidateReasons must record why candidate 0 was skipped
      expect(result.diagnostics.skippedCandidateReasons.length).toBeGreaterThanOrEqual(1);
      expect(result.diagnostics.skippedCandidateReasons[0]).toBe("candidate_0:not_usable");
      expect(result.diagnostics.selectedContainerSelector).toBe("div/section");
      expect(result.diagnostics.topCandidates[0]?.selector).not.toBe(
        result.diagnostics.selectedContainerSelector,
      );
    }
  });

  it("Test L-fail: without retry loop, the failing candidate causes extraction failure", async () => {
    // Same fixture as Test L but only the failing candidate exists.
    // This proves the retry loop is necessary: without a second candidate,
    // extraction fails. Uses unique paragraphs to avoid dedup.
    const failP1 = "The opening paragraph of this report provides a brief overview of the key findings and sets the stage for the detailed analysis that follows in subsequent sections.";
    const failP2 = "The second introductory paragraph summarizes the methodology used in the investigation and highlights the most significant evidence uncovered during the research.";

    const html = `<!DOCTYPE html>
<html><title>Fail Only</title>
<meta property="og:description" content="Test" />
<body>
  <article>
    <p>${failP1}</p>
    <p>${failP2}</p>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 505,
      articleUrl: "https://example.com/fail-only",
      existingTitle: "Fail Only",
    });

    // Must fail — the only candidate doesn't pass isUsableBody
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Diagnostics should still record why the candidate was skipped
      expect(result.diagnostics.skippedCandidateReasons.length).toBeGreaterThanOrEqual(1);
      expect(result.diagnostics.skippedCandidateReasons[0]).toContain("not_usable");
      expect(result.diagnostics.topCandidates.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("Test M: boilerplate-heavy wrapper does not cause false truncation rejection", async () => {
    // A valid multi-paragraph article inside a large wrapper with nav/header/footer/sidebar.
    // The wrapper inflates rawTextLength, but cleanedTextLength should be reasonable
    // because boilerplate is stripped before the truncation check.
    const p1 = "The central bank announced a new interest rate policy that will affect lending markets across the eurozone for the foreseeable future.".repeat(2);
    const p2 = "Economists have broadly welcomed the decision saying it provides much needed stability for financial markets during uncertain times.".repeat(2);
    const p3 = "The policy will take effect next month and is expected to influence mortgage rates and business lending terms significantly.".repeat(2);
    const p4 = "Industry analysts predict the changes will lead to increased economic activity in the housing sector over the coming quarters.".repeat(2);
    const p5 = "The central bank governor expressed confidence that the new policy framework will achieve its stated objectives.".repeat(2);

    const bodyPs = [p1, p2, p3, p4, p5].map((t) => `<p>${t}</p>`).join("\n    ");

    const html = `<!DOCTYPE html>
<html><head><title>Rate Decision</title>
<meta property="og:description" content="Interest rate decision" />
</head>
<body>
  <nav>${"Navigation link item ".repeat(40)}</nav>
  <header>${"Header content area ".repeat(40)}</header>
  <main>
    <article>
      <h1>Rate Decision</h1>
      ${bodyPs}
    </article>
    <aside>${"Sidebar widget content ".repeat(40)}</aside>
  </main>
  <footer>${"Footer content area ".repeat(40)}</footer>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 506,
      articleUrl: "https://example.com/rate-decision",
      existingTitle: "Rate Decision",
    });

    // Must succeed — boilerplate-heavy wrapper should not cause false rejection
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText).toContain("central bank announced");
      expect(result.bodyText).toContain("central bank governor");
      expect(result.bodyText).not.toContain("Navigation link");
      expect(result.bodyText).not.toContain("Sidebar widget");
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(5);
    }
  });

  it("Test M-truncation: truncated-only candidate is detected and extraction fails cleanly", async () => {
    // A single <article> with 3 paragraphs (~320 chars each after .repeat(2) = ~960 total)
    // inside a container with ~3000 chars of span text. The article passes
    // isUsableBody (3+ paragraphs, 960+ chars, Gate 1) but fails isTruncatedExtraction
    // (yield ~0.24 < 0.30 with < 4 paragraphs). No alternative candidate exists.
    // Readability is mocked to return null, so extraction must fail cleanly.
    vi.resetModules();
    vi.doMock("@mozilla/readability", () => ({
      Readability: class {
        parse() { return null; }
      },
    }));

    const bigSpan = "Metadata label content ".repeat(150); // ~3000 chars in a span
    const p1 = "The first paragraph of the article provides meaningful context about the situation and discusses the key implications for stakeholders involved in the matter.".repeat(2);
    const p2 = "The second paragraph adds additional detail to the overall narrative and presents supporting evidence from multiple sources consulted during the research phase.".repeat(2);
    const p3 = "The third paragraph wraps up the available content and provides concluding remarks about the significance of the findings presented in this article.".repeat(2);

    const html = `<!DOCTYPE html>
<html><head><title>Truncated</title>
<meta property="og:description" content="Test truncation" />
</head>
<body>
  <article>
    <h1>Truncated Article</h1>
    <span>${bigSpan}</span>
    <p>${p1}</p>
    <p>${p2}</p>
    <p>${p3}</p>
  </article>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 507,
      articleUrl: "https://example.com/truncated-test",
      existingTitle: "Truncated",
    });

    vi.doUnmock("@mozilla/readability");

    // Must fail — the only candidate is truncated and no alternative exists
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["too_short", "no_article_text"]).toContain(result.rejectedReason);
      // skippedCandidateReasons must record exactly why the candidate was rejected.
      // The article passes isUsableBody (3 paragraphs, ~540 chars, Gate 1) but
      // fails isTruncatedExtraction (yield ~0.15 < 0.30 with < 4 paragraphs).
      expect(result.diagnostics.skippedCandidateReasons.length).toBeGreaterThanOrEqual(1);
      expect(result.diagnostics.skippedCandidateReasons[0]).toContain("truncated_extraction");
      // topCandidates must be preserved even though extraction failed
      expect(result.diagnostics.topCandidates.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("Test M-all-fail: all candidates fail diagnostics are preserved in rejection", async () => {
    // Every candidate is too short to pass isUsableBody. Extraction must fail
    // with a clear rejection reason. Diagnostics must preserve skippedCandidateReasons
    // and topCandidates even though no body was extracted.
    // Use paragraphs that are meaningful enough to create candidates (pass
    // scoreCandidate) but too short to pass isUsableBody.
    // 2 paragraphs of ~130 chars each = ~260 total. Fails Gate 1 (< 500 chars
    // with only 2 paragraphs) and Gate 2 (< 800 chars).
    const shortPara = "This paragraph is just long enough to pass the meaningful paragraph filter but not long enough to qualify as a usable article body for extraction purposes.";

    const html = `<!DOCTYPE html>
<html><head><title>All Fail</title>
<meta property="og:description" content="Test all fail" />
</head>
<body>
  <article>
    <h1>All Fail</h1>
    <p>${shortPara}</p>
    <p>${shortPara}</p>
  </article>
  <div class="content">
    <h2>Content</h2>
    <p>${shortPara}</p>
    <p>${shortPara}</p>
  </div>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 508,
      articleUrl: "https://example.com/all-fail",
      existingTitle: "All Fail",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["too_short", "no_article_text"]).toContain(result.rejectedReason);
      // Diagnostics must survive total failure
      expect(result.diagnostics.topCandidates.length).toBeGreaterThanOrEqual(1);
      // skippedCandidateReasons must be populated with failure reasons
      expect(result.diagnostics.skippedCandidateReasons.length).toBeGreaterThanOrEqual(1);
      expect(result.diagnostics.skippedCandidateReasons.some((r: string) => r.includes("not_usable"))).toBe(true);
    }
  });

  it("Test N: same-container credit-first extraction — credit paragraph + real paragraphs in one article", async () => {
    // A single <article> container where the first direct child is a short
    // credit/byline paragraph, followed by multiple substantive article paragraphs.
    // There is no separate story-body div. The extractor must capture ALL
    // paragraphs, not stop after the credit.
    const credit = "By Sarah Johnson, Senior Correspondent for the National Desk reporting from the capital city.";
    const p1 = "The first major section of the article explores the historical context and background of the topic in considerable depth with expert analysis.".repeat(2);
    const p2 = "The second section examines current trends and data providing evidence-based insights into the present situation and its implications.".repeat(2);
    const p3 = "The third section analyzes potential future implications and what experts predict will happen next in this evolving situation.".repeat(2);
    const p4 = "The fourth section discusses counterarguments and alternative perspectives on the issue at hand from multiple viewpoints.".repeat(2);
    const p5 = "The fifth section presents case studies that illustrate the practical applications of the concepts discussed throughout the article.".repeat(2);

    const html = `<!DOCTYPE html>
<html><head><title>Same Container Article</title>
<meta property="og:description" content="A test article" />
</head>
<body>
  <article>
    <h1>Same Container Article</h1>
    <p>${credit}</p>
    <p>${p1}</p>
    <p>${p2}</p>
    <p>${p3}</p>
    <p>${p4}</p>
    <p>${p5}</p>
  </article>
  <aside class="related">
    <h3>Related stories</h3>
    <a href="/r1">Related story one</a>
  </aside>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 509,
      articleUrl: "https://example.com/same-container",
      existingTitle: "Same Container Article",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must contain ALL body paragraphs including the credit
      expect(result.bodyText).toContain("Sarah Johnson");
      expect(result.bodyText).toContain("historical context");
      expect(result.bodyText).toContain("current trends");
      expect(result.bodyText).toContain("future implications");
      expect(result.bodyText).toContain("counterarguments");
      expect(result.bodyText).toContain("case studies");
      // Must NOT contain related stories
      expect(result.bodyText).not.toContain("Related stories");
      expect(result.bodyText).not.toContain("Related story one");
      // Must have 6+ paragraphs (credit + 5 body)
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(6);
    }
  });

  it("Test O: valid short article in moderately noisy wrapper is accepted", async () => {
    // A short but complete article (3 paragraphs) inside a wrapper with some
    // sidebar and footer content. Must not be rejected as truncated.
    const p1 = "The local council voted tonight to approve the community center project that residents have been requesting.".repeat(2);
    const p2 = "Construction is expected to begin in the spring with an estimated completion date of eighteen months.".repeat(2);
    const p3 = "The center will include meeting rooms a gymnasium and a library space for community use.".repeat(2);

    const html = `<!DOCTYPE html>
<html><head><title>Short Article</title>
<meta property="og:description" content="Short news" />
</head>
<body>
  <main>
    <article>
      <h1>Short Article</h1>
      <p>${p1}</p>
      <p>${p2}</p>
      <p>${p3}</p>
    </article>
    <aside>${"Sidebar widget content here ".repeat(20)}</aside>
  </main>
  <footer>${"Footer links and information ".repeat(20)}</footer>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const { extractArticleContentFromUrl } = await import("./article-content-extractor");
    const result = await extractArticleContentFromUrl({
      articleId: 510,
      articleUrl: "https://example.com/short-noisy",
      existingTitle: "Short Article",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText).toContain("local council voted");
      expect(result.bodyText).toContain("Construction is expected");
      expect(result.bodyText).toContain("meeting rooms");
      expect(result.bodyText).not.toContain("Sidebar widget");
      expect(result.bodyText).not.toContain("Footer links");
      expect(result.diagnostics.selectedContainerParagraphCount).toBeGreaterThanOrEqual(3);
    }
  });

  it("Test P: isTruncatedExtraction unit check — uses cleanedTextLength not raw", async () => {
    // Verify that isTruncatedExtraction uses cleanedTextLength (after boilerplate
    // stripping) rather than rawTextLength. A container with lots of boilerplate
    // that inflates rawTextLength should NOT trigger truncation when the cleaned
    // text is proportional to extracted content.
    const { extractArticleContentFromUrl } = await import("./article-content-extractor");

    // This is the same as Test M (boilerplate-heavy) — if it passes, the
    // cleanedTextLength-based check is working.
    const p1 = "The research team published their findings today after three years of extensive fieldwork.".repeat(3);
    const p2 = "The study found significant correlations between climate patterns and biodiversity loss.".repeat(3);
    const p3 = "Conservation efforts have been stepped up in response to the findings.".repeat(3);

    const bodyPs = [p1, p2, p3].map((t) => `<p>${t}</p>`).join("\n    ");

    const html = `<!DOCTYPE html>
<html><title>Research</title>
<meta property="og:description" content="Research findings" />
<body>
  <nav>${"Nav link ".repeat(60)}</nav>
  <header>${"Header ".repeat(60)}</header>
  <article>
    <h1>Research Findings</h1>
    ${bodyPs}
  </article>
  <aside>${"Sidebar ".repeat(60)}</aside>
  <footer>${"Footer ".repeat(60)}</footer>
</body></html>`;
    safeFetchMock.mockResolvedValue(makeResponse(html));

    const result = await extractArticleContentFromUrl({
      articleId: 511,
      articleUrl: "https://example.com/research-cleaned",
      existingTitle: "Research",
    });

    // Must succeed — boilerplate should not cause false truncation
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText).toContain("research team");
      expect(result.bodyText).toContain("biodiversity");
      expect(result.bodyText).toContain("Conservation");
    }
  });
});

describe("text normalization helpers", () => {
  it("collapseWhitespace preserves paragraph boundaries", async () => {
    const { collapseWhitespace } = await import("./article-content-extractor");
    const input = "Hello   world\n\n\n\nSecond   paragraph";
    const result = collapseWhitespace(input);
    expect(result).toBe("Hello world\n\nSecond paragraph");
  });

  it("extractMeaningfulParagraphs filters short fragments", async () => {
    const { extractMeaningfulParagraphs } = await import("./article-content-extractor");

    // Create a minimal DOM-like element with mix of short and long paragraphs
    const { JSDOM } = await import("./jsdom-runtime").then((module) => module.loadJsdom());
    const dom = new JSDOM(`<div>
      <p>Hi</p>
      <p>This is a meaningful paragraph that should be extracted because it has enough words and characters to pass the filter.</p>
      <p>OK</p>
      <p>Another</p>
    </div>`);
    const container = dom.window.document.querySelector("div")!;
    const paragraphs = extractMeaningfulParagraphs(container);

    // Very short paragraphs should be filtered out
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0]).toContain("meaningful paragraph");
  });
});
