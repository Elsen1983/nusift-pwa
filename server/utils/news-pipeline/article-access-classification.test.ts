import { describe, expect, it } from "vitest";
import { classifyEarlyAccessHint } from "./paywall-detection";
import {
  ARTICLE_ACCESS_DETECTOR_VERSION,
  classifyArticleAccess,
  extractJsonLdPaywallSignalsFromMarkup,
  extractJsonLdPaywallSignalsFromValue,
  isSubstantialBodyText,
  mapClassificationToIsPaywall,
  type ArticleAccessClassification,
  type ArticleAccessClassificationInput,
} from "./article-access-classification";

const baseInput = (over: Partial<ArticleAccessClassificationInput> = {}): ArticleAccessClassificationInput => ({
  statusCode: 200,
  bodyText: null,
  usableBodyExtracted: false,
  bodyTruncationDetected: false,
  rawPageText: "",
  articleScopedGateOrOverlayDetected: false,
  articleScopedCtaTexts: [],
  jsonLdPaywallSignals: [],
  ...over,
});

const FULL_BODY = [
  "The first paragraph of a fully accessible article introduces the topic with enough detail to be useful.",
  "The second paragraph expands on the reporting with additional context and quotes from sources.",
  "The third paragraph continues the analysis with supporting evidence and historical background.",
  "The fourth paragraph concludes the piece with implications and future outlook for readers.",
].join("\n\n");

const expectClassification = (
  input: ArticleAccessClassificationInput,
  expected: ArticleAccessClassification,
) => {
  const result = classifyArticleAccess(input);
  expect(result.classification).toBe(expected);
  return result;
};

describe("isSubstantialBodyText Unicode sentence boundaries", () => {
  it("accepts a sufficiently long CJK body with CJK punctuation", () => {
    const body = `${"これは公開された記事の詳細な本文であり、読者に必要な背景と分析を提供します".repeat(6)}。` +
      `${"追加の段落では新しい事実と関係者の説明を分かりやすく紹介します".repeat(5)}！` +
      `${"最後の段落では調査結果の意味と今後の見通しを慎重にまとめています".repeat(5)}？`;

    expect(body.length).toBeGreaterThanOrEqual(400);
    expect(isSubstantialBodyText(body)).toBe(true);
  });
});

