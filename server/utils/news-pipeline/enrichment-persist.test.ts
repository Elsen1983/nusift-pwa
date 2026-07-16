import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleEnrichmentOutcome, ArticleUpstreamProvenance } from "./enrichment";
import {
  buildFailureOutcome,
  buildHeadlessRequiredOutcome,
  buildSkippedOutcome,
  buildSuccessOutcome,
} from "./enrichment";

// ─── Mock prisma ────────────────────────────────────────────────────────────
// $transaction with an array is called by persistEnrichmentOutcome.
const articleUpdateMock = vi.fn();
const artifactCreateMock = vi.fn();
const pipelineArtifactFindManyMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    article: {
      update: (...args: any[]) => articleUpdateMock(...args),
    },
    pipelineArtifact: {
      create: (...args: any[]) => artifactCreateMock(...args),
      findMany: (...args: any[]) => pipelineArtifactFindManyMock(...args),
    },
  },
}));

const baseProvenance: ArticleUpstreamProvenance = {
  sourceId: "src-1",
  categoryId: "cat-1",
  feedOrigin: "rss",
  feedUrl: "https://example.com/rss",
  discoveredFromCategoryFeed: true,
  arrivedViaHardCaseRerun: false,
  ingestedAt: "2026-07-15T08:00:00.000Z",
};

const makeSuccess = (): ArticleEnrichmentOutcome =>
  buildSuccessOutcome({
    articleId: 42,
    articleUrl: "https://example.com/a",
    provenance: baseProvenance,
    method: { method: "http-dom", detail: "article>main" },
    quality: { confidence: 0.9, qualityScore: 88, signals: ["has_author"], bodyLength: 1200 },
    fields: {
      title: { raw: "Feed title", chosenValue: "HTML title", chosenFrom: "dom", overrideReason: "richer" },
      bodyText: { raw: null, chosenValue: "Extracted body...", chosenFrom: "dom", overrideReason: "feed empty" },
    },
  });

/** Cast Prisma.InputJsonValue back to a concrete shape for assertions. */
const asObj = (v: unknown) => v as Record<string, unknown>;

describe("outcomeKindToArtifact", () => {
  it("maps SUCCESS → article_enrichment_result / CAPTURED", async () => {
    const { outcomeKindToArtifact } = await import("./enrichment-persist");
    expect(outcomeKindToArtifact("SUCCESS")).toEqual({
      artifactType: "article_enrichment_result",
      status: "CAPTURED",
    });
  });

  it("maps SKIPPED → article_enrichment_result / SKIPPED", async () => {
    const { outcomeKindToArtifact } = await import("./enrichment-persist");
    expect(outcomeKindToArtifact("SKIPPED")).toEqual({
      artifactType: "article_enrichment_result",
      status: "SKIPPED",
    });
  });

  it("maps HEADLESS_REQUIRED → article_headless_queue_candidate / PENDING_HEADLESS", async () => {
    const { outcomeKindToArtifact } = await import("./enrichment-persist");
    expect(outcomeKindToArtifact("HEADLESS_REQUIRED")).toEqual({
      artifactType: "article_headless_queue_candidate",
      status: "PENDING_HEADLESS",
    });
  });

  it("maps all terminal failures → article_enrichment_rejection / FAILED", async () => {
    const { outcomeKindToArtifact } = await import("./enrichment-persist");
    for (const kind of [
      "RETRYABLE_FAILURE",
      "PAYWALL_BLOCKED",
      "CANONICAL_MISMATCH",
      "LOW_CONTENT_QUALITY",
      "UNSUPPORTED_STRUCTURE",
    ] as const) {
      expect(outcomeKindToArtifact(kind)).toEqual({
        artifactType: "article_enrichment_rejection",
        status: "FAILED",
      });
    }
  });
});

