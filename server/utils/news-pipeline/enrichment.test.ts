import { describe, expect, it } from "vitest";
import type {
  ArticleEnrichmentOutcome,
  ArticleUpstreamProvenance,
  EnrichmentOutcomeKind,
  EnrichmentRejectionReason,
} from "./enrichment";
import {
  buildFailureOutcome,
  buildHeadlessRequiredOutcome,
  buildSkippedOutcome,
  buildSuccessOutcome,
  createEnrichmentOutcome,
  outcomeKindToStatus,
  serializeEnrichmentPayload,
  serializeOutcomeSummary,
  validateEnrichmentOutcome,
} from "./enrichment";

/** Cast Prisma.InputJsonValue back to a concrete shape for test assertions. */
const asPayload = (v: unknown) => v as Record<string, unknown>;

const baseProvenance: ArticleUpstreamProvenance = {
  sourceId: "src-1",
  categoryId: "cat-1",
  feedOrigin: "rss",
  feedUrl: "https://example.com/rss",
  discoveredFromCategoryFeed: true,
  arrivedViaHardCaseRerun: false,
  ingestedAt: "2026-07-15T08:00:00.000Z",
};

const makeTiming = (durationMs = 120): ArticleEnrichmentOutcome["timing"] => ({
  startedAt: "2026-07-16T10:00:00.000Z",
  finishedAt: "2026-07-16T10:00:00.120Z",
  durationMs,
  fetchMs: 60,
  extractMs: 50,
});

// ─── buildSuccessOutcome ────────────────────────────────────────────────────

describe("buildSuccessOutcome", () => {
  it("produces a SUCCESS outcome with field provenance and quality", () => {
    const outcome = buildSuccessOutcome({
      articleId: 42,
      articleUrl: "https://example.com/article-1",
      provenance: baseProvenance,
      method: { method: "http-dom", detail: "article>main", resolvedCanonicalUrl: "https://example.com/article-1", redirected: false },
      timing: makeTiming(),
      quality: { confidence: 0.9, qualityScore: 88, signals: ["has_author"], bodyLength: 1200 },
      fields: {
        title: {
          raw: "Feed title",
          chosenValue: "HTML title",
          chosenFrom: "dom",
          overrideReason: "HTML title richer than feed",
        },
        bodyText: {
          raw: null,
          chosenValue: "Extracted body...",
          chosenFrom: "dom",
          overrideReason: "Feed had no body",
        },
      },
    });

    expect(outcome.kind).toBe("SUCCESS");
    expect(outcome.articleId).toBe(42);
    expect(outcome.articleUrl).toBe("https://example.com/article-1");
    expect(outcome.schemaVersion).toBe(1);
    expect(outcome.rejection).toBeNull();
    expect(outcome.error).toBeNull();

    // Provenance preserved untouched
    expect(outcome.provenance).toEqual(baseProvenance);
    expect(outcome.provenance.sourceId).toBe("src-1");
    expect(outcome.provenance.feedOrigin).toBe("rss");

    // Method
    expect(outcome.method.method).toBe("http-dom");
    expect(outcome.method.resolvedCanonicalUrl).toBe("https://example.com/article-1");

    // Quality normalized
    expect(outcome.quality.confidence).toBe(0.9);
    expect(outcome.quality.qualityScore).toBe(88);
    expect(outcome.quality.signals).toEqual(["has_author"]);

    // Field provenance
    expect(outcome.fields.title?.chosenValue).toBe("HTML title");
    expect(outcome.fields.title?.chosenFrom).toBe("dom");
    expect(outcome.fields.bodyText?.chosenFrom).toBe("dom");
  });

  it("defaults confidence to 0.8 and method to none when omitted", () => {
    const outcome = buildSuccessOutcome({
      articleId: 1,
      provenance: baseProvenance,
      fields: {},
    });

    expect(outcome.quality.confidence).toBe(0.8);
    expect(outcome.method.method).toBe("none");
    expect(outcome.timing.durationMs).toBe(0);
  });

  it("is JSON-serializable for Prisma persistence", () => {
    const outcome = buildSuccessOutcome({
      articleId: 42,
      provenance: baseProvenance,
      fields: {
        title: { raw: "a", chosenValue: "b", chosenFrom: "meta", overrideReason: "r" },
      },
    });

    const json = JSON.stringify(outcome);
    expect(json).toBeTruthy();

    const parsed = JSON.parse(json);
    expect(parsed.kind).toBe("SUCCESS");
    expect(parsed.provenance.sourceId).toBe("src-1");
    expect(parsed.fields.title.chosenFrom).toBe("meta");
  });
});

