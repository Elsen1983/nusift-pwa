import { describe, expect, it } from "vitest";
import {
  normalizeRejectionDiagnostic,
  isRejectionArtifact,
  type RawRejectionArtifact,
} from "./rejection-diagnostics-normalizer";

const makeArtifact = (overrides: Partial<RawRejectionArtifact> = {}): RawRejectionArtifact => ({
  id: "art-001",
  createdAt: new Date("2026-07-29T10:00:00Z"),
  pipelineRunId: "run-abc",
  sourceId: "src-1",
  categoryId: "cat-1",
  artifactType: "article_enrichment_rejection",
  status: "FAILED",
  payload: {
    schemaVersion: 1,
    extractorVersion: "a3-http-boundary-v1",
    kind: "LOW_CONTENT_QUALITY",
    articleId: 42,
    articleUrl: "https://example.com/article",
    provenance: { sourceId: "src-1", categoryId: "cat-1", feedOrigin: "rss" },
    rejection: { code: "LOW_CONTENT_QUALITY", detail: "[too_short] Body text too short" },
    quality: { confidence: 0.3 },
    rejectionDiagnostics: {
      selectedContainerSelector: "div.content",
      selectedContainerScore: 15,
      selectedContainerParagraphCount: 1,
      selectedContainerTextLength: 200,
      candidateContainerCount: 2,
      bodyRejectedReason: "too_short",
      scoreReasons: ["single_paragraph", "very_short_text"],
      bodySource: "dom",
      linkTextRatio: 0.05,
      boilerplatePenalty: 0,
      topCandidates: [
        { selector: "div.content", score: 15, paragraphCount: 1, textLength: 200, reasons: ["single_paragraph"] },
        { selector: "article", score: 8, paragraphCount: 1, textLength: 100, reasons: ["single_paragraph"] },
      ],
      stoppedAtText: null,
      stoppedAtClassOrId: null,
      excludedBlockCount: 0,
    },
  },
  errorLog: "LOW_CONTENT_QUALITY: LOW_CONTENT_QUALITY — [too_short] Body text too short",
  ...overrides,
});

