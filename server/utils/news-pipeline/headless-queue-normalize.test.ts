import { describe, it, expect } from "vitest";
import {
  isPlainObject,
  readString,
  readNumber,
  readStringArray,
  readBoolean,
  normalizeHeadlessQueueArtifact,
  buildHeadlessQueueSummary,
} from "./headless-queue-normalize";

// ─── Helper unit tests ──────────────────────────────────────────────────────

describe("isPlainObject", () => {
  it("returns true for plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isPlainObject("hello")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe("readString", () => {
  it("returns non-empty strings", () => {
    expect(readString("hello")).toBe("hello");
    expect(readString("https://example.com")).toBe("https://example.com");
  });

  it("returns null for empty string", () => {
    expect(readString("")).toBeNull();
  });

  it("returns null for non-string values", () => {
    expect(readString(42)).toBeNull();
    expect(readString(true)).toBeNull();
    expect(readString(null)).toBeNull();
    expect(readString(undefined)).toBeNull();
    expect(readString([])).toBeNull();
    expect(readString({})).toBeNull();
  });
});

describe("readNumber", () => {
  it("returns finite numbers", () => {
    expect(readNumber(0)).toBe(0);
    expect(readNumber(42)).toBe(42);
    expect(readNumber(-1)).toBe(-1);
    expect(readNumber(3.14)).toBe(3.14);
  });

  it("returns null for NaN and Infinity", () => {
    expect(readNumber(NaN)).toBeNull();
    expect(readNumber(Infinity)).toBeNull();
    expect(readNumber(-Infinity)).toBeNull();
  });

  it("returns null for non-number values", () => {
    expect(readNumber("42")).toBeNull();
    expect(readNumber(true)).toBeNull();
    expect(readNumber(null)).toBeNull();
    expect(readNumber(undefined)).toBeNull();
    expect(readNumber([])).toBeNull();
    expect(readNumber({})).toBeNull();
  });
});

describe("readStringArray", () => {
  it("returns arrays of strings as-is", () => {
    expect(readStringArray(["a", "b"])).toEqual(["a", "b"]);
  });

  it("filters out non-string items", () => {
    expect(readStringArray(["a", 42, null, "b", true, undefined])).toEqual(["a", "b"]);
  });

  it("returns empty array for non-arrays", () => {
    expect(readStringArray("not an array")).toEqual([]);
    expect(readStringArray(42)).toEqual([]);
    expect(readStringArray(null)).toEqual([]);
    expect(readStringArray(undefined)).toEqual([]);
    expect(readStringArray(true)).toEqual([]);
    expect(readStringArray({})).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(readStringArray([])).toEqual([]);
  });
});

describe("readBoolean", () => {
  it("returns true only for boolean true", () => {
    expect(readBoolean(true)).toBe(true);
  });

  it("returns false for everything else", () => {
    expect(readBoolean(false)).toBe(false);
    expect(readBoolean("true")).toBe(false);
    expect(readBoolean(1)).toBe(false);
    expect(readBoolean(null)).toBe(false);
    expect(readBoolean(undefined)).toBe(false);
    expect(readBoolean({})).toBe(false);
    expect(readBoolean([])).toBe(false);
  });
});

// ─── Normalizer tests ───────────────────────────────────────────────────────

describe("normalizeHeadlessQueueArtifact", () => {
  const baseArtifact = {
    id: "art-1",
    status: "PENDING_HEADLESS",
    artifactType: "article_discovery_headless_required",
    sourceId: "src-1",
    categoryId: "cat-1",
    createdAt: new Date("2026-01-15T10:00:00Z"),
    updatedAt: new Date("2026-01-15T10:05:00Z"),
    candidateCount: 0,
    payload: {},
  };

  it("extracts targetUrl from payload", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { targetUrl: "https://example.com/news" },
    });
    expect(result.targetUrl).toBe("https://example.com/news");
  });

  it("returns null targetUrl when missing", () => {
    const result = normalizeHeadlessQueueArtifact(baseArtifact);
    expect(result.targetUrl).toBeNull();
  });

  it("extracts quality from nested qualityAssessment", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        qualityAssessment: { quality: "weak", confidence: "low" },
      },
    });
    expect(result.quality).toBe("weak");
    expect(result.confidence).toBe("low");
  });

  it("falls back to top-level quality when no qualityAssessment", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { quality: "productive" },
    });
    expect(result.quality).toBe("productive");
  });

  it("extracts escalationReasons from qualityAssessment", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        qualityAssessment: {
          escalationReasons: ["low_candidate_count", "blocked_by_robots"],
        },
      },
    });
    expect(result.escalationReasons).toEqual([
      "low_candidate_count",
      "blocked_by_robots",
    ]);
  });

  it("falls back to top-level escalationReasons", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { escalationReasons: ["manual_escalation"] },
    });
    expect(result.escalationReasons).toEqual(["manual_escalation"]);
  });

  it("returns empty escalationReasons when absent", () => {
    const result = normalizeHeadlessQueueArtifact(baseArtifact);
    expect(result.escalationReasons).toEqual([]);
  });

  it("extracts headless processing metadata from payload", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      status: "HEADLESS_PROCESSING",
      payload: {
        headlessProcessingStartedAt: "2026-01-15T10:10:00Z",
        headlessRecoveryCount: 2,
        lastHeadlessRecoveryAt: "2026-01-15T10:30:00Z",
        browserFallbackRan: true,
      },
    });
    expect(result.headlessProcessingStartedAt).toBe("2026-01-15T10:10:00Z");
    expect(result.headlessRecoveryCount).toBe(2);
    expect(result.lastHeadlessRecoveryAt).toBe("2026-01-15T10:30:00Z");
    expect(result.browserFallbackRan).toBe(true);
  });

  it("returns null for absent headless metadata", () => {
    const result = normalizeHeadlessQueueArtifact(baseArtifact);
    expect(result.headlessProcessingStartedAt).toBeNull();
    expect(result.headlessRecoveryCount).toBeNull();
    expect(result.lastHeadlessRecoveryAt).toBeNull();
    expect(result.browserFallbackRan).toBe(false);
  });

  it("preserves sourceId, categoryId, candidateCount, timestamps", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      candidateCount: 5,
    });
    expect(result.id).toBe("art-1");
    expect(result.sourceId).toBe("src-1");
    expect(result.categoryId).toBe("cat-1");
    expect(result.candidateCount).toBe(5);
    expect(result.createdAt).toEqual(new Date("2026-01-15T10:00:00Z"));
    expect(result.updatedAt).toEqual(new Date("2026-01-15T10:05:00Z"));
    expect(result.artifactType).toBe("article_discovery_headless_required");
  });

  it("handles null sourceId and categoryId", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      sourceId: null,
      categoryId: null,
    });
    expect(result.sourceId).toBeNull();
    expect(result.categoryId).toBeNull();
  });

  it("handles completely null payload gracefully", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: null,
    });
    expect(result.targetUrl).toBeNull();
    expect(result.quality).toBeNull();
    expect(result.escalationReasons).toEqual([]);
    expect(result.headlessProcessingStartedAt).toBeNull();
    expect(result.browserFallbackRan).toBe(false);
  });

  // ─── Malformed payload regression tests ─────────────────────────────────

  it("handles payload as a string", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: "not a payload" as any,
    });
    expect(result.targetUrl).toBeNull();
    expect(result.quality).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.escalationReasons).toEqual([]);
    expect(result.headlessProcessingStartedAt).toBeNull();
    expect(result.headlessRecoveryCount).toBeNull();
    expect(result.lastHeadlessRecoveryAt).toBeNull();
    expect(result.browserFallbackRan).toBe(false);
  });

  it("handles payload as an array", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: [1, 2, 3] as any,
    });
    expect(result.targetUrl).toBeNull();
    expect(result.quality).toBeNull();
    expect(result.escalationReasons).toEqual([]);
  });

  it("handles payload as a number", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: 42 as any,
    });
    expect(result.targetUrl).toBeNull();
    expect(result.browserFallbackRan).toBe(false);
  });

  it("handles qualityAssessment as a non-object (string)", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        qualityAssessment: "not an object" as any,
        quality: "productive",
      },
    });
    expect(result.quality).toBe("productive");
    expect(result.confidence).toBeNull();
    expect(result.escalationReasons).toEqual([]);
  });

  it("handles qualityAssessment as an array", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        qualityAssessment: [1, 2, 3] as any,
        quality: "weak",
      },
    });
    expect(result.quality).toBe("weak");
    expect(result.confidence).toBeNull();
  });

  it("handles escalationReasons as a string instead of array", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        escalationReasons: "not_an_array" as any,
      },
    });
    expect(result.escalationReasons).toEqual([]);
  });

  it("filters non-string values from escalationReasons array", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        escalationReasons: ["valid", 42, null, "also_valid", true, undefined] as any,
      },
    });
    expect(result.escalationReasons).toEqual(["valid", "also_valid"]);
  });

  it("handles headlessRecoveryCount as a string", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        headlessRecoveryCount: "3" as any,
      },
    });
    expect(result.headlessRecoveryCount).toBeNull();
  });

  it("handles headlessRecoveryCount as NaN", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        headlessRecoveryCount: NaN as any,
      },
    });
    expect(result.headlessRecoveryCount).toBeNull();
  });

  it("handles headlessRecoveryCount as Infinity", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        headlessRecoveryCount: Infinity as any,
      },
    });
    expect(result.headlessRecoveryCount).toBeNull();
  });

  it("handles headlessRecoveryCount as 0 (valid finite number)", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        headlessRecoveryCount: 0,
      },
    });
    expect(result.headlessRecoveryCount).toBe(0);
  });

  it("normalizes browserFallbackRan string 'true' to false", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserFallbackRan: "true" as any,
      },
    });
    expect(result.browserFallbackRan).toBe(false);
  });

  it("normalizes browserFallbackRan truthy number to false", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserFallbackRan: 1 as any,
      },
    });
    expect(result.browserFallbackRan).toBe(false);
  });

  it("normalizes browserFallbackRan object to false", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserFallbackRan: { ran: true } as any,
      },
    });
    expect(result.browserFallbackRan).toBe(false);
  });

  it("handles headlessProcessingStartedAt as a number", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        headlessProcessingStartedAt: 1700000000000 as any,
      },
    });
    expect(result.headlessProcessingStartedAt).toBeNull();
  });

  it("handles lastHeadlessRecoveryAt as an object", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        lastHeadlessRecoveryAt: { date: "2026-01-15" } as any,
      },
    });
    expect(result.lastHeadlessRecoveryAt).toBeNull();
  });

  it("handles qualityAssessment with non-string quality", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        qualityAssessment: { quality: 42, confidence: ["high"] },
      },
    });
    expect(result.quality).toBeNull();
    expect(result.confidence).toBeNull();
  });

  it("prefers qualityAssessment quality over top-level quality", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        quality: "productive",
        qualityAssessment: { quality: "weak" },
      },
    });
    expect(result.quality).toBe("weak");
  });

  it("falls back to top-level quality when qualityAssessment quality is non-string", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        quality: "productive",
        qualityAssessment: { quality: 42 },
      },
    });
    expect(result.quality).toBe("productive");
  });

  it("handles empty object payload without errors", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {},
    });
    expect(result.targetUrl).toBeNull();
    expect(result.quality).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.escalationReasons).toEqual([]);
    expect(result.headlessProcessingStartedAt).toBeNull();
    expect(result.headlessRecoveryCount).toBeNull();
    expect(result.lastHeadlessRecoveryAt).toBeNull();
    expect(result.browserFallbackRan).toBe(false);
  });

  it("does not expose raw payload or candidate arrays", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        targetUrl: "https://example.com",
        candidates: [{ url: "https://example.com/1" }],
        outcomeSummary: { totalEvaluated: 10 },
        discoverySources: { listingPages: 3 },
      },
    });
    expect(result).not.toHaveProperty("candidates");
    expect(result).not.toHaveProperty("outcomeSummary");
    expect(result).not.toHaveProperty("discoverySources");
    expect(result).not.toHaveProperty("payload");
  });

  // ─── staleSamples extraction ─────────────────────────────────────────────

  it("extracts staleSamples from rejectedCandidates with staleReason", () => {
    const result = normalizeHeadlessQueueArtifact({
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

    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { rejectedCandidates },
    });

    expect(result.staleSamples).toHaveLength(3);
  });

  it("returns empty staleSamples when rejectedCandidates is absent", () => {
    const result = normalizeHeadlessQueueArtifact(baseArtifact);
    expect(result.staleSamples).toEqual([]);
  });

  it("returns empty staleSamples when rejectedCandidates is not an array", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { rejectedCandidates: "not an array" as any },
    });
    expect(result.staleSamples).toEqual([]);
  });

  it("skips rejected_stale entries without staleReason", () => {
    const result = normalizeHeadlessQueueArtifact({
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

  it("extracts staleSamples from browserRejectedOutcomes on browser fallback artifacts", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserRejectedOutcomes: [
          {
            status: "rejected_stale",
            url: "https://example.com/future",
            staleReason: "future_published_at",
            rawPublishedAt: "2099-01-01",
            normalizedPublishedAt: "2099-01-01T00:00:00.000Z",
            publishedAtSource: "listing_context",
            ageDays: -26472,
          },
        ],
      },
    });

    expect(result.staleSamples).toHaveLength(1);
    expect(result.staleSamples[0]?.url).toBe("https://example.com/future");
    expect(result.staleSamples[0]?.staleReason).toBe("future_published_at");
    expect(result.staleSamples[0]?.publishedAtSource).toBe("listing_context");
    expect(result.dateAnomalySamples).toHaveLength(1);
    expect(result.dateAnomalySamples[0]?.staleReason).toBe("future_published_at");
  });

  it("fills staleSamples from static candidates first, then browser outcomes up to cap", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        rejectedCandidates: [
          { status: "rejected_stale", url: "https://example.com/static-1", staleReason: "missing_published_at" },
          { status: "rejected_stale", url: "https://example.com/static-2", staleReason: "invalid_published_at" },
        ],
        browserRejectedOutcomes: [
          { status: "rejected_stale", url: "https://example.com/browser-1", staleReason: "future_published_at" },
          { status: "rejected_stale", url: "https://example.com/browser-2", staleReason: "published_at_before_cutoff" },
        ],
      },
    });

    expect(result.staleSamples.map((sample) => sample.url)).toEqual([
      "https://example.com/static-1",
      "https://example.com/static-2",
      "https://example.com/browser-1",
    ]);
  });

  it("dateAnomalySamples only contains browser date anomalies", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserRejectedOutcomes: [
          { status: "rejected_stale", url: "https://example.com/future", staleReason: "future_published_at" },
          { status: "rejected_stale", url: "https://example.com/old", staleReason: "published_at_before_cutoff" },
          { status: "rejected_missing_title", url: "https://example.com/missing-title" },
        ],
      },
    });

    expect(result.dateAnomalySamples.map((sample) => sample.url)).toEqual([
      "https://example.com/future",
    ]);
  });
});