describe("classifyArticleAccess — Prompt 15A regression fixtures", () => {
  it("A: fully accessible article whose topic repeatedly includes paywall/subscription words → ACCESSIBLE", () => {
    const body = [
      "This analysis discusses how the paywall at The Herald changed their business model.",
      "Netflix subscription pricing is also compared against traditional newspaper paywalls.",
      "Being behind a paywall means fewer readers, which is a recurring industry debate.",
      "The author concludes that paywalls are neither good nor bad; it depends on the outlet.",
    ].join("\n\n");
    const result = expectClassification(baseInput({
      bodyText: body,
      usableBodyExtracted: true,
      rawPageText: body,
    }), "ACCESSIBLE");
    expect(result.confidence).toBe("HIGH");
    expect(result.isPaywall).toBe(false);
    // Topic words are only low-confidence context, never decisive.
    expect(result.evidence.some((e) => e.code === "topic_signals")).toBe(false);
    expect(result.contradictingEvidence.some((e) => e.code === "topic_signals")).toBe(true);
  });

  it("B: freely accessible article quoting 'Subscribe to continue reading' about another website → ACCESSIBLE", () => {
    const body = [
      "According to Streaming Weekly, their readers now see 'Subscribe to continue reading'.",
      "The quote describes the other site's registration wall, not this publication's.",
      "This article remains free and openly available to every reader without an account.",
      "The final paragraph wraps up the reporting on third-party subscription practices.",
    ].join("\n\n");
    // The DOM analyzer does not treat an in-body quoted sentence as an
    // article-scoped CTA, so no CTA evidence reaches the classifier.
    const result = expectClassification(baseInput({
      bodyText: body,
      usableBodyExtracted: true,
      rawPageText: body,
    }), "ACCESSIBLE");
    expect(result.isPaywall).toBe(false);
  });

  it("C: navigation/footer Subscribe CTA plus full article body → ACCESSIBLE", () => {
    // Nav/footer chrome is outside the article container, so the analyzer
    // passes no article-scoped CTA text.
    const result = expectClassification(baseInput({
      bodyText: FULL_BODY,
      usableBodyExtracted: true,
      rawPageText: `${FULL_BODY}\nSubscribe to our newsletter\nBecome a subscriber`,
    }), "ACCESSIBLE");
    expect(result.isPaywall).toBe(false);
  });

  it("D: article-scoped 'Subscribe to continue reading' gate plus truncated body → PAYWALL_BLOCKED", () => {
    const result = expectClassification(baseInput({
      bodyText: "This is a very short teaser that gives only the lede.",
      usableBodyExtracted: false,
      bodyTruncationDetected: true,
      articleScopedGateOrOverlayDetected: true,
      articleScopedCtaTexts: ["Subscribe to continue reading this article."],
      rawPageText: "Subscribe to continue reading this article.",
    }), "PAYWALL_BLOCKED");
    expect(result.confidence).toBe("HIGH");
    expect(result.isPaywall).toBe(true);
    expect(result.evidenceArticleScoped).toBe(true);
    expect(result.articleScopedGateOrOverlayDetected).toBe(true);
    expect(result.bodyTruncationDetected).toBe(true);
  });

  it("E: valid article-scoped JSON-LD isAccessibleForFree:false with full readable body and no gate → METERED_OR_DECLARED, isPaywall=false", () => {
    const result = expectClassification(baseInput({
      bodyText: FULL_BODY,
      usableBodyExtracted: true,
      jsonLdPaywallSignals: [
        { code: "isAccessibleForFree:false", nodeType: "NewsArticle", nodeIdentityState: "matched" },
      ],
      rawPageText: FULL_BODY,
    }), "METERED_OR_DECLARED");
    // Metered/declared content is READABLE — never blocking paywall behavior.
    expect(result.isPaywall).toBe(false);
    expect(result.classification).not.toBe("PAYWALL_BLOCKED");
    // Structured classification + evidence remain available for Prompt 15B.
    expect(result.evidence.some((e) => e.code === "jsonld_declared_paywall")).toBe(true);
  });

  it("F: isAccessibleForFree:false on an unrelated JSON-LD article → ignored", () => {
    const markup = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "NewsArticle",
          url: "https://other.example.com/unrelated-story",
          headline: "Unrelated story",
          isAccessibleForFree: false,
        },
      ],
    });
    const scan = extractJsonLdPaywallSignalsFromValue(JSON.parse(markup), "https://current.example.com/story/42");
    expect(scan.signals[0]?.nodeIdentityState).toBe("conflicting");
    // The extractor filters conflicting nodes before calling the classifier.
    const result = expectClassification(baseInput({
      bodyText: FULL_BODY,
      usableBodyExtracted: true,
      jsonLdPaywallSignals: [],
    }), "ACCESSIBLE");
    expect(result.isPaywall).toBe(false);
  });

  it("F1: bare top-level metadata without a supported Article type is ignored", () => {
    const scan = extractJsonLdPaywallSignalsFromValue(
      { isAccessibleForFree: false },
      "https://example.com/story/42",
    );
    expect(scan.signals).toEqual([]);
    expect(scan.articleNodeCount).toBe(0);
  });

  it("F2: matched JSON-LD node is honored; unstated single node is clearly related", () => {
    const matched = extractJsonLdPaywallSignalsFromValue(
      JSON.parse(JSON.stringify({
        "@type": "NewsArticle",
        url: "https://example.com/story/42",
        isAccessibleForFree: false,
      })),
      "https://example.com/story/42?utm_source=rss",
    );
    expect(matched.signals.some((s) => s.nodeIdentityState === "matched")).toBe(true);

    const unstated = extractJsonLdPaywallSignalsFromValue(
      JSON.parse(JSON.stringify({ "@type": "NewsArticle", isAccessibleForFree: false })),
      "https://example.com/story/42",
    );
    expect(unstated.signals[0]?.nodeIdentityState).toBe("unstated");
    expect(unstated.articleNodeCount).toBe(1);
  });

  it("F3: conflicting JSON-LD supplied directly to the classifier is ignored defensively", () => {
    const result = expectClassification(baseInput({
      bodyText: FULL_BODY,
      usableBodyExtracted: true,
      jsonLdPaywallSignals: [{
        code: "isAccessibleForFree:false",
        nodeType: "NewsArticle",
        nodeIdentityState: "conflicting",
      }],
    }), "ACCESSIBLE");
    expect(result.isPaywall).toBe(false);
  });

  it("F4: canonical pathname comparison preserves case and ignores only query/fragment identity noise", () => {
    const conflicting = extractJsonLdPaywallSignalsFromValue({
      "@type": "NewsArticle",
      url: "/news/story",
      isAccessibleForFree: false,
    }, "https://EXAMPLE.com/News/Story?utm_source=rss#read");
    expect(conflicting.signals[0]?.nodeIdentityState).toBe("conflicting");
    expect(conflicting.conflictingNodeCount).toBe(1);

    const matching = extractJsonLdPaywallSignalsFromValue({
      "@type": "NewsArticle",
      url: "/News/Story",
      isAccessibleForFree: false,
    }, "https://EXAMPLE.com/News/Story?utm_source=rss#read");
    expect(matching.signals[0]?.nodeIdentityState).toBe("matched");

    const result = expectClassification(baseInput({
      bodyText: FULL_BODY,
      usableBodyExtracted: true,
      jsonLdPaywallSignals: conflicting.signals,
    }), "ACCESSIBLE");
    expect(result.classification).not.toBe("METERED_OR_DECLARED");
    expect(result.classification).not.toBe("PAYWALL_BLOCKED");
  });

  it("F5: hostname case differences match and trailing slashes use root-preserving normalization", () => {
    const hostnameMatch = extractJsonLdPaywallSignalsFromValue({
      "@type": "NewsArticle",
      url: "https://example.com/News/Story",
      isAccessibleForFree: false,
    }, "https://EXAMPLE.COM/News/Story");
    expect(hostnameMatch.signals[0]?.nodeIdentityState).toBe("matched");

    const trailingSlashMatch = extractJsonLdPaywallSignalsFromValue({
      "@type": "NewsArticle",
      url: "https://example.com/News/Story/",
      isAccessibleForFree: false,
    }, "https://example.com/News/Story");
    expect(trailingSlashMatch.signals[0]?.nodeIdentityState).toBe("matched");

    const rootSlashMatch = extractJsonLdPaywallSignalsFromValue({
      "@type": "NewsArticle",
      url: "https://example.com/",
      isAccessibleForFree: false,
    }, "https://example.com");
    expect(rootSlashMatch.signals[0]?.nodeIdentityState).toBe("matched");
  });

  it("F6: relative JSON-LD identity resolves against the current canonical article URL", () => {
    const scan = extractJsonLdPaywallSignalsFromValue({
      "@type": "NewsArticle",
      url: "index",
      isAccessibleForFree: false,
    }, "https://example.com/News/index?source=rss");
    expect(scan.signals[0]?.nodeIdentityState).toBe("matched");
  });

  it("F7: malformed URL identities fail closed", () => {
    const scan = extractJsonLdPaywallSignalsFromValue({
      "@type": "NewsArticle",
      url: "http://[malformed",
      isAccessibleForFree: false,
    }, "https://example.com/News/Story");
    expect(scan.signals[0]?.nodeIdentityState).toBe("conflicting");
    expect(extractJsonLdPaywallSignalsFromMarkup(
      '<script type="application/ld+json">{"@type":"NewsArticle","url":"http://[malformed","isAccessibleForFree":false}</script>',
      "https://example.com/News/Story",
    )).toEqual([]);
  });

  it("F8: malformed supplied canonical URL rejects valid, identity-less, and multiple Article nodes", () => {
    const malformedCanonical = "https://[malformed-canonical";
    const validIdentity = extractJsonLdPaywallSignalsFromValue({
      "@type": "NewsArticle",
      url: "https://example.com/News/Story",
      isAccessibleForFree: false,
    }, malformedCanonical);
    const identityLess = extractJsonLdPaywallSignalsFromValue({
      "@type": "NewsArticle",
      isAccessibleForFree: false,
    }, malformedCanonical);
    const multiple = extractJsonLdPaywallSignalsFromValue([
      { "@type": "NewsArticle", isAccessibleForFree: false },
      { "@type": "NewsArticle", url: "https://example.com/other", isAccessibleForFree: false },
    ], malformedCanonical);

    expect(validIdentity.signals).toEqual([]);
    expect(identityLess.signals).toEqual([]);
    expect(multiple.signals).toEqual([]);
    expect(validIdentity.articleNodeCount).toBe(1);
    expect(identityLess.articleNodeCount).toBe(1);
    expect(multiple.articleNodeCount).toBe(2);

    const markup = `<script type="application/ld+json">${JSON.stringify({
      "@graph": [
        { "@type": "NewsArticle", isAccessibleForFree: false },
        { "@type": "NewsArticle", url: "https://example.com/other", isAccessibleForFree: false },
      ],
    })}</script>`;
    expect(extractJsonLdPaywallSignalsFromMarkup(markup, malformedCanonical)).toEqual([]);

    const early = classifyEarlyAccessHint({
      sourceStage: "agent1",
      articleText: "Ordinary article preview",
      articleUrl: malformedCanonical,
      structuredMarkup: '<script type="application/ld+json">{"@type":"NewsArticle","url":"https://example.com/News/Story","isAccessibleForFree":false}</script>',
    });
    expect(early.classification).not.toBe("PAYWALL_BLOCKED");
    expect(early.classification).not.toBe("METERED_OR_DECLARED");
  });

  it("F9: missing canonical URL preserves the single unambiguous identity-less Article compatibility rule", () => {
    const scan = extractJsonLdPaywallSignalsFromValue({
      "@type": "NewsArticle",
      isAccessibleForFree: false,
    }, null);
    expect(scan.signals[0]?.nodeIdentityState).toBe("unstated");
    expect(extractJsonLdPaywallSignalsFromMarkup(
      '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>',
      null,
    )).toHaveLength(1);
  });

  it("G: CAPTCHA/robot challenge → INTERSTITIAL_OR_CHALLENGE (never paywall)", () => {
    const result = expectClassification(baseInput({
      bodyText: null,
      rawPageText: "Checking your browser before accessing the site. Please wait while we verify you are human.",
      challengeTextSignals: ["captcha"],
    }), "INTERSTITIAL_OR_CHALLENGE");
    expect(result.isPaywall).toBe(null);
    expect(result.evidence.some((e) => e.code === "interstitial_challenge")).toBe(true);
  });

  it("H: HTTP 403 page → HTTP_ACCESS_BLOCKED (never paywall)", () => {
    const result = expectClassification(baseInput({
      statusCode: 403,
      bodyText: null,
      rawPageText: "Access denied",
    }), "HTTP_ACCESS_BLOCKED");
    expect(result.confidence).toBe("HIGH");
    expect(result.isPaywall).toBe(null);
  });

  it("H2: explicit request-access denial text on a 200 page → HTTP_ACCESS_BLOCKED", () => {
    const result = expectClassification(baseInput({
      statusCode: 200,
      bodyText: null,
      rawPageText: "403 Forbidden — you don't have permission to access this resource.",
    }), "HTTP_ACCESS_BLOCKED");
    expect(result.isPaywall).toBe(null);
  });

  it("I: HTTP 202 interstitial → INTERSTITIAL_OR_CHALLENGE with bounded retry semantics preserved", () => {
    const result = expectClassification(baseInput({
      statusCode: 202,
      bodyText: null,
      rawPageText: "Please wait while we redirect you to the article...",
    }), "INTERSTITIAL_OR_CHALLENGE");
    expect(result.isPaywall).toBe(null);
  });

  it("J: malformed JSON-LD → no crash and no paywall classification", () => {
    const signals = extractJsonLdPaywallSignalsFromMarkup(
      '<script type="application/ld+json">{ this is not json </script>',
    );
    expect(signals).toEqual([]);
    const result = expectClassification(baseInput({
      bodyText: FULL_BODY,
      usableBodyExtracted: true,
      jsonLdPaywallSignals: [],
    }), "ACCESSIBLE");
    expect(result.isPaywall).toBe(false);
  });

  it("K: full body plus erroneous publisher-global paywall metadata → no blocking classification", () => {
    const markup = JSON.stringify({
      "@type": "WebPage",
      isAccessibleForFree: false, // WebPage-only metadata must be ignored
      mainEntityOfPage: {
        "@type": "NewsArticle",
        headline: "Free story",
      },
    });
    const scan = extractJsonLdPaywallSignalsFromMarkup(markup);
    expect(scan.length).toBe(0);
    const result = expectClassification(baseInput({
      bodyText: FULL_BODY,
      usableBodyExtracted: true,
      rawPageText: FULL_BODY,
    }), "ACCESSIBLE");
    expect(result.isPaywall).toBe(false);
  });

  it("L: genuine paywall with truncated body and article-scoped gate → PAYWALL_BLOCKED", () => {
    const result = expectClassification(baseInput({
      bodyText: "Preview only. The full story is reserved.",
      usableBodyExtracted: false,
      bodyTruncationDetected: true,
      articleScopedGateOrOverlayDetected: true,
      articleScopedCtaTexts: ["This article is available to subscribers only."],
      rawPageText: "This article is available to subscribers only. Preview only.",
    }), "PAYWALL_BLOCKED");
    expect(result.confidence).toBe("HIGH");
    expect(result.isPaywall).toBe(true);
  });
});

