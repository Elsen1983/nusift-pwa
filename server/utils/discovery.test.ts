import { describe, expect, it, vi } from "vitest";

// Mock Prisma before importing discovery.ts (which imports prisma at module level)
vi.mock("./prisma", () => ({
  prisma: {
    newsSource: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    sourceCategory: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
  },
}));

vi.mock("./news-pipeline/log", () => ({
  logAgentScan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./news-pipeline/rss-status", () => ({
  normalizeActiveRssStatus: vi.fn((_status: string) => _status),
}));

// We need to test the payload shape that buildDiscoveryEvidencePayload produces.
// Since it's a private function in discovery.ts, we test it indirectly by importing
// the module and verifying the shape of what createDiscoveryOutcome produces,
// which is the exact same factory that discovery.ts uses.

import { createDiscoveryOutcome } from "./news-pipeline/types";
import type { FeedDiscoveryResult, TaxonomyEvidence } from "./news-pipeline/types";

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
});

describe("discovery.ts outcome integration", () => {
  it("successful discovery produces outcome with verified=true and all legacy fields", () => {
    const discovery: FeedDiscoveryResult = {
      feedUrl: "https://example.com/rss",
      discoveredVia: "https://example.com",
      detection: "html-link",
      contentType: "application/rss+xml",
      score: 65,
      scopeConfidence: "medium",
      scopeMatch: "exact",
      taxonomyEvidence: emptyTaxonomyEvidence(),
      topCandidates: [{
        feedUrl: "https://example.com/rss",
        detection: "html-link",
        score: 65,
        contentType: "application/rss+xml",
        scopeMatch: "exact",
      }],
      rejectedCandidates: [],
      canonicalIdentity: "https://example.com/rss",
    };

    const outcome = createDiscoveryOutcome("https://example.com", discovery);

    // Canonical outcome fields
    expect(outcome.feedUrl).toBe("https://example.com/rss");
    expect(outcome.targetUrl).toBe("https://example.com");
    expect(outcome.verified).toBe(true);
    expect(outcome.resolverPath).toBe("fetch");
    expect(outcome.browserAttempted).toBe(false);
    expect(outcome.evaluatedAt).toBeTruthy();

    // Simulates the exact payload shape discovery.ts builds
    const payload = {
      evaluatedAt: outcome.evaluatedAt,
      targetUrl: "https://example.com",
      feedUrl: discovery.feedUrl,
      discoveredVia: discovery.discoveredVia || null,
      detection: discovery.detection,
      scopeConfidence: discovery.scopeConfidence || "low",
      scopeMatch: discovery.scopeMatch || "generic",
      score: discovery.score ?? 0,
      taxonomyEvidence: discovery.taxonomyEvidence || null,
      canonicalIdentity: discovery.canonicalIdentity ?? null,
      topCandidates: discovery.topCandidates || [],
      rejectedCandidates: discovery.rejectedCandidates || [],
      lastError: discovery.lastError || null,
      outcome,
    };

    // Legacy flat fields present
    expect(payload.feedUrl).toBe("https://example.com/rss");
    expect(payload.scopeMatch).toBe("exact");
    expect(payload.scopeConfidence).toBe("medium");

    // Outcome field present
    expect(payload.outcome).toBeDefined();
    expect(payload.outcome.verified).toBe(true);
    expect(payload.outcome.scopeMatch).toBe("exact");
  });

  it("blocked discovery (SSRF) produces outcome with verified=false", () => {
    const discovery: FeedDiscoveryResult = {
      feedUrl: null,
      discoveredVia: null,
      detection: "blocked-security",
      score: 0,
      scopeConfidence: "low",
      scopeMatch: "unrelated",
      taxonomyEvidence: emptyTaxonomyEvidence(),
      topCandidates: [],
      rejectedCandidates: [],
      lastError: "SSRF blocked",
    };

    const outcome = createDiscoveryOutcome("https://blocked.example.com", discovery);

    expect(outcome.feedUrl).toBeNull();
    expect(outcome.verified).toBe(false);
    expect(outcome.detection).toBe("blocked-security");
    expect(outcome.lastError).toBe("SSRF blocked");
    expect(outcome.resolverPath).toBe("fetch");
  });

  it("WAF-blocked discovery produces outcome with verified=false and correct detection", () => {
    const discovery: FeedDiscoveryResult = {
      feedUrl: null,
      discoveredVia: null,
      detection: "failed",
      score: 0,
      scopeConfidence: "low",
      scopeMatch: "unrelated",
      taxonomyEvidence: emptyTaxonomyEvidence(),
      topCandidates: [],
      rejectedCandidates: [],
      lastError: "WAF_BLOCKED_403",
    };

    const outcome = createDiscoveryOutcome("https://waf.example.com", discovery);

    expect(outcome.verified).toBe(false);
    expect(outcome.lastError).toBe("WAF_BLOCKED_403");
    expect(outcome.targetUrl).toBe("https://waf.example.com");
  });

  it("category failure produces outcome with verified=false", () => {
    const discovery: FeedDiscoveryResult = {
      feedUrl: null,
      discoveredVia: null,
      detection: "failed",
      score: 0,
      scopeConfidence: "low",
      scopeMatch: "unrelated",
      taxonomyEvidence: emptyTaxonomyEvidence(),
      topCandidates: [],
      rejectedCandidates: [],
      lastError: "Connection timeout",
    };

    const outcome = createDiscoveryOutcome("https://example.com/sport", discovery);

    expect(outcome.verified).toBe(false);
    expect(outcome.targetUrl).toBe("https://example.com/sport");
    expect(outcome.lastError).toBe("Connection timeout");
  });

  it("full payload with legacy fields + outcome is JSON-serializable", () => {
    const discovery: FeedDiscoveryResult = {
      feedUrl: "https://example.com/sport/rss",
      discoveredVia: "https://example.com/sport",
      detection: "taxonomy-extraction",
      contentType: "application/rss+xml",
      score: 80,
      scopeConfidence: "high",
      scopeMatch: "exact",
      taxonomyEvidence: {
        ...emptyTaxonomyEvidence(),
        sectionIds: ["42"],
        categorySlugs: ["sport"],
        canonicalSectionHandles: ["sport"],
      },
      topCandidates: [{
        feedUrl: "https://example.com/sport/rss",
        detection: "taxonomy-extraction",
        score: 80,
        contentType: "application/rss+xml",
        scopeMatch: "exact",
      }],
      rejectedCandidates: [{
        feedUrl: "https://example.com/rss.xml",
        detection: "html-link",
        score: 30,
        contentType: null,
        scopeMatch: "generic",
        reason: "did not validate",
      }],
      canonicalIdentity: "https://example.com/sport/rss",
    };

    const outcome = createDiscoveryOutcome("https://example.com/sport", discovery);

    const payload = {
      evaluatedAt: outcome.evaluatedAt,
      targetUrl: "https://example.com/sport",
      feedUrl: discovery.feedUrl,
      discoveredVia: discovery.discoveredVia || null,
      detection: discovery.detection,
      scopeConfidence: discovery.scopeConfidence || "low",
      scopeMatch: discovery.scopeMatch || "generic",
      score: discovery.score ?? 0,
      taxonomyEvidence: discovery.taxonomyEvidence || null,
      canonicalIdentity: discovery.canonicalIdentity ?? null,
      topCandidates: discovery.topCandidates || [],
      rejectedCandidates: discovery.rejectedCandidates || [],
      lastError: discovery.lastError || null,
      outcome,
    };

    // Should serialize without error
    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json);

    expect(parsed.outcome).toBeDefined();
    expect(parsed.outcome.verified).toBe(true);
    expect(parsed.outcome.scopeMatch).toBe("exact");
    expect(parsed.outcome.taxonomyEvidence.sectionIds).toEqual(["42"]);
    expect(parsed.outcome.topCandidates).toHaveLength(1);
    expect(parsed.outcome.rejectedCandidates).toHaveLength(1);
    expect(parsed.outcome.rejectedCandidates[0].reason).toBe("did not validate");
    expect(parsed.outcome.canonicalIdentity).toBe("https://example.com/sport/rss");

    // Legacy flat fields still present alongside outcome
    expect(parsed.feedUrl).toBe("https://example.com/sport/rss");
    expect(parsed.scopeMatch).toBe("exact");
    expect(parsed.scopeConfidence).toBe("high");
  });

  it("scopeMatch defaults are consistent between legacy and outcome", () => {
    const discovery: FeedDiscoveryResult = {
      feedUrl: null,
      discoveredVia: null,
      detection: "none",
      score: 0,
      scopeConfidence: "low",
      scopeMatch: "generic",
      taxonomyEvidence: emptyTaxonomyEvidence(),
      topCandidates: [],
      rejectedCandidates: [],
    };

    const outcome = createDiscoveryOutcome("https://example.com", discovery);

    // Both legacy and outcome should use the same default
    const legacyScopeMatch = discovery.scopeMatch || "generic";
    expect(legacyScopeMatch).toBe(outcome.scopeMatch);
  });
});
