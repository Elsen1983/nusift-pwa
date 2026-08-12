import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArticleAccessOutcomeSummary,
  ArticleEnrichmentOutcome,
  ArticleUpstreamProvenance,
} from "./enrichment";
import {
  buildFailureOutcome,
  buildHeadlessRequiredOutcome,
  buildSkippedOutcome,
  buildSuccessOutcome,
} from "./enrichment";

// ─── Mock prisma ────────────────────────────────────────────────────────────
// The persistence path uses both array and callback transactions.
const articleUpdateMock = vi.fn();
const articleUpdateManyMock = vi.fn();
const articleFindUniqueMock = vi.fn();
const artifactCreateMock = vi.fn();
const artifactDeleteManyMock = vi.fn();
const claimDeleteManyMock = vi.fn();
const claimFindUniqueMock = vi.fn();
const claimCreateMock = vi.fn();
const claimDeleteManyDirectMock = vi.fn();
const pipelineArtifactFindManyMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: (...args: any[]) => transactionMock(...args),
    article: {
      update: (...args: any[]) => articleUpdateMock(...args),
      updateMany: (...args: any[]) => articleUpdateManyMock(...args),
      findUnique: (...args: any[]) => articleFindUniqueMock(...args),
    },
    articleEnrichmentClaim: {
      deleteMany: (...args: any[]) => claimDeleteManyDirectMock(...args),
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

const makeAccess = (
  classification: ArticleAccessOutcomeSummary["classification"],
  overrides: Partial<ArticleAccessOutcomeSummary> = {},
): ArticleAccessOutcomeSummary => ({
  classification,
  sourceStage: "agent3",
  confidence: classification === "PAYWALL_BLOCKED" ? "HIGH" : "MEDIUM",
  detectorVersion: "article-access-v1.0.0",
  evidenceCodes: ["article_scoped_cta", "body_truncated", ...Array.from({ length: 30 }, (_, index) => `evidence_${index}`)],
  contradictingEvidenceCodes: ["contradiction", ...Array.from({ length: 30 }, (_, index) => `contradiction_${index}`)],
  evidenceArticleScoped: classification === "PAYWALL_BLOCKED",
  usableBodyExtracted: classification === "ACCESSIBLE" || classification === "METERED_OR_DECLARED",
  bodyTruncationDetected: classification === "PAYWALL_BLOCKED",
  articleScopedGateOrOverlayDetected: classification === "PAYWALL_BLOCKED",
  decisive: classification === "PAYWALL_BLOCKED" || classification === "ACCESSIBLE",
  previousIsPaywall: false,
  earlyStageClassification: null,
  earlyStageSource: null,
  earlyStageEvidenceCodes: [],
  earlyStageContradictingEvidenceCodes: [],
  finalIsPaywall: classification === "PAYWALL_BLOCKED" ? true : classification === "ACCESSIBLE" ? false : null,
  overrideReason: null,
  ...overrides,
});

const makeSuccess = (): ArticleEnrichmentOutcome =>
  buildSuccessOutcome({
    articleId: 42,
    articleUrl: "https://example.com/a",
    provenance: baseProvenance,
    method: { method: "http-dom", detail: "article>main" },
    quality: { confidence: 0.9, qualityScore: 88, signals: ["has_author"], bodyLength: 1200 },
    fields: {
      title: { raw: "Feed title", chosenValue: "HTML title", chosenFrom: "dom", overrideReason: "richer" },
      bodyText: { raw: null, chosenValue: "A".repeat(1200), chosenFrom: "dom", overrideReason: "feed empty" },
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
      "HTTP_ACCESS_BLOCKED",
      "INTERSTITIAL_OR_CHALLENGE",
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
    const update = buildArticleEnrichmentUpdate(outcome, {
      existingTitle: "Published title",
      existingCanonicalUrl: "https://example.com/a",
    }) as Record<string, unknown>;

    expect(update.enrichmentStatus).toBe("ENRICHED");
    expect(update.enrichmentMethod).toBe("http-dom");
    expect(update.enrichmentConfidence).toBe(0.9);
    expect(update.publicationStatus).toBe("PUBLISHED");
    expect(update.publicationStage).toBe("agent3");
    expect(update.publicationReadyAt).toEqual(new Date(outcome.timing.finishedAt));
    // Attempt count increments atomically when the claim is acquired, not on final write.
    expect(update.enrichmentAttemptCount).toBeUndefined();
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

  it("promotes an HTTP Article canonical URL after successful HTTPS transport", async () => {
    const { buildArticleEnrichmentUpdate } = await import("./enrichment-persist");
    const outcome = makeSuccess();
    outcome.articleUrl = "https://example.com/a";
    outcome.provenance.originalArticleUrl = "http://example.com/a";
    outcome.method.transportUrl = "https://example.com/a";
    outcome.method.originalArticleUrl = "http://example.com/a";

    const update = buildArticleEnrichmentUpdate(outcome, {
      existingTitle: "Published title",
      existingCanonicalUrl: "http://example.com/a",
    }) as Record<string, unknown>;

    expect(update.canonicalUrl).toBe("https://example.com/a");
    expect(update.publicationStatus).toBe("PUBLISHED");
  });

  it("derives publication from the body that will actually be durable", async () => {
    const { buildArticleEnrichmentUpdate } = await import("./enrichment-persist");

    const shortReplacement = buildSuccessOutcome({
      articleId: 1,
      provenance: baseProvenance,
      quality: { bodyLength: 100 },
      fields: {
        bodyText: {
          raw: "A".repeat(900),
          chosenValue: "B".repeat(100),
          chosenFrom: "dom",
          overrideReason: "test replacement",
        },
      },
    });
    const shortReplacementUpdate = buildArticleEnrichmentUpdate(shortReplacement, {
      existingBodyText: "A".repeat(900),
      existingTitle: "Published title",
      existingCanonicalUrl: "https://example.com/a",
    }) as Record<string, unknown>;
    expect(shortReplacementUpdate.bodyText).toBe("B".repeat(100));
    expect(shortReplacementUpdate.publicationStatus).toBe("PROCESSING");
    expect(shortReplacementUpdate.publicationReadyAt).toBeNull();

    const unchangedLongValue = buildSuccessOutcome({
      articleId: 2,
      provenance: baseProvenance,
      quality: { bodyLength: 900 },
      fields: {
        bodyText: {
          raw: "C".repeat(900),
          chosenValue: "C".repeat(900),
          chosenFrom: "unchanged",
          overrideReason: "kept existing",
        },
      },
    });
    const unchangedUpdate = buildArticleEnrichmentUpdate(unchangedLongValue, {
      existingBodyText: "D".repeat(100),
      existingTitle: "Published title",
      existingCanonicalUrl: "https://example.com/a",
    }) as Record<string, unknown>;
    expect(unchangedUpdate.bodyText).toBeUndefined();
    expect(unchangedUpdate.publicationStatus).toBe("PROCESSING");
    expect(unchangedUpdate.publicationReadyAt).toBeNull();

    const noReplacement = buildSuccessOutcome({
      articleId: 3,
      provenance: baseProvenance,
      quality: { bodyLength: null },
      fields: {},
    });
    const noReplacementUpdate = buildArticleEnrichmentUpdate(noReplacement, {
      existingBodyText: "E".repeat(100),
      existingTitle: "Published title",
      existingCanonicalUrl: "https://example.com/a",
    }) as Record<string, unknown>;
    expect(noReplacementUpdate.publicationStatus).toBe("PROCESSING");
    expect(noReplacementUpdate.publicationReadyAt).toBeNull();
  });

  it("applies Agent 3 access authority to the legacy boolean compatibility field", async () => {
    const { buildArticleEnrichmentUpdate } = await import("./enrichment-persist");
    const successFields = {
      bodyText: { raw: null, chosenValue: "A".repeat(1200), chosenFrom: "dom" as const, overrideReason: "full body" },
    };

    const earlyHintCleared = buildArticleEnrichmentUpdate(
      buildSuccessOutcome({ articleId: 1, provenance: baseProvenance, fields: successFields, access: makeAccess("ACCESSIBLE", {
        previousIsPaywall: true,
        earlyStageClassification: "PAYWALL_BLOCKED",
        overrideReason: "Cleared early paywall hint after successful substantial article-body extraction without paywall signals.",
      }) }),
      { existingBodyText: null, existingTitle: "Story", existingCanonicalUrl: "https://example.com/story" },
    ) as Record<string, unknown>;
    expect(earlyHintCleared.isPaywall).toBe(false);    expect(asObj(earlyHintCleared.enrichmentOutcome).access).toMatchObject({
      sourceStage: "agent3",
      previousIsPaywall: true,
      finalIsPaywall: false,
    });

    const genuineBlock = buildArticleEnrichmentUpdate(
      buildFailureOutcome({ articleId: 2, provenance: baseProvenance, reason: { code: "PAYWALL_BLOCKED" }, retryable: false }),
    ) as Record<string, unknown>;
    // A failure builder without the extractor result has no access summary, so
    // persistence must not invent a paywall boolean from a generic rejection.
    expect(genuineBlock.isPaywall).toBeUndefined();

    const blockedWithEvidence = buildArticleEnrichmentUpdate(
      buildSuccessOutcome({ articleId: 3, provenance: baseProvenance, fields: successFields, access: makeAccess("PAYWALL_BLOCKED") }),
      { existingBodyText: null, existingTitle: "Story", existingCanonicalUrl: "https://example.com/story" },
    ) as Record<string, unknown>;
    expect(blockedWithEvidence.isPaywall).toBe(true);

    const unknownPreservesExisting = buildArticleEnrichmentUpdate(
      buildSuccessOutcome({ articleId: 4, provenance: baseProvenance, fields: successFields, access: makeAccess("UNKNOWN", {
        previousIsPaywall: true,
        finalIsPaywall: null,
      }) }),
      { existingBodyText: null, existingTitle: "Story", existingCanonicalUrl: "https://example.com/story" },
    ) as Record<string, unknown>;
    expect(unknownPreservesExisting.isPaywall).toBeUndefined();

    const technicalBlockDoesNotInferPaywall = buildArticleEnrichmentUpdate(
      buildSuccessOutcome({ articleId: 5, provenance: baseProvenance, fields: {}, access: makeAccess("HTTP_ACCESS_BLOCKED") }),
    ) as Record<string, unknown>;
    expect(technicalBlockDoesNotInferPaywall.isPaywall).toBeUndefined();
  });

  it("keeps bounded access evidence and does not expose full body through the row summary", async () => {
    const { buildEnrichmentArtifactCreate, buildArticleEnrichmentUpdate } = await import("./enrichment-persist");
    const outcome = buildSuccessOutcome({
      articleId: 6,
      articleUrl: "https://example.com/story?token=secret",
      provenance: { ...baseProvenance, feedUrl: "https://example.com/rss?api_key=secret" },
      method: { method: "http-dom", detail: "<div>SECRET HTML</div> token=secret" },
      fields: { bodyText: { raw: null, chosenValue: "SECRET BODY".repeat(300), chosenFrom: "dom", overrideReason: "test" } },
      access: makeAccess("ACCESSIBLE"),
    });
    const summary = asObj(buildArticleEnrichmentUpdate(outcome).enrichmentOutcome);
    const artifact = asObj(buildEnrichmentArtifactCreate(outcome, "run-1").payload);
    const access = asObj(summary.access);
    expect((access.evidenceCodes as string[]).length).toBeLessThanOrEqual(12);
    expect((access.contradictingEvidenceCodes as string[]).length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(summary)).not.toContain("SECRET BODY");
    // Raw body/text, markup, credentials, and query secrets are never stored
    // in evidence artifacts.
    const artifactJson = JSON.stringify(artifact);
    expect(artifactJson).not.toContain("SECRET BODY");
    expect(artifactJson).not.toContain("SECRET HTML");
    expect(artifactJson).not.toContain("token=secret");
    expect(artifactJson).not.toContain("api_key=secret");
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
    expect(failed.publicationStatus).toBe("REJECTED");
    expect(failed.publicationReadyAt).toBeNull();
  });

  it("keeps recoverable interstitials in PROCESSING and only quarantined interstitials become REJECTED", async () => {
    const { buildArticleEnrichmentUpdate } = await import("./enrichment-persist");
    const interstitial = (disposition: string | null) =>
      buildArticleEnrichmentUpdate(
        buildFailureOutcome({
          articleId: 7,
          provenance: baseProvenance,
          reason: { code: "INTERSTITIAL_OR_CHALLENGE", detail: "HTTP 202 interstitial" },
          retryable: false,
        }),
        { retryDisposition: disposition ? { state: disposition } : null },
      ) as Record<string, unknown>;

    // First attempt / no disposition yet → recoverable.
    expect(interstitial(null).enrichmentStatus).toBe("ENRICHMENT_FAILED");
    expect(interstitial(null).publicationStatus).toBe("PROCESSING");
    expect(interstitial(null).publicationReadyAt).toBeNull();
    // Deferred (browser recovery still possible) → recoverable.
    expect(interstitial("DEFERRED").publicationStatus).toBe("PROCESSING");
    // Ready-retry (cooldown elapsed) → still recoverable.
    expect(interstitial("READY_RETRY").publicationStatus).toBe("PROCESSING");
    // Exhausted/quarantined → terminal rejection.
    expect(interstitial("QUARANTINED").publicationStatus).toBe("REJECTED");
    expect(interstitial("QUARANTINED").publicationReadyAt).toBeNull();

    // Terminal kinds keep their existing behavior.
    const paywall = buildArticleEnrichmentUpdate(
      buildFailureOutcome({
        articleId: 8,
        provenance: baseProvenance,
        reason: { code: "PAYWALL_BLOCKED" },
        retryable: false,
      }),
    ) as Record<string, unknown>;
    expect(paywall.publicationStatus).toBe("REJECTED");
  });

  it("a successful browser recovery transitions normally to publication-ready state", async () => {
    const { buildArticleEnrichmentUpdate } = await import("./enrichment-persist");
    const recovered = buildSuccessOutcome({
      articleId: 9,
      articleUrl: "https://example.com/a",
      provenance: baseProvenance,
      method: { method: "browser-dom", detail: "browser recovery" },
      quality: { confidence: 0.9, qualityScore: 88, signals: ["method:browser-dom"], bodyLength: 1200 },
      fields: {
        title: { raw: "Feed title", chosenValue: "HTML title", chosenFrom: "dom", overrideReason: "richer" },
        bodyText: { raw: null, chosenValue: "A".repeat(1200), chosenFrom: "dom", overrideReason: "browser recovery" },
      },
    });
    const update = buildArticleEnrichmentUpdate(recovered, {
      existingTitle: "Published title",
      existingCanonicalUrl: "https://example.com/a",
      existingBodyText: "A".repeat(1200),
    }) as Record<string, unknown>;

    expect(update.enrichmentStatus).toBe("ENRICHED");
    expect(update.publicationStatus).toBe("PUBLISHED");
    expect(update.publicationReadyAt).toEqual(new Date(recovered.timing.finishedAt));
  });

  it("persists blocking metadata in the row summary for progress cooldown checks", async () => {
    const { buildArticleEnrichmentUpdate } = await import("./enrichment-persist");
    const outcome = buildFailureOutcome({
      articleId: 1,
      provenance: baseProvenance,
      reason: { code: "UNKNOWN", detail: "[http_error] HTTP 429", httpStatus: 429 },
      retryable: false,
    });
    outcome.browserFallback = {
      attempted: true,
      succeeded: false,
      staticStatusCode: null,
      staticRejectedReason: "http_error",
      staticMethod: "http-dom",
      method: "browser-dom",
      rejectedReason: "http_error",
      browserRejectedReason: "http_error",
      statusCode: 429,
      runtimeUnavailable: false,
      rateLimited: true,
      confidence: null,
      browserDiagnostics: null,
    };

    const update = buildArticleEnrichmentUpdate(outcome) as Record<string, unknown>;
    const summary = asObj(update.enrichmentOutcome);
    const browserFallback = asObj(summary.browserFallback);

    expect(summary.rejectionHttpStatus).toBe(429);
    expect(summary.rejectionDetail).toBe("[http_error] HTTP 429");
    expect(browserFallback.rateLimited).toBe(true);
    expect(browserFallback.statusCode).toBe(429);
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
    articleUpdateManyMock.mockResolvedValue({ count: 1 });
    claimDeleteManyMock.mockResolvedValue({ count: 1 });
    articleFindUniqueMock.mockResolvedValue({
      bodyText: "A".repeat(1200),
      title: "Published title",
      canonicalUrl: "https://example.com/a",
    });
    claimFindUniqueMock.mockResolvedValue({
      articleId: 42,
      pipelineRunId: "run-1",
      token: "claim-1",
      attemptNumber: 1,
      expectedStatus: "INGESTED",
      expiresAt: new Date(Date.now() + 60_000),
    });
    claimFindUniqueMock.mockResolvedValue({
      articleId: 42,
      pipelineRunId: "run-1",
      token: "claim-1",
      attemptNumber: 1,
      expectedStatus: "INGESTED",
      expiresAt: new Date(Date.now() + 60_000),
    });
    transactionMock.mockImplementation(async (callback: any) => callback({
      article: {
        findUnique: (...args: any[]) => articleFindUniqueMock(...args),
        update: (...args: any[]) => articleUpdateMock(...args),
        updateMany: (...args: any[]) => {
          const result = articleUpdateManyMock(...args);
          if (!args[0]?.data?.enrichmentAttemptCount) articleUpdateMock(...args);
          return result;
        },
      },
      articleEnrichmentClaim: {
        findUnique: (...args: any[]) => claimFindUniqueMock(...args),
        deleteMany: (...args: any[]) => claimDeleteManyMock(...args),
        create: (...args: any[]) => claimCreateMock(...args),
      },
      pipelineArtifact: {
        create: (...args: any[]) => artifactCreateMock(...args),
      },
    }));
  });

  it("runs claim release + article update + artifact create atomically", async () => {
    const { persistEnrichmentOutcome } = await import("./enrichment-persist");
    const result = await persistEnrichmentOutcome(makeSuccess(), "run-1", "claim-1");

    expect(result.artifactId).toBe("art-1");
    expect(result.applied).toBe(true);
    expect(result.claimLost).toBe(false);
    expect(claimDeleteManyMock).toHaveBeenCalledWith({
      where: expect.objectContaining({ articleId: 42, pipelineRunId: "run-1", token: "claim-1" }),
    });
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

  it("does not write the row or artifact after a stale worker loses its claim", async () => {
    claimDeleteManyMock.mockResolvedValueOnce({ count: 0 });
    const { persistEnrichmentOutcome } = await import("./enrichment-persist");

    const result = await persistEnrichmentOutcome(makeSuccess(), "run-1", "stale-token");

    expect(result).toEqual({ artifactId: null, applied: false, claimLost: true });
    expect(articleUpdateMock).not.toHaveBeenCalled();
    expect(artifactCreateMock).not.toHaveBeenCalled();
  });
});

describe("claimEnrichmentArticle and recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    claimDeleteManyMock.mockResolvedValue({ count: 0 });
    claimDeleteManyDirectMock.mockResolvedValue({ count: 2 });
    claimFindUniqueMock.mockResolvedValue({
      articleId: 42,
      pipelineRunId: "run-1",
      token: "claim-1",
      attemptNumber: 1,
      expectedStatus: "INGESTED",
      expiresAt: new Date(Date.now() + 60_000),
    });
    claimCreateMock.mockImplementation(async (args: any) => ({
      ...args.data,
      attemptNumber: args.data.attemptNumber,
    }));
    articleUpdateManyMock.mockResolvedValue({ count: 1 });
    articleFindUniqueMock.mockResolvedValue({
      bodyText: "A".repeat(1200),
      title: "Published title",
      canonicalUrl: "https://example.com/a",
    });
    articleFindUniqueMock.mockResolvedValue({ enrichmentAttemptCount: 0, enrichmentStatus: "INGESTED" });
    claimFindUniqueMock.mockImplementation(async (args: any) => ({
      articleId: 42,
      pipelineRunId: "run-1",
      token: args?.where?.token ?? "claim-1",
      attemptNumber: 1,
      expectedStatus: "INGESTED",
      expiresAt: new Date(Date.now() + 60_000),
    }));
    transactionMock.mockImplementation(async (callback: any) => callback({
      article: {
        updateMany: (...args: any[]) => articleUpdateManyMock(...args),
        findUnique: (...args: any[]) => articleFindUniqueMock(...args),
      },
      articleEnrichmentClaim: {
        findUnique: (...args: any[]) => claimFindUniqueMock(...args),
        deleteMany: (...args: any[]) => claimDeleteManyMock(...args),
        create: (...args: any[]) => claimCreateMock(...args),
      },
    }));
  });

  it("allows only one concurrent owner through the unique claim", async () => {
    const { claimEnrichmentArticle } = await import("./enrichment-persist");
    claimCreateMock
      .mockResolvedValueOnce({ articleId: 42, pipelineRunId: "run-1", token: "one", attemptNumber: 1, expectedStatus: "INGESTED", claimedAt: new Date(), expiresAt: new Date(Date.now() + 1000) })
      .mockRejectedValueOnce(Object.assign(new Error("unique claim"), { code: "P2002" }));

    const first = await claimEnrichmentArticle(42, "run-1");
    const second = await claimEnrichmentArticle(42, "run-2");

    expect(first?.articleId).toBe(42);
    expect(second).toBeNull();
    expect(first?.attemptNumber).toBe(1);
    expect(claimCreateMock.mock.calls[0]![0].data).toEqual(expect.objectContaining({
      attemptNumber: 1,
      expectedStatus: "INGESTED",
    }));
  });

  it("returns a harmless claim miss when the Article disappears", async () => {
    const { claimEnrichmentArticle } = await import("./enrichment-persist");
    articleFindUniqueMock.mockResolvedValueOnce(null);

    await expect(claimEnrichmentArticle(42, "run-missing")).resolves.toBeNull();
    expect(claimCreateMock).not.toHaveBeenCalled();
    expect(articleUpdateManyMock).not.toHaveBeenCalled();
  });

  it("does not hide an unrelated database error during claim acquisition", async () => {
    const { claimEnrichmentArticle } = await import("./enrichment-persist");
    articleFindUniqueMock.mockRejectedValueOnce(new Error("database connection lost"));

    await expect(claimEnrichmentArticle(42, "run-db-error")).rejects.toThrow("database connection lost");
    expect(claimCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a stale selection snapshot without incrementing the attempt", async () => {
    const { claimEnrichmentArticle } = await import("./enrichment-persist");
    articleUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    const result = await claimEnrichmentArticle(42, "run-stale", new Date(), undefined, 0, "INGESTED");

    expect(result).toBeNull();
    expect(claimCreateMock).not.toHaveBeenCalled();
    expect(articleUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 42, enrichmentAttemptCount: 0, enrichmentStatus: "INGESTED" },
      data: { enrichmentAttemptCount: { increment: 1 } },
    });
  });

  it("rejects final persistence when the Article CAS no longer matches", async () => {
    const { persistEnrichmentOutcome } = await import("./enrichment-persist");
    articleUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    const result = await persistEnrichmentOutcome(makeSuccess(), "run-1", "claim-1");

    expect(result).toEqual({ artifactId: null, applied: false, claimLost: true });
    expect(artifactCreateMock).not.toHaveBeenCalled();
  });

  it("releases expired claims explicitly and permits a later claim", async () => {
    const { claimEnrichmentArticle, recoverExpiredEnrichmentClaims } = await import("./enrichment-persist");
    const now = new Date("2026-07-31T12:00:00.000Z");

    await expect(recoverExpiredEnrichmentClaims(now)).resolves.toBe(2);
    expect(claimDeleteManyDirectMock).toHaveBeenCalledWith({ where: { expiresAt: { lte: now } } });

    const recovered = await claimEnrichmentArticle(42, "run-recovery", now);
    expect(recovered).not.toBeNull();
    expect(recovered?.pipelineRunId).toBe("run-recovery");
    expect(recovered?.attemptNumber).toBe(1);
  });

  it("rolls back a neutral defer attempt only for the live owned claim", async () => {
    const { releaseEnrichmentClaim } = await import("./enrichment-persist");
    const expiresAt = new Date(Date.now() + 60_000);
    claimFindUniqueMock.mockResolvedValue({
      articleId: 42,
      pipelineRunId: "run-1",
      token: "claim-1",
      attemptNumber: 2,
      expectedStatus: "INGESTED",
      expiresAt,
    });
    articleUpdateManyMock.mockResolvedValue({ count: 1 });
    claimDeleteManyMock.mockResolvedValue({ count: 1 });
    artifactDeleteManyMock.mockResolvedValue({ count: 1 });
    transactionMock.mockImplementation(async (callback: any) => callback({
      article: { updateMany: (...args: any[]) => articleUpdateManyMock(...args) },
      articleEnrichmentClaim: {
        findUnique: (...args: any[]) => claimFindUniqueMock(...args),
        deleteMany: (...args: any[]) => claimDeleteManyMock(...args),
      },
      pipelineArtifact: { deleteMany: (...args: any[]) => artifactDeleteManyMock(...args) },
    }));

    await expect(releaseEnrichmentClaim(42, "run-1", "claim-1", new Date(), {
      rollbackAttempt: true,
      attemptMarkerId: "marker-1",
    })).resolves.toBe(true);
    expect(articleUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 42, enrichmentAttemptCount: 2, enrichmentStatus: "INGESTED" },
      data: { enrichmentAttemptCount: { decrement: 1 } },
    });
    expect(claimDeleteManyMock).toHaveBeenCalledWith({
      where: { articleId: 42, pipelineRunId: "run-1", token: "claim-1", attemptNumber: 2, expiresAt },
    });
    expect(artifactDeleteManyMock).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "marker-1", status: "ATTEMPTED" }),
    });
  });

  it("does not roll back a neutral defer after ownership changed", async () => {
    const { releaseEnrichmentClaim } = await import("./enrichment-persist");
    claimFindUniqueMock.mockResolvedValue(null);
    transactionMock.mockImplementation(async (callback: any) => callback({
      article: { updateMany: (...args: any[]) => articleUpdateManyMock(...args) },
      articleEnrichmentClaim: { findUnique: (...args: any[]) => claimFindUniqueMock(...args) },
      pipelineArtifact: { deleteMany: (...args: any[]) => artifactDeleteManyMock(...args) },
    }));

    await expect(releaseEnrichmentClaim(42, "run-1", "stale", new Date(), {
      rollbackAttempt: true,
    })).resolves.toBe(false);
    expect(articleUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("persistEnrichmentBatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    articleUpdateMock.mockResolvedValue({ id: 0 });
    articleUpdateManyMock.mockResolvedValue({ count: 1 });
    articleFindUniqueMock.mockResolvedValue({
      bodyText: "A".repeat(1200),
      title: "Published title",
      canonicalUrl: "https://example.com/a",
    });
    artifactCreateMock.mockResolvedValue({ id: "" });
    claimFindUniqueMock.mockImplementation(async (args: any) => {
      const token = String(args?.where?.token ?? "claim-42");
      const articleId = Number(token.replace(/^claim-/, "")) || 42;
      return {
        articleId,
        pipelineRunId: "run-1",
        token,
        attemptNumber: 1,
        expectedStatus: "INGESTED",
        expiresAt: new Date(Date.now() + 60_000),
      };
    });
    transactionMock.mockImplementation(async (callback: any) => callback({
      article: {
        findUnique: (...args: any[]) => articleFindUniqueMock(...args),
        update: (...args: any[]) => articleUpdateMock(...args),
        updateMany: (...args: any[]) => {
          const result = articleUpdateManyMock(...args);
          if (!args[0]?.data?.enrichmentAttemptCount) articleUpdateMock(...args);
          return result;
        },
      },
      articleEnrichmentClaim: {
        findUnique: (...args: any[]) => claimFindUniqueMock(...args),
        deleteMany: (...args: any[]) => claimDeleteManyMock(...args),
        create: (...args: any[]) => claimCreateMock(...args),
      },
      pipelineArtifact: { create: (...args: any[]) => artifactCreateMock(...args) },
    }));
    claimDeleteManyMock.mockResolvedValue({ count: 1 });
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

    const result = await persistEnrichmentBatch(
      outcomes,
      "run-1",
      new Map([[42, "claim-42"], [2, "claim-2"], [3, "claim-3"]]),
    );

    expect(result.persisted).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.claimLost).toBe(0);
    expect(result.byKind.SUCCESS).toBe(1);
    expect(result.byKind.SKIPPED).toBe(1);
    expect(result.byKind.HEADLESS_REQUIRED).toBe(1);
    expect(result.artifactIds).toEqual(["art-a", "art-b", "art-c"]);
  });

  it("counts a persist failure without throwing (best-effort batch)", async () => {
    const { persistEnrichmentBatch } = await import("./enrichment-persist");
    articleUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("P2025 record not found"));

    const outcomes: ArticleEnrichmentOutcome[] = [
      makeSuccess(),
      buildSkippedOutcome({ articleId: 99, provenance: baseProvenance, reasonCode: "ALREADY_ENRICHED" }),
    ];

    const result = await persistEnrichmentBatch(
      outcomes,
      "run-1",
      new Map([[42, "claim-42"], [99, "claim-99"]]),
    );

    expect(result.persisted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.claimLost).toBe(0);
    expect(result.byKind.SUCCESS).toBe(1);
    expect(result.byKind.SKIPPED).toBe(0);
  });

  it("keeps programming failures batch-fatal", async () => {
    const { persistEnrichmentBatch } = await import("./enrichment-persist");
    claimFindUniqueMock.mockRejectedValueOnce(new TypeError("invalid persistence adapter"));

    await expect(persistEnrichmentBatch(
      [makeSuccess()],
      "run-1",
      new Map([[42, "claim-42"]]),
    )).rejects.toThrow("invalid persistence adapter");
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
          claimLost: 0,
          byKind: {
            SUCCESS: 1,
            SKIPPED: 1,
            RETRYABLE_FAILURE: 0,
            HEADLESS_REQUIRED: 0,
            PAYWALL_BLOCKED: 0,
            CANONICAL_MISMATCH: 0,
            LOW_CONTENT_QUALITY: 0,
            UNSUPPORTED_STRUCTURE: 0,
            HTTP_ACCESS_BLOCKED: 0,
            INTERSTITIAL_OR_CHALLENGE: 0,
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

  it("preserves unknown optional provenance fields as null", async () => {
    const { readEnrichmentSummary } = await import("./enrichment-persist");
    const summary = readEnrichmentSummary({
      kind: "SUCCESS",
      provenance: { sourceId: "src-1" },
    });
    expect(summary!.method).toBe("none");
    expect(summary!.confidence).toBe(0);
    expect(summary!.rejectionCode).toBeNull();
    expect(summary!.provenance.categoryId).toBeNull();
    expect(summary!.provenance.feedOrigin).toBeNull();
  });
});