// ─── buildSkippedOutcome ────────────────────────────────────────────────────

describe("buildSkippedOutcome", () => {
  it("produces a SKIPPED outcome with a structured reason", () => {
    const outcome = buildSkippedOutcome({
      articleId: 7,
      articleUrl: "https://example.com/a",
      provenance: baseProvenance,
      reasonCode: "ALREADY_ENRICHED",
      detail: "Article was enriched in a prior run.",
    });

    expect(outcome.kind).toBe("SKIPPED");
    expect(outcome.rejection).not.toBeNull();
    expect(outcome.rejection?.code).toBe("ALREADY_ENRICHED");
    expect(outcome.rejection?.detail).toBe("Article was enriched in a prior run.");
    expect(outcome.quality.confidence).toBe(0);
    expect(outcome.method.method).toBe("none");
    expect(outcome.fields).toEqual({});
    // Provenance still preserved
    expect(outcome.provenance.sourceId).toBe("src-1");
  });

  it("supports outside-freshness-window skip", () => {
    const outcome = buildSkippedOutcome({
      articleId: 7,
      provenance: baseProvenance,
      reasonCode: "OUTSIDE_FRESHNESS_WINDOW",
    });

    expect(outcome.kind).toBe("SKIPPED");
    expect(outcome.rejection?.code).toBe("OUTSIDE_FRESHNESS_WINDOW");
  });
});

// ─── buildHeadlessRequiredOutcome ───────────────────────────────────────────

describe("buildHeadlessRequiredOutcome", () => {
  it("produces a HEADLESS_REQUIRED outcome ready for the Phase 3 queue", () => {
    const outcome = buildHeadlessRequiredOutcome({
      articleId: 99,
      articleUrl: "https://example.com/js-heavy",
      provenance: { ...baseProvenance, arrivedViaHardCaseRerun: true },
      detail: "Article body rendered by client-side JS; HTTP extraction found no content block.",
      method: { method: "http-dom", detail: "no article/main selector matched" },
    });

    expect(outcome.kind).toBe("HEADLESS_REQUIRED");
    expect(outcome.rejection?.code).toBe("HEADLESS_REQUIRED");
    expect(outcome.rejection?.detail).toContain("client-side JS");
    expect(outcome.method.method).toBe("http-dom");
    // Upstream hard-case-rerun provenance preserved
    expect(outcome.provenance.arrivedViaHardCaseRerun).toBe(true);
    expect(outcome.quality.confidence).toBe(0);
  });

  it("maps to ENRICHMENT_QUEUED_HEADLESS status", () => {
    const outcome = buildHeadlessRequiredOutcome({
      articleId: 99,
      provenance: baseProvenance,
    });
    expect(outcomeKindToStatus(outcome.kind)).toBe("ENRICHMENT_QUEUED_HEADLESS");
  });
});

// ─── buildFailureOutcome ────────────────────────────────────────────────────