describe("buildArticleEnrichmentUpdate", () => {
  it("produces a minimal row update with status, timestamps, method, confidence, summary", async () => {
    const { buildArticleEnrichmentUpdate } = await import("./enrichment-persist");
    const outcome = makeSuccess();
    const update = buildArticleEnrichmentUpdate(outcome) as Record<string, unknown>;

    expect(update.enrichmentStatus).toBe("ENRICHED");
    expect(update.enrichmentMethod).toBe("http-dom");
    expect(update.enrichmentConfidence).toBe(0.9);
    // attempt count increments atomically
    expect(update.enrichmentAttemptCount).toEqual({ increment: 1 });
    // timestamps come from the outcome timing
    expect(update.enrichmentStartedAt).toBeInstanceOf(Date);
    expect(update.enrichmentFinishedAt).toBeInstanceOf(Date);
    // summary is the small JSON, NOT the full payload
    const summary = asObj(update.enrichmentOutcome);
    expect(summary.kind).toBe("SUCCESS");
    expect(summary.method).toBe("http-dom");
    expect(summary.confidence).toBe(0.9);
    expect(summary.rejectionCode).toBeNull();
    // summary must NOT carry full field provenance
    expect(summary.fields).toBeUndefined();
  });

  it("derives status from outcomeKindToStatus for each kind", async () => {
    const { buildArticleEnrichmentUpdate } = await import("./enrichment-persist");

    const skipped = buildArticleEnrichmentUpdate(
      buildSkippedOutcome({ articleId: 1, provenance: baseProvenance, reasonCode: "ALREADY_ENRICHED" }),
    ) as Record<string, unknown>;
    expect(skipped.enrichmentStatus).toBe("ENRICHMENT_SKIPPED");

    const headless = buildArticleEnrichmentUpdate(
      buildHeadlessRequiredOutcome({ articleId: 1, provenance: baseProvenance }),
    ) as Record<string, unknown>;
    expect(headless.enrichmentStatus).toBe("ENRICHMENT_QUEUED_HEADLESS");

    const failed = buildArticleEnrichmentUpdate(
      buildFailureOutcome({
        articleId: 1,
        provenance: baseProvenance,
        reason: { code: "PAYWALL_BLOCKED" },
        retryable: false,
      }),
    ) as Record<string, unknown>;
    expect(failed.enrichmentStatus).toBe("ENRICHMENT_FAILED");
  });
});

describe("buildEnrichmentArtifactCreate", () => {
  it("builds an artifact with the full payload, source/category provenance, and correct type", async () => {
    const { buildEnrichmentArtifactCreate } = await import("./enrichment-persist");
    const outcome = makeSuccess();
    const data = buildEnrichmentArtifactCreate(outcome, "run-1") as Record<string, unknown>;

    expect(data.pipelineRunId).toBe("run-1");
    expect(data.sourceId).toBe("src-1");
    expect(data.categoryId).toBe("cat-1");
    expect(data.artifactType).toBe("article_enrichment_result");
    expect(data.status).toBe("CAPTURED");
    expect(data.candidateCount).toBe(1);

    // Full payload preserves field-level provenance + upstream provenance
    const payload = asObj(data.payload);
    expect(payload.kind).toBe("SUCCESS");
    expect(payload.articleId).toBe(42);
    const provenance = asObj(payload.provenance);
    expect(provenance.sourceId).toBe("src-1");
    expect(provenance.feedOrigin).toBe("rss");
    const fields = asObj(payload.fields);
    expect(asObj(fields.title).chosenFrom).toBe("dom");
    // errorLog null for success
    expect(data.errorLog).toBeNull();
  });

  it("builds a rejection artifact with errorLog from the rejection code", async () => {
    const { buildEnrichmentArtifactCreate } = await import("./enrichment-persist");
    const outcome = buildFailureOutcome({
      articleId: 5,
      provenance: baseProvenance,
      reason: { code: "PAYWALL_BLOCKED", detail: "Subscribe overlay" },
      retryable: false,
    });
    const data = buildEnrichmentArtifactCreate(outcome, "run-1") as Record<string, unknown>;

    expect(data.artifactType).toBe("article_enrichment_rejection");
    expect(data.status).toBe("FAILED");
    expect(data.candidateCount).toBe(0);
    expect(String(data.errorLog)).toContain("PAYWALL_BLOCKED");
    expect(String(data.errorLog)).toContain("Subscribe overlay");
  });

  it("builds a headless queue candidate artifact with PENDING_HEADLESS", async () => {
    const { buildEnrichmentArtifactCreate } = await import("./enrichment-persist");
    const outcome = buildHeadlessRequiredOutcome({
      articleId: 9,
      provenance: { ...baseProvenance, arrivedViaHardCaseRerun: true },
      detail: "SPA",
    });
    const data = buildEnrichmentArtifactCreate(outcome, "run-1") as Record<string, unknown>;

    expect(data.artifactType).toBe("article_headless_queue_candidate");
    expect(data.status).toBe("PENDING_HEADLESS");
    // provenance preserved including hard-case-rerun flag
    const payload = asObj(data.payload);
    const provenance = asObj(payload.provenance);
    expect(provenance.arrivedViaHardCaseRerun).toBe(true);
  });
});

