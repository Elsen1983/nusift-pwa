import { describe, expect, it } from "vitest";
import {
  classifyFeedForSource,
  isInvalidSubPathRedirect,
  isSameSourceAfterProtocolNormalization,
  normalizeFrontPageUrlForAudit,
} from "./import-rss";

describe("classifyFeedForSource", () => {
  it("marks feeds as scoped when item links stay under the sub-path", () => {
    const xml = `
      <rss><channel>
        <item><link>https://www.independent.ie/regionals/wexfordpeople/story-1</link></item>
      </channel></rss>
    `;

    expect(
      classifyFeedForSource(
        "https://www.independent.ie/regionals/wexfordpeople",
        "https://www.independent.ie/regionals/wexfordpeople/rss",
        xml,
      ),
    ).toBe("SCOPED");
  });

  it("marks feeds as shared root when they are root-level feeds without scoped item links", () => {
    const xml = `
      <rss><channel>
        <item><link>https://www.independent.ie/irish-news/story-1</link></item>
      </channel></rss>
    `;

    expect(
      classifyFeedForSource(
        "https://www.independent.ie/regionals/wexfordpeople",
        "https://www.independent.ie/rss",
        xml,
      ),
    ).toBe("SHARED_ROOT");
  });
});

describe("isInvalidSubPathRedirect", () => {
  it("flags redirects from a sub-path to the root homepage", () => {
    expect(
      isInvalidSubPathRedirect(
        "https://www.example.com/regionals/wexfordpeople",
        "https://www.example.com/",
      ),
    ).toBe(true);
  });

  it("accepts redirects that stay within the same sub-path", () => {
    expect(
      isInvalidSubPathRedirect(
        "https://www.example.com/regionals/wexfordpeople",
        "https://www.example.com/regionals/wexfordpeople/",
      ),
    ).toBe(false);
  });
});

describe("normalizeFrontPageUrlForAudit", () => {
  it("upgrades http sources to https and adds a trailing slash for sub-paths", () => {
    expect(
      normalizeFrontPageUrlForAudit("http://www.independent.ie/regionals/wexfordpeople"),
    ).toBe("https://www.independent.ie/regionals/wexfordpeople/");
  });

  it("keeps root URLs in canonical https form", () => {
    expect(normalizeFrontPageUrlForAudit("http://www.independent.ie")).toBe(
      "https://www.independent.ie/",
    );
  });
});

describe("isSameSourceAfterProtocolNormalization", () => {
  it("accepts protocol and trailing-slash normalization only", () => {
    expect(
      isSameSourceAfterProtocolNormalization(
        "http://www.independent.ie/regionals/wexfordpeople",
        "https://www.independent.ie/regionals/wexfordpeople/",
      ),
    ).toBe(true);
  });

  it("rejects redirects that collapse a sub-path to root", () => {
    expect(
      isSameSourceAfterProtocolNormalization(
        "http://www.independent.ie/regionals/wexfordpeople",
        "https://www.independent.ie/",
      ),
    ).toBe(false);
  });
});
