import { describe, expect, it } from "vitest";
import {
  getArticleTransportIdentity,
  getHttpsArticleUrl,
  isExplicitHttpFallbackAllowed,
} from "./article-transport-policy";

describe("article transport policy", () => {
  it("builds an HTTPS equivalent without changing the article path", () => {
    expect(getHttpsArticleUrl("http://example.com/news/42?edition=uk#top")).toBe(
      "https://example.com/news/42?edition=uk#top",
    );
  });

  it("rejects credentials and non-default HTTP ports for HTTPS upgrade", () => {
    expect(getHttpsArticleUrl("http://user:pass@example.com/news/42")).toBeNull();
    expect(getHttpsArticleUrl("http://example.com:8080/news/42")).toBeNull();
  });

  it("shares identity between HTTP and HTTPS variants", () => {
    expect(getArticleTransportIdentity("http://example.com/news/42#top")).toBe(
      getArticleTransportIdentity("https://example.com/news/42"),
    );
  });

  it("allows HTTP fallback only for explicitly configured hosts", () => {
    const env = { NUSIFT_AGENT3_HTTP_FALLBACK_ALLOWED_HOSTS: "legacy.example.com" };
    expect(isExplicitHttpFallbackAllowed("http://legacy.example.com/a", env)).toBe(true);
    expect(isExplicitHttpFallbackAllowed("http://other.example.com/a", env)).toBe(false);
    expect(isExplicitHttpFallbackAllowed("https://legacy.example.com/a", env)).toBe(false);
  });

  it("does not allow HTTP fallback by default", () => {
    expect(isExplicitHttpFallbackAllowed("http://example.com/a", {})).toBe(false);
  });
});