// ─── Browser fallback result metadata normalization ─────────────────────────

describe("normalizeHeadlessQueueArtifact — browser fallback fields", () => {
  const baseArtifact = {
    id: "art-browser-1",
    status: "RESOLVED",
    artifactType: "article_discovery_headless_required",
    sourceId: "src-1",
    categoryId: null,
    createdAt: new Date("2026-07-21T10:00:00Z"),
    updatedAt: new Date("2026-07-21T10:05:00Z"),
    candidateCount: 3,
    payload: {},
  };

  // ── Missing browser fields display safely ──────────────────────────────

  it("returns null/false/[] defaults when browser fields are absent", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { targetUrl: "https://example.com/news" },
    });
    expect(result.browserFallbackStartedAt).toBeNull();
    expect(result.browserFallbackFinishedAt).toBeNull();
    expect(result.browserRawLinks).toBeNull();
    expect(result.browserEvaluated).toBeNull();
    expect(result.browserAccepted).toBeNull();
    expect(result.browserRejected).toBeNull();
    expect(result.browserInserted).toBeNull();
    expect(result.browserSkipped).toBeNull();
    expect(result.browserFailed).toBeNull();
    expect(result.browserTopRejectionReasons).toEqual([]);
    expect(result.browserError).toBeNull();
    expect(result.browserQualityAssessment).toBeNull();
    expect(result.renderedUrl).toBeNull();
    expect(result.browserFallbackRan).toBe(false);
  });

  // ── Explicit zero counts are preserved ─────────────────────────────────

  it("preserves explicit zero counts (browser ran, evaluated links, accepted 0)", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      status: "BROWSER_NO_CANDIDATES",
      candidateCount: 0,
      payload: {
        browserFallbackRan: true,
        browserRawLinks: 5,
        browserEvaluated: 5,
        browserAccepted: 0,
        browserRejected: 5,
        browserInserted: 0,
        browserSkipped: 0,
        browserFailed: 0,
      },
    });
    // Explicit zeros must be preserved — they mean "browser ran and found
    // nothing", distinct from null which means "field absent".
    expect(result.browserRawLinks).toBe(5);
    expect(result.browserEvaluated).toBe(5);
    expect(result.browserAccepted).toBe(0);
    expect(result.browserRejected).toBe(5);
    expect(result.browserInserted).toBe(0);
    expect(result.browserSkipped).toBe(0);
    expect(result.browserFailed).toBe(0);
  });

  // ── Malformed payload does not leak raw payload ────────────────────────

  it("handles payload as a string without leaking raw payload", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: "not a payload" as any,
    });
    expect(result.browserFallbackRan).toBe(false);
    expect(result.browserRawLinks).toBeNull();
    expect(result.browserQualityAssessment).toBeNull();
    expect(result).not.toHaveProperty("payload");
  });

  it("handles payload as an array without leaking raw payload", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: [1, 2, 3] as any,
    });
    expect(result.browserFallbackRan).toBe(false);
    expect(result.browserRawLinks).toBeNull();
    expect(result).not.toHaveProperty("payload");
  });

  it("handles payload as a number without leaking raw payload", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: 42 as any,
    });
    expect(result.browserFallbackRan).toBe(false);
    expect(result.browserRawLinks).toBeNull();
    expect(result).not.toHaveProperty("payload");
  });

  // ── Browser link audit field normalization ─────────────────────────────

  it("returns null/false/[] defaults for absent browser link audit fields", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { targetUrl: "https://example.com" },
    });
    expect(result.browserShortlistedLinks).toBeNull();
    expect(result.browserTopRejectedLinks).toEqual([]);
    expect(result.browserShortlistedLinkSamples).toEqual([]);
    expect(result.browserTopLinkRejectionReasons).toEqual([]);
  });

  it("normalizes browserTopRejectedLinks with valid entries", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserTopRejectedLinks: [
          { url: "https://example.com/about", normalizedUrl: null, anchorText: "About", score: 0, rejected: true, reason: "utility_path", scoreReasons: [], sameDomain: true, utilityPath: true, categoryScoped: null },
          { url: "https://example.com/news/low", normalizedUrl: "https://example.com/news/low", anchorText: "Low", score: 10, rejected: true, reason: "low_score", scoreReasons: ["date_in_url"], sameDomain: true, utilityPath: false, categoryScoped: null },
        ],
      },
    });
    expect(result.browserTopRejectedLinks).toHaveLength(2);
    expect(result.browserTopRejectedLinks[0]!.url).toBe("https://example.com/about");
    expect(result.browserTopRejectedLinks[0]!.reason).toBe("utility_path");
    expect(result.browserTopRejectedLinks[0]!.utilityPath).toBe(true);
    expect(result.browserTopRejectedLinks[1]!.score).toBe(10);
  });

  it("drops malformed browserTopRejectedLinks entries", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserTopRejectedLinks: [
          { url: "https://example.com/valid", rejected: true, reason: "low_score", score: 5, scoreReasons: [], sameDomain: true, utilityPath: false, categoryScoped: null },
          "not an object",
          { reason: "missing url" },
          null,
          42,
          { url: "", rejected: true, reason: "invalid" },  // empty url dropped
        ],
      },
    });
    expect(result.browserTopRejectedLinks).toHaveLength(1);
    expect(result.browserTopRejectedLinks[0]!.url).toBe("https://example.com/valid");
  });

  it("caps browserTopRejectedLinks at 20", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      url: `https://example.com/rejected-${i}`,
      rejected: true,
      reason: "low_score",
      score: i,
      scoreReasons: [],
      sameDomain: true,
      utilityPath: false,
      categoryScoped: null,
    }));
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { browserTopRejectedLinks: entries },
    });
    expect(result.browserTopRejectedLinks).toHaveLength(20);
  });

  it("normalizes browserShortlistedLinkSamples with valid entries", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserShortlistedLinkSamples: [
          { url: "https://example.com/news/article", score: 65, rejected: false, reason: null, scoreReasons: ["same_domain", "multi_segment_path"], sameDomain: true, utilityPath: false, categoryScoped: null },
        ],
      },
    });
    expect(result.browserShortlistedLinkSamples).toHaveLength(1);
    expect(result.browserShortlistedLinkSamples[0]!.score).toBe(65);
    expect(result.browserShortlistedLinkSamples[0]!.rejected).toBe(false);
    expect(result.browserShortlistedLinkSamples[0]!.scoreReasons).toEqual(["same_domain", "multi_segment_path"]);
  });

  it("caps browserShortlistedLinkSamples at 25", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      url: `https://example.com/news/article-${i}`,
      score: 50,
      rejected: false,
      reason: null,
      scoreReasons: [],
      sameDomain: true,
      utilityPath: false,
      categoryScoped: null,
    }));
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { browserShortlistedLinkSamples: entries },
    });
    expect(result.browserShortlistedLinkSamples).toHaveLength(25);
  });

  it("normalizes browserShortlistedLinks as a finite number", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { browserShortlistedLinks: 5 },
    });
    expect(result.browserShortlistedLinks).toBe(5);
  });

  it("normalizes browserShortlistedLinks non-number to null", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { browserShortlistedLinks: "5" as any },
    });
    expect(result.browserShortlistedLinks).toBeNull();
  });

  it("normalizes browserTopLinkRejectionReasons", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserTopLinkRejectionReasons: [
          { reason: "utility_path", count: 300 },
          { reason: "different_domain", count: 200 },
          { reason: "low_score", count: 100 },
        ],
      },
    });
    expect(result.browserTopLinkRejectionReasons).toHaveLength(3);
    expect(result.browserTopLinkRejectionReasons[0]).toEqual({ reason: "utility_path", count: 300 });
  });

  it("returns empty browserTopLinkRejectionReasons for non-array", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: { browserTopLinkRejectionReasons: "not an array" as any },
    });
    expect(result.browserTopLinkRejectionReasons).toEqual([]);
  });

  it("handles categoryScoped as null in audit entries", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserTopRejectedLinks: [
          { url: "https://example.com/x", rejected: true, reason: "low_score", score: 0, scoreReasons: [], sameDomain: true, utilityPath: false, categoryScoped: null },
        ],
      },
    });
    expect(result.browserTopRejectedLinks[0]!.categoryScoped).toBeNull();
  });

  // ── Browser fields are normalized safely (wrong types) ─────────────────

  it("normalizes non-number browser count fields to null", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserFallbackRan: true,
        browserRawLinks: "10" as any,
        browserEvaluated: [5] as any,
        browserAccepted: { count: 3 } as any,
        browserRejected: NaN as any,
        browserInserted: Infinity as any,
      },
    });
    expect(result.browserRawLinks).toBeNull();
    expect(result.browserEvaluated).toBeNull();
    expect(result.browserAccepted).toBeNull();
    expect(result.browserRejected).toBeNull();
    expect(result.browserInserted).toBeNull();
  });

  it("normalizes browserError to null for non-string values", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserError: 42 as any,
      },
    });
    expect(result.browserError).toBeNull();
  });

  it("normalizes browserError to null for empty string", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserError: "",
      },
    });
    expect(result.browserError).toBeNull();
  });

  it("preserves a valid browserError string", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserError: "Candidate persistence failed: connection lost",
      },
    });
    expect(result.browserError).toBe("Candidate persistence failed: connection lost");
  });

  it("normalizes browserFallbackRan string 'true' to false", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserFallbackRan: "true" as any,
      },
    });
    expect(result.browserFallbackRan).toBe(false);
  });

  it("normalizes browserFallbackRan truthy number to false", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserFallbackRan: 1 as any,
      },
    });
    expect(result.browserFallbackRan).toBe(false);
  });

  // ── browserQualityAssessment normalization ──────────────────────────────

  it("extracts browserQualityAssessment when valid object", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserQualityAssessment: {
          quality: "productive",
          confidence: "high",
          shouldEscalateToHeadless: false,
          escalationReasons: ["low_acceptance_rate"],
          explanation: "Browser found 3 articles.",
        },
      },
    });
    expect(result.browserQualityAssessment).not.toBeNull();
    expect(result.browserQualityAssessment?.quality).toBe("productive");
    expect(result.browserQualityAssessment?.confidence).toBe("high");
    expect(result.browserQualityAssessment?.shouldEscalateToHeadless).toBe(false);
    expect(result.browserQualityAssessment?.escalationReasons).toEqual(["low_acceptance_rate"]);
    expect(result.browserQualityAssessment?.explanation).toBe("Browser found 3 articles.");
  });

  it("returns null browserQualityAssessment for non-object value", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserQualityAssessment: "productive" as any,
      },
    });
    expect(result.browserQualityAssessment).toBeNull();
  });

  it("returns null browserQualityAssessment for array value", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserQualityAssessment: [1, 2, 3] as any,
      },
    });
    expect(result.browserQualityAssessment).toBeNull();
  });

  it("returns null browserQualityAssessment for null value", () => {
    // Explicit null is the expected value for runtime-unavailable failures.
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserQualityAssessment: null,
      },
    });
    expect(result.browserQualityAssessment).toBeNull();
  });

  it("filters non-string entries from browserQualityAssessment.escalationReasons", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserQualityAssessment: {
          escalationReasons: ["valid", 42, null, "also_valid", true] as any,
        },
      },
    });
    expect(result.browserQualityAssessment?.escalationReasons).toEqual(["valid", "also_valid"]);
  });

  // ── browserTopRejectionReasons normalization ────────────────────────────

  it("extracts browserTopRejectionReasons with reason + count", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserTopRejectionReasons: [
          { reason: "stale", count: 8 },
          { reason: "low_score", count: 5 },
          { reason: "out_of_scope", count: 2 },
        ],
      },
    });
    expect(result.browserTopRejectionReasons).toHaveLength(3);
    expect(result.browserTopRejectionReasons[0]).toEqual({ reason: "stale", count: 8 });
  });

  it("returns empty browserTopRejectionReasons for non-array value", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserTopRejectionReasons: "not an array" as any,
      },
    });
    expect(result.browserTopRejectionReasons).toEqual([]);
  });

  it("filters malformed entries from browserTopRejectionReasons", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserTopRejectionReasons: [
          { reason: "stale", count: 8 },
          "not an object",
          { reason: "", count: 5 },          // empty reason dropped
          { reason: "low_score", count: "5" as any }, // non-number count dropped
          { reason: "out_of_scope", count: 0 },       // count 0 preserved
          { count: 5 },                                // missing reason dropped
          null,
        ],
      },
    });
    expect(result.browserTopRejectionReasons).toEqual([
      { reason: "stale", count: 8 },
      { reason: "out_of_scope", count: 0 },
    ]);
  });

  it("caps browserTopRejectionReasons at 5", () => {
    const reasons = Array.from({ length: 10 }, (_, i) => ({
      reason: `reason-${i}`,
      count: i + 1,
    }));
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      payload: {
        browserTopRejectionReasons: reasons,
      },
    });
    expect(result.browserTopRejectionReasons).toHaveLength(5);
  });

  // ── Full browser fallback payload roundtrip ─────────────────────────────

  it("roundtrip: full browser fallback artifact normalizes all fields correctly", () => {
    const result = normalizeHeadlessQueueArtifact({
      ...baseArtifact,
      candidateCount: 3,
      payload: {
        targetUrl: "https://example.com/news",
        browserFallbackRan: true,
        browserFallbackStartedAt: "2026-07-21T10:01:00Z",
        browserFallbackFinishedAt: "2026-07-21T10:03:00Z",
        browserRawLinks: 15,
        browserEvaluated: 8,
        browserAccepted: 3,
        browserRejected: 5,
        browserInserted: 3,
        browserSkipped: 0,
        browserFailed: 0,
        browserTopRejectionReasons: [{ reason: "stale", count: 4 }],
        browserError: null,
        browserOutcomeSummary: { totalEvaluated: 8, accepted: 3, rejected: 5 },
        browserQualityAssessment: {
          quality: "productive",
          confidence: "high",
          shouldEscalateToHeadless: false,
          escalationReasons: [],
          explanation: "Browser found 3 articles.",
        },
        renderedUrl: "https://example.com/news",
      },
    });
    expect(result.browserFallbackRan).toBe(true);
    expect(result.browserFallbackStartedAt).toBe("2026-07-21T10:01:00Z");
    expect(result.browserFallbackFinishedAt).toBe("2026-07-21T10:03:00Z");
    expect(result.browserRawLinks).toBe(15);
    expect(result.browserEvaluated).toBe(8);
    expect(result.browserAccepted).toBe(3);
    expect(result.browserRejected).toBe(5);
    expect(result.browserInserted).toBe(3);
    expect(result.browserSkipped).toBe(0);
    expect(result.browserFailed).toBe(0);
    expect(result.browserTopRejectionReasons).toEqual([{ reason: "stale", count: 4 }]);
    expect(result.browserError).toBeNull();
    expect(result.browserQualityAssessment?.quality).toBe("productive");
    expect(result.renderedUrl).toBe("https://example.com/news");
  });
});