describe("buildFailureOutcome", () => {
  it("produces a RETRYABLE_FAILURE when retryable=true", () => {
    const outcome = buildFailureOutcome({
      articleId: 5,
      articleUrl: "https://example.com/x",
      provenance: baseProvenance,
      reason: { code: "FETCH_TIMEOUT", detail: "Request timed out after 10s" },
      retryable: true,
      httpStatus: null,
    });

    expect(outcome.kind).toBe("RETRYABLE_FAILURE");
    expect(outcome.rejection?.code).toBe("FETCH_TIMEOUT");
    expect(outcome.rejection?.httpStatus).toBeNull();
    expect(outcome.error).toBeNull();
    // Provenance preserved
    expect(outcome.provenance.feedOrigin).toBe("rss");
  });

  it("produces a terminal PAYWALL_BLOCKED outcome when retryable=false", () => {
    const outcome = buildFailureOutcome({
      articleId: 5,
      provenance: baseProvenance,
      reason: { code: "PAYWALL_BLOCKED", detail: "Subscribe overlay detected" },
      retryable: false,
      error: "paywall",
    });

    expect(outcome.kind).toBe("PAYWALL_BLOCKED");
    expect(outcome.rejection?.code).toBe("PAYWALL_BLOCKED");
    expect(outcome.error).toBe("paywall");
    expect(outcomeKindToStatus(outcome.kind)).toBe("ENRICHMENT_FAILED");
  });

  it("preserves httpStatus from input or reason", () => {
    const outcome = buildFailureOutcome({
      articleId: 5,
      provenance: baseProvenance,
      reason: { code: "HTTP_FORBIDDEN" },
      retryable: false,
      httpStatus: 403,
    });

    expect(outcome.rejection?.httpStatus).toBe(403);
  });

  it("maps a terminal HTTP_FORBIDDEN code to a valid outcome kind (UNSUPPORTED_STRUCTURE), not the raw code", () => {
    // Regression: previously `buildFailureOutcome` cast `reason.code` directly
    // to `EnrichmentOutcomeKind`, producing an invalid kind like "HTTP_FORBIDDEN"
    // that would fail validation on round-trip. Now it must map to a valid kind.
    const outcome = buildFailureOutcome({
      articleId: 5,
      provenance: baseProvenance,
      reason: { code: "HTTP_FORBIDDEN", detail: "403" },
      retryable: false,
      httpStatus: 403,
    });

    expect(outcome.kind).not.toBe("HTTP_FORBIDDEN");
    expect(outcome.kind).toBe("UNSUPPORTED_STRUCTURE");
    expect(outcome.rejection?.code).toBe("HTTP_FORBIDDEN");

    // And it must round-trip validly
    const { valid } = validateEnrichmentOutcome(
      JSON.parse(JSON.stringify(serializeEnrichmentPayload(outcome))),
    );
    expect(valid).toBe(true);
  });

  it("maps all terminal rejection codes to valid outcome kinds", () => {
    const codes: Array<[EnrichmentRejectionReason["code"], EnrichmentOutcomeKind]> = [
      ["PAYWALL_BLOCKED", "PAYWALL_BLOCKED"],
      ["CANONICAL_MISMATCH", "CANONICAL_MISMATCH"],
      ["LOW_CONTENT_QUALITY", "LOW_CONTENT_QUALITY"],
      ["UNSUPPORTED_STRUCTURE", "UNSUPPORTED_STRUCTURE"],
      ["HEADLESS_REQUIRED", "HEADLESS_REQUIRED"],
      ["HTTP_FORBIDDEN", "UNSUPPORTED_STRUCTURE"],
      ["HTTP_NOT_FOUND", "UNSUPPORTED_STRUCTURE"],
      ["FETCH_TIMEOUT", "UNSUPPORTED_STRUCTURE"],
      ["DUPLICATE_OR_REDUNDANT", "SKIPPED"],
      ["ALREADY_ENRICHED", "SKIPPED"],
      ["OUTSIDE_FRESHNESS_WINDOW", "SKIPPED"],
      ["NO_ARTICLE_URL", "SKIPPED"],
      ["UNKNOWN", "UNSUPPORTED_STRUCTURE"],
    ];

    for (const [code, expectedKind] of codes) {
      const outcome = buildFailureOutcome({
        articleId: 1,
        provenance: baseProvenance,
        reason: { code },
        retryable: false,
      });
      expect(outcome.kind).toBe(expectedKind);
      // Every terminal failure must round-trip validly
      const { valid } = validateEnrichmentOutcome(
        JSON.parse(JSON.stringify(serializeEnrichmentPayload(outcome))),
      );
      expect(valid).toBe(true);
    }
  });
});

// ─── serialize / validate round trip ────────────────────────────────────────

