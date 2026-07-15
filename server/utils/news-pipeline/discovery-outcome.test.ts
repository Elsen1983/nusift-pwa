import { describe, expect, it } from "vitest";
import { createDiscoveryOutcome } from "./types";
import type { FeedDiscoveryResult, ResolutionMeta, TaxonomyEvidence } from "./types";
import { buildDiscoveryEvidencePayload } from "./ingest";

/** Cast Prisma.InputJsonValue back to a concrete shape for test assertions. */
const asPayload = (v: unknown) => v as Record<string, unknown>;

const emptyTaxonomyEvidence = (): TaxonomyEvidence => ({
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
  countryHints: [],
  countryCodes: [],
});

const makeFeedDiscoveryResult = (
  overrides: Partial<FeedDiscoveryResult> = {},
): FeedDiscoveryResult => ({
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
      canonicalIdentity: "https://example.com/rss",
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
      canonicalIdentity: "https://example.com/rss",
    },
  ],
  canonicalIdentity: "https://example.com/rss",
  ...overrides,
});

const fetchOnlyMeta: ResolutionMeta = {
  resolverPath: "fetch",
  browserAttempted: false,
  browserMethod: "none",
  browserCandidateCount: 0,
  browserCandidates: [],
  browserError: null,
};

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

describe("createDiscoveryOutcome", () => {
  it("produces a complete DiscoveryOutcome from a successful discovery", () => {
    const discovery = makeFeedDiscoveryResult();
    const outcome = createDiscoveryOutcome("https://example.com", discovery);

    // Core discovery fields preserved
    expect(outcome.feedUrl).toBe("https://example.com/rss");
    expect(outcome.discoveredVia).toBe("https://example.com");
    expect(outcome.detection).toBe("html-link");
    expect(outcome.score).toBe(65);
    expect(outcome.scopeConfidence).toBe("medium");
    expect(outcome.scopeMatch).toBe("exact");
    expect(outcome.canonicalIdentity).toBe("https://example.com/rss");
    expect(outcome.topCandidates).toHaveLength(1);
    expect(outcome.rejectedCandidates).toHaveLength(1);

    // Outcome-specific fields
    expect(outcome.targetUrl).toBe("https://example.com");
    expect(outcome.verified).toBe(true);
    expect(outcome.evaluatedAt).toBeTruthy();
    expect(typeof outcome.evaluatedAt).toBe("string");
    // ISO-8601 format
    expect(() => new Date(outcome.evaluatedAt)).not.toThrow();
    expect(new Date(outcome.evaluatedAt).getTime()).not.toBeNaN();

    // Default fetch-only resolution metadata
    expect(outcome.resolverPath).toBe("fetch");
    expect(outcome.browserAttempted).toBe(false);
    expect(outcome.browserMethod).toBe("none");
    expect(outcome.browserCandidateCount).toBe(0);
    expect(outcome.browserCandidates).toEqual([]);
    expect(outcome.browserError).toBeNull();
  });

  it("sets verified=false when feedUrl is null (discovery failed)", () => {
    const discovery = makeFeedDiscoveryResult({
      feedUrl: null,
      discoveredVia: null,
      detection: "none",
      score: 0,
      scopeConfidence: "low",
      scopeMatch: "unrelated",
      canonicalIdentity: null,
      lastError: "No feed candidates succeeded.",
    });

    const outcome = createDiscoveryOutcome("https://example.com", discovery);

    expect(outcome.verified).toBe(false);
    expect(outcome.feedUrl).toBeNull();
    expect(outcome.lastError).toBe("No feed candidates succeeded.");
  });

  it("includes browser resolution metadata when provided", () => {
    const discovery = makeFeedDiscoveryResult();
    const outcome = createDiscoveryOutcome(
      "https://example.com",
      discovery,
      jsdomMeta,
    );

    expect(outcome.resolverPath).toBe("jsdom");
    expect(outcome.browserAttempted).toBe(true);
    expect(outcome.browserMethod).toBe("jsdom");
    expect(outcome.browserCandidateCount).toBe(3);
    expect(outcome.browserCandidates).toHaveLength(2);
    expect(outcome.browserCandidates[0]!.feedUrl).toBe("https://example.com/rss");
    expect(outcome.browserCandidates[0]!.source).toBe("dom-link");
    expect(outcome.browserError).toBeNull();
  });

  it("serializes to JSON-compatible values", () => {
    const discovery = makeFeedDiscoveryResult();
    const outcome = createDiscoveryOutcome("https://example.com", discovery);

    // Should not throw on JSON serialization
    const json = JSON.stringify(outcome);
    expect(json).toBeTruthy();

    const parsed = JSON.parse(json);
    expect(parsed.feedUrl).toBe("https://example.com/rss");
    expect(parsed.verified).toBe(true);
    expect(parsed.resolverPath).toBe("fetch");
    expect(parsed.targetUrl).toBe("https://example.com");
    expect(parsed.topCandidates).toHaveLength(1);
    expect(parsed.rejectedCandidates).toHaveLength(1);
  });

  it("preserves null discoveredVia and lastError gracefully", () => {
    const discovery = makeFeedDiscoveryResult({
      discoveredVia: null,
      lastError: undefined,
    });
    const outcome = createDiscoveryOutcome("https://example.com", discovery);

    expect(outcome.discoveredVia).toBeNull();
    // lastError should be undefined (not converted to null)
    expect(outcome.lastError).toBeUndefined();
  });

  it("defaults contentType to null when omitted", () => {
    const discovery = makeFeedDiscoveryResult({ contentType: undefined });
    const outcome = createDiscoveryOutcome("https://example.com", discovery);

    expect(outcome.contentType).toBeNull();
  });

  it("defaults canonicalIdentity to null when omitted", () => {
    const discovery = makeFeedDiscoveryResult({ canonicalIdentity: undefined });
    const outcome = createDiscoveryOutcome("https://example.com", discovery);

    expect(outcome.canonicalIdentity).toBeNull();
  });
});