describe("persistEnrichmentOutcome", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    articleUpdateMock.mockResolvedValue({ id: 42 });
    artifactCreateMock.mockResolvedValue({ id: "art-1" });
  });

  it("runs article update + artifact create in one transaction and returns the artifact id", async () => {
    const { persistEnrichmentOutcome } = await import("./enrichment-persist");
    const result = await persistEnrichmentOutcome(makeSuccess(), "run-1");

    expect(result.artifactId).toBe("art-1");
    expect(result.applied).toBe(true);
    expect(articleUpdateMock).toHaveBeenCalledTimes(1);
    expect(artifactCreateMock).toHaveBeenCalledTimes(1);

    // article update targets the right id
    const updateArgs = articleUpdateMock.mock.calls[0]![0];
    expect(updateArgs.where.id).toBe(42);
    expect(updateArgs.data.enrichmentStatus).toBe("ENRICHED");

    // artifact create has the right run + type
    const createArgs = artifactCreateMock.mock.calls[0]![0];
    expect(createArgs.data.pipelineRunId).toBe("run-1");
    expect(createArgs.data.artifactType).toBe("article_enrichment_result");
  });
});

describe("persistEnrichmentBatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    articleUpdateMock.mockResolvedValue({ id: 0 });
    artifactCreateMock.mockResolvedValue({ id: "" });
  });

  it("persists each outcome and aggregates byKind counts", async () => {
    const { persistEnrichmentBatch } = await import("./enrichment-persist");
    const outcomes: ArticleEnrichmentOutcome[] = [
      makeSuccess(), // SUCCESS
      buildSkippedOutcome({ articleId: 2, provenance: baseProvenance, reasonCode: "ALREADY_ENRICHED" }), // SKIPPED
      buildHeadlessRequiredOutcome({ articleId: 3, provenance: baseProvenance }), // HEADLESS_REQUIRED
    ];
    // give distinct artifact ids
    artifactCreateMock
      .mockResolvedValueOnce({ id: "art-a" })
      .mockResolvedValueOnce({ id: "art-b" })
      .mockResolvedValueOnce({ id: "art-c" });

    const result = await persistEnrichmentBatch(outcomes, "run-1");

    expect(result.persisted).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.byKind.SUCCESS).toBe(1);
    expect(result.byKind.SKIPPED).toBe(1);
    expect(result.byKind.HEADLESS_REQUIRED).toBe(1);
    expect(result.artifactIds).toEqual(["art-a", "art-b", "art-c"]);
  });

  it("counts a persist failure without throwing (best-effort batch)", async () => {
    const { persistEnrichmentBatch } = await import("./enrichment-persist");
    articleUpdateMock
      .mockResolvedValueOnce({ id: 42 })
      .mockRejectedValueOnce(new Error("P2025 record not found"));

    const outcomes: ArticleEnrichmentOutcome[] = [
      makeSuccess(),
      buildSkippedOutcome({ articleId: 99, provenance: baseProvenance, reasonCode: "ALREADY_ENRICHED" }),
    ];

    const result = await persistEnrichmentBatch(outcomes, "run-1");

    expect(result.persisted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.byKind.SUCCESS).toBe(1);
    expect(result.byKind.SKIPPED).toBe(0);
  });
});

describe("buildEnrichmentRunSummary", () => {
  it("produces a JSON summary with articleCount + byKind + artifactCount", async () => {
    const { buildEnrichmentRunSummary } = await import("./enrichment-persist");
    const summary = asObj(
      buildEnrichmentRunSummary(
        {
          persisted: 2,
          failed: 1,
          byKind: {
            SUCCESS: 1,
            SKIPPED: 1,
            RETRYABLE_FAILURE: 0,
            HEADLESS_REQUIRED: 0,
            PAYWALL_BLOCKED: 0,
            CANONICAL_MISMATCH: 0,
            LOW_CONTENT_QUALITY: 0,
            UNSUPPORTED_STRUCTURE: 0,
          },
          artifactIds: ["a", "b"],
        },
        3,
      ),
    );

    expect(summary.articleCount).toBe(3);
    expect(summary.persisted).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.artifactCount).toBe(2);
    expect(asObj(summary.byKind).SUCCESS).toBe(1);
  });
});

