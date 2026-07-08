import { describe, expect, it } from "vitest";
import {
  buildDiscoveryEvidencePayload,
  isFallbackFeedItemRelevantToCategory,
  isScopedCategoryFeed,
  isWithinFreshnessWindow,
  matchCategoryIdForUrl,
  shouldQueueHardCaseDiscovery,
} from "./ingest";
import { cleanFeedValue } from "./text";
import type { ScopeMatch, TaxonomyEvidence } from "./types";

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

describe("isFallbackFeedItemRelevantToCategory", () => {
  it("accepts root-feed items when feed metadata clearly matches the category target", () => {
    const result = isFallbackFeedItemRelevantToCategory(
      "https://bleacherreport.com/nba",
      {
        title: "Steph Curry Addresses LeBron James Rumors Amid Warriors Buzz in NBA Free Agency",
        description: "Bleacher Report front-page article",
        categories: ["NBA"],
      },
    );

    expect(result).toBe(true);
  });

  it("rejects unrelated root-feed items when neither URL path nor metadata match the category target", () => {
    const result = isFallbackFeedItemRelevantToCategory(
      "https://bleacherreport.com/nba",
      {
        title: "Wimbledon semifinal schedule announced",
        description: "Tennis coverage",
        categories: ["Tennis"],
      },
    );

    expect(result).toBe(false);
  });

  it("supports multi-segment category targets by matching the meaningful segment", () => {
    const result = isFallbackFeedItemRelevantToCategory(
      "https://www.independent.ie/county/cork/",
      {
        title: "Cork manager reacts after dramatic late win",
        description: "County coverage",
        categories: ["GAA", "Cork"],
      },
    );

    expect(result).toBe(true);
  });
});

describe("isScopedCategoryFeed", () => {
  it("treats exact/probable discovery matches as scoped category feeds", () => {
    expect(
      isScopedCategoryFeed(
        "https://www.blikk.hu/politika",
        "https://www.blikk.hu/politika?feed=true&category=/politika",
        { scopeMatch: "probable" },
      ),
    ).toBe(true);
  });

  it("treats generic root-like feeds as non-scoped category feeds", () => {
    expect(
      isScopedCategoryFeed(
        "https://bleacherreport.com/nba",
        "https://feeds.bleacherreport.com/articles",
        { scopeMatch: "generic" },
      ),
    ).toBe(false);
  });

  it("falls back to URL heuristics when discovery evidence is missing", () => {
    expect(
      isScopedCategoryFeed(
        "https://www.independent.ie/county/cork/",
        "https://www.independent.ie/county/cork/rss/",
      ),
    ).toBe(true);

    expect(
      isScopedCategoryFeed(
        "https://bleacherreport.com/nba",
        "https://bleacherreport.com/?service=rss",
      ),
    ).toBe(false);
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

describe("buildDiscoveryEvidencePayload", () => {
  const makeEvidence = (overrides: Record<string, unknown> = {}) => ({
    feedUrl: "https://example.com/sport/rss" as string | null,
    discoveredVia: "https://example.com/sport" as string | null,
    detection: "html-link",
    scopeConfidence: "medium",
    scopeMatch: "exact" as ScopeMatch,
    taxonomyEvidence: {
      sectionIds: ["42"],
      tagIds: [],
      categorySlugs: ["sport"],
      collectionIds: [],
      routeNames: [],
      canonicalSectionHandles: ["sport"],
      feedParams: [],
      matchedFeedUrls: [],
    } as TaxonomyEvidence,
    score: 65,
    topCandidates: [
      {
        feedUrl: "https://example.com/sport/rss",
        detection: "html-link",
        score: 65,
        contentType: "application/rss+xml",
        scopeMatch: "exact" as ScopeMatch,
      },
    ],
    rejectedCandidates: [
      {
        feedUrl: "https://example.com/rss.xml",
        detection: "html-link",
        score: 30,
        contentType: null as string | null,
        reason: "did not validate",
        scopeMatch: "generic" as ScopeMatch,
      },
    ],
    lastError: undefined as string | undefined,
    ...overrides,
  });

  it("preserves structured taxonomyEvidence as an object, not flattened", () => {
    const taxonomyEvidence: TaxonomyEvidence = {
      sectionIds: ["42"],
      tagIds: ["7"],
      categorySlugs: ["sport", "football"],
      collectionIds: ["c1"],
      routeNames: ["sportRoute"],
      canonicalSectionHandles: ["sport"],
      feedParams: ["42"],
      matchedFeedUrls: ["https://example.com/sport/rss"],
    };

    const result = buildDiscoveryEvidencePayload(
      "https://example.com/sport",
      makeEvidence({ taxonomyEvidence }),
    );

    expect(result.taxonomyEvidence).toBeDefined();
    expect(typeof result.taxonomyEvidence).toBe("object");
    expect(Array.isArray(result.taxonomyEvidence)).toBe(false);

    const te = result.taxonomyEvidence as TaxonomyEvidence;
    expect(te.sectionIds).toEqual(["42"]);
    expect(te.tagIds).toEqual(["7"]);
    expect(te.categorySlugs).toEqual(["sport", "football"]);
    expect(te.collectionIds).toEqual(["c1"]);
    expect(te.routeNames).toEqual(["sportRoute"]);
    expect(te.canonicalSectionHandles).toEqual(["sport"]);
    expect(te.feedParams).toEqual(["42"]);
    expect(te.matchedFeedUrls).toEqual(["https://example.com/sport/rss"]);
  });

  it("preserves scopeMatch through serialization", () => {
    const result = buildDiscoveryEvidencePayload(
      "https://example.com/sport",
      makeEvidence({ scopeMatch: "probable" as ScopeMatch }),
    );

    expect(result.scopeMatch).toBe("probable");
  });

  it("preserves scopeConfidence through serialization", () => {
    const result = buildDiscoveryEvidencePayload(
      "https://example.com/sport",
      makeEvidence({ scopeConfidence: "high" }),
    );

    expect(result.scopeConfidence).toBe("high");
  });

  it("preserves topCandidates and rejectedCandidates arrays", () => {
    const result = buildDiscoveryEvidencePayload(
      "https://example.com/sport",
      makeEvidence(),
    );

    expect(result.topCandidates).toHaveLength(1);
    expect(result.topCandidates[0]!.scopeMatch).toBe("exact");
    expect(result.rejectedCandidates).toHaveLength(1);
    expect(result.rejectedCandidates[0]!.reason).toBe("did not validate");
  });

  it("applies fallbacks for missing optional fields on loose-typed input", () => {
    const result = buildDiscoveryEvidencePayload("https://example.com/news", {
      feedUrl: null,
      detection: "none",
    });

    expect(result.scopeMatch).toBe("generic");
    expect(result.scopeConfidence).toBe("low");
    expect(result.taxonomyEvidence).toBeNull();
    expect(result.score).toBe(0);
    expect(result.topCandidates).toEqual([]);
    expect(result.rejectedCandidates).toEqual([]);
  });
});