describe("buildDiscoveryEvidencePayload outcome field", () => {
  it("includes a structured outcome in the evidence payload", () => {
    const result = asPayload(buildDiscoveryEvidencePayload(
      "https://example.com/sport",
      {
        feedUrl: "https://example.com/sport/rss",
        discoveredVia: "https://example.com/sport",
        detection: "html-link",
        scopeConfidence: "high",
        scopeMatch: "exact",
        taxonomyEvidence: {
          ...emptyTaxonomyEvidence(),
          sectionIds: ["42"],
          categorySlugs: ["sport"],
        },
        score: 80,
        topCandidates: [
          {
            feedUrl: "https://example.com/sport/rss",
            detection: "html-link",
            score: 80,
            contentType: "application/rss+xml",
            scopeMatch: "exact",
          },
        ],
        rejectedCandidates: [],
      },
    ));

    // outcome field exists and has expected shape
    expect(result.outcome).toBeDefined();
    expect(typeof result.outcome).toBe("object");

    const outcome = result.outcome as Record<string, unknown>;
    expect(outcome.feedUrl).toBe("https://example.com/sport/rss");
    expect(outcome.targetUrl).toBe("https://example.com/sport");
    expect(outcome.verified).toBe(true);
    expect(outcome.resolverPath).toBe("fetch");
    expect(outcome.browserAttempted).toBe(false);
    expect(outcome.evaluatedAt).toBeTruthy();
    expect(outcome.topCandidates).toHaveLength(1);
    expect(outcome.rejectedCandidates).toHaveLength(0);

    // Legacy flat fields still present alongside outcome
    expect(result.feedUrl).toBe("https://example.com/sport/rss");
    expect(result.scopeMatch).toBe("exact");
    expect(result.scopeConfidence).toBe("high");
  });

  it("outcome has verified=false when no feed resolved", () => {
    const result = asPayload(buildDiscoveryEvidencePayload("https://example.com", {
      feedUrl: null,
      detection: "none",
      lastError: "No candidates found.",
    }));

    const outcome = result.outcome as Record<string, unknown>;
    expect(outcome.verified).toBe(false);
    expect(outcome.feedUrl).toBeNull();
    expect(outcome.lastError).toBe("No candidates found.");
  });

  it("outcome is JSON-serializable for Prisma persistence", () => {
    const result = asPayload(buildDiscoveryEvidencePayload("https://example.com", {
      feedUrl: "https://example.com/rss",
      detection: "html-link",
      scopeMatch: "probable",
      score: 50,
    }));

    // Full payload should serialize without error
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);

    expect(parsed.outcome).toBeDefined();
    expect(parsed.outcome.feedUrl).toBe("https://example.com/rss");
    expect(parsed.outcome.verified).toBe(true);
    expect(parsed.outcome.scopeMatch).toBe("probable");
  });
});

describe("DiscoveryOutcome regression: existing FeedDiscoveryResult shape preserved", () => {
  it("createDiscoveryOutcome preserves all FeedDiscoveryResult fields spread", () => {
    const discovery = makeFeedDiscoveryResult({
      taxonomyEvidence: {
        ...emptyTaxonomyEvidence(),
        sectionIds: ["1"],
        categorySlugs: ["tech"],
        canonicalSectionHandles: ["tech"],
        countryCodes: ["IE"],
      },
    });

    const outcome = createDiscoveryOutcome("https://example.com", discovery);

    // All FeedDiscoveryResult fields must be present
    expect(outcome.feedUrl).toBe(discovery.feedUrl);
    expect(outcome.discoveredVia).toBe(discovery.discoveredVia);
    expect(outcome.detection).toBe(discovery.detection);
    expect(outcome.contentType).toBe(discovery.contentType);
    expect(outcome.score).toBe(discovery.score);
    expect(outcome.scopeConfidence).toBe(discovery.scopeConfidence);
    expect(outcome.scopeMatch).toBe(discovery.scopeMatch);
    expect(outcome.taxonomyEvidence).toBe(discovery.taxonomyEvidence);
    expect(outcome.topCandidates).toBe(discovery.topCandidates);
    expect(outcome.rejectedCandidates).toBe(discovery.rejectedCandidates);
    expect(outcome.canonicalIdentity).toBe(discovery.canonicalIdentity);

    // Taxonomy evidence preserved as structured object
    expect(outcome.taxonomyEvidence.sectionIds).toEqual(["1"]);
    expect(outcome.taxonomyEvidence.categorySlugs).toEqual(["tech"]);
    expect(outcome.taxonomyEvidence.countryCodes).toEqual(["IE"]);
  });
});