describe("buildAttemptMarkerArtifact", () => {
  it("builds a lightweight attempt marker with the correct shape", async () => {
    const { buildAttemptMarkerArtifact } = await import("./enrichment-persist");
    const data = buildAttemptMarkerArtifact(
      42,
      1,
      "2026-07-16T10:00:00.000Z",
      "run-1",
      "src-1",
      "cat-1",
    ) as Record<string, unknown>;

    expect(data.pipelineRunId).toBe("run-1");
    expect(data.sourceId).toBe("src-1");
    expect(data.categoryId).toBe("cat-1");
    expect(data.artifactType).toBe("article_enrichment_attempt");
    expect(data.status).toBe("ATTEMPTED");
    expect(data.candidateCount).toBe(0);
    expect(data.errorLog).toBeNull();

    // Payload is lightweight — no full outcome, no field provenance
    const payload = asObj(data.payload);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.artifactKind).toBe("attempt_marker");
    expect(payload.articleId).toBe(42);
    expect(payload.attemptNumber).toBe(1);
    expect(payload.startedAt).toBe("2026-07-16T10:00:00.000Z");
    // Must NOT carry outcome fields
    expect(payload.kind).toBeUndefined();
    expect(payload.provenance).toBeUndefined();
    expect(payload.fields).toBeUndefined();
  });

  it("handles null categoryId", async () => {
    const { buildAttemptMarkerArtifact } = await import("./enrichment-persist");
    const data = buildAttemptMarkerArtifact(
      1, 1, "2026-07-16T10:00:00.000Z", "run-1", "src-1", null,
    ) as Record<string, unknown>;
    expect(data.categoryId).toBeNull();
  });
});

describe("persistAttemptMarker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    artifactCreateMock.mockResolvedValue({ id: "marker-1" });
  });

  it("creates an attempt marker artifact and returns the id", async () => {
    const { persistAttemptMarker } = await import("./enrichment-persist");
    const id = await persistAttemptMarker(
      42, 2, "2026-07-16T10:00:00.000Z", "run-1", "src-1", "cat-1",
    );

    expect(id).toBe("marker-1");
    expect(artifactCreateMock).toHaveBeenCalledTimes(1);
    const createArgs = artifactCreateMock.mock.calls[0]![0];
    expect(createArgs.data.artifactType).toBe("article_enrichment_attempt");
    expect(createArgs.data.status).toBe("ATTEMPTED");
    const payload = asObj(createArgs.data.payload);
    expect(payload.articleId).toBe(42);
    expect(payload.attemptNumber).toBe(2);
  });
});

describe("readEnrichmentSummary", () => {
  it("reads back a valid summary", async () => {
    const { readEnrichmentSummary } = await import("./enrichment-persist");
    const summary = readEnrichmentSummary({
      schemaVersion: 1,
      kind: "SUCCESS",
      method: "http-dom",
      confidence: 0.9,
      rejectionCode: null,
      provenance: { sourceId: "src-1", categoryId: "cat-1", feedOrigin: "rss" },
    });

    expect(summary).not.toBeNull();
    expect(summary!.kind).toBe("SUCCESS");
    expect(summary!.method).toBe("http-dom");
    expect(summary!.confidence).toBe(0.9);
    expect(summary!.rejectionCode).toBeNull();
    expect(summary!.provenance.sourceId).toBe("src-1");
  });

  it("returns null for malformed input", async () => {
    const { readEnrichmentSummary } = await import("./enrichment-persist");
    expect(readEnrichmentSummary(null)).toBeNull();
    expect(readEnrichmentSummary("string")).toBeNull();
    expect(readEnrichmentSummary({})).toBeNull();
    expect(readEnrichmentSummary({ kind: "SUCCESS" })).toBeNull();
    expect(
      readEnrichmentSummary({ kind: "SUCCESS", provenance: { feedOrigin: "rss" } }),
    ).toBeNull(); // missing sourceId
  });

  it("normalizes missing optional fields to safe defaults", async () => {
    const { readEnrichmentSummary } = await import("./enrichment-persist");
    const summary = readEnrichmentSummary({
      kind: "SUCCESS",
      provenance: { sourceId: "src-1" },
    });
    expect(summary!.method).toBe("none");
    expect(summary!.confidence).toBe(0);
    expect(summary!.rejectionCode).toBeNull();
    expect(summary!.provenance.categoryId).toBeNull();
    expect(summary!.provenance.feedOrigin).toBe("rss");
  });
});
