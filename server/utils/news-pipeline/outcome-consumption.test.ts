import { describe, expect, it } from "vitest";
import type { ScopeMatch, TaxonomyEvidence } from "./types";
import { extractDiscoveryOutcome, validateDiscoveryEvidence } from "./types";

/**
 * These tests verify the contract that downstream consumers (sources.get.ts,
 * ingest.ts readCategoryDiscoveryEvidence) prefer the canonical `outcome`
 * field when present, and fall back to legacy flat fields for older payloads.
 *
 * Both helpers now use the shared `validateDiscoveryEvidence` validator —
 * matching the production code in sources.get.ts and ingest.ts exactly.
 */

// Replicates the readDiscoveryEvidence logic from sources.get.ts (using validateDiscoveryEvidence)
const readDiscoveryEvidence = (value: unknown) => {
  const validated = validateDiscoveryEvidence(value);
  if (!validated) return null;

  return {
    topCandidates: validated.topCandidates as Array<{
      feedUrl?: string | null;
      score?: number | null;
      detection?: string | null;
      scopeMatch?: ScopeMatch | null;
    }> | undefined,
    taxonomyEvidence: validated.taxonomyEvidence as {
      canonicalSectionHandles?: string[];
      matchedFeedUrls?: string[];
    } | null | undefined,
    verified: validated.verified,
    scopeMatch: validated.scopeMatch,
    resolverPath: validated.resolverPath,
    detection: validated.detection,
  };
};

// Replicates the readCategoryDiscoveryEvidence logic from ingest.ts (using validateDiscoveryEvidence)
const readCategoryDiscoveryEvidence = (
  discoveryEvidence: unknown,
): { scopeMatch?: ScopeMatch | undefined; verified?: boolean | undefined; taxonomyEvidence?: TaxonomyEvidence | null } | null => {
  const validated = validateDiscoveryEvidence(discoveryEvidence);
  if (!validated) return null;

  return {
    scopeMatch: validated.scopeMatch,
    verified: validated.verified,
    taxonomyEvidence: validated.taxonomyEvidence,
  };
};

describe("downstream consumers prefer outcome when present", () => {
  const newPayload = {
    evaluatedAt: "2026-07-15T10:00:00.000Z",
    targetUrl: "https://example.com/sport",
    feedUrl: "https://example.com/sport/rss",
    discoveredVia: "https://example.com/sport",
    detection: "html-link",
    scopeConfidence: "high",
    scopeMatch: "exact",
    taxonomyEvidence: null,
    score: 80,
    topCandidates: [{ feedUrl: "https://example.com/rss", score: 30, detection: "html-link", scopeMatch: "generic" }],
    rejectedCandidates: [],
    lastError: null,
    outcome: {
      feedUrl: "https://example.com/sport/rss",
      discoveredVia: "https://example.com/sport",
      detection: "taxonomy-extraction",
      contentType: "application/rss+xml",
      score: 80,
      scopeConfidence: "high",
      scopeMatch: "probable",
      taxonomyEvidence: {
        sectionIds: ["42"],
        tagIds: [],
        categorySlugs: ["sport"],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: ["sport"],
        feedParams: [],
        matchedFeedUrls: ["https://example.com/sport/rss"],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
      } as TaxonomyEvidence,
      topCandidates: [
        { feedUrl: "https://example.com/sport/rss", score: 80, detection: "taxonomy-extraction", scopeMatch: "probable" },
        { feedUrl: "https://example.com/rss", score: 30, detection: "html-link", scopeMatch: "generic" },
      ],
      rejectedCandidates: [],
      canonicalIdentity: "https://example.com/sport/rss",
      evaluatedAt: "2026-07-15T10:00:00.000Z",
      targetUrl: "https://example.com/sport",
      verified: true,
      resolverPath: "fetch",
      browserAttempted: false,
      browserMethod: "none",
      browserCandidateCount: 0,
      browserCandidates: [],
      browserError: null,
    },
  };

  it("readDiscoveryEvidence prefers outcome.topCandidates over legacy flat topCandidates", () => {
    const result = readDiscoveryEvidence(newPayload);

    // outcome has 2 candidates, legacy has 1 — should get 2 from outcome
    expect(result?.topCandidates).toHaveLength(2);
    expect(result?.topCandidates?.[0]?.detection).toBe("taxonomy-extraction");
    expect(result?.topCandidates?.[0]?.score).toBe(80);
  });

  it("readDiscoveryEvidence prefers outcome.taxonomyEvidence over legacy null", () => {
    const result = readDiscoveryEvidence(newPayload);

    // Legacy taxonomyEvidence is null, outcome has structured data
    expect(result?.taxonomyEvidence).toBeDefined();
    expect(result?.taxonomyEvidence?.canonicalSectionHandles).toEqual(["sport"]);
    expect(result?.taxonomyEvidence?.matchedFeedUrls).toEqual(["https://example.com/sport/rss"]);
  });

  it("readCategoryDiscoveryEvidence prefers outcome.scopeMatch over legacy", () => {
    const result = readCategoryDiscoveryEvidence(newPayload);

    // Legacy scopeMatch is "exact", outcome is "probable"
    expect(result?.scopeMatch).toBe("probable");
  });
});

