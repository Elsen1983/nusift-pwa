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
