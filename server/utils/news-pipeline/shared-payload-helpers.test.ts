import { describe, expect, it } from "vitest";
import type { DiscoveryOutcome, ResolutionMeta, TaxonomyEvidence } from "./types";
import {
  buildErrorDiscoveryOutcome,
  emptyTaxonomyEvidence,
  formatDiscoveryLog,
  nonNullish,
  serializeDiscoveryPayload,
  serializeDiscoveryPayloadWithMeta,
} from "./types";

/** Cast Prisma.InputJsonValue back to a concrete shape for test assertions. */
const asPayload = (v: unknown) => v as Record<string, unknown>;

const makeOutcome = (
  overrides: Partial<DiscoveryOutcome> = {},
): DiscoveryOutcome => ({
  feedUrl: "https://example.com/rss",
  discoveredVia: "https://example.com",
  detection: "html-link",
  contentType: "application/rss+xml",
  score: 65,
  scopeConfidence: "medium",
  scopeMatch: "exact",
  taxonomyEvidence: emptyTaxonomyEvidence(),
  topCandidates: [
    {
      feedUrl: "https://example.com/rss",
      detection: "html-link",
      score: 65,
      contentType: "application/rss+xml",
      scopeMatch: "exact",
    },
  ],
  rejectedCandidates: [
    {
      feedUrl: "https://example.com/feed.xml",
      detection: "html-link",
      score: 30,
      contentType: null,
      scopeMatch: "generic",
      reason: "did not validate",
    },
  ],
  lastError: undefined,
  canonicalIdentity: "https://example.com/rss",
  evaluatedAt: "2026-01-15T10:00:00.000Z",
  targetUrl: "https://example.com",
  verified: true,
  resolverPath: "fetch",
  browserAttempted: false,
  browserMethod: "none",
  browserCandidateCount: 0,
  browserCandidates: [],
  browserError: null,
  ...overrides,
});

const jsdomMeta: ResolutionMeta = {
  resolverPath: "jsdom",
  browserAttempted: true,
  browserMethod: "jsdom",
  browserCandidateCount: 3,
  browserCandidates: [
    { feedUrl: "https://example.com/rss", source: "dom-link" },
    { feedUrl: "https://example.com/feed", source: "anchor-tag" },
  ],
  browserError: null,
};

// ─── serializeDiscoveryPayload ───────────────────────────────────────────────

describe("serializeDiscoveryPayload", () => {
  it("produces all legacy flat fields from outcome", () => {
    const outcome = makeOutcome();
    const payload = asPayload(serializeDiscoveryPayload(outcome));

    expect(payload.evaluatedAt).toBe("2026-01-15T10:00:00.000Z");
    expect(payload.targetUrl).toBe("https://example.com");
    expect(payload.feedUrl).toBe("https://example.com/rss");
    expect(payload.discoveredVia).toBe("https://example.com");
    expect(payload.detection).toBe("html-link");
    expect(payload.scopeConfidence).toBe("medium");
    expect(payload.scopeMatch).toBe("exact");
    expect(payload.score).toBe(65);
    expect(payload.canonicalIdentity).toBe("https://example.com/rss");
    expect(payload.lastError).toBeNull();
  });

  it("includes taxonomyEvidence as structured object", () => {
    const outcome = makeOutcome({
      taxonomyEvidence: {
        ...emptyTaxonomyEvidence(),
        sectionIds: ["42"],
        categorySlugs: ["sport"],
      },
    });
    const payload = asPayload(serializeDiscoveryPayload(outcome));

    expect(payload.taxonomyEvidence).toBeDefined();
    expect(typeof payload.taxonomyEvidence).toBe("object");
    expect((payload.taxonomyEvidence as TaxonomyEvidence).sectionIds).toEqual(["42"]);
    expect((payload.taxonomyEvidence as TaxonomyEvidence).categorySlugs).toEqual(["sport"]);
  });

  it("includes canonical outcome field", () => {
    const outcome = makeOutcome();
    const payload = asPayload(serializeDiscoveryPayload(outcome));

    expect(payload.outcome).toBe(outcome);
    expect((payload.outcome as DiscoveryOutcome).verified).toBe(true);
    expect((payload.outcome as DiscoveryOutcome).resolverPath).toBe("fetch");
  });

  it("is JSON-serializable", () => {
    const outcome = makeOutcome();
    const payload = asPayload(serializeDiscoveryPayload(outcome));

    const json = JSON.stringify(payload);
    expect(json).toBeTruthy();

    const parsed = JSON.parse(json);
    expect(parsed.feedUrl).toBe("https://example.com/rss");
    expect(parsed.outcome.verified).toBe(true);
    expect(parsed.topCandidates).toHaveLength(1);
    expect(parsed.rejectedCandidates).toHaveLength(1);
  });

  it("converts undefined lastError to null", () => {
    const outcome = makeOutcome({ lastError: undefined });
    const payload = asPayload(serializeDiscoveryPayload(outcome));
    expect(payload.lastError).toBeNull();
  });

  it("preserves null canonicalIdentity", () => {
    const outcome = makeOutcome({ canonicalIdentity: null });
    const payload = asPayload(serializeDiscoveryPayload(outcome));
    expect(payload.canonicalIdentity).toBeNull();
  });
});