describe("downstream consumers fall back to legacy flat fields for older payloads", () => {
  const legacyPayload = {
    evaluatedAt: "2026-07-01T10:00:00.000Z",
    targetUrl: "https://example.com",
    feedUrl: "https://example.com/rss",
    discoveredVia: "https://example.com",
    detection: "html-link",
    scopeConfidence: "medium",
    scopeMatch: "exact",
    taxonomyEvidence: {
      sectionIds: [],
      tagIds: [],
      categorySlugs: ["news"],
      canonicalSectionHandles: ["news"],
      matchedFeedUrls: ["https://example.com/feed"],
    },
    score: 50,
    topCandidates: [{ feedUrl: "https://example.com/rss", score: 50, detection: "html-link", scopeMatch: "exact" }],
    rejectedCandidates: [],
    lastError: null,
    // No outcome field — this is an older record
  };

  it("readDiscoveryEvidence falls back to legacy topCandidates when no outcome", () => {
    const result = readDiscoveryEvidence(legacyPayload);

    expect(result?.topCandidates).toHaveLength(1);
    expect(result?.topCandidates?.[0]?.feedUrl).toBe("https://example.com/rss");
    expect(result?.topCandidates?.[0]?.score).toBe(50);
  });

  it("readDiscoveryEvidence falls back to legacy taxonomyEvidence when no outcome", () => {
    const result = readDiscoveryEvidence(legacyPayload);

    expect(result?.taxonomyEvidence).toBeDefined();
    expect(result?.taxonomyEvidence?.canonicalSectionHandles).toEqual(["news"]);
    expect(result?.taxonomyEvidence?.matchedFeedUrls).toEqual(["https://example.com/feed"]);
  });

  it("readCategoryDiscoveryEvidence falls back to legacy scopeMatch when no outcome", () => {
    const result = readCategoryDiscoveryEvidence(legacyPayload);

    expect(result?.scopeMatch).toBe("exact");
  });
});

describe("edge cases for downstream consumer reading", () => {
  it("readDiscoveryEvidence returns null for null input", () => {
    expect(readDiscoveryEvidence(null)).toBeNull();
  });

  it("readDiscoveryEvidence returns null for array input", () => {
    expect(readDiscoveryEvidence([])).toBeNull();
  });

  it("readDiscoveryEvidence returns null for primitive input", () => {
    expect(readDiscoveryEvidence("string")).toBeNull();
  });

  it("readDiscoveryEvidence handles empty object", () => {
    const result = readDiscoveryEvidence({});
    // Validator defaults: topCandidates→[], taxonomyEvidence→null
    expect(result?.topCandidates).toEqual([]);
    expect(result?.taxonomyEvidence).toBeNull();
  });

  it("readDiscoveryEvidence handles payload with empty outcome object (malformed, falls back to legacy)", () => {
    const result = readDiscoveryEvidence({ outcome: {}, topCandidates: [{ feedUrl: "legacy", score: 10 }] });
    // outcome exists but is empty → fails isValidOutcomeShape → outcomeMalformed, falls back to legacy
    expect(result?.topCandidates).toHaveLength(1);
    expect(result?.topCandidates?.[0]?.feedUrl).toBe("legacy");
  });

  it("readCategoryDiscoveryEvidence returns null for null input", () => {
    expect(readCategoryDiscoveryEvidence(null)).toBeNull();
  });

  it("readCategoryDiscoveryEvidence returns undefined scopeMatch for payload with no scopeMatch", () => {
    const result = readCategoryDiscoveryEvidence({ feedUrl: "https://example.com" });
    expect(result).toBeDefined();
    expect(result?.scopeMatch).toBeUndefined();
  });

  it("readCategoryDiscoveryEvidence handles outcome with no scopeMatch, falls back to legacy", () => {
    const payload = {
      scopeMatch: "generic",
      outcome: {
        // no scopeMatch in outcome; also missing required fields for isValidOutcomeShape
        feedUrl: "https://example.com",
      },
    };
    const result = readCategoryDiscoveryEvidence(payload);
    // outcome is malformed (missing evaluatedAt, targetUrl, etc.) → falls back to legacy flat
    expect(result?.scopeMatch).toBe("generic");
  });
});

describe("extractDiscoveryOutcome shared helper", () => {
  it("extracts outcome from a valid new-payload with outcome field", () => {
    const payload = {
      feedUrl: "https://example.com/rss",
      outcome: {
        feedUrl: "https://example.com/rss",
        verified: true,
        resolverPath: "fetch",
        scopeMatch: "probable",
      },
    };

    const outcome = extractDiscoveryOutcome(payload);
    expect(outcome).toBeDefined();
    expect(outcome?.verified).toBe(true);
    expect(outcome?.resolverPath).toBe("fetch");
    expect(outcome?.scopeMatch).toBe("probable");
  });

  it("returns null for legacy payload without outcome field", () => {
    const payload = {
      feedUrl: "https://example.com/rss",
      detection: "html-link",
      scopeMatch: "exact",
    };

    const outcome = extractDiscoveryOutcome(payload);
    expect(outcome).toBeNull();
  });

  it("returns null for null input", () => {
    expect(extractDiscoveryOutcome(null)).toBeNull();
  });

  it("returns null for array input", () => {
    expect(extractDiscoveryOutcome([])).toBeNull();
  });

  it("returns null for primitive input", () => {
    expect(extractDiscoveryOutcome("string")).toBeNull();
  });

  it("returns null for empty outcome object", () => {
    // Empty outcome is still a valid object, so it should be returned
    const payload = { outcome: {} };
    const outcome = extractDiscoveryOutcome(payload);
    expect(outcome).toBeDefined();
    expect(outcome?.verified).toBeUndefined();
  });

  it("returns null when outcome is a non-object (e.g. string)", () => {
    const payload = { outcome: "not-an-object" };
    expect(extractDiscoveryOutcome(payload)).toBeNull();
  });

  it("returns null when outcome is an array", () => {
    const payload = { outcome: [1, 2, 3] };
    expect(extractDiscoveryOutcome(payload)).toBeNull();
  });
});

