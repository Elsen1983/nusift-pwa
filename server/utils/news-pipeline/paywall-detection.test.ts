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

  it("recognizes structured paywall metadata", () => {
    expect(hasStrongPaywallHint({
      articleText: "Ordinary article preview",
      structuredMarkup: '<script type="application/ld+json">{"isAccessibleForFree":false}</script>',
    })).toBe(true);
  });
});
