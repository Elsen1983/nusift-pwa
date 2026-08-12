import { describe, expect, it } from "vitest";
import {
  normalizeArticleCanonicalIdentity,
  normalizeScopedRssGuid,
  scopedRssGuidIdentity,
} from "./article-identity";

describe("Article identity", () => {
  it("converges HTTP/HTTPS and tracking/query order variants", () => {
    expect(normalizeArticleCanonicalIdentity("http://EXAMPLE.com:80/story/?b=2&utm_source=x&a=1#fragment"))
      .toBe("https://example.com/story?a=1&b=2");
    expect(normalizeArticleCanonicalIdentity("https://example.com/story?b=2&a=1"))
      .toBe("https://example.com/story?a=1&b=2");
  });

  it("does not heuristically merge AMP, mobile, or different publisher destinations", () => {
    expect(normalizeArticleCanonicalIdentity("https://example.com/story/amp"))
      .not.toBe(normalizeArticleCanonicalIdentity("https://example.com/story"));
    expect(normalizeArticleCanonicalIdentity("https://m.example.com/story"))
      .not.toBe(normalizeArticleCanonicalIdentity("https://example.com/story"));
    expect(normalizeArticleCanonicalIdentity("https://publisher-a.test/wire/1"))
      .not.toBe(normalizeArticleCanonicalIdentity("https://publisher-b.test/wire/1"));
  });

  it("rejects unsafe or malformed canonical identities", () => {
    expect(normalizeArticleCanonicalIdentity("javascript:alert(1)")).toBeNull();
    expect(normalizeArticleCanonicalIdentity("https://user:secret@example.com/story")).toBeNull();
    expect(normalizeArticleCanonicalIdentity("not a URL")).toBeNull();
  });

  it("scopes reusable opaque GUIDs by source and rejects malformed values", () => {
    expect(scopedRssGuidIdentity("source-a", "wire-1")).not.toBe(scopedRssGuidIdentity("source-b", "wire-1"));
    expect(normalizeScopedRssGuid("  wire-1  ")).toBe("wire-1");
    expect(normalizeScopedRssGuid(" ")).toBeNull();
    expect(normalizeScopedRssGuid("null")).toBeNull();
    expect(normalizeScopedRssGuid("bad\u0000guid")).toBeNull();
  });
});