// ─── Summary tests ──────────────────────────────────────────────────────────

describe("buildHeadlessQueueSummary", () => {
  const makeItem = (status: string) => ({
    id: `art-${status}`,
    status,
    artifactType: "article_discovery_headless_required",
    sourceId: null as string | null,
    categoryId: null as string | null,
    targetUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    quality: null,
    confidence: null,
    escalationReasons: [],
    headlessProcessingStartedAt: null,
    headlessRecoveryCount: null,
    lastHeadlessRecoveryAt: null,
    browserFallbackRan: false,
    candidateCount: 0,
    staleSamples: [] as Array<{ url: string; normalizedPublishedAt: string | null; publishedAtSource: string | null; ageDays: number | null; staleReason: string | null }>,
    dateAnomalySamples: [] as Array<{ url: string; normalizedPublishedAt: string | null; publishedAtSource: string | null; ageDays: number | null; staleReason: string | null }>,
    browserFallbackStartedAt: null,
    browserFallbackFinishedAt: null,
    browserRawLinks: null,
    browserEvaluated: null,
    browserAccepted: null,
    browserRejected: null,
    browserInserted: null,
    browserSkipped: null,
    browserFailed: null,
    browserTopRejectionReasons: [] as Array<{ reason: string; count: number }>,
    browserError: null,
    browserQualityAssessment: null,
    renderedUrl: null,
    browserShortlistedLinks: null as number | null,
    browserTopRejectedLinks: [] as Array<{ url: string; normalizedUrl: string | null; anchorText: string | null; score: number; rejected: boolean; reason: string | null; scoreReasons: string[]; sameDomain: boolean; utilityPath: boolean; categoryScoped: boolean | null }>,
    browserShortlistedLinkSamples: [] as Array<{ url: string; normalizedUrl: string | null; anchorText: string | null; score: number; rejected: boolean; reason: string | null; scoreReasons: string[]; sameDomain: boolean; utilityPath: boolean; categoryScoped: boolean | null }>,
    browserTopLinkRejectionReasons: [] as Array<{ reason: string; count: number }>,
  });

  it("counts items by status", () => {
    const items = [
      makeItem("PENDING_HEADLESS"),
      makeItem("PENDING_HEADLESS"),
      makeItem("HEADLESS_PROCESSING"),
      makeItem("RESOLVED"),
      makeItem("RESOLVED"),
      makeItem("RESOLVED"),
    ];
    const summary = buildHeadlessQueueSummary(items);
    expect(summary.total).toBe(6);
    expect(summary.byStatus).toEqual({
      PENDING_HEADLESS: 2,
      HEADLESS_PROCESSING: 1,
      RESOLVED: 3,
    });
  });

  it("returns zero total for empty array", () => {
    const summary = buildHeadlessQueueSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.byStatus).toEqual({});
  });
});
