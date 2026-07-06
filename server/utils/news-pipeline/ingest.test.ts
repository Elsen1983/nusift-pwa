import { describe, expect, it } from "vitest";
import { isWithinFreshnessWindow, matchCategoryIdForUrl } from "./ingest";
import { cleanFeedValue } from "./text";

describe("matchCategoryIdForUrl", () => {
  it("matches the most specific category path for article URLs", () => {
    const result = matchCategoryIdForUrl(
      "https://www.independent.ie/regionals/wexfordpeople/news/example-story-12345.html",
      [
        { id: "rootish", normalizedPath: "/regionals" },
        { id: "wexford", normalizedPath: "/regionals/wexfordpeople" },
      ],
    );

    expect(result).toBe("wexford");
  });

  it("does not match unrelated article paths", () => {
    const result = matchCategoryIdForUrl(
      "https://www.independent.ie/world-news/example-story-12345.html",
      [{ id: "wexford", normalizedPath: "/regionals/wexfordpeople" }],
    );

    expect(result).toBeNull();
  });
});

describe("isWithinFreshnessWindow", () => {
  const now = new Date("2026-07-03T12:00:00.000Z");

  it("accepts articles published within the last 7 days", () => {
    expect(isWithinFreshnessWindow(new Date("2026-06-27T12:00:00.000Z"), now)).toBe(true);
  });

  it("rejects articles older than 7 days or missing dates", () => {
    expect(isWithinFreshnessWindow(new Date("2026-06-26T11:59:59.000Z"), now)).toBe(false);
    expect(isWithinFreshnessWindow(null, now)).toBe(false);
  });
});

describe("cleanFeedValue", () => {
  it("unwraps CDATA-wrapped links so they remain valid URLs", () => {
    expect(
      cleanFeedValue(
        "<![CDATA[https://www.szon.hu/helyi-sport/2026/07/atletika-valogatott-kovacs-lili-anita-tilki-flora]]>",
      ),
    ).toBe(
      "https://www.szon.hu/helyi-sport/2026/07/atletika-valogatott-kovacs-lili-anita-tilki-flora",
    );
  });

  it("decodes CDATA-wrapped titles and entities without stripping content", () => {
    expect(
      cleanFeedValue(
        "<![CDATA[West Cork mum&apos;s urgent vaccination plea after losing daughter]]>",
      ),
    ).toBe("West Cork mum's urgent vaccination plea after losing daughter");
  });
});
