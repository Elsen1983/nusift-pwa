import { describe, expect, it } from "vitest";
import {
  normalizeSourceIdentityUrl,
  resolveSourceUrlIdentity,
  sourceIdentityKey,
} from "./source-url-identity";

describe("source URL identity", () => {
  it("normalizes www, fragments, and trailing slashes", () => {
    expect(normalizeSourceIdentityUrl("https://WWW.Example.com/news/#top")).toBe(
      "https://example.com/news",
    );
  });

  it("normalizes root URLs independently of paths and queries", () => {
    expect(
      normalizeSourceIdentityUrl("https://www.example.com/news?q=1#top", {
        rootOnly: true,
      }),
    ).toBe("https://example.com");
  });

  it("produces the same identity for equivalent source URLs", () => {
    expect(sourceIdentityKey("https://www.example.com/")).toBe(
      sourceIdentityKey("https://example.com"),
    );
  });

  it("rejects unsupported protocols", () => {
    expect(() => normalizeSourceIdentityUrl("ftp://example.com/feed")).toThrow(
      "Unsupported source URL protocol.",
    );
  });

  it("classifies origin URLs as roots", () => {
    expect(resolveSourceUrlIdentity("https://www.example.com/")).toEqual({
      normalizedUrl: "https://example.com",
      rootUrl: "https://example.com",
      isRoot: true,
    });
  });

  it("classifies path URLs as categories under the origin root", () => {
    expect(resolveSourceUrlIdentity("https://WWW.Example.com/category/local-news/")).toEqual({
      normalizedUrl: "https://example.com/category/local-news",
      rootUrl: "https://example.com",
      isRoot: false,
    });
  });
});
