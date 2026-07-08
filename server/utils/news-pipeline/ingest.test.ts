import { describe, expect, it } from "vitest";
import { isWithinFreshnessWindow, matchCategoryIdForUrl, shouldQueueHardCaseDiscovery } from "./ingest";
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

describe("publish date fallback behavior", () => {
  it("still treats missing dates as stale before fallback resolution", () => {
    expect(isWithinFreshnessWindow(null, new Date("2026-07-06T12:00:00.000Z"))).toBe(false);
  });
});

describe("shouldQueueHardCaseDiscovery", () => {
  it("queues unresolved targets when discovery surfaced evidence but no usable feed", () => {
    expect(
      shouldQueueHardCaseDiscovery({
        feedUrl: null,
        topCandidates: [{ feedUrl: "https://example.com/feed.xml" }],
        rejectedCandidates: [],
        lastError: "",
      }),
    ).toBe(true);
  });

  it("does not queue when a usable feed was already resolved", () => {
    expect(
      shouldQueueHardCaseDiscovery({
        feedUrl: "https://example.com/feed.xml",
        topCandidates: [],
        rejectedCandidates: [],
        lastError: "",
      }),
    ).toBe(false);
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

  it("repairs common UTF-8 mojibake sequences from misdecoded feeds", () => {
    expect(
      cleanFeedValue(
        "Ferencz Orsolya: â€žA csalÃ¡domnak sokszor mÃ©ltatlan tÃ¡madÃ¡sokat kellett elviselnieâ€",
      ),
    ).toBe(
      "Ferencz Orsolya: „A családomnak sokszor méltatlan támadásokat kellett elviselnie”",
    );
  });

  it("repairs quoted apostrophe style mojibake from english feeds", () => {
    expect(
      cleanFeedValue(
        "â€˜We could be sick about that until Christmas. But weâ€™ll drive onâ€™",
      ),
    ).toBe(
      "‘We could be sick about that until Christmas. But we’ll drive on’",
    );
  });

  it("repairs euro and accented names seen in live feeds", () => {
    expect(
      cleanFeedValue("Man, 30s, arrested as more than â‚¬1.6m of cannabis seized in Cork"),
    ).toBe("Man, 30s, arrested as more than €1.6m of cannabis seized in Cork");

    expect(
      cleanFeedValue("Met Ã‰ireann issues warning as temps to hit 'low 30s'"),
    ).toBe("Met Éireann issues warning as temps to hit 'low 30s'");

    expect(
      cleanFeedValue("Mum of brave FÃ©ile O'Sullivan tells of road to recovery"),
    ).toBe("Mum of brave Féile O'Sullivan tells of road to recovery");
  });
});
