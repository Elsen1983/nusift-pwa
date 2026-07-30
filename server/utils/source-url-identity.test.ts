import { describe, expect, it } from "vitest";
import {
  normalizeSourceIdentityUrl,
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
});
