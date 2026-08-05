/**
 * Tests for the Agent 2 verified canonical host scope.
 *
 * Covers the trust model:
 * - root host redirects to a publisher-controlled subdomain → candidates on
 *   that subdomain are accepted (verified via redirect/final-URL evidence)
 * - the same subdomain is rejected when no redirect/canonical evidence exists
 * - unrelated external domains remain rejected
 * - social/analytics/advertising/CDN hosts are never accepted as evidence
 * - canonical evidence must originate from the same publisher family
 * - query values are redacted in diagnostics
 */
import { describe, it, expect } from "vitest";
import {
  buildVerifiedHostScope,
  isHostVerified,
  isSamePublisherFamily,
  isNonPublisherHost,
  normalizeHostname,
  hostOfUrl,
  sanitizeHostEvidenceUrl,
  serializeHostScope,
  trustedHostsSet,
} from "./canonical-host-scope";

describe("canonical-host-scope", () => {
  describe("normalizeHostname / hostOfUrl", () => {
    it("normalizes case and strips www", () => {
      expect(normalizeHostname("WWW.Example.COM")).toBe("example.com");
      expect(normalizeHostname("news.Example.com")).toBe("news.example.com");
    });

    it("extracts hosts from URLs and rejects invalid URLs", () => {
      expect(hostOfUrl("https://www.example.com/news/story")).toBe("example.com");
      expect(hostOfUrl("https://news.example.com/")).toBe("news.example.com");
      expect(hostOfUrl("not a url")).toBeNull();
    });
  });

  describe("isSamePublisherFamily", () => {
    it("treats identical hosts as the same family", () => {
      expect(isSamePublisherFamily("example.com", "example.com")).toBe(true);
    });

    it("treats subdomains sharing the last two labels as the same family", () => {
      expect(isSamePublisherFamily("news.example.com", "www.example.com")).toBe(true);
      expect(isSamePublisherFamily("m.example.com", "example.com")).toBe(true);
    });

    it("rejects unrelated domains", () => {
      expect(isSamePublisherFamily("example.com", "example.org")).toBe(false);
      expect(isSamePublisherFamily("news.example.com", "other-site.com")).toBe(false);
    });
  });

  describe("isNonPublisherHost", () => {
    it("flags social, analytics, and CDN hosts", () => {
      expect(isNonPublisherHost("facebook.com")).toBe(true);
      expect(isNonPublisherHost("www.twitter.com")).toBe(true);
      expect(isNonPublisherHost("analytics.google.com")).toBe(false);
      expect(isNonPublisherHost("google-analytics.com")).toBe(true);
      expect(isNonPublisherHost("cdn.example.cloudfront.net")).toBe(true);
    });

    it("does not flag normal publisher hosts", () => {
      expect(isNonPublisherHost("example.com")).toBe(false);
      expect(isNonPublisherHost("news.example.com")).toBe(false);
    });
  });

  describe("sanitizeHostEvidenceUrl", () => {
    it("redacts query values and preserves keys", () => {
      const sanitized = sanitizeHostEvidenceUrl("https://example.com/story?utm_source=x&id=42&secret=abc");
      expect(sanitized).toContain("utm_source=[redacted]");
      expect(sanitized).toContain("id=[redacted]");
      expect(sanitized).not.toContain("secret=abc");
      expect(sanitized).not.toContain("42");
    });

    it("truncates long URLs", () => {
      const long = `https://example.com/${"a".repeat(500)}`;
      const sanitized = sanitizeHostEvidenceUrl(long, 80);
      expect(sanitized.length).toBeLessThanOrEqual(81);
    });
  });

  describe("buildVerifiedHostScope + isHostVerified", () => {
    it("accepts candidates on a subdomain established by a redirect chain", () => {
      const scope = buildVerifiedHostScope({
        configuredTargetUrl: "https://example.com/",
        redirectUrls: ["https://example.com/", "https://news.example.com/"],
        finalUrl: "https://news.example.com/world",
      });
      expect(scope).not.toBeNull();
      expect(scope!.transitioned).toBe(true);
      expect(scope!.effectiveHost).toBe("news.example.com");
      expect(isHostVerified(scope, "https://news.example.com/world/article-slug")).toBe(true);
    });

    it("rejects the same subdomain when no redirect/canonical evidence exists", () => {
      const scope = buildVerifiedHostScope({
        configuredTargetUrl: "https://example.com/",
        finalUrl: "https://example.com/",
      });
      expect(scope!.transitioned).toBe(false);
      expect(isHostVerified(scope, "https://sub.example.com/some/article")).toBe(false);
    });

    it("accepts a canonical-relationship host from the same publisher family", () => {
      const scope = buildVerifiedHostScope({
        configuredTargetUrl: "https://example.com/",
        finalUrl: "https://www.example.com/news",
        canonicalUrl: "https://www.example.com/news",
      });
      expect(isHostVerified(scope, "https://www.example.com/news/2026/07/29/story")).toBe(true);
    });

    it("rejects a canonical host from an unrelated external domain", () => {
      const scope = buildVerifiedHostScope({
        configuredTargetUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        canonicalUrl: "https://unrelated-site.com/some/page",
      });
      expect(isHostVerified(scope, "https://unrelated-site.com/some/page")).toBe(false);
    });

    it("rejects social-domain links even when they appear in the chain", () => {
      const scope = buildVerifiedHostScope({
        configuredTargetUrl: "https://example.com/",
        redirectUrls: ["https://facebook.com/example"],
        finalUrl: "https://facebook.com/example",
      });
      // A social host must never become the effective/trusted host.
      expect(scope!.effectiveHost).toBe("example.com");
      expect(isHostVerified(scope, "https://facebook.com/example")).toBe(false);
      expect(trustedHostsSet(scope).has("facebook.com")).toBe(false);
    });

    it("rejects CDN hosts from canonical evidence", () => {
      const scope = buildVerifiedHostScope({
        configuredTargetUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        canonicalUrl: "https://cdn.example.cloudfront.net/some/page",
      });
      expect(isHostVerified(scope, "https://cdn.example.cloudfront.net/some/page")).toBe(false);
    });

    it("keeps the configured host trusted when no transition occurs", () => {
      const scope = buildVerifiedHostScope({
        configuredTargetUrl: "https://www.example.com/",
        finalUrl: "https://www.example.com/news",
      });
      expect(isHostVerified(scope, "https://example.com/news/story")).toBe(true);
      expect(scope!.transitioned).toBe(false);
    });

    it("returns null for an invalid configured target", () => {
      expect(buildVerifiedHostScope({ configuredTargetUrl: "not a url" })).toBeNull();
    });
  });

  describe("serializeHostScope", () => {
    it("produces bounded, redacted evidence entries", () => {
      const scope = buildVerifiedHostScope({
        configuredTargetUrl: "https://example.com/?ref=xyz",
        finalUrl: "https://news.example.com/?token=secret",
      });
      const serialized = serializeHostScope(scope);
      expect(serialized.length).toBeGreaterThanOrEqual(2);
      const finalEntry = serialized.find((e) => e.host === "news.example.com");
      expect(finalEntry).toBeDefined();
      expect(finalEntry!.via).not.toContain("secret");
      expect(finalEntry!.establishedBy).toBe("final_url");
    });
  });
});