describe("serialize + validate round trip", () => {
  it("round-trips a SUCCESS outcome through serialize → validate", () => {
    const original = buildSuccessOutcome({
      articleId: 42,
      articleUrl: "https://example.com/a",
      provenance: baseProvenance,
      method: { method: "http-meta", resolvedCanonicalUrl: "https://example.com/a" },
      timing: makeTiming(150),
      quality: { confidence: 0.75, qualityScore: 70, signals: ["short_body"], bodyLength: 300 },
      fields: {
        title: { raw: "t1", chosenValue: "t2", chosenFrom: "meta", overrideReason: "richer" },
        excerpt: { raw: null, chosenValue: "e", chosenFrom: "dom", overrideReason: "feed empty" },
        isPaywall: { raw: false, chosenValue: true, chosenFrom: "dom", overrideReason: "overlay" },
      },
    });

    const payload = serializeEnrichmentPayload(original);
    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json);

    const { valid, outcome } = validateEnrichmentOutcome(parsed);

    expect(valid).toBe(true);
    expect(outcome).not.toBeNull();
    expect(outcome!.kind).toBe("SUCCESS");
    expect(outcome!.articleId).toBe(42);
    expect(outcome!.articleUrl).toBe("https://example.com/a");
    expect(outcome!.provenance.sourceId).toBe("src-1");
    expect(outcome!.provenance.feedOrigin).toBe("rss");
    expect(outcome!.method.method).toBe("http-meta");
    expect(outcome!.quality.confidence).toBe(0.75);
    expect(outcome!.quality.signals).toEqual(["short_body"]);
    expect(outcome!.fields.title?.chosenFrom).toBe("meta");
    expect(outcome!.fields.isPaywall?.chosenValue).toBe(true);
    expect(outcome!.timing.durationMs).toBe(150);
  });

  it("round-trips a HEADLESS_REQUIRED outcome", () => {
    const original = buildHeadlessRequiredOutcome({
      articleId: 3,
      provenance: { ...baseProvenance, arrivedViaHardCaseRerun: true },
      detail: "SPA",
    });

    const parsed = JSON.parse(JSON.stringify(serializeEnrichmentPayload(original)));
    const { valid, outcome } = validateEnrichmentOutcome(parsed);

    expect(valid).toBe(true);
    expect(outcome!.kind).toBe("HEADLESS_REQUIRED");
    expect(outcome!.rejection?.code).toBe("HEADLESS_REQUIRED");
    expect(outcome!.provenance.arrivedViaHardCaseRerun).toBe(true);
  });

  it("round-trips a RETRYABLE_FAILURE outcome", () => {
    const original = buildFailureOutcome({
      articleId: 3,
      provenance: baseProvenance,
      reason: { code: "FETCH_TIMEOUT" },
      retryable: true,
      error: "timeout",
    });

    const parsed = JSON.parse(JSON.stringify(serializeEnrichmentPayload(original)));
    const { valid, outcome } = validateEnrichmentOutcome(parsed);

    expect(valid).toBe(true);
    expect(outcome!.kind).toBe("RETRYABLE_FAILURE");
    expect(outcome!.error).toBe("timeout");
  });

  it("serializeOutcomeSummary stays small and carries provenance", () => {
    const outcome = buildSuccessOutcome({
      articleId: 42,
      provenance: baseProvenance,
      method: { method: "http-dom" },
      quality: { confidence: 0.6 },
      fields: {
        title: { raw: "a", chosenValue: "b", chosenFrom: "dom", overrideReason: "r" },
      },
    });

    const summary = asPayload(serializeOutcomeSummary(outcome));

    expect(summary.kind).toBe("SUCCESS");
    expect(summary.method).toBe("http-dom");
    expect(summary.confidence).toBe(0.6);
    expect(summary.rejectionCode).toBeNull();
    expect((summary.provenance as Record<string, unknown>).sourceId).toBe("src-1");
    // Summary must NOT carry full field provenance (DB-efficient)
    expect(summary.fields).toBeUndefined();
  });

  it("summary includes rejectionCode for non-success outcomes", () => {
    const outcome = buildFailureOutcome({
      articleId: 1,
      provenance: baseProvenance,
      reason: { code: "PAYWALL_BLOCKED" },
      retryable: false,
    });

    const summary = asPayload(serializeOutcomeSummary(outcome));
    expect(summary.rejectionCode).toBe("PAYWALL_BLOCKED");
  });
});

// ─── validateEnrichmentOutcome robustness ───────────────────────────────────