// ─── serializeDiscoveryPayloadWithMeta ──────────────────────────────────────

describe("serializeDiscoveryPayloadWithMeta", () => {
  it("includes all resolution meta fields alongside legacy fields", () => {
    const outcome = makeOutcome({
      resolverPath: "jsdom",
      browserAttempted: true,
      browserMethod: "jsdom",
      browserCandidateCount: 3,
      browserCandidates: [
        { feedUrl: "https://example.com/rss", source: "dom-link" },
      ],
    });
    const payload = asPayload(serializeDiscoveryPayloadWithMeta(outcome, jsdomMeta));

    // Legacy fields present
    expect(payload.feedUrl).toBe("https://example.com/rss");
    expect(payload.scopeMatch).toBe("exact");

    // Resolution meta in flat fields
    expect(payload.resolverPath).toBe("jsdom");
    expect(payload.browserAttempted).toBe(true);
    expect(payload.browserMethod).toBe("jsdom");
    expect(payload.browserCandidateCount).toBe(3);
    expect(payload.browserCandidates).toEqual([
      { feedUrl: "https://example.com/rss", source: "dom-link" },
      { feedUrl: "https://example.com/feed", source: "anchor-tag" },
    ]);
    expect(payload.browserError).toBeNull();

    // Outcome still present
    expect(payload.outcome).toBe(outcome);
  });

  it("includes browserCandidates and browserError in flat fields", () => {
    const metaWith: ResolutionMeta = {
      resolverPath: "jsdom",
      browserAttempted: true,
      browserMethod: "jsdom",
      browserCandidateCount: 2,
      browserCandidates: [
        { feedUrl: "https://a.com/rss", source: "dom-link" },
        { feedUrl: "https://b.com/rss", source: "anchor-tag" },
      ],
      browserError: null,
    };
    const outcome = makeOutcome();
    const payload = asPayload(serializeDiscoveryPayloadWithMeta(outcome, metaWith));

    expect(payload.browserCandidates).toHaveLength(2);
    expect(payload.browserError).toBeNull();
  });

  it("preserves browserError string from meta", () => {
    const metaWithError: ResolutionMeta = {
      resolverPath: "none",
      browserAttempted: true,
      browserMethod: "jsdom",
      browserCandidateCount: 0,
      browserCandidates: [],
      browserError: "Browser resolution failed: timeout",
    };
    const outcome = makeOutcome({ verified: false, feedUrl: null });
    const payload = asPayload(serializeDiscoveryPayloadWithMeta(outcome, metaWithError));

    expect(payload.browserError).toBe("Browser resolution failed: timeout");
    expect(payload.resolverPath).toBe("none");
  });
});

// ─── formatDiscoveryLog ─────────────────────────────────────────────────────

describe("formatDiscoveryLog", () => {
  it("formats basic discovery info without outcome", () => {
    const discovery = {
      detection: "html-link",
      scopeConfidence: "medium",
      score: 65,
      topCandidates: [
        { feedUrl: "https://a.com/rss", detection: "html-link", score: 65 },
        { feedUrl: "https://b.com/rss", detection: "direct-feed", score: 40 },
      ],
    };

    const log = formatDiscoveryLog(discovery);

    expect(log).toContain("method=html-link");
    expect(log).toContain("confidence=medium");
    expect(log).toContain("score=65");
    expect(log).toContain("html-link:65:https://a.com/rss");
    expect(log).toContain("direct-feed:40:https://b.com/rss");
    expect(log).not.toContain("verified=");
    expect(log).not.toContain("resolverPath=");
  });

  it("includes verified and resolverPath when outcome is provided", () => {
    const discovery = {
      detection: "html-link",
      scopeConfidence: "high",
      score: 80,
      topCandidates: [],
    };
    const outcome = makeOutcome({ verified: true, resolverPath: "jsdom" });

    const log = formatDiscoveryLog(discovery, outcome);

    expect(log).toContain("verified=true");
    expect(log).toContain("resolverPath=jsdom");
    expect(log).toContain("candidates=none");
  });

  it("includes lastError when present", () => {
    const discovery = {
      detection: "none",
      score: 0,
      topCandidates: [],
      lastError: "Connection refused",
    };

    const log = formatDiscoveryLog(discovery);

    expect(log).toContain("lastError=Connection refused");
  });

  it("defaults confidence to n/a when missing", () => {
    const discovery = { detection: "none", score: 0, topCandidates: [] };

    const log = formatDiscoveryLog(discovery);

    expect(log).toContain("confidence=n/a");
  });

  it("truncates to top 3 candidates", () => {
    const discovery = {
      detection: "html-link",
      score: 50,
      topCandidates: [
        { feedUrl: "https://1.com", detection: "d1", score: 50 },
        { feedUrl: "https://2.com", detection: "d2", score: 40 },
        { feedUrl: "https://3.com", detection: "d3", score: 30 },
        { feedUrl: "https://4.com", detection: "d4", score: 20 },
      ],
    };

    const log = formatDiscoveryLog(discovery);

    expect(log).toContain("https://1.com");
    expect(log).toContain("https://3.com");
    expect(log).not.toContain("https://4.com");
  });
});