describe("classifyArticleAccess — boundary behavior", () => {
  it("never lets topic words alone classify as paywalled", () => {
    for (const text of [
      "Netflix subscription prices are rising again this quarter.",
      "The newspaper introduced a paywall for its archive.",
      "Subscribers to our newsletter get premium weekly updates.",
    ]) {
      const result = classifyArticleAccess(baseInput({ bodyText: text, usableBodyExtracted: false, rawPageText: text }));
      expect(result.classification).not.toBe("PAYWALL_BLOCKED");
      expect(result.isPaywall).not.toBe(true);
    }
  });

  it("full usable body wins over challenge/ad-blocker noise", () => {
    const result = classifyArticleAccess(baseInput({
      bodyText: FULL_BODY,
      usableBodyExtracted: true,
      rawPageText: `${FULL_BODY}\nPlease disable your ad blocker to continue.`,
      adBlockerWarningDetected: true,
    }));
    expect(result.classification).toBe("ACCESSIBLE");
  });

  it("ad-blocker warning without an article-specific gate and no body → INTERSTITIAL_OR_CHALLENGE (never paywall)", () => {
    const result = classifyArticleAccess(baseInput({
      bodyText: null,
      usableBodyExtracted: false,
      rawPageText: "Please disable your ad blocker to access this page.",
      adBlockerWarningDetected: true,
    }));
    expect(result.classification).toBe("INTERSTITIAL_OR_CHALLENGE");
    expect(result.isPaywall).toBe(null);
  });

  it("maps the legacy blocking boolean exactly (Prompt 15A-1)", () => {
    const cases: Array<[ArticleAccessClassification, boolean | null]> = [
      ["PAYWALL_BLOCKED", true],
      ["METERED_OR_DECLARED", false],
      ["ACCESSIBLE", false],
      ["INTERSTITIAL_OR_CHALLENGE", null],
      ["HTTP_ACCESS_BLOCKED", null],
      ["UNKNOWN", null],
    ];
    for (const [classification, expected] of cases) {
      expect(mapClassificationToIsPaywall(classification)).toBe(expected);
    }
  });

  it("maps isPaywall correctly per classification", () => {
    expect(classifyArticleAccess(baseInput({ usableBodyExtracted: true, bodyText: FULL_BODY })).isPaywall).toBe(false);
    expect(classifyArticleAccess(baseInput({
      usableBodyExtracted: false,
      articleScopedCtaTexts: ["Subscribe to continue reading"],
    })).isPaywall).toBe(true);
    // METERED_OR_DECLARED is readable → false, never true.
    expect(classifyArticleAccess(baseInput({
      usableBodyExtracted: true,
      jsonLdPaywallSignals: [{ code: "PaywalledContent", nodeType: "PaywalledContent", nodeIdentityState: "matched" }],
    })).isPaywall).toBe(false);
    expect(classifyArticleAccess(baseInput({})).isPaywall).toBe(null);
    expect(classifyArticleAccess(baseInput({ statusCode: 403 })).isPaywall).toBe(null);
  });

  it("METERED_OR_DECLARED keeps its structured classification and decisive evidence", () => {
    const result = classifyArticleAccess(baseInput({
      usableBodyExtracted: true,
      jsonLdPaywallSignals: [
        { code: "isAccessibleForFree:false", nodeType: "NewsArticle", nodeIdentityState: "matched" },
      ],
    }));
    expect(result.classification).toBe("METERED_OR_DECLARED");
    expect(result.decisive).toBe(true);
    expect(result.evidenceArticleScoped).toBe(true);
  });

  it("returns bounded, versioned result without raw content", () => {
    const result = classifyArticleAccess(baseInput({
      bodyText: FULL_BODY,
      usableBodyExtracted: true,
      rawPageText: FULL_BODY,
      articleScopedCtaTexts: ["Subscribe to continue reading this article."],
    }));
    expect(result.detectorVersion).toBe(ARTICLE_ACCESS_DETECTOR_VERSION);
    expect(result.evidence.length).toBeLessThanOrEqual(12);
    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThan(3000);
    expect(serialized).not.toContain(FULL_BODY.slice(0, 50));
  });
});

