import { describe, expect, it } from "vitest";
import { isLikelyIndividualArticleUrl } from "./source-url-policy";

describe("source URL policy", () => {
  it.each([
    "https://example.com/",
    "https://example.com/news/technology/",
    "https://www.irishmirror.ie/news/irish-news/crime/",
  ])("accepts homepage and nested section targets: %s", (url) => {
    expect(isLikelyIndividualArticleUrl(url)).toBe(false);
  });

  it.each([
    "https://example.com/news/2026/08/07/story-title/",
    "https://www.irishmirror.ie/news/irish-news/crime/garda-cold-cases-unit-boss-21926903",
    "https://example.com/news/this-is-a-long-individual-article-headline-slug",
  ])("rejects strong individual-article targets: %s", (url) => {
    expect(isLikelyIndividualArticleUrl(url)).toBe(true);
  });
});