describe("normalizeRejectionDiagnostic", () => {
  it("normalizes a valid rejection payload with diagnostics", () => {
    const result = normalizeRejectionDiagnostic(makeArtifact());
    expect(result).not.toBeNull();
    expect(result!.id).toBe("art-001");
    expect(result!.kind).toBe("LOW_CONTENT_QUALITY");
    expect(result!.articleId).toBe(42);
    expect(result!.title).toBeNull(); // no title in this fixture's rejectionDiagnostics
    expect(result!.articleUrl).toBe("https://example.com/article");
    expect(result!.sourceId).toBe("src-1");
    expect(result!.categoryId).toBe("cat-1");
    expect(result!.rejectedReason).toBe("LOW_CONTENT_QUALITY");
    expect(result!.detail).toContain("too_short");
    expect(result!.confidence).toBe(0.3);
    expect(result!.extractorVersion).toBe("a3-http-boundary-v1");
    expect(result!.diagnostics.selectedContainerSelector).toBe("div.content");
    expect(result!.diagnostics.selectedContainerScore).toBe(15);
    expect(result!.diagnostics.selectedContainerParagraphCount).toBe(1);
    expect(result!.diagnostics.selectedContainerTextLength).toBe(200);
    expect(result!.diagnostics.candidateContainerCount).toBe(2);
    expect(result!.diagnostics.bodyRejectedReason).toBe("too_short");
    expect(result!.diagnostics.scoreReasons).toEqual(["single_paragraph", "very_short_text"]);
    expect(result!.diagnostics.bodySource).toBe("dom");
    expect(result!.diagnostics.linkTextRatio).toBe(0.05);
    expect(result!.diagnostics.boilerplatePenalty).toBe(0);
    expect(result!.diagnostics.topCandidates).toHaveLength(2);
    expect(result!.diagnostics.topCandidates[0]!.selector).toBe("div.content");
    expect(result!.diagnostics.topCandidates[0]!.score).toBe(15);
    expect(result!.diagnostics.stoppedAtText).toBeNull();
    expect(result!.diagnostics.stoppedAtClassOrId).toBeNull();
    expect(result!.diagnostics.excludedBlockCount).toBe(0);
  });

  it("caps topCandidates to max 5", () => {
    const manyCandidates = Array.from({ length: 10 }, (_, i) => ({
      selector: `div.c${i}`,
      score: i * 10,
      paragraphCount: i,
      textLength: i * 100,
      reasons: [`reason_${i}`],
    }));
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        rejectionDiagnostics: {
          ...(makeArtifact().payload as Record<string, unknown>).rejectionDiagnostics as Record<string, unknown>,
          topCandidates: manyCandidates,
        },
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).not.toBeNull();
    expect(result!.diagnostics.topCandidates).toHaveLength(5);
  });

  it("caps scoreReasons to max 10", () => {
    const manyReasons = Array.from({ length: 20 }, (_, i) => `reason_${i}`);
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        rejectionDiagnostics: {
          ...(makeArtifact().payload as Record<string, unknown>).rejectionDiagnostics as Record<string, unknown>,
          scoreReasons: manyReasons,
        },
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).not.toBeNull();
    expect(result!.diagnostics.scoreReasons).toHaveLength(10);
  });

  it("caps stoppedAtText to 120 chars", () => {
    const longText = "A".repeat(200);
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        rejectionDiagnostics: {
          ...(makeArtifact().payload as Record<string, unknown>).rejectionDiagnostics as Record<string, unknown>,
          stoppedAtText: longText,
        },
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).not.toBeNull();
    expect(result!.diagnostics.stoppedAtText).toHaveLength(120);
  });

  it("caps stoppedAtClassOrId to 160 chars", () => {
    const longClassId = "B".repeat(200);
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        rejectionDiagnostics: {
          ...(makeArtifact().payload as Record<string, unknown>).rejectionDiagnostics as Record<string, unknown>,
          stoppedAtClassOrId: longClassId,
        },
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).not.toBeNull();
    expect(result!.diagnostics.stoppedAtClassOrId).toHaveLength(160);
  });

  it("ignores SUCCESS outcomes", () => {
    const artifact = makeArtifact({
      artifactType: "article_enrichment_result",
      status: "CAPTURED",
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        kind: "SUCCESS",
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).toBeNull();
  });

  it("ignores SKIPPED outcomes", () => {
    const artifact = makeArtifact({
      artifactType: "article_enrichment_result",
      status: "SKIPPED",
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        kind: "SKIPPED",
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).toBeNull();
  });

  it("survives malformed payload (non-object)", () => {
    const artifact = makeArtifact({ payload: "not an object" });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).toBeNull();
  });

  it("survives malformed payload (null)", () => {
    const artifact = makeArtifact({ payload: null });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).toBeNull();
  });

  it("survives malformed payload (array)", () => {
    const artifact = makeArtifact({ payload: [1, 2, 3] });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).toBeNull();
  });

  it("survives payload with no kind field", () => {
    const artifact = makeArtifact({
      payload: { schemaVersion: 1, articleId: 42 },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).toBeNull();
  });

  it("handles payload with missing rejectionDiagnostics gracefully", () => {
    const artifact = makeArtifact({
      payload: {
        schemaVersion: 1,
        extractorVersion: "a3-http-boundary-v1",
        kind: "UNSUPPORTED_STRUCTURE",
        articleId: 99,
        articleUrl: "https://example.com/bad",
        provenance: { sourceId: "src-2", categoryId: null, feedOrigin: "rss" },
        rejection: { code: "UNSUPPORTED_STRUCTURE", detail: "parse_error" },
        quality: { confidence: 0 },
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("UNSUPPORTED_STRUCTURE");
    expect(result!.diagnostics.selectedContainerSelector).toBeNull();
    expect(result!.diagnostics.topCandidates).toEqual([]);
    expect(result!.diagnostics.scoreReasons).toEqual([]);
  });

  it("reads title from rejectionDiagnostics.title when present", () => {
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        rejectionDiagnostics: {
          ...(makeArtifact().payload as Record<string, unknown>).rejectionDiagnostics as Record<string, unknown>,
          title: "Test Article Title",
        },
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Test Article Title");
  });

  it("caps title from rejectionDiagnostics to 180 chars", () => {
    const longTitle = "A".repeat(250);
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        rejectionDiagnostics: {
          ...(makeArtifact().payload as Record<string, unknown>).rejectionDiagnostics as Record<string, unknown>,
          title: longTitle,
        },
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).not.toBeNull();
    expect(result!.title).toHaveLength(180);
  });

  it("handles null values in diagnostics fields gracefully", () => {
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        rejectionDiagnostics: {
          selectedContainerSelector: null,
          selectedContainerScore: null,
          selectedContainerParagraphCount: null,
          selectedContainerTextLength: null,
          candidateContainerCount: null,
          bodyRejectedReason: null,
          scoreReasons: null,
          bodySource: null,
          linkTextRatio: null,
          boilerplatePenalty: null,
          topCandidates: null,
          stoppedAtText: null,
          stoppedAtClassOrId: null,
          excludedBlockCount: null,
        },
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).not.toBeNull();
    expect(result!.diagnostics.scoreReasons).toEqual([]);
    expect(result!.diagnostics.topCandidates).toEqual([]);
    expect(result!.diagnostics.selectedContainerSelector).toBeNull();
    expect(result!.diagnostics.linkTextRatio).toBeNull();
  });

  it("normalizes HEADLESS_REQUIRED artifacts", () => {
    const artifact = makeArtifact({
      artifactType: "article_headless_queue_candidate",
      status: "PENDING_HEADLESS",
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        kind: "HEADLESS_REQUIRED",
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("HEADLESS_REQUIRED");
  });

  it("normalizes PAYWALL_BLOCKED artifacts", () => {
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        kind: "PAYWALL_BLOCKED",
        rejection: { code: "PAYWALL_BLOCKED", detail: "Access denied" },
      },
    });
    const result = normalizeRejectionDiagnostic(artifact);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("PAYWALL_BLOCKED");
  });

  it("marks HTTP 403/429 rejections as access blocked", () => {
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        kind: "UNSUPPORTED_STRUCTURE",
        rejection: { code: "UNSUPPORTED_STRUCTURE", detail: "[http_error] HTTP 403", httpStatus: 403 },
        browserFallback: {
          attempted: true,
          succeeded: false,
          statusCode: 403,
        },
      },
    });

    const result = normalizeRejectionDiagnostic(artifact);

    expect(result).not.toBeNull();
    expect(result!.httpAccessBlocked).toBe(true);
  });

  it("normalizes HTTP_ACCESS_BLOCKED kind from stored artifacts", () => {
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        kind: "HTTP_ACCESS_BLOCKED",
        articleId: 77,
        articleUrl: "https://blocked.example/article",
        rejection: { code: "HTTP_FORBIDDEN", detail: "[http_error] HTTP 403 Forbidden", httpStatus: 403 },
        browserFallback: {
          attempted: true,
          succeeded: false,
          statusCode: 403,
          runtimeUnavailable: false,
          rateLimited: false,
        },
      },
    });

    const result = normalizeRejectionDiagnostic(artifact);

    expect(result).not.toBeNull();
    expect(result!.kind).toBe("HTTP_ACCESS_BLOCKED");
    expect(result!.articleId).toBe(77);
    expect(result!.rejectedReason).toBe("HTTP_FORBIDDEN");
    expect(result!.httpAccessBlocked).toBe(true);
    expect(result!.browserFallback).not.toBeNull();
    expect(result!.browserFallback!.statusCode).toBe(403);
    expect(result!.browserFallback!.attempted).toBe(true);
    expect(result!.browserFallback!.succeeded).toBe(false);
  });

  it("normalizes HTTP_ACCESS_BLOCKED kind with 429 status", () => {
    const artifact = makeArtifact({
      payload: {
        ...(makeArtifact().payload as Record<string, unknown>),
        kind: "HTTP_ACCESS_BLOCKED",
        articleId: 88,
        rejection: { code: "HTTP_FORBIDDEN", detail: "[http_error] HTTP 429 Too Many Requests", httpStatus: 429 },
        browserFallback: {
          attempted: false,
          succeeded: false,
          statusCode: null,
          browserFallbackSkippedReason: "runtime_unavailable_global_stop",
        },
      },
    });

    const result = normalizeRejectionDiagnostic(artifact);

    expect(result).not.toBeNull();
    expect(result!.kind).toBe("HTTP_ACCESS_BLOCKED");
    expect(result!.httpAccessBlocked).toBe(true);
    expect(result!.browserFallback).not.toBeNull();
    expect(result!.browserFallback!.skippedReason).toBe("runtime_unavailable_global_stop");
  });

  it("HTTP_ACCESS_BLOCKED is included in REJECTION_KINDS", async () => {
    const { REJECTION_KINDS } = await import("./rejection-diagnostics-normalizer");
    expect(REJECTION_KINDS).toContain("HTTP_ACCESS_BLOCKED");
  });

  it("does not mark ordinary low quality rejections as access blocked", () => {
    const result = normalizeRejectionDiagnostic(makeArtifact());

    expect(result).not.toBeNull();
    expect(result!.httpAccessBlocked).toBe(false);
  });
});

describe("isRejectionArtifact", () => {
  it("returns true for article_enrichment_rejection with FAILED status", () => {
    expect(isRejectionArtifact(makeArtifact())).toBe(true);
  });

  it("returns true for article_headless_queue_candidate with PENDING_HEADLESS status", () => {
    expect(isRejectionArtifact(makeArtifact({
      artifactType: "article_headless_queue_candidate",
      status: "PENDING_HEADLESS",
    }))).toBe(true);
  });

  it("returns false for article_enrichment_result with CAPTURED status", () => {
    expect(isRejectionArtifact(makeArtifact({
      artifactType: "article_enrichment_result",
      status: "CAPTURED",
    }))).toBe(false);
  });

  it("returns false for article_enrichment_result with SKIPPED status", () => {
    expect(isRejectionArtifact(makeArtifact({
      artifactType: "article_enrichment_result",
      status: "SKIPPED",
    }))).toBe(false);
  });

  it("returns false for article_enrichment_attempt", () => {
    expect(isRejectionArtifact(makeArtifact({
      artifactType: "article_enrichment_attempt",
      status: "ATTEMPTED",
    }))).toBe(false);
  });
});
