import { describe, expect, it } from "vitest";
import { normalizeDiscoveryQualityArtifact } from "./discovery-quality-normalize";

const baseArtifact = {
  id: "art-1",
  createdAt: new Date("2026-07-16T10:00:00Z"),
  sourceId: "src-1",
  categoryId: null as string | null,
  artifactType: "article_discovery_candidates",
  status: "CAPTURED",
  candidateCount: 3,
};

describe("normalizeDiscoveryQualityArtifact", () => {
  // ── shouldEscalateToHeadless ─────────────────────────────────────────

  it("returns false for candidate artifact with explicit shouldEscalateToHeadless false", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {
        qualityAssessment: {
          quality: "productive",
          shouldEscalateToHeadless: false,
          escalationReasons: [],
          confidence: "high",
          explanation: "All good.",
        },
      },
    });

    expect(result.shouldEscalateToHeadless).toBe(false);
    expect(result.quality).toBe("productive");
  });

  it("returns true for candidate artifact with explicit shouldEscalateToHeadless true", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {
        qualityAssessment: {
          quality: "weak",
          shouldEscalateToHeadless: true,
          escalationReasons: ["low_acceptance_rate"],
          confidence: "medium",
          explanation: "Weak coverage.",
        },
      },
    });

    expect(result.shouldEscalateToHeadless).toBe(true);
    expect(result.quality).toBe("weak");
  });

  it("returns false for candidate artifact when qualityAssessment is missing", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {},
    });

    expect(result.shouldEscalateToHeadless).toBe(false);
  });

  it("always returns true for headless_required artifact regardless of payload", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      artifactType: "article_discovery_headless_required",
      status: "PENDING_HEADLESS",
      candidateCount: 0,
      payload: {
        quality: "failed",
        escalationReasons: ["no_candidates"],
        explanation: "No candidates found.",
      },
    });

    expect(result.shouldEscalateToHeadless).toBe(true);
  });

  it("always returns true for headless_required artifact with weak quality", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      artifactType: "article_discovery_headless_required",
      status: "PENDING_HEADLESS",
      candidateCount: 0,
      payload: {
        quality: "weak",
        escalationReasons: ["low_acceptance_rate", "mostly_fetch_failed"],
        explanation: "Weak coverage.",
      },
    });

    expect(result.shouldEscalateToHeadless).toBe(true);
    expect(result.quality).toBe("weak");
  });

  it("always returns true for headless_required artifact with blocked quality", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      artifactType: "article_discovery_headless_required",
      status: "PENDING_HEADLESS",
      candidateCount: 0,
      payload: {
        quality: "blocked",
        escalationReasons: ["blocked_or_forbidden", "mostly_fetch_failed"],
        explanation: "Site blocks requests.",
      },
    });

    expect(result.shouldEscalateToHeadless).toBe(true);
    expect(result.quality).toBe("blocked");
  });

  // ── Quality and confidence extraction ────────────────────────────────

  it("extracts quality from nested qualityAssessment first", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {
        quality: "blocked",
        qualityAssessment: { quality: "productive", confidence: "high" },
      },
    });

    expect(result.quality).toBe("productive");
  });

  it("falls back to payload-level quality when qualityAssessment is empty", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      artifactType: "article_discovery_headless_required",
      payload: { quality: "failed" },
    });

    expect(result.quality).toBe("failed");
  });

  it("returns null quality when neither exists", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {},
    });

    expect(result.quality).toBeNull();
  });

  // ── Escalation reasons ──────────────────────────────────────────────

  it("extracts escalation reasons from qualityAssessment first", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {
        qualityAssessment: {
          escalationReasons: ["mostly_fetch_failed"],
        },
        escalationReasons: ["no_candidates"],
      },
    });

    expect(result.escalationReasons).toEqual(["mostly_fetch_failed"]);
  });

  it("falls back to payload-level escalation reasons", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      artifactType: "article_discovery_headless_required",
      payload: {
        escalationReasons: ["blocked_or_forbidden", "mostly_fetch_failed"],
      },
    });

    expect(result.escalationReasons).toEqual(["blocked_or_forbidden", "mostly_fetch_failed"]);
  });

  it("returns empty array when no escalation reasons exist", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {},
    });

    expect(result.escalationReasons).toEqual([]);
  });

  // ── Outcome summary ─────────────────────────────────────────────────

  it("extracts outcomeSummary from payload", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {
        outcomeSummary: {
          totalEvaluated: 15,
          accepted: 3,
          rejected: 12,
          byStatus: { accepted: 3, rejected_stale: 8, fetch_failed: 4 },
          topRejectionReasons: [{ reason: "stale", count: 8 }],
        },
      },
    });

    expect(result.outcomeSummary.totalEvaluated).toBe(15);
    expect(result.outcomeSummary.accepted).toBe(3);
    expect(result.outcomeSummary.rejected).toBe(12);
    expect(result.outcomeSummary.byStatus).toEqual({ accepted: 3, rejected_stale: 8, fetch_failed: 4 });
    expect(result.outcomeSummary.topRejectionReasons).toEqual([{ reason: "stale", count: 8 }]);
  });

  it("returns zeroed outcomeSummary when payload has none", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {},
    });

    expect(result.outcomeSummary.totalEvaluated).toBe(0);
    expect(result.outcomeSummary.accepted).toBe(0);
    expect(result.outcomeSummary.rejected).toBe(0);
    expect(result.outcomeSummary.byStatus).toEqual({});
    expect(result.outcomeSummary.topRejectionReasons).toEqual([]);
  });

  // ── Discovery sources ───────────────────────────────────────────────

  it("extracts discoverySources from payload", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {
        discoverySources: { listingPages: 2, sitemapUrls: 5, jsonldUrls: 3 },
      },
    });

    expect(result.discoverySources).toEqual({ listingPages: 2, sitemapUrls: 5, jsonldUrls: 3 });
  });

  it("returns zeroed discoverySources when payload has none", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {},
    });

    expect(result.discoverySources).toEqual({ listingPages: 0, sitemapUrls: 0, jsonldUrls: 0 });
  });

  // ── Pass-through fields ─────────────────────────────────────────────

  it("passes through id, sourceId, categoryId, artifactType, status, candidateCount", () => {
    const result = normalizeDiscoveryQualityArtifact({
      id: "art-42",
      createdAt: new Date("2026-07-15"),
      sourceId: "src-99",
      categoryId: "cat-7",
      artifactType: "article_discovery_headless_required",
      status: "PENDING_HEADLESS",
      candidateCount: 0,
      payload: {},
    });

    expect(result.id).toBe("art-42");
    expect(result.sourceId).toBe("src-99");
    expect(result.categoryId).toBe("cat-7");
    expect(result.artifactType).toBe("article_discovery_headless_required");
    expect(result.status).toBe("PENDING_HEADLESS");
    expect(result.candidateCount).toBe(0);
  });

  it("extracts targetUrl from payload", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: { targetUrl: "https://example.com/news" },
    });

    expect(result.targetUrl).toBe("https://example.com/news");
  });

  it("returns null targetUrl when payload has none", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {},
    });

    expect(result.targetUrl).toBeNull();
  });

  // ── staleSamples extraction ──────────────────────────────────────────

  it("extracts staleSamples from rejectedCandidates with staleReason", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {
        rejectedCandidates: [
          { status: "rejected_stale", url: "https://example.com/old-1", staleReason: "published_at_before_cutoff", normalizedPublishedAt: "2020-01-01T00:00:00Z", publishedAtSource: "article:published_time", ageDays: 2392 },
          { status: "rejected_stale", url: "https://example.com/old-2", staleReason: "missing_published_at", normalizedPublishedAt: null, publishedAtSource: "unknown", ageDays: null },
          { status: "accepted", url: "https://example.com/fresh" },
        ],
      },
    });

    expect(result.staleSamples).toHaveLength(2);
    expect(result.staleSamples[0]?.url).toBe("https://example.com/old-1");
    expect(result.staleSamples[0]?.staleReason).toBe("published_at_before_cutoff");
    expect(result.staleSamples[0]?.ageDays).toBe(2392);
    expect(result.staleSamples[1]?.staleReason).toBe("missing_published_at");
  });

  it("caps staleSamples at 3", () => {
    const rejectedCandidates = Array.from({ length: 5 }, (_, i) => ({
      status: "rejected_stale",
      url: `https://example.com/old-${i}`,
      staleReason: "published_at_before_cutoff",
      normalizedPublishedAt: "2020-01-01T00:00:00Z",
      publishedAtSource: "article:published_time",
      ageDays: 2000,
    }));

    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: { rejectedCandidates },
    });

    expect(result.staleSamples).toHaveLength(3);
  });

  it("returns empty staleSamples when no rejectedCandidates", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {},
    });

    expect(result.staleSamples).toEqual([]);
  });

  it("returns empty staleSamples when rejectedCandidates is not an array", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: { rejectedCandidates: "not an array" },
    });

    expect(result.staleSamples).toEqual([]);
  });

  it("skips rejected_stale entries without staleReason", () => {
    const result = normalizeDiscoveryQualityArtifact({
      ...baseArtifact,
      payload: {
        rejectedCandidates: [
          { status: "rejected_stale", url: "https://example.com/old" },
          { status: "rejected_stale", url: "https://example.com/old-2", staleReason: "published_at_before_cutoff" },
        ],
      },
    });

    expect(result.staleSamples).toHaveLength(1);
    expect(result.staleSamples[0]?.url).toBe("https://example.com/old-2");
  });

  // ── Artifact roundtrip: invalid_published_at ─────────────────────────

  it("roundtrip: invalid_published_at stale audit survives from artifact payload to normalized staleSamples", () => {
    // Simulates what persistArticleDiscoveryArtifact would produce for a
    // rejected_stale outcome with staleReason: "invalid_published_at".
    // The rawPublishedAt is preserved, normalizedPublishedAt is null.
    const mockArtifactPayload = {
      targetUrl: "https://www.nba.com/news/trade-story",
      outcomeSummary: {
        totalEvaluated: 20,
        accepted: 0,
        rejected: 20,
        byStatus: { rejected_stale: 20 },
        topRejectionReasons: [{ reason: "invalid publishedAt", count: 20 }],
      },
      qualityAssessment: {
        quality: "failed",
        shouldEscalateToHeadless: true,
        escalationReasons: ["no_candidates"],
        confidence: "high",
        explanation: "20 URL(s) were evaluated but none produced valid article candidates. 20 were stale.",
      },
      rejectedCandidates: [
        {
          url: "https://www.nba.com/news/story-1",
          canonicalUrl: "https://www.nba.com/news/story-1",
          sourceKind: "listing" as const,
          status: "rejected_stale" as const,
          title: "NBA Trade Story One",
          publishedAt: null,
          reason: "invalid publishedAt",
          rawPublishedAt: "not-a-valid-date-string",
          normalizedPublishedAt: null,
          publishedAtSource: "datePublished" as const,
          freshnessCutoffIso: "2026-07-06T12:00:00.000Z",
          ageDays: null,
          staleReason: "invalid_published_at" as const,
        },
        {
          url: "https://www.nba.com/news/story-2",
          canonicalUrl: "https://www.nba.com/news/story-2",
          sourceKind: "listing" as const,
          status: "rejected_stale" as const,
          title: "NBA Trade Story Two",
          publishedAt: null,
          reason: "invalid publishedAt",
          rawPublishedAt: "2020-01-15T00:00:00Z",
          normalizedPublishedAt: "2020-01-15T00:00:00.000Z",
          publishedAtSource: "article:modified_time" as const,
          freshnessCutoffIso: "2026-07-06T12:00:00.000Z",
          ageDays: 2378,
          staleReason: "published_at_before_cutoff" as const,
        },
      ],
    };

    const result = normalizeDiscoveryQualityArtifact({
      id: "nba-artifact-1",
      createdAt: new Date("2026-07-20T12:00:00Z"),
      sourceId: "71d49c2b-9fcd-4f26-b163-c3318e576b2b",
      categoryId: null,
      artifactType: "article_discovery_candidates",
      status: "FAILED",
      candidateCount: 0,
      payload: mockArtifactPayload,
    });

    // Verify staleSamples extracted correctly
    expect(result.staleSamples).toHaveLength(2);

    // First sample: invalid_published_at
    const invalidSample = result.staleSamples[0];
    expect(invalidSample?.url).toBe("https://www.nba.com/news/story-1");
    expect(invalidSample?.staleReason).toBe("invalid_published_at");
    expect(invalidSample?.normalizedPublishedAt).toBeNull();
    expect(invalidSample?.publishedAtSource).toBe("datePublished");
    expect(invalidSample?.ageDays).toBeNull();

    // Second sample: published_at_before_cutoff
    const staleSample = result.staleSamples[1];
    expect(staleSample?.url).toBe("https://www.nba.com/news/story-2");
    expect(staleSample?.staleReason).toBe("published_at_before_cutoff");
    expect(staleSample?.normalizedPublishedAt).toBe("2020-01-15T00:00:00.000Z");
    expect(staleSample?.publishedAtSource).toBe("article:modified_time");
    expect(staleSample?.ageDays).toBe(2378);

    // Verify quality and escalation preserved
    expect(result.quality).toBe("failed");
    expect(result.shouldEscalateToHeadless).toBe(true);
    expect(result.targetUrl).toBe("https://www.nba.com/news/trade-story");
  });
});