describe("validateEnrichmentOutcome robustness", () => {
  it("rejects non-object input", () => {
    expect(validateEnrichmentOutcome(null).valid).toBe(false);
    expect(validateEnrichmentOutcome("string").valid).toBe(false);
    expect(validateEnrichmentOutcome(42).valid).toBe(false);
    expect(validateEnrichmentOutcome([]).valid).toBe(false);
  });

  it("flags malformed kind but rejects unknown kind", () => {
    const { valid, kindMalformed } = validateEnrichmentOutcome({
      kind: "NOT_A_REAL_KIND",
      articleId: 1,
      provenance: baseProvenance,
      timing: makeTiming(),
    });
    expect(valid).toBe(false);
    expect(kindMalformed).toBe(true);
  });

  it("rejects missing articleId", () => {
    const { valid } = validateEnrichmentOutcome({
      kind: "SUCCESS",
      provenance: baseProvenance,
      timing: makeTiming(),
    });
    expect(valid).toBe(false);
  });

  it("rejects missing/invalid provenance", () => {
    const { valid } = validateEnrichmentOutcome({
      kind: "SUCCESS",
      articleId: 1,
      provenance: { feedOrigin: "rss" }, // missing sourceId
      timing: makeTiming(),
    });
    expect(valid).toBe(false);
  });

  it("rejects missing timing", () => {
    const { valid } = validateEnrichmentOutcome({
      kind: "SUCCESS",
      articleId: 1,
      provenance: baseProvenance,
    });
    expect(valid).toBe(false);
  });

  it("normalizes malformed sub-fields to safe defaults without rejecting the whole payload", () => {
    const parsed = JSON.parse(
      JSON.stringify(
        serializeEnrichmentPayload(
          buildSuccessOutcome({
            articleId: 1,
            provenance: baseProvenance,
            fields: {
              title: { raw: "a", chosenValue: "b", chosenFrom: "dom", overrideReason: "r" },
            },
          }),
        ),
      ),
    );

    // Corrupt a nested sub-field
    parsed.quality.confidence = "not-a-number";
    parsed.method.method = "bogus";
    parsed.rejection = { code: "NOT_A_CODE" };
    parsed.fields.title.chosenFrom = "bogus";

    const { valid, outcome } = validateEnrichmentOutcome(parsed);

    expect(valid).toBe(true);
    expect(outcome!.quality.confidence).toBe(0); // clamped/normalized
    expect(outcome!.method.method).toBe("none");
    expect(outcome!.rejection?.code).toBe("UNKNOWN");
    expect(outcome!.fields.title?.chosenFrom).toBe("none");
  });

  it("normalizes unknown feedOrigin to rss", () => {
    const parsed = JSON.parse(
      JSON.stringify(
        serializeEnrichmentPayload(
          buildSuccessOutcome({ articleId: 1, provenance: baseProvenance, fields: {} }),
        ),
      ),
    );
    parsed.provenance.feedOrigin = "xml";

    const { valid, outcome } = validateEnrichmentOutcome(parsed);
    expect(valid).toBe(true);
    expect(outcome!.provenance.feedOrigin).toBe("rss");
  });
});

// ─── createEnrichmentOutcome direct ─────────────────────────────────────────

describe("createEnrichmentOutcome", () => {
  it("clamps confidence to 0..1", () => {
    const high = createEnrichmentOutcome({
      kind: "SUCCESS",
      articleId: 1,
      provenance: baseProvenance,
      timing: makeTiming(),
      quality: { confidence: 5 },
      fields: {},
    });
    expect(high.quality.confidence).toBe(1);

    const low = createEnrichmentOutcome({
      kind: "SUCCESS",
      articleId: 1,
      provenance: baseProvenance,
      timing: makeTiming(),
      quality: { confidence: -2 },
      fields: {},
    });
    expect(low.quality.confidence).toBe(0);
  });

  it("coerces nullish articleUrl and error to null", () => {
    const outcome = createEnrichmentOutcome({
      kind: "SKIPPED",
      articleId: 1,
      provenance: baseProvenance,
      timing: makeTiming(),
      fields: {},
    });
    expect(outcome.articleUrl).toBeNull();
    expect(outcome.error).toBeNull();
    expect(outcome.rejection).toBeNull();
  });
});

// ─── outcomeKindToStatus mapping ─────────────────────────────────────────────

describe("outcomeKindToStatus", () => {
  it("maps every outcome kind to a valid enrichment status", () => {
    expect(outcomeKindToStatus("SUCCESS")).toBe("ENRICHED");
    expect(outcomeKindToStatus("SKIPPED")).toBe("ENRICHMENT_SKIPPED");
    expect(outcomeKindToStatus("HEADLESS_REQUIRED")).toBe("ENRICHMENT_QUEUED_HEADLESS");
    expect(outcomeKindToStatus("RETRYABLE_FAILURE")).toBe("ENRICHMENT_FAILED");
    expect(outcomeKindToStatus("PAYWALL_BLOCKED")).toBe("ENRICHMENT_FAILED");
    expect(outcomeKindToStatus("CANONICAL_MISMATCH")).toBe("ENRICHMENT_FAILED");
    expect(outcomeKindToStatus("LOW_CONTENT_QUALITY")).toBe("ENRICHMENT_FAILED");
    expect(outcomeKindToStatus("UNSUPPORTED_STRUCTURE")).toBe("ENRICHMENT_FAILED");
  });
});