// ─── nonNullish ────────────────────────────────────────────────────────────

describe("nonNullish", () => {
  it("filters out null and undefined while preserving valid values", () => {
    const input = [1, null, 2, undefined, 3, null];
    const result = input.filter(nonNullish);
    expect(result).toEqual([1, 2, 3]);
  });

  it("narrows type from T | null | undefined to NonNullable<T>", () => {
    const items: Array<string | null | undefined> = ["a", null, "b", undefined];
    const filtered = items.filter(nonNullish);
    // TypeScript infers filtered as string[]
    expect(filtered.every((item) => typeof item === "string")).toBe(true);
    expect(filtered).toEqual(["a", "b"]);
  });

  it("preserves falsy non-nullish values (0, empty string, false)", () => {
    const input = [0, "", false, null, undefined, 42];
    const result = input.filter(nonNullish);
    expect(result).toEqual([0, "", false, 42]);
  });

  it("returns empty array when all values are nullish", () => {
    const input = [null, undefined, null];
    const result = input.filter(nonNullish);
    expect(result).toEqual([]);
  });

  it("replaces the filter(Boolean) as any pattern for Prisma OR filters", () => {
    // Simulates the Prisma OR filter pattern from ingest.ts
    const rssGuids = ["guid-1"];
    const canonicalUrls: string[] = [];

    const filters = [
      rssGuids.length ? { rssGuid: { in: rssGuids } } : undefined,
      canonicalUrls.length ? { canonicalUrl: { in: canonicalUrls } } : undefined,
    ].filter(nonNullish);

    expect(filters).toEqual([{ rssGuid: { in: ["guid-1"] } }]);
    expect(filters).toHaveLength(1);
  });

  it("builds correct Prisma OR array for persistCandidates (rssGuids + canonicalUrls + contentHashes)", () => {
    // Regression test: verifies the persistCandidates Prisma OR filter pattern
    // produces the same result as the old `filter(Boolean) as any` approach.
    const rssGuids = ["guid-1", "guid-2"];
    const canonicalUrls = ["https://example.com/a"];
    const contentHashes: string[] = [];

    const or = [
      rssGuids.length ? { rssGuid: { in: rssGuids } } : undefined,
      canonicalUrls.length ? { canonicalUrl: { in: canonicalUrls } } : undefined,
      contentHashes.length ? { contentHash: { in: contentHashes } } : undefined,
    ].filter(nonNullish);

    expect(or).toEqual([
      { rssGuid: { in: ["guid-1", "guid-2"] } },
      { canonicalUrl: { in: ["https://example.com/a"] } },
    ]);
    expect(or).toHaveLength(2);
  });

  it("produces empty Prisma OR array when all candidates are empty", () => {
    const rssGuids: string[] = [];
    const canonicalUrls: string[] = [];
    const contentHashes: string[] = [];

    const or = [
      rssGuids.length ? { rssGuid: { in: rssGuids } } : undefined,
      canonicalUrls.length ? { canonicalUrl: { in: canonicalUrls } } : undefined,
      contentHashes.length ? { contentHash: { in: contentHashes } } : undefined,
    ].filter(nonNullish);

    expect(or).toEqual([]);
    expect(or).toHaveLength(0);
  });

  it("includes all three filter types when all have values", () => {
    const rssGuids = ["g1"];
    const canonicalUrls = ["https://a.com"];
    const contentHashes = ["hash-abc"];

    const or = [
      rssGuids.length ? { rssGuid: { in: rssGuids } } : undefined,
      canonicalUrls.length ? { canonicalUrl: { in: canonicalUrls } } : undefined,
      contentHashes.length ? { contentHash: { in: contentHashes } } : undefined,
    ].filter(nonNullish);

    expect(or).toHaveLength(3);
    expect(or).toEqual([
      { rssGuid: { in: ["g1"] } },
      { canonicalUrl: { in: ["https://a.com"] } },
      { contentHash: { in: ["hash-abc"] } },
    ]);
  });
});