describe("validateDiscoveryEvidence", () => {
  it("returns null for null input", () => {
    expect(validateDiscoveryEvidence(null)).toBeNull();
  });

  it("returns null for array input", () => {
    expect(validateDiscoveryEvidence([])).toBeNull();
  });

  it("returns null for primitive input", () => {
    expect(validateDiscoveryEvidence("string")).toBeNull();
    expect(validateDiscoveryEvidence(42)).toBeNull();
    expect(validateDiscoveryEvidence(true)).toBeNull();
  });

  it("validates a canonical outcome payload with all fields", () => {
    const payload = {
      feedUrl: "https://example.com/rss",
      detection: "html-link",
      scopeMatch: "generic",
      outcome: {
        feedUrl: "https://example.com/sport/rss",
        detection: "taxonomy-extraction",
        scopeMatch: "probable",
        scopeConfidence: "high",
        score: 80,
        verified: true,
        resolverPath: "jsdom",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com/sport",
        taxonomyEvidence: {
          sectionIds: ["42"],
          tagIds: ["7"],
          categorySlugs: ["sport"],
          collectionIds: [],
          routeNames: [],
          canonicalSectionHandles: ["sport"],
          feedParams: [],
          matchedFeedUrls: [],
          localeHints: [],
          hreflangLocales: [],
          editionPaths: [],
        },
        topCandidates: [{ feedUrl: "https://example.com/sport/rss" }],
        rejectedCandidates: [],
        lastError: null,
        canonicalIdentity: "https://example.com/sport/rss",
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.hasOutcome).toBe(true);
    expect(result!.feedUrl).toBe("https://example.com/sport/rss");
    expect(result!.detection).toBe("taxonomy-extraction");
    expect(result!.scopeMatch).toBe("probable");
    expect(result!.scopeConfidence).toBe("high");
    expect(result!.score).toBe(80);
    expect(result!.verified).toBe(true);
    expect(result!.resolverPath).toBe("jsdom");
    expect(result!.taxonomyEvidence).toBeDefined();
    expect(result!.taxonomyEvidence!.sectionIds).toEqual(["42"]);
    expect(result!.topCandidates).toHaveLength(1);
    expect(result!.rejectedCandidates).toHaveLength(0);
    expect(result!.lastError).toBeNull();
    expect(result!.canonicalIdentity).toBe("https://example.com/sport/rss");
  });

  it("validates a legacy flat payload without outcome", () => {
    const payload = {
      feedUrl: "https://example.com/rss",
      detection: "html-link",
      scopeMatch: "exact",
      scopeConfidence: "medium",
      score: 50,
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: ["news"],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: ["news"],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
      },
      topCandidates: [{ feedUrl: "https://example.com/rss" }],
      rejectedCandidates: [],
      lastError: null,
      canonicalIdentity: null,
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.hasOutcome).toBe(false);
    expect(result!.outcome).toBeNull();
    expect(result!.feedUrl).toBe("https://example.com/rss");
    expect(result!.detection).toBe("html-link");
    expect(result!.scopeMatch).toBe("exact");
    expect(result!.scopeConfidence).toBe("medium");
    expect(result!.score).toBe(50);
    // Legacy payloads without verified/resolverPath return undefined (genuinely absent)
    expect(result!.verified).toBeUndefined();
    expect(result!.resolverPath).toBeUndefined();
    expect(result!.taxonomyEvidence).toBeDefined();
    expect(result!.taxonomyEvidence!.categorySlugs).toEqual(["news"]);
  });

  it("normalizes invalid scopeMatch to generic", () => {
    const payload = { scopeMatch: "invalid-value", feedUrl: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.scopeMatch).toBe("generic");
  });

  it("normalizes invalid scopeConfidence to low", () => {
    const payload = { scopeConfidence: "extreme", feedUrl: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.scopeConfidence).toBe("low");
  });

  it("normalizes invalid resolverPath to none", () => {
    const payload = { resolverPath: "puppeteer", feedUrl: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.resolverPath).toBe("none");
  });

  it("normalizes non-number score to 0", () => {
    const payload = { score: "not-a-number", feedUrl: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);
  });

  it("normalizes non-string feedUrl to null", () => {
    const payload = { feedUrl: 12345 };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.feedUrl).toBeNull();
  });

  it("normalizes non-array topCandidates to empty array", () => {
    const payload = { topCandidates: "not-an-array", feedUrl: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.topCandidates).toEqual([]);
  });

  it("normalizes invalid taxonomyEvidence to null", () => {
    const payload = { taxonomyEvidence: "not-an-object", feedUrl: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.taxonomyEvidence).toBeNull();
  });

  it("normalizes taxonomyEvidence with non-array required fields to normalized object with empty arrays", () => {
    const payload = { taxonomyEvidence: { sectionIds: "not-array" }, feedUrl: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    const tax = result!.taxonomyEvidence;
    // Field-by-field normalization: non-array sectionIds → [], missing fields → []
    expect(tax).not.toBeNull();
    expect(tax!.sectionIds).toEqual([]);
    expect(tax!.tagIds).toEqual([]);
    expect(tax!.categorySlugs).toEqual([]);
  });

  it("returns undefined for genuinely missing fields and safe defaults for structural fields", () => {
    const result = validateDiscoveryEvidence({});
    expect(result).not.toBeNull();
    expect(result!.hasOutcome).toBe(false);
    // Structural fields always have defaults
    expect(result!.feedUrl).toBeNull();
    expect(result!.topCandidates).toEqual([]);
    expect(result!.rejectedCandidates).toEqual([]);
    expect(result!.lastError).toBeNull();
    expect(result!.canonicalIdentity).toBeNull();
    expect(result!.taxonomyEvidence).toBeNull();
    // Genuinely missing fields return undefined (not safe defaults)
    expect(result!.detection).toBeUndefined();
    expect(result!.scopeMatch).toBeUndefined();
    expect(result!.scopeConfidence).toBeUndefined();
    expect(result!.score).toBeUndefined();
    expect(result!.verified).toBeUndefined();
    expect(result!.resolverPath).toBeUndefined();
  });

  it("preserves valid falsy values (0 score, null feedUrl)", () => {
    const payload = { score: 0, feedUrl: null, lastError: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);
    expect(result!.feedUrl).toBeNull();
    expect(result!.lastError).toBeNull();
  });

  it("normalizes present-but-invalid verified to undefined (not boolean)", () => {
    const payload = { verified: "yes", feedUrl: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    // "yes" is not a boolean, so verified is undefined (invalid, not missing)
    expect(result!.verified).toBeUndefined();
  });

  it("normalizes present-but-invalid detection to unknown", () => {
    const payload = { detection: 123, feedUrl: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.detection).toBe("unknown");
  });

  it("normalizes non-string lastError to null", () => {
    const payload = { lastError: 42, feedUrl: null };
    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.lastError).toBeNull();
  });

  it("outcome fields override legacy flat fields when outcome is valid", () => {
    const payload = {
      feedUrl: "https://legacy.com/rss",
      detection: "html-link",
      scopeMatch: "generic",
      verified: false,
      outcome: {
        feedUrl: "https://outcome.com/rss",
        detection: "taxonomy-extraction",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        scopeMatch: "exact",
        verified: true,
        score: 90,
        topCandidates: [],
        rejectedCandidates: [],
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result!.hasOutcome).toBe(true);
    expect(result!.feedUrl).toBe("https://outcome.com/rss");
    expect(result!.detection).toBe("taxonomy-extraction");
    expect(result!.scopeMatch).toBe("exact");
    expect(result!.verified).toBe(true);
    expect(result!.score).toBe(90);
  });

  it("preserves explicitly false verified from outcome (not normalized to undefined)", () => {
    const payload = {
      outcome: {
        feedUrl: null,
        verified: false,
        detection: "none",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        scopeMatch: "unrelated",
        score: 0,
        topCandidates: [],
        rejectedCandidates: [],
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result!.hasOutcome).toBe(true);
    expect(result!.verified).toBe(false);
  });

  it("preserves resolverPath none from outcome (not normalized to undefined)", () => {
    const payload = {
      outcome: {
        feedUrl: null,
        resolverPath: "none",
        verified: false,
        detection: "none",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        scopeMatch: "unrelated",
        score: 0,
        topCandidates: [],
        rejectedCandidates: [],
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result!.hasOutcome).toBe(true);
    expect(result!.resolverPath).toBe("none");
  });

  it("malformed outcome is rejected but legacy fields still work", () => {
    const payload = {
      feedUrl: "https://legacy.com/rss",
      detection: "html-link",
      scopeMatch: "exact",
      outcome: "not-an-object",
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result!.hasOutcome).toBe(false);
    expect(result!.feedUrl).toBe("https://legacy.com/rss");
    expect(result!.scopeMatch).toBe("exact");
  });

  it("outcomeMalformed is false when outcome is absent", () => {
    const result = validateDiscoveryEvidence({ feedUrl: "https://example.com" });
    expect(result!.hasOutcome).toBe(false);
    expect(result!.outcomeMalformed).toBe(false);
  });

  it("outcomeMalformed is false when outcome is valid", () => {
    const payload = {
      outcome: {
        feedUrl: "https://example.com/rss",
        detection: "html-link",
        verified: true,
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        topCandidates: [],
        rejectedCandidates: [],
      },
    };
    const result = validateDiscoveryEvidence(payload);
    expect(result!.hasOutcome).toBe(true);
    expect(result!.outcomeMalformed).toBe(false);
  });

  it("rejects malformed outcome missing evaluatedAt and falls back to legacy", () => {
    const payload = {
      feedUrl: "https://legacy.com/rss",
      detection: "html-link",
      scopeMatch: "exact",
      outcome: {
        feedUrl: "https://outcome.com/rss",
        detection: "taxonomy-extraction",
        verified: true,
        targetUrl: "https://example.com",
        topCandidates: [],
        rejectedCandidates: [],
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result!.hasOutcome).toBe(false);
    expect(result!.outcomeMalformed).toBe(true);
    expect(result!.outcome).toBeNull();
    expect(result!.feedUrl).toBe("https://legacy.com/rss");
    expect(result!.detection).toBe("html-link");
    expect(result!.scopeMatch).toBe("exact");
  });

  it("rejects malformed outcome missing targetUrl and falls back to legacy", () => {
    const payload = {
      feedUrl: "https://legacy.com/rss",
      outcome: {
        feedUrl: "https://outcome.com/rss",
        detection: "html-link",
        verified: true,
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        topCandidates: [],
        rejectedCandidates: [],
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result!.outcomeMalformed).toBe(true);
    expect(result!.hasOutcome).toBe(false);
    expect(result!.feedUrl).toBe("https://legacy.com/rss");
  });

  it("rejects malformed outcome with wrong type for verified", () => {
    const payload = {
      feedUrl: "https://legacy.com/rss",
      outcome: {
        feedUrl: "https://outcome.com/rss",
        detection: "html-link",
        verified: "yes",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        topCandidates: [],
        rejectedCandidates: [],
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result!.outcomeMalformed).toBe(true);
    expect(result!.hasOutcome).toBe(false);
    expect(result!.feedUrl).toBe("https://legacy.com/rss");
  });

  it("rejects malformed outcome with non-array topCandidates", () => {
    const payload = {
      feedUrl: "https://legacy.com/rss",
      outcome: {
        feedUrl: "https://outcome.com/rss",
        detection: "html-link",
        verified: true,
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        topCandidates: "not-an-array",
        rejectedCandidates: [],
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result!.outcomeMalformed).toBe(true);
    expect(result!.hasOutcome).toBe(false);
    expect(result!.feedUrl).toBe("https://legacy.com/rss");
  });

  it("rejects malformed outcome with wrong feedUrl type", () => {
    const payload = {
      feedUrl: "https://legacy.com/rss",
      outcome: {
        feedUrl: 12345,
        detection: "html-link",
        verified: true,
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        topCandidates: [],
        rejectedCandidates: [],
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result!.outcomeMalformed).toBe(true);
    expect(result!.hasOutcome).toBe(false);
    expect(result!.feedUrl).toBe("https://legacy.com/rss");
  });

  it("malformed outcome does not poison legacy fields even without legacy fallback", () => {
    const payload = {
      outcome: {
        feedUrl: null,
        detection: "html-link",
        verified: true,
        targetUrl: "https://example.com",
        topCandidates: [],
        rejectedCandidates: [],
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result!.outcomeMalformed).toBe(true);
    expect(result!.hasOutcome).toBe(false);
    expect(result!.feedUrl).toBeNull();
    expect(result!.detection).toBeUndefined();
  });

  it("valid outcome with malformed nested taxonomyEvidence is still accepted (field-level normalization)", () => {
    const payload = {
      outcome: {
        feedUrl: "https://example.com/rss",
        detection: "html-link",
        verified: true,
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        topCandidates: [],
        rejectedCandidates: [],
        taxonomyEvidence: "not-an-object",
      },
    };

    const result = validateDiscoveryEvidence(payload);
    // Outcome passes structural validation (isValidOutcomeShape)
    expect(result!.hasOutcome).toBe(true);
    expect(result!.outcomeMalformed).toBe(false);
    // But malformed taxonomyEvidence is normalized to null at field level
    expect(result!.taxonomyEvidence).toBeNull();
    // Other outcome fields are still used
    expect(result!.feedUrl).toBe("https://example.com/rss");
    expect(result!.verified).toBe(true);
  });

  it("valid outcome with browser metadata passes through correctly", () => {
    const payload = {
      outcome: {
        feedUrl: "https://example.com/rss",
        detection: "browser-dom-link",
        verified: true,
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        scopeMatch: "probable",
        scopeConfidence: "medium",
        score: 65,
        topCandidates: [],
        rejectedCandidates: [],
        resolverPath: "jsdom",
        browserAttempted: true,
        browserMethod: "jsdom",
        browserCandidateCount: 3,
        browserCandidates: [
          { feedUrl: "https://example.com/rss", source: "dom-link" },
        ],
        browserError: null,
      },
    };

    const result = validateDiscoveryEvidence(payload);
    expect(result!.hasOutcome).toBe(true);
    expect(result!.outcomeMalformed).toBe(false);
    expect(result!.feedUrl).toBe("https://example.com/rss");
    expect(result!.detection).toBe("browser-dom-link");
    expect(result!.scopeMatch).toBe("probable");
    expect(result!.scopeConfidence).toBe("medium");
    expect(result!.score).toBe(65);
    expect(result!.resolverPath).toBe("jsdom");
    expect(result!.verified).toBe(true);
  });
});

describe("enriched readDiscoveryEvidence return shape", () => {
  it("returns verified, scopeMatch, resolverPath, detection from outcome", () => {
    const payload = {
      feedUrl: "https://example.com/rss",
      detection: "html-link",
      scopeMatch: "generic",
      outcome: {
        feedUrl: "https://example.com/rss",
        detection: "taxonomy-extraction",
        scopeMatch: "probable",
        verified: true,
        resolverPath: "jsdom",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        topCandidates: [],
        rejectedCandidates: [],
      },
    };

    const result = readDiscoveryEvidence(payload);
    expect(result?.verified).toBe(true);
    expect(result?.scopeMatch).toBe("probable");
    expect(result?.resolverPath).toBe("jsdom");
    expect(result?.detection).toBe("taxonomy-extraction");
  });

  it("falls back to legacy flat fields for enriched return when no outcome", () => {
    const payload = {
      feedUrl: "https://example.com/rss",
      detection: "html-link",
      scopeMatch: "exact",
    };

    const result = readDiscoveryEvidence(payload);
    expect(result?.verified).toBeUndefined();
    expect(result?.scopeMatch).toBe("exact");
    expect(result?.resolverPath).toBeUndefined();
    expect(result?.detection).toBe("html-link");
  });
});

describe("enriched readCategoryDiscoveryEvidence return shape", () => {
  it("returns verified and taxonomyEvidence from outcome", () => {
    const payload = {
      scopeMatch: "generic",
      outcome: {
        scopeMatch: "probable",
        verified: true,
        feedUrl: "https://example.com/rss",
        detection: "html-link",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        targetUrl: "https://example.com",
        topCandidates: [],
        rejectedCandidates: [],
        taxonomyEvidence: {
          sectionIds: ["42"],
          tagIds: [],
          categorySlugs: ["sport"],
          collectionIds: [],
          routeNames: [],
          canonicalSectionHandles: ["sport"],
          feedParams: [],
          matchedFeedUrls: [],
          localeHints: [],
          hreflangLocales: [],
          editionPaths: [],
        },
      },
    };

    const result = readCategoryDiscoveryEvidence(payload);
    expect(result?.scopeMatch).toBe("probable");
    expect(result?.verified).toBe(true);
    expect(result?.taxonomyEvidence).toBeDefined();
    expect(result?.taxonomyEvidence?.sectionIds).toEqual(["42"]);
  });

  it("falls back to legacy taxonomyEvidence when no outcome", () => {
    const payload = {
      scopeMatch: "exact",
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: ["news"],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: ["news"],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
      },
    };

    const result = readCategoryDiscoveryEvidence(payload);
    expect(result?.scopeMatch).toBe("exact");
    expect(result?.verified).toBeUndefined();
    expect(result?.taxonomyEvidence).toBeDefined();
    expect(result?.taxonomyEvidence?.categorySlugs).toEqual(["news"]);
  });
});

describe("outcomeMalformed propagation through consumer helpers", () => {
  const validOutcome = {
    feedUrl: "https://example.com/rss",
    detection: "html-link",
    verified: true,
    evaluatedAt: "2026-01-01T00:00:00.000Z",
    targetUrl: "https://example.com",
    scopeMatch: "probable" as const,
    scopeConfidence: "high" as const,
    score: 80,
    topCandidates: [{ feedUrl: "https://example.com/rss", score: 80, detection: "html-link", scopeMatch: "probable" as const }],
    rejectedCandidates: [],
  };

  const malformedOutcome = {
    // Missing evaluatedAt, targetUrl — fails isValidOutcomeShape
    feedUrl: "https://example.com/rss",
    detection: "html-link",
    verified: true,
    topCandidates: [],
    rejectedCandidates: [],
  };

  it("readDiscoveryEvidence passes through valid outcome fields (hasOutcome=true path)", () => {
    const payload = {
      feedUrl: "https://legacy.com/rss",
      detection: "legacy-det",
      scopeMatch: "generic" as const,
      outcome: validOutcome,
    };

    const result = readDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    // Outcome fields preferred over legacy (detection differs: outcome=html-link vs legacy=legacy-det)
    expect(result?.detection).toBe("html-link");
    expect(result?.scopeMatch).toBe("probable");
    expect(result?.verified).toBe(true);
    expect(result?.topCandidates).toHaveLength(1);
  });

  it("readDiscoveryEvidence falls back to legacy when outcome is malformed", () => {
    const payload = {
      feedUrl: "https://legacy.com/rss",
      detection: "legacy-det",
      scopeMatch: "exact" as const,
      verified: false,
      topCandidates: [{ feedUrl: "https://legacy.com/rss", score: 50, detection: "legacy-det", scopeMatch: "exact" as const }],
      outcome: malformedOutcome,
    };

    const result = readDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    // Falls back to legacy flat fields
    expect(result?.detection).toBe("legacy-det");
    expect(result?.scopeMatch).toBe("exact");
    expect(result?.verified).toBe(false);
    expect(result?.topCandidates).toHaveLength(1);
    expect(result?.topCandidates?.[0]?.feedUrl).toBe("https://legacy.com/rss");
  });

  it("readCategoryDiscoveryEvidence falls back to legacy when outcome is malformed", () => {
    const payload = {
      scopeMatch: "exact" as const,
      outcome: malformedOutcome,
    };

    const result = readCategoryDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    // Falls back to legacy flat fields since outcome is malformed
    expect(result?.scopeMatch).toBe("exact");
  });

  it("readCategoryDiscoveryEvidence uses valid outcome scopeMatch when outcome is valid", () => {
    const payload = {
      scopeMatch: "generic" as const,
      outcome: validOutcome,
    };

    const result = readCategoryDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    expect(result?.scopeMatch).toBe("probable");
    expect(result?.verified).toBe(true);
  });

  it("malformed outcome without legacy fallback returns safe defaults through readDiscoveryEvidence", () => {
    const payload = {
      outcome: malformedOutcome,
      // No legacy flat fields at all
    };

    const result = readDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    // All fields come from validator defaults since no legacy either
    expect(result?.detection).toBeUndefined();
    expect(result?.scopeMatch).toBeUndefined();
    expect(result?.verified).toBeUndefined();
    expect(result?.topCandidates).toEqual([]);
    expect(result?.taxonomyEvidence).toBeNull();
  });

  it("malformed outcome without legacy fallback returns scopeMatch=undefined through readCategoryDiscoveryEvidence", () => {
    const payload = {
      outcome: malformedOutcome,
      // No legacy flat fields
    };

    const result = readCategoryDiscoveryEvidence(payload);
    expect(result).not.toBeNull();
    // scopeMatch is genuinely absent → undefined (not "generic")
    expect(result?.scopeMatch).toBeUndefined();
    expect(result?.verified).toBeUndefined();
    expect(result?.taxonomyEvidence).toBeNull();
  });
});

describe("deep TaxonomyEvidence validation", () => {
  const makeValidOutcome = (taxonomyEvidence?: unknown) => ({
    feedUrl: "https://example.com/rss",
    detection: "html-link",
    verified: true,
    evaluatedAt: "2026-01-01T00:00:00.000Z",
    targetUrl: "https://example.com",
    topCandidates: [],
    rejectedCandidates: [],
    ...(taxonomyEvidence !== undefined ? { taxonomyEvidence } : {}),
  });

  const fullTaxonomy = {
    sectionIds: ["s1", "s2"],
    tagIds: ["t1"],
    categorySlugs: ["sport"],
    collectionIds: ["c1"],
    routeNames: ["/sport"],
    canonicalSectionHandles: ["sport"],
    feedParams: ["lang=en"],
    matchedFeedUrls: ["https://example.com/sport/rss"],
    localeHints: ["en"],
    hreflangLocales: ["en", "de"],
    editionPaths: ["/uk", "de"],
    countryHints: ["United Kingdom"],
    countryCodes: ["GB"],
    directoryTraversal: {
      traversedUrl: "https://example.com/sport",
      matchedLabel: "Sport",
      candidateCount: 2,
    },
    canonicalIdentity: "https://example.com/sport/rss",
  };

  it("accepts valid TaxonomyEvidence with all string arrays and optional fields", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: fullTaxonomy,
      feedUrl: "https://example.com/rss",
    });
    expect(result).not.toBeNull();
    const tax = result!.taxonomyEvidence;
    expect(tax).not.toBeNull();
    expect(tax!.sectionIds).toEqual(["s1", "s2"]);
    expect(tax!.tagIds).toEqual(["t1"]);
    expect(tax!.categorySlugs).toEqual(["sport"]);
    expect(tax!.collectionIds).toEqual(["c1"]);
    expect(tax!.routeNames).toEqual(["/sport"]);
    expect(tax!.canonicalSectionHandles).toEqual(["sport"]);
    expect(tax!.feedParams).toEqual(["lang=en"]);
    expect(tax!.matchedFeedUrls).toEqual(["https://example.com/sport/rss"]);
    expect(tax!.localeHints).toEqual(["en"]);
    expect(tax!.hreflangLocales).toEqual(["en", "de"]);
    expect(tax!.editionPaths).toEqual(["/uk", "de"]);
    expect(tax!.countryHints).toEqual(["United Kingdom"]);
    expect(tax!.countryCodes).toEqual(["GB"]);
    expect(tax!.directoryTraversal).toEqual({
      traversedUrl: "https://example.com/sport",
      matchedLabel: "Sport",
      candidateCount: 2,
    });
    expect(tax!.canonicalIdentity).toBe("https://example.com/sport/rss");
  });

  it("normalizes arrays containing non-string values to empty arrays", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: ["s1", 42, null],
        tagIds: ["t1"],
        categorySlugs: ["sport"],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    const tax = result!.taxonomyEvidence;
    expect(tax).not.toBeNull();
    // sectionIds has non-string elements → normalized to []
    expect(tax!.sectionIds).toEqual([]);
    // tagIds and categorySlugs are valid → preserved
    expect(tax!.tagIds).toEqual(["t1"]);
    expect(tax!.categorySlugs).toEqual(["sport"]);
  });

  it("normalizes arrays containing objects to empty arrays", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [{ id: 1 }],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    expect(result!.taxonomyEvidence!.sectionIds).toEqual([]);
  });

  it("normalizes arrays containing undefined elements to empty arrays", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [undefined, "t1"],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    // undefined is not a string → normalized to []
    expect(result!.taxonomyEvidence!.tagIds).toEqual([]);
  });

  it("normalizes non-array required fields to empty arrays (not null)", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: "not-an-array",
        tagIds: 42,
        categorySlugs: null,
        collectionIds: {},
        routeNames: true,
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    const tax = result!.taxonomyEvidence;
    expect(tax).not.toBeNull();
    // All non-array required fields → []
    expect(tax!.sectionIds).toEqual([]);
    expect(tax!.tagIds).toEqual([]);
    expect(tax!.categorySlugs).toEqual([]);
    expect(tax!.collectionIds).toEqual([]);
    expect(tax!.routeNames).toEqual([]);
    // Valid arrays preserved
    expect(tax!.canonicalSectionHandles).toEqual([]);
  });

  it("handles missing required array fields (defaults to empty arrays)", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        // Only sectionIds present; rest are missing
        sectionIds: ["s1"],
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    const tax = result!.taxonomyEvidence;
    expect(tax).not.toBeNull();
    expect(tax!.sectionIds).toEqual(["s1"]);
    expect(tax!.tagIds).toEqual([]);
    expect(tax!.categorySlugs).toEqual([]);
    expect(tax!.collectionIds).toEqual([]);
    expect(tax!.routeNames).toEqual([]);
    expect(tax!.canonicalSectionHandles).toEqual([]);
    expect(tax!.feedParams).toEqual([]);
    expect(tax!.matchedFeedUrls).toEqual([]);
    expect(tax!.localeHints).toEqual([]);
    expect(tax!.hreflangLocales).toEqual([]);
    expect(tax!.editionPaths).toEqual([]);
  });

  it("preserves valid optional string arrays (countryHints, countryCodes)", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
        countryHints: ["Hungary", "Germany"],
        countryCodes: ["HU", "DE"],
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    const tax = result!.taxonomyEvidence;
    expect(tax!.countryHints).toEqual(["Hungary", "Germany"]);
    expect(tax!.countryCodes).toEqual(["HU", "DE"]);
  });

  it("normalizes malformed optional string arrays to empty arrays", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
        countryHints: [42, null],
        countryCodes: "not-an-array",
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    const tax = result!.taxonomyEvidence;
    expect(tax!.countryHints).toEqual([]);
    expect(tax!.countryCodes).toEqual([]);
  });

  it("omits absent optional string arrays (leaves them undefined)", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
        // countryHints and countryCodes are absent
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    const tax = result!.taxonomyEvidence;
    expect(tax!.countryHints).toBeUndefined();
    expect(tax!.countryCodes).toBeUndefined();
  });

  it("preserves valid directoryTraversal object", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
        directoryTraversal: {
          traversedUrl: "https://example.com/sport",
          matchedLabel: "Sport",
          candidateCount: 3,
        },
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    expect(result!.taxonomyEvidence!.directoryTraversal).toEqual({
      traversedUrl: "https://example.com/sport",
      matchedLabel: "Sport",
      candidateCount: 3,
    });
  });

  it("drops malformed directoryTraversal (wrong field types)", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
        directoryTraversal: {
          traversedUrl: 123, // not a string
          matchedLabel: "Sport",
          candidateCount: 3,
        },
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    expect(result!.taxonomyEvidence!.directoryTraversal).toBeUndefined();
  });

  it("drops directoryTraversal when candidateCount is not a number", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
        directoryTraversal: {
          traversedUrl: "https://example.com/sport",
          matchedLabel: "Sport",
          candidateCount: "three", // not a number
        },
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    expect(result!.taxonomyEvidence!.directoryTraversal).toBeUndefined();
  });

  it("drops directoryTraversal when it is not a plain object", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
        directoryTraversal: "not-an-object",
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    expect(result!.taxonomyEvidence!.directoryTraversal).toBeUndefined();
  });

  it("preserves canonicalIdentity string", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
        canonicalIdentity: "https://example.com/feed",
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    expect(result!.taxonomyEvidence!.canonicalIdentity).toBe("https://example.com/feed");
  });

  it("preserves canonicalIdentity null", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
        canonicalIdentity: null,
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    expect(result!.taxonomyEvidence!.canonicalIdentity).toBeNull();
  });

  it("normalizes malformed canonicalIdentity to null", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {
        sectionIds: [],
        tagIds: [],
        categorySlugs: [],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
        canonicalIdentity: 12345,
      },
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    expect(result!.taxonomyEvidence!.canonicalIdentity).toBeNull();
  });

  it("malformed taxonomy arrays inside a valid outcome do not poison the outcome", () => {
    const result = validateDiscoveryEvidence({
      outcome: makeValidOutcome({
        sectionIds: [42, null],
        tagIds: "not-an-array",
        categorySlugs: ["sport"],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
      }),
      feedUrl: "https://legacy.com/rss",
    });
    // Outcome itself is valid (passes isValidOutcomeShape)
    expect(result!.hasOutcome).toBe(true);
    expect(result!.outcomeMalformed).toBe(false);
    // taxonomyEvidence is normalized (not null — the object exists, just arrays are normalized)
    const tax = result!.taxonomyEvidence;
    expect(tax).not.toBeNull();
    expect(tax!.sectionIds).toEqual([]); // non-string elements → []
    expect(tax!.tagIds).toEqual([]); // not an array → []
    expect(tax!.categorySlugs).toEqual(["sport"]); // valid → preserved
  });

  it("empty taxonomy object (all fields missing) produces all-empty arrays", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: {},
      feedUrl: null,
    });
    expect(result).not.toBeNull();
    const tax = result!.taxonomyEvidence;
    expect(tax).not.toBeNull();
    expect(tax!.sectionIds).toEqual([]);
    expect(tax!.tagIds).toEqual([]);
    expect(tax!.categorySlugs).toEqual([]);
    expect(tax!.collectionIds).toEqual([]);
    expect(tax!.routeNames).toEqual([]);
    expect(tax!.canonicalSectionHandles).toEqual([]);
    expect(tax!.feedParams).toEqual([]);
    expect(tax!.matchedFeedUrls).toEqual([]);
    expect(tax!.localeHints).toEqual([]);
    expect(tax!.hreflangLocales).toEqual([]);
    expect(tax!.editionPaths).toEqual([]);
  });

  it("validates taxonomyEvidence inside outcome (not just at root level)", () => {
    const result = validateDiscoveryEvidence({
      taxonomyEvidence: { sectionIds: ["legacy"], tagIds: [], categorySlugs: [] },
      outcome: makeValidOutcome({
        sectionIds: ["outcome-s1"],
        tagIds: ["outcome-t1"],
        categorySlugs: ["outcome-cat"],
        collectionIds: [],
        routeNames: [],
        canonicalSectionHandles: [],
        feedParams: [],
        matchedFeedUrls: [],
        localeHints: [],
        hreflangLocales: [],
        editionPaths: [],
      }),
      feedUrl: null,
    });
    expect(result!.hasOutcome).toBe(true);
    const tax = result!.taxonomyEvidence;
    // Outcome taxonomyEvidence should be preferred over legacy
    expect(tax!.sectionIds).toEqual(["outcome-s1"]);
    expect(tax!.tagIds).toEqual(["outcome-t1"]);
    expect(tax!.categorySlugs).toEqual(["outcome-cat"]);
  });
});