describe("JSON-LD @type array handling (Prompt 15A-1)", () => {
  const scan = (node: unknown, url = "https://example.com/story/42") =>
    extractJsonLdPaywallSignalsFromValue(node, url);

  it("accepts a supported article type appearing later in the array", () => {
    const { signals, articleNodeCount } = scan({
      "@type": ["CreativeWork", "NewsArticle"],
      isAccessibleForFree: false,
    });
    expect(articleNodeCount).toBe(1);
    expect(signals[0]?.code).toBe("isAccessibleForFree:false");
    // First SUPPORTED type is preserved for evidence.
    expect(signals[0]?.nodeType).toBe("NewsArticle");
  });

  it("accepts WebPage + Article as an article node", () => {
    const { signals, articleNodeCount } = scan({
      "@type": ["WebPage", "Article"],
      isAccessibleForFree: false,
    });
    expect(articleNodeCount).toBe(1);
    expect(signals.length).toBe(1);
    expect(signals[0]?.nodeType).toBe("Article");
  });

  it("accepts a supported type first in the array", () => {
    const { signals } = scan({
      "@type": ["NewsArticle", "CreativeWork"],
      isAccessibleForFree: false,
    });
    expect(signals[0]?.nodeType).toBe("NewsArticle");
  });

  it("ignores arrays with no supported article type", () => {
    const { signals, articleNodeCount } = scan({
      "@type": ["WebPage", "FAQPage"],
      isAccessibleForFree: false,
    });
    expect(signals).toEqual([]);
    expect(articleNodeCount).toBe(0);
  });

  it("handles malformed mixed type entries without crashing", () => {
    const { signals, articleNodeCount } = scan({
      "@type": ["NewsArticle", 123, null, {}, { "@type": "nested" }],
      isAccessibleForFree: false,
    });
    expect(articleNodeCount).toBe(1);
    expect(signals.length).toBe(1);
  });

  it("treats a supported type plus conflicting canonical identity as conflicting", () => {
    const { signals } = scan({
      "@type": ["CreativeWork", "NewsArticle"],
      url: "https://other.example.com/unrelated",
      isAccessibleForFree: false,
    });
    expect(signals[0]?.nodeIdentityState).toBe("conflicting");
  });

  it("does not emit evidence for a bare object without a supported article type", () => {
    const { signals, articleNodeCount } = scan({ isAccessibleForFree: false });
    expect(signals).toEqual([]);
    expect(articleNodeCount).toBe(0);
  });

  it("treats an identity-less single article node as unstated", () => {
    const { signals, articleNodeCount } = scan({
      "@type": ["WebPage", "NewsArticle"],
      isAccessibleForFree: false,
    });
    expect(articleNodeCount).toBe(1);
    expect(signals[0]?.nodeIdentityState).toBe("unstated");
  });

  it("preserves PaywalledContent hasPart signals under type-array article nodes", () => {
    const { signals } = scan({
      "@type": ["CreativeWork", "NewsArticle"],
      url: "https://example.com/story/42",
      hasPart: [{ "@type": "PaywalledContent" }],
    });
    expect(signals.some((s) => s.code === "PaywalledContent" && s.nodeIdentityState === "matched")).toBe(true);
  });
});