// ─── serializeDiscoveryPayload legacyOverrides ─────────────────────────────

describe("serializeDiscoveryPayload legacyOverrides", () => {
  it("applies legacyOverrides to the serialized payload", () => {
    const outcome = makeOutcome({
      taxonomyEvidence: {
        ...emptyTaxonomyEvidence(),
        sectionIds: ["42"],
      },
    });

    // Override taxonomyEvidence to null for backward compatibility
    const payload = asPayload(serializeDiscoveryPayload(outcome, { taxonomyEvidence: null }));

    // The override wins
    expect(payload.taxonomyEvidence).toBeNull();
    // Other fields are unaffected
    expect(payload.feedUrl).toBe("https://example.com/rss");
    expect(payload.scopeMatch).toBe("exact");
    // Outcome still has the original taxonomy evidence
    expect((payload.outcome as Record<string, unknown>).taxonomyEvidence).toBeDefined();
    expect(((payload.outcome as Record<string, unknown>).taxonomyEvidence as TaxonomyEvidence).sectionIds).toEqual(["42"]);
  });

  it("produces identical output when no overrides are provided", () => {
    const outcome = makeOutcome();
    const withOverride = asPayload(serializeDiscoveryPayload(outcome));
    const withoutOverride = asPayload(serializeDiscoveryPayload(outcome, undefined));

    expect(JSON.stringify(withOverride)).toBe(JSON.stringify(withoutOverride));
  });

  it("override does not affect the nested outcome object", () => {
    const outcome = makeOutcome();
    const payload = asPayload(serializeDiscoveryPayload(outcome, { taxonomyEvidence: null }));

    // Legacy flat field is null
    expect(payload.taxonomyEvidence).toBeNull();
    // Outcome still has the original evidence
    const nestedOutcome = payload.outcome as Record<string, unknown>;
    expect(nestedOutcome.taxonomyEvidence).toBeDefined();
    expect(Array.isArray((nestedOutcome.taxonomyEvidence as TaxonomyEvidence).sectionIds)).toBe(true);
  });
});

// ─── buildErrorDiscoveryOutcome ─────────────────────────────────────────────

describe("buildErrorDiscoveryOutcome", () => {
  it("produces verified=false outcome with correct detection", () => {
    const outcome = buildErrorDiscoveryOutcome(
      "https://example.com",
      "blocked-security",
      "SSRF blocked",
    );

    expect(outcome.verified).toBe(false);
    expect(outcome.feedUrl).toBeNull();
    expect(outcome.detection).toBe("blocked-security");
    expect(outcome.lastError).toBe("SSRF blocked");
    expect(outcome.targetUrl).toBe("https://example.com");
    expect(outcome.score).toBe(0);
    expect(outcome.scopeConfidence).toBe("low");
    expect(outcome.scopeMatch).toBe("unrelated");
    expect(outcome.topCandidates).toEqual([]);
    expect(outcome.rejectedCandidates).toEqual([]);
  });

  it("uses emptyTaxonomyEvidence for taxonomy fields", () => {
    const outcome = buildErrorDiscoveryOutcome(
      "https://example.com",
      "failed",
      "timeout",
    );

    expect(outcome.taxonomyEvidence).toBeDefined();
    expect(outcome.taxonomyEvidence.sectionIds).toEqual([]);
    expect(outcome.taxonomyEvidence.categorySlugs).toEqual([]);
  });

  it("defaults to fetch resolverPath", () => {
    const outcome = buildErrorDiscoveryOutcome(
      "https://example.com",
      "failed",
      "error",
    );

    expect(outcome.resolverPath).toBe("fetch");
    expect(outcome.browserAttempted).toBe(false);
    expect(outcome.browserMethod).toBe("none");
  });

  it("is JSON-serializable for Prisma persistence", () => {
    const outcome = buildErrorDiscoveryOutcome(
      "https://example.com",
      "blocked-security",
      "SSRF",
    );

    const json = JSON.stringify(outcome);
    const parsed = JSON.parse(json);
    expect(parsed.verified).toBe(false);
    expect(parsed.detection).toBe("blocked-security");
    expect(parsed.taxonomyEvidence.sectionIds).toEqual([]);
  });
});
