import { describe, expect, it } from "vitest";
import { hasStrongPaywallHint } from "./paywall-detection";

describe("hasStrongPaywallHint", () => {
  it.each([
    "Subscribe to our newsletter",
    "Get premium updates in your inbox",
    "Premium league analysis continues below",
    "Readers can subscribe for daily alerts",
  ])("does not treat generic page or feed language as a paywall: %s", (articleText) => {
    expect(hasStrongPaywallHint({ articleText })).toBe(false);
  });

  it.each([
    "Subscribe to continue reading this article",
    "Sign in to access this story",
    "This article is available to subscribers",
    "Subscriber-only content",
  ])("recognizes article access restrictions: %s", (articleText) => {
    expect(hasStrongPaywallHint({ articleText })).toBe(true);
  });

  it("ignores identity-less non-Article JSON-LD metadata", () => {
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      structuredMarkup: '<script type="application/ld+json">{"isAccessibleForFree":false}</script>',
    })).toBe(false);
  });

  it("recognizes matching identity-less Article JSON-LD when it is the only supported node", () => {
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      articleUrl: "https://example.com/story",
      structuredMarkup: '<script type="application/ld+json">{"@type":"NewsArticle","headline":"Story","isAccessibleForFree":false}</script>',
    })).toBe(true);
  });

  it("ignores an unrelated Article JSON-LD node", () => {
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      articleUrl: "https://example.com/story",
      structuredMarkup: '<script type="application/ld+json">{"@type":"NewsArticle","url":"https://example.com/other","isAccessibleForFree":false}</script>',
    })).toBe(false);
  });

  it("ignores conflicting Article identities when no current article node matches", () => {
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      articleUrl: "https://example.com/story",
      structuredMarkup: '<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","url":"https://example.com/other","isAccessibleForFree":false},{"@type":"NewsArticle","isAccessibleForFree":false}]}</script>',
    })).toBe(false);
  });

  it("accepts an Article type array and @graph identity match", () => {
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      articleUrl: "https://example.com/story?utm_source=test#read",
      structuredMarkup: '<script type="application/ld+json">{"@graph":[{"@type":["WebPage","NewsArticle"],"url":"https://example.com/story","isAccessibleForFree":false}]}</script>',
    })).toBe(true);
  });

  it("does not match JSON-LD when only the pathname case differs", () => {
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      articleUrl: "https://example.com/News/Story?utm_source=test#read",
      structuredMarkup: '<script type="application/ld+json">{"@type":"NewsArticle","url":"/news/story","isAccessibleForFree":false}</script>',
    })).toBe(false);
  });

  it("matches query/fragment-only differences, hostname case, and deterministic trailing slash differences", () => {
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      articleUrl: "https://EXAMPLE.COM/News/Story?utm_source=test#read",
      structuredMarkup: '<script type="application/ld+json">{"@type":"NewsArticle","url":"https://example.com/News/Story/","isAccessibleForFree":false}</script>',
    })).toBe(true);
  });

  it("fails closed when the supplied canonical article URL is malformed", () => {
    const markup = '<script type="application/ld+json">{"@type":"NewsArticle","url":"https://example.com/News/Story","isAccessibleForFree":false}</script>';
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      articleUrl: "https://[malformed-canonical",
      structuredMarkup: markup,
    })).toBe(false);
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      articleUrl: "https://[malformed-canonical",
      structuredMarkup: '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>',
    })).toBe(false);
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      articleUrl: "https://[malformed-canonical",
      structuredMarkup: '<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","isAccessibleForFree":false},{"@type":"NewsArticle","url":"https://example.com/other","isAccessibleForFree":false}]}</script>',
    })).toBe(false);
  });

  it.each([
    "The company announced a new paywall strategy for its archive.",
    "Netflix subscription pricing keeps rising across Europe.",
    "The author argues that being behind a paywall reduces readership.",
    "Premium features are now included in the standard tier.",
    "Subscribers can download the weekly edition as a PDF.",
  ])("Prompt 15A: generic topic words never classify as paywalled: %s", (articleText) => {
    expect(hasStrongPaywallHint({ articleText })).toBe(false);
  });

  it("Prompt 15A: a full free article quoting another service's paywall is not a paywall", () => {
    const articleText =
      "A full free article about media economics published today. According to Streaming Weekly, " +
      "\"Subscribe to continue reading\" now greets non-members of that service, and the quote " +
      "describes the other platform's registration wall rather than this publication's policy. " +
      "This outlet remains free for every reader without an account. The reporting continues " +
      "with more analysis of subscription trends across the industry and what they mean for " +
      "independent journalism in the current market environment.";
    expect(hasStrongPaywallHint({ articleText })).toBe(false);
  });

  it("Prompt 15A: structured paywall metadata on an unrelated node type is not decisive", () => {
    expect(hasStrongPaywallHint({
      articleText: "Ordinary free article preview",
      structuredMarkup: '<script type="application/ld+json">{"@type":"FAQPage","isAccessibleForFree":false}</script>',
    })).toBe(false);
  });

  it("Prompt 15A: malformed JSON-LD never crashes and never classifies", () => {
    expect(hasStrongPaywallHint({
      articleText: "Ordinary free article preview",
      structuredMarkup: '<script type="application/ld+json">{broken json</script>',
    })).toBe(false);
  });
});
