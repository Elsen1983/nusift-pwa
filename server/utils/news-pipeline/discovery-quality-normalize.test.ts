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
});
