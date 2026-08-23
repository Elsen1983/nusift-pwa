import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleEnrichmentOutcome, ArticleUpstreamProvenance } from "./enrichment";
import { AGENT3_EXTRACTOR_VERSION } from "./enrichment";
import { StageBatchTelemetryTracker } from "./stage-telemetry";
import { buildAgent3BatchDispositions, collectAgent3HttpEvidence } from "./enrichment-runtime";

// ─── Mock prisma ────────────────────────────────────────────────────────────
const articleFindManyMock = vi.fn();
const articleUpdateMock = vi.fn();
const articleUpdateManyMock = vi.fn();
const articleFindUniqueMock = vi.fn();
const articleCountMock = vi.fn();
const artifactCreateMock = vi.fn();
const artifactDeleteManyMock = vi.fn();
const claimCreateMock = vi.fn();
const claimDeleteManyMock = vi.fn();
const claimFindUniqueMock = vi.fn();
const claimRows = new Map<string, Record<string, unknown>>();
const claimDeleteManyDirectMock = vi.fn();
const claimCountMock = vi.fn();
const transactionMock = vi.fn();
const artifactFindManyMock = vi.fn();
const artifactFindFirstMock = vi.fn();
const pipelineRunCreateMock = vi.fn();
const pipelineRunUpdateMock = vi.fn();
const pipelineRunFindFirstMock = vi.fn();
const logAgentScanMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: (...args: any[]) => transactionMock(...args),
    article: {
      findMany: (...args: any[]) => articleFindManyMock(...args),
      findUnique: (...args: any[]) => articleFindUniqueMock(...args),
      update: (...args: any[]) => articleUpdateMock(...args),
      updateMany: (...args: any[]) => articleUpdateManyMock(...args),
      count: (...args: any[]) => articleCountMock(...args),
    },
    articleEnrichmentClaim: {
      deleteMany: (...args: any[]) => claimDeleteManyDirectMock(...args),
      count: (...args: any[]) => claimCountMock(...args),
    },
    pipelineArtifact: {
      create: (...args: any[]) => artifactCreateMock(...args),
      findMany: (...args: any[]) => artifactFindManyMock(...args),
      findFirst: (...args: any[]) => artifactFindFirstMock(...args),
      deleteMany: (...args: any[]) => artifactDeleteManyMock(...args),
    },
    pipelineRun: {
      create: (...args: any[]) => pipelineRunCreateMock(...args),
      update: (...args: any[]) => pipelineRunUpdateMock(...args),
      findFirst: (...args: any[]) => pipelineRunFindFirstMock(...args),
    },
  },
}));

// logAgentScan is imported from ./log which imports prisma; mock it to avoid
// real DB writes and to assert start/finish logging.
vi.mock("./log", () => ({
  logAgentScan: (...args: any[]) => logAgentScanMock(...args),
}));

// createPipelineRun lives in ./artifacts which imports prisma; mock the module
// so we control the run id. runEnrichmentBatch no longer calls finalizePipelineRun
// (it does a single prisma.pipelineRun.update captured by pipelineRunUpdateMock),
// but the mock still provides a stub so the import resolves.
vi.mock("./artifacts", () => ({
  createPipelineRun: (...args: any[]) => pipelineRunCreateMock(...args),
}));

// Phase 2: mock the real article content extractor so runEnrichmentBatch
// tests don't need actual HTTP calls. The mock returns a SUCCESS outcome
// for articles with a URL and a SKIPPED outcome for articles without one.
const extractArticleContentFromUrlMock = vi.fn();
vi.mock("./article-content-extractor", () => ({
  extractArticleContentFromUrl: (...args: any[]) => extractArticleContentFromUrlMock(...args),
}));

// Phase 3: mock the browser fallback extractor so runEnrichmentBatch
// tests don't need actual Playwright/browser calls.
const extractArticleContentWithBrowserMock = vi.fn();
vi.mock("./article-content-browser-extractor", () => ({
  extractArticleContentWithBrowser: (...args: any[]) => extractArticleContentWithBrowserMock(...args),
  isBrowserFallbackEligibleForFailure: (...args: any[]) => {
    // Inline eligibility logic matching the real implementation
    const [result] = args;
    const { rejectedReason, statusCode, qualitySignals } = result;
    // Mirror the production hard boundary: any static HTTP 429 is no-browser.
    if (statusCode === 429) return false;
    const signals: string[] = qualitySignals ?? [];
    const browserUsefulSignals = new Set([
      "browser_navigation_failed", "browser_http_403", "browser_http_429",
      "browser_rate_limited", "browser_error", "fetch_timeout",
      "connection_reset", "bot_blocked", "static_fetch_blocked",
    ]);
    switch (rejectedReason) {
      case "http_error": return statusCode === 403;
      case "no_article_text": case "empty_html": case "too_short":
      case "interstitial_or_challenge": return true;
      case "fetch_failed": {
        if (signals.some((s: string) => browserUsefulSignals.has(s))) return true;
        const detailLower = (result.detail ?? "").toLowerCase();
        if (detailLower.includes("timeout") || detailLower.includes("403") ||
            detailLower.includes("connection reset") ||
            detailLower.includes("econnreset") || detailLower.includes("navigation failed"))
          return true;
        return false;
      }
      default: return false;
    }
  },
  isBrowserFallbackEligible: (rejectedReason: string, statusCode: number | null) => {
    switch (rejectedReason) {
      case "http_error": return statusCode === 403;
      case "no_article_text": case "empty_html": case "too_short":
      case "interstitial_or_challenge": return true;
      case "fetch_failed": return false;
      default: return false;
    }
  },
}));

function configureAgent3PrismaMocks(): void {
  claimRows.clear();
  claimDeleteManyDirectMock.mockResolvedValue({ count: 0 });
  claimCountMock.mockResolvedValue(0);
  artifactDeleteManyMock.mockResolvedValue({ count: 1 });
  claimDeleteManyMock.mockImplementation(async (args: any) => {
    const token = args?.where?.token as string | undefined;
    if (!token) return { count: 0 };
    return { count: claimRows.delete(token) ? 1 : 0 };
  });
  claimCreateMock.mockImplementation(async (args: any) => {
    const row = { ...args.data };
    claimRows.set(row.token as string, row);
    return row;
  });
  claimFindUniqueMock.mockImplementation(async (args: any) => {
    const token = args?.where?.token as string | undefined;
    return token ? claimRows.get(token) ?? null : null;
  });
  articleUpdateManyMock.mockResolvedValue({ count: 1 });
  articleFindUniqueMock.mockResolvedValue({ enrichmentAttemptCount: 1 });
  transactionMock.mockImplementation(async (callback: any) => {
    const articleUpdateCallsBefore = articleUpdateMock.mock.calls.length;
    const artifactCreateCallsBefore = artifactCreateMock.mock.calls.length;
    try {
      return await callback({
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
          deleteMany: (...args: any[]) => artifactDeleteManyMock(...args),
        },
      });
    } catch (error) {
      // Model the rollback boundary of the real Prisma transaction in the
      // runtime mock: an artifact failure cannot leave the Article update as a
      // durable write.
      articleUpdateMock.mock.calls.splice(articleUpdateCallsBefore);
      artifactCreateMock.mock.calls.splice(artifactCreateCallsBefore);
      throw error;
    }
  });
}

const asObj = (v: unknown) => v as Record<string, unknown>;

const makeArticle = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  sourceId: "src-1",
  categoryId: "cat-1" as string | null,
  canonicalUrl: "https://example.com/a" as string | null,
  sourceUrl: "https://example.com" as string | null,
  title: "Test Article",
  bodyText: "Some body text" as string | null,
  publishedAt: new Date("2026-07-15T10:00:00.000Z") as Date | null,
  isPaywall: false,
  createdAt: new Date("2026-07-15T08:00:00.000Z"),
  enrichmentStatus: "INGESTED",
  enrichmentAttemptCount: 0,
  ...overrides,
});

describe("Agent 3 selected-item accounting", () => {
  const emptyByKind = () => ({
    SUCCESS: 0, SKIPPED: 0, RETRYABLE_FAILURE: 0, HEADLESS_REQUIRED: 0,
    PAYWALL_BLOCKED: 0, CANONICAL_MISMATCH: 0, LOW_CONTENT_QUALITY: 0,
    UNSUPPORTED_STRUCTURE: 0, HTTP_ACCESS_BLOCKED: 0, INTERSTITIAL_OR_CHALLENGE: 0,
  });

  it("reconciles mutually exclusive dispositions exactly", () => {
    const byKind = emptyByKind();
    byKind.SUCCESS = 1;
    byKind.RETRYABLE_FAILURE = 1;
    expect(buildAgent3BatchDispositions({
      selectedCount: 6,
      persist: { persisted: 2, failed: 0, claimLost: 1, byKind, artifactIds: [] },
      interstitial: { deferred: 0, quarantined: 0, readyRetry: 0, nonRetryable: 0 },
      claimSkipped: 1,
      governorDeferred: 1,
      sourceCooldownSkipped: 1,
    })).toEqual({
      succeeded: 1,
      failedRetryable: 1,
      failedPermanent: 0,
      skipped: 2,
      deferred: 1,
      quarantined: 0,
      claimLost: 1,
      persistenceFailed: 0,
    });
  });

  it("fails loudly when selected dispositions do not reconcile", () => {
    expect(() => buildAgent3BatchDispositions({
      selectedCount: 2,
      persist: { persisted: 1, failed: 0, claimLost: 0, byKind: { ...emptyByKind(), SUCCESS: 1 }, artifactIds: [] },
      interstitial: { deferred: 0, quarantined: 0, readyRetry: 0, nonRetryable: 0 },
      claimSkipped: 0,
      governorDeferred: 0,
      sourceCooldownSkipped: 0,
    })).toThrow("disposition invariant failed");
  });
});

/** Build a mock rss_candidates artifact payload from Agent 1. */
const makeIngestArtifactPayload = (candidates: Array<Record<string, unknown>> = []) => ({
  sourceId: "src-1",
  categoryId: "cat-1",
  feedUrl: "https://example.com/feed.xml",
  feedFormat: "rss",
  candidates,
});

/** Build a mock ingest candidate matching makeArticle(). */
const makeIngestCandidate = (overrides: Record<string, unknown> = {}) => ({
  canonicalUrl: "https://example.com/a",
  categoryId: "cat-1",
  title: "Test Article",
  provenance: {
    origin: "atom",
    feedUrl: "https://example.com/atom.xml",
    discoveredFromCategoryFeed: true,
    fetchedAt: "2026-07-15T07:55:00.000Z",
  },
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildArticleProvenance", () => {
  it("builds upstream provenance from an Article row preserving source/category", async () => {
    const { buildArticleProvenance } = await import("./enrichment-runtime");
    const provenance = buildArticleProvenance(makeArticle());

    expect(provenance.sourceId).toBe("src-1");
    expect(provenance.categoryId).toBe("cat-1");
    expect(provenance.feedOrigin).toBeNull();
    expect(provenance.discoveredFromCategoryFeed).toBeNull();
    expect(provenance.arrivedViaHardCaseRerun).toBeNull();
    expect(provenance.ingestedAt).toBe("2026-07-15T08:00:00.000Z");
  });

  it("sets discoveredFromCategoryFeed=false when categoryId is null", async () => {
    const { buildArticleProvenance } = await import("./enrichment-runtime");
    const provenance = buildArticleProvenance(makeArticle({ categoryId: null }));
    expect(provenance.discoveredFromCategoryFeed).toBeNull();
    expect(provenance.categoryId).toBeNull();
  });
});

describe("buildIsPaywallProvenance", () => {
  it("clears an early paywall hint after substantial accessible body extraction", async () => {
    const { buildIsPaywallProvenance } = await import("./enrichment-runtime");
    const result = buildIsPaywallProvenance(true, null, `${"Accessible article paragraph. ".repeat(30)}\n\n${"Second paragraph. ".repeat(20)}`);
    expect(result?.chosenValue).toBe(false);
    expect(result?.chosenFrom).toBe("dom");
  });

  it("does not clear a paywall hint from a short preview", async () => {
    const { buildIsPaywallProvenance } = await import("./enrichment-runtime");
    expect(buildIsPaywallProvenance(true, null, "Short preview only.")).toBeNull();
  });

  it("preserves a confirmed extractor paywall decision", async () => {
    const { buildIsPaywallProvenance } = await import("./enrichment-runtime");
    const result = buildIsPaywallProvenance(false, true, "Preview text");
    expect(result?.chosenValue).toBe(true);
    expect(result?.chosenFrom).toBe("dom");
  });
});

describe("stubExtractArticle", () => {
  it("produces a SUCCESS outcome with unchanged field provenance for a normal article", async () => {
    const { stubExtractArticle } = await import("./enrichment-runtime");
    const outcome = stubExtractArticle(makeArticle());

    expect(outcome.kind).toBe("SUCCESS");
    expect(outcome.articleId).toBe(42);
    expect(outcome.articleUrl).toBe("https://example.com/a");
    expect(outcome.method.method).toBe("http-meta");
    expect(outcome.method.detail).toContain("stub");
    expect(outcome.quality.confidence).toBe(0.5);
    expect(outcome.fields.title?.chosenFrom).toBe("unchanged");
    expect(outcome.fields.title?.chosenValue).toBe("Test Article");
    expect(outcome.fields.isPaywall?.chosenValue).toBe(false);
    // provenance preserved
    expect(outcome.provenance.sourceId).toBe("src-1");
    // no destructive override
    expect(outcome.rejection).toBeNull();
  });

  it("produces a SKIPPED outcome when the article has no URL", async () => {
    const { stubExtractArticle } = await import("./enrichment-runtime");
    const outcome = stubExtractArticle(
      makeArticle({ canonicalUrl: null, sourceUrl: null }),
    );

    expect(outcome.kind).toBe("SKIPPED");
    expect(outcome.rejection?.code).toBe("NO_ARTICLE_URL");
    expect(outcome.articleUrl).toBeNull();
  });

  it("produces a SKIPPED outcome when the article is already ENRICHED (defensive)", async () => {
    const { stubExtractArticle } = await import("./enrichment-runtime");
    const outcome = stubExtractArticle(
      makeArticle({ enrichmentStatus: "ENRICHED" }),
    );

    expect(outcome.kind).toBe("SKIPPED");
    expect(outcome.rejection?.code).toBe("ALREADY_ENRICHED");
  });

  it("is JSON-serializable and round-trips through validateEnrichmentOutcome", async () => {
    const { stubExtractArticle } = await import("./enrichment-runtime");
    const { validateEnrichmentOutcome, serializeEnrichmentPayload } = await import("./enrichment");
    const outcome = stubExtractArticle(makeArticle());

    const parsed = JSON.parse(JSON.stringify(serializeEnrichmentPayload(outcome)));
    const { valid, outcome: roundTripped } = validateEnrichmentOutcome(parsed);

    expect(valid).toBe(true);
    expect(roundTripped!.kind).toBe("SUCCESS");
    expect(roundTripped!.provenance.sourceId).toBe("src-1");
  });
});

describe("selectEnrichmentEligibleArticles", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configureAgent3PrismaMocks();
    articleFindManyMock.mockResolvedValue([makeArticle()]);
  });

  it("queries with the freshness cutoff + eligible statuses + capped take", async () => {
    const { selectEnrichmentEligibleArticles, MAX_ARTICLES_PER_RUN } = await import("./enrichment-runtime");
    const now = new Date("2026-07-16T12:00:00.000Z");
    const articles = await selectEnrichmentEligibleArticles(now);

    expect(articles).toHaveLength(1);
    expect(articleFindManyMock).toHaveBeenCalledTimes(3);
    const args = articleFindManyMock.mock.calls[1]![0];

    // cutoff is 7 days before now
    const cutoff = args.where.date.gte as Date;
    expect(cutoff.getTime()).toBe(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    );

    // NEW is queried before retry tiers.
    expect(args.where.enrichmentStatus).toBe("INGESTED");
    expect(args.take).toBe(MAX_ARTICLES_PER_RUN * 3);
  });

  it("clamps a custom limit to MAX_ARTICLES_PER_RUN", async () => {
    const { selectEnrichmentEligibleArticles, MAX_ARTICLES_PER_RUN } = await import("./enrichment-runtime");
    await selectEnrichmentEligibleArticles(new Date(), 9999);
    const args = articleFindManyMock.mock.calls[1]![0];
    expect(args.take).toBe(MAX_ARTICLES_PER_RUN * 3);
  });
});

describe("recoverUpstreamProvenanceBatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configureAgent3PrismaMocks();
  });

  it("recovers precise provenance when Agent 1 ingest artifacts exist", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        id: "ingest-artifact-1",
        pipelineRunId: "ingest-run-1",
        sourceId: "src-1",
        payload: makeIngestArtifactPayload([
          makeIngestCandidate({ canonicalUrl: "https://example.com/a" }),
        ]),
      },
    ]);

    const articles = [makeArticle()];
    const result = await recoverUpstreamProvenanceBatch(articles);
    const provenance = result.get(42)!;

    // Recovered from artifact, not the conservative default
    expect(provenance.feedOrigin).toBe("atom");
    expect(provenance.feedUrl).toBe("https://example.com/atom.xml");
    expect(provenance.discoveredFromCategoryFeed).toBe(true);
    expect(provenance.sourceId).toBe("src-1");
    expect(provenance.categoryId).toBe("cat-1");
    expect(provenance.ingestedAt).toBe("2026-07-15T08:00:00.000Z");
    // The artifact proves origin/feed URL, but not hard-case rerun lineage.
    expect(provenance.arrivedViaHardCaseRerun).toBeNull();
    expect(provenance.ingestArtifactId).toBe("ingest-artifact-1");
    expect(provenance.ingestPipelineRunId).toBe("ingest-run-1");
  });

  it("searches through multiple artifacts for the matching candidate", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    // Most recent artifact does NOT contain the article; older one does.
    artifactFindManyMock.mockResolvedValue([
      {
        sourceId: "src-1",
        payload: makeIngestArtifactPayload([
          { canonicalUrl: "https://example.com/other-article" },
        ]),
      },
      {
        sourceId: "src-1",
        payload: makeIngestArtifactPayload([
          makeIngestCandidate({ canonicalUrl: "https://example.com/a" }),
        ]),
      },
    ]);

    const result = await recoverUpstreamProvenanceBatch([makeArticle()]);
    const provenance = result.get(42)!;
    expect(provenance.feedOrigin).toBe("atom");
  });

  it("recovers Agent 2-only access evidence from article_discovery_candidates without rss_candidates", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        id: "a2-artifact-1",
        pipelineRunId: "a2-run-1",
        sourceId: "src-1",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-16T10:00:00.000Z"),
        payload: {
          candidates: [{
            sourceId: "src-1",
            categoryId: "cat-1",
            sourceUrl: "https://example.com/category?utm_source=feed",
            canonicalUrl: "https://example.com/a?utm_medium=social#fragment",
            provenance: { origin: "web_discovery", feedUrl: null, discoveredFromCategoryFeed: true },
            accessEvidence: {
              classification: "METERED_OR_DECLARED",
              sourceStage: "agent2",
              evidenceCodes: ["jsonld_declared_paywall", ...Array.from({ length: 30 }, (_, i) => `code-${i}`)],
              contradictingEvidenceCodes: ["full_body_visible"],
            },
          }],
        },
      },
    ]);

    const provenance = (await recoverUpstreamProvenanceBatch([makeArticle()])).get(42)!;
    expect(provenance.feedOrigin).toBe("web_discovery");
    expect(provenance.ingestArtifactId).toBe("a2-artifact-1");
    expect(provenance.earlyAccessEvidence).toMatchObject({
      classification: "METERED_OR_DECLARED",
      sourceStage: "agent2",
      contradictingEvidenceCodes: ["full_body_visible"],
    });
    expect(provenance.earlyAccessEvidence!.evidenceCodes).toHaveLength(12);
    expect(provenance.earlyAccessRecovery).toMatchObject({
      status: "MATCHED",
      matchingArtifactType: "article_discovery_candidates",
      candidateMatchType: "canonical",
      matchingArtifactId: "a2-artifact-1",
    });
    expect(artifactFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ artifactType: { in: ["rss_candidates", "article_discovery_candidates"] } }),
      take: 201,
    }));
  });

  it("ignores unrelated candidates and malformed/unknown access evidence conservatively", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        id: "a2-artifact-malformed",
        pipelineRunId: "a2-run-malformed",
        sourceId: "src-1",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-16T10:00:00.000Z"),
        payload: {
          candidates: [
            { sourceId: "src-1", canonicalUrl: "https://example.com/other", accessEvidence: { classification: "PAYWALL_BLOCKED", sourceStage: "agent2" } },
            { sourceId: "src-1", canonicalUrl: "https://example.com/a", accessEvidence: { classification: "PAYWALL_BLOCKED", sourceStage: "crawler" } },
          ],
        },
      },
    ]);

    const provenance = (await recoverUpstreamProvenanceBatch([makeArticle()])).get(42)!;
    expect(provenance.earlyAccessEvidence).toBeNull();
    expect(provenance.earlyAccessRecovery?.status).toBe("MATCHED");
  });

  it("prefers the newest exact match, while an unrelated newer artifact cannot hide an older exact match", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        id: "new-unrelated",
        pipelineRunId: "a2-run-new",
        sourceId: "src-1",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-18T10:00:00.000Z"),
        payload: { candidates: [{ canonicalUrl: "https://example.com/other", accessEvidence: { classification: "PAYWALL_BLOCKED", sourceStage: "agent2" } }] },
      },
      {
        id: "old-exact",
        pipelineRunId: "a2-run-old",
        sourceId: "src-1",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-17T10:00:00.000Z"),
        payload: { candidates: [{ canonicalUrl: "https://example.com/a", accessEvidence: { classification: "METERED_OR_DECLARED", sourceStage: "agent2" } }] },
      },
    ]);
    const provenance = (await recoverUpstreamProvenanceBatch([makeArticle()])).get(42)!;
    expect(provenance.ingestArtifactId).toBe("old-exact");
    expect(provenance.earlyAccessEvidence?.classification).toBe("METERED_OR_DECLARED");
  });

  it("uses a stable artifact id tie-breaker for equal timestamps", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        id: "artifact-a",
        sourceId: "src-1",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-18T10:00:00.000Z"),
        payload: { candidates: [{ canonicalUrl: "https://example.com/a", accessEvidence: { classification: "ACCESSIBLE", sourceStage: "agent2" } }] },
      },
      {
        id: "artifact-z",
        sourceId: "src-1",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-18T10:00:00.000Z"),
        payload: { candidates: [{ canonicalUrl: "https://example.com/a", accessEvidence: { classification: "PAYWALL_BLOCKED", sourceStage: "agent2" } }] },
      },
    ]);
    const provenance = (await recoverUpstreamProvenanceBatch([makeArticle()])).get(42)!;
    expect(provenance.ingestArtifactId).toBe("artifact-z");
    expect(provenance.earlyAccessEvidence?.classification).toBe("PAYWALL_BLOCKED");
  });

  it("does not let a newer exact candidate with malformed access evidence hide an older valid exact match", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        id: "new-malformed",
        sourceId: "src-1",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-19T10:00:00.000Z"),
        payload: {
          candidates: [{
            canonicalUrl: "https://example.com/a?utm_source=newer#fragment",
            accessEvidence: { classification: "PAYWALL_BLOCKED", sourceStage: "unknown-stage", evidenceCodes: ["raw <html>"] },
          }],
        },
      },
      {
        id: "old-valid",
        sourceId: "src-1",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-18T10:00:00.000Z"),
        payload: {
          candidates: [{
            canonicalUrl: "https://example.com/a",
            accessEvidence: { classification: "METERED_OR_DECLARED", sourceStage: "agent2", evidenceCodes: ["declared_access"] },
          }],
        },
      },
    ]);

    const provenance = (await recoverUpstreamProvenanceBatch([makeArticle()])).get(42)!;
    expect(provenance.ingestArtifactId).toBe("old-valid");
    expect(provenance.earlyAccessEvidence).toMatchObject({
      classification: "METERED_OR_DECLARED",
      sourceStage: "agent2",
      evidenceCodes: ["declared_access"],
    });
  });

  it("uses a matching candidate sourceUrl when canonical identity is absent", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([{
      id: "source-url-legacy",
      sourceId: "src-1",
      artifactType: "rss_candidates",
      createdAt: new Date("2026-07-18T10:00:00.000Z"),
      payload: {
        candidates: [{
          sourceUrl: "https://example.com/a?utm_medium=feed#top",
          accessEvidence: { classification: "ACCESSIBLE", sourceStage: "agent1", evidenceCodes: ["feed_hint"] },
        }],
      },
    }]);

    const provenance = (await recoverUpstreamProvenanceBatch([makeArticle({ canonicalUrl: null, sourceUrl: "https://example.com/a" })])).get(42)!;
    expect(provenance.earlyAccessRecovery?.candidateMatchType).toBe("source");
    expect(provenance.earlyAccessEvidence?.sourceStage).toBe("agent1");
  });

  it("marks a bounded candidate window as truncated instead of loading unbounded history", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([{
      id: "large-artifact",
      sourceId: "src-1",
      artifactType: "article_discovery_candidates",
      createdAt: new Date("2026-07-18T10:00:00.000Z"),
      payload: { candidates: Array.from({ length: 101 }, (_, i) => ({ canonicalUrl: `https://example.com/unrelated-${i}` })) },
    }]);
    const provenance = (await recoverUpstreamProvenanceBatch([makeArticle()])).get(42)!;
    expect(provenance.earlyAccessRecovery?.status).toBe("WINDOW_TRUNCATED");
    expect(provenance.earlyAccessRecoveryWindowTruncated).toBe(true);
  });

  it("uses independent per-source windows so a noisy source cannot starve another source", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    const noisyArtifacts = Array.from({ length: 201 }, (_, index) => ({
      id: `source-a-${String(index).padStart(3, "0")}`,
      sourceId: "src-a",
      artifactType: "article_discovery_candidates",
      createdAt: new Date(2026, 6, 20, 12, 0, index),
      payload: { candidates: [{ canonicalUrl: `https://a.example.com/unrelated-${index}` }] },
    }));
    const sourceBArtifact = {
      id: "source-b-match",
      sourceId: "src-b",
      artifactType: "article_discovery_candidates",
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
      payload: {
        candidates: [{
          sourceId: "src-b",
          canonicalUrl: "https://b.example.com/story",
          accessEvidence: {
            classification: "METERED_OR_DECLARED",
            sourceStage: "agent2",
            evidenceCodes: ["source_b_evidence"],
            contradictingEvidenceCodes: [],
          },
        }],
      },
    };
    artifactFindManyMock.mockImplementation(async (args: any) =>
      args?.where?.sourceId === "src-a" ? noisyArtifacts : [sourceBArtifact],
    );

    const result = await recoverUpstreamProvenanceBatch([
      makeArticle({ id: 101, sourceId: "src-a", canonicalUrl: "https://a.example.com/story" }),
      makeArticle({ id: 102, sourceId: "src-b", canonicalUrl: "https://b.example.com/story" }),
    ]);
    const sourceA = result.get(101)!;
    const sourceB = result.get(102)!;

    expect(sourceA.earlyAccessRecovery).toMatchObject({
      status: "WINDOW_TRUNCATED",
      artifactsScanned: 200,
      windowTruncated: true,
    });
    expect(sourceB.earlyAccessRecovery).toMatchObject({
      status: "MATCHED",
      artifactsScanned: 1,
      windowTruncated: false,
      matchingArtifactId: "source-b-match",
    });
    expect(sourceB.earlyAccessEvidence?.sourceStage).toBe("agent2");
    expect(artifactFindManyMock).toHaveBeenCalledTimes(2);
    for (const call of artifactFindManyMock.mock.calls) {
      expect(call[0].take).toBe(201);
      expect(typeof call[0].where.sourceId).toBe("string");
    }
  });

  it("isolates source-local QUERY_FAILED diagnostics while preserving successful sources", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockImplementation(async (args: any) => {
      if (args?.where?.sourceId === "src-a") throw new Error("source-a query failed");
      return [{
        id: "source-b-success",
        sourceId: "src-b",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        payload: {
          candidates: [{
            sourceId: "src-b",
            canonicalUrl: "https://b.example.com/story",
            accessEvidence: { classification: "ACCESSIBLE", sourceStage: "agent2", evidenceCodes: ["b_success"], contradictingEvidenceCodes: [] },
          }],
        },
      }];
    });

    const result = await recoverUpstreamProvenanceBatch([
      makeArticle({ id: 201, sourceId: "src-a" }),
      makeArticle({ id: 202, sourceId: "src-b", canonicalUrl: "https://b.example.com/story" }),
    ]);

    expect(result.get(201)!.earlyAccessRecovery?.status).toBe("QUERY_FAILED");
    expect(result.get(201)!.earlyAccessEvidence).toBeUndefined();
    expect(result.get(202)!.earlyAccessRecovery?.status).toBe("MATCHED");
    expect(result.get(202)!.earlyAccessEvidence).toMatchObject({ sourceStage: "agent2", evidenceCodes: ["b_success"] });
  });

  it("returns QUERY_FAILED for every article when every source query fails", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockRejectedValue(new Error("all source queries failed"));

    const result = await recoverUpstreamProvenanceBatch([
      makeArticle({ id: 211, sourceId: "src-a" }),
      makeArticle({ id: 212, sourceId: "src-b", canonicalUrl: "https://b.example.com/story" }),
    ]);

    expect(result.get(211)!.earlyAccessRecovery?.status).toBe("QUERY_FAILED");
    expect(result.get(212)!.earlyAccessRecovery?.status).toBe("QUERY_FAILED");
  });

  it("lets newer valid sourceUrl evidence beat older valid canonical evidence", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        id: "new-source-url",
        sourceId: "src-1",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        payload: {
          candidates: [{
            sourceUrl: "https://example.com/a?utm_source=newer",
            accessEvidence: { classification: "ACCESSIBLE", sourceStage: "agent2", evidenceCodes: ["new_source"], contradictingEvidenceCodes: [] },
          }],
        },
      },
      {
        id: "old-canonical",
        sourceId: "src-1",
        artifactType: "rss_candidates",
        createdAt: new Date("2026-07-19T10:00:00.000Z"),
        payload: {
          candidates: [{
            canonicalUrl: "https://example.com/a",
            accessEvidence: { classification: "PAYWALL_BLOCKED", sourceStage: "agent1", evidenceCodes: ["old_canonical"], contradictingEvidenceCodes: [] },
          }],
        },
      },
    ]);

    const provenance = (await recoverUpstreamProvenanceBatch([makeArticle()])).get(42)!;
    expect(provenance.ingestArtifactId).toBe("new-source-url");
    expect(provenance.earlyAccessEvidence).toMatchObject({
      classification: "ACCESSIBLE",
      sourceStage: "agent2",
      evidenceCodes: ["new_source"],
    });
    expect(provenance.earlyAccessRecovery?.candidateMatchType).toBe("source");
  });

  it("uses canonical identity only as the equal-timestamp tie-break, regardless of DB return order", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    const canonical = {
      id: "canonical-id",
      sourceId: "src-1",
      artifactType: "rss_candidates",
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      payload: { candidates: [{ canonicalUrl: "https://example.com/a", accessEvidence: { classification: "PAYWALL_BLOCKED", sourceStage: "agent1", evidenceCodes: ["canonical"], contradictingEvidenceCodes: [] } }] },
    };
    const source = {
      id: "source-id",
      sourceId: "src-1",
      artifactType: "article_discovery_candidates",
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      payload: { candidates: [{ sourceUrl: "https://example.com/a", accessEvidence: { classification: "ACCESSIBLE", sourceStage: "agent2", evidenceCodes: ["source"], contradictingEvidenceCodes: [] } }] },
    };

    artifactFindManyMock.mockResolvedValue([source, canonical]);
    const first = (await recoverUpstreamProvenanceBatch([makeArticle()])).get(42)!;
    artifactFindManyMock.mockReset();
    artifactFindManyMock.mockResolvedValue([canonical, source]);
    const second = (await recoverUpstreamProvenanceBatch([makeArticle()])).get(42)!;

    expect(first.ingestArtifactId).toBe("canonical-id");
    expect(second.ingestArtifactId).toBe("canonical-id");
    expect(first.earlyAccessEvidence?.evidenceCodes).toEqual(["canonical"]);
    expect(second.earlyAccessEvidence?.evidenceCodes).toEqual(["canonical"]);
  });

  it("falls back to conservative defaults when no ingest artifacts exist", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([]);

    const result = await recoverUpstreamProvenanceBatch([makeArticle()]);
    const provenance = result.get(42)!;

    // No matching evidence means origin and route are unknown.
    expect(provenance.feedOrigin).toBeNull();
    expect(provenance.feedUrl).toBeNull();
    expect(provenance.discoveredFromCategoryFeed).toBeNull();
    expect(provenance.arrivedViaHardCaseRerun).toBeNull();
  });

  it("falls back when no candidate matches the article canonicalUrl", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        sourceId: "src-1",
        payload: makeIngestArtifactPayload([
          { canonicalUrl: "https://example.com/different-article" },
        ]),
      },
    ]);

    const result = await recoverUpstreamProvenanceBatch([makeArticle()]);
    const provenance = result.get(42)!;
    expect(provenance.feedOrigin).toBeNull();
  });

  it("falls back when candidate has no provenance object", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        sourceId: "src-1",
        payload: makeIngestArtifactPayload([
          { canonicalUrl: "https://example.com/a" },
        ]),
      },
    ]);

    const result = await recoverUpstreamProvenanceBatch([makeArticle()]);
    const provenance = result.get(42)!;
    expect(provenance.feedOrigin).toBeNull(); // no provenance on candidate
  });

  it("falls back for articles with no canonicalUrl or sourceUrl", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        sourceId: "src-1",
        payload: makeIngestArtifactPayload([makeIngestCandidate()]),
      },
    ]);

    const result = await recoverUpstreamProvenanceBatch([
      makeArticle({ canonicalUrl: null, sourceUrl: null }),
    ]);
    const provenance = result.get(42)!;
    expect(provenance.feedOrigin).toBeNull(); // no URL to match
  });

  it("falls back when the DB query fails", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockRejectedValue(new Error("DB connection failed"));

    const result = await recoverUpstreamProvenanceBatch([makeArticle()]);
    const provenance = result.get(42)!;
    expect(provenance.feedOrigin).toBeNull(); // explicit unknown fallback
    expect(provenance.sourceId).toBe("src-1");
  });

  it("returns empty map for empty input", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    const result = await recoverUpstreamProvenanceBatch([]);
    expect(result.size).toBe(0);
    expect(artifactFindManyMock).not.toHaveBeenCalled();
  });

  it("does not invent an origin for unknown feedOrigin values", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        sourceId: "src-1",
        payload: makeIngestArtifactPayload([
          makeIngestCandidate({
            provenance: {
              origin: "xml",
              feedUrl: "https://example.com/feed.xml",
              discoveredFromCategoryFeed: false,
            },
          }),
        ]),
      },
    ]);

    const result = await recoverUpstreamProvenanceBatch([makeArticle()]);
    expect(result.get(42)!.feedOrigin).toBeNull(); // "xml" is not valid evidence
  });

  it("recovers rss feedOrigin correctly", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        sourceId: "src-1",
        payload: makeIngestArtifactPayload([
          makeIngestCandidate({
            provenance: {
              origin: "rss",
              feedUrl: "https://example.com/rss.xml",
              discoveredFromCategoryFeed: false,
            },
          }),
        ]),
      },
    ]);

    const result = await recoverUpstreamProvenanceBatch([makeArticle()]);
    expect(result.get(42)!.feedOrigin).toBe("rss");
    expect(result.get(42)!.feedUrl).toBe("https://example.com/rss.xml");
    expect(result.get(42)!.discoveredFromCategoryFeed).toBe(false);
  });

  it("handles multiple articles from different sources", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        sourceId: "src-1",
        payload: makeIngestArtifactPayload([
          makeIngestCandidate({ provenance: { origin: "atom", feedUrl: "https://a.com/atom" } }),
        ]),
      },
      {
        sourceId: "src-2",
        payload: makeIngestArtifactPayload([
          { canonicalUrl: "https://other.com/b", provenance: { origin: "json", feedUrl: "https://other.com/feed.json" } },
        ]),
      },
    ]);

    const articles = [
      makeArticle({ id: 1 }),
      makeArticle({ id: 2, sourceId: "src-2", canonicalUrl: "https://other.com/b" }),
    ];
    const result = await recoverUpstreamProvenanceBatch(articles);
    expect(result.get(1)!.feedOrigin).toBe("atom");
    // Article 2 matches src-2's candidate whose provenance.origin is "json"
    expect(result.get(2)!.feedOrigin).toBe("json");
  });
});

describe("stubExtractArticle with provenanceOverride", () => {
  it("uses provided provenance instead of conservative fallback", async () => {
    const { stubExtractArticle } = await import("./enrichment-runtime");
    const precise: ArticleUpstreamProvenance = {
      sourceId: "src-1",
      categoryId: "cat-1",
      feedOrigin: "atom",
      feedUrl: "https://example.com/atom.xml",
      discoveredFromCategoryFeed: true,
      arrivedViaHardCaseRerun: false,
      ingestedAt: "2026-07-15T07:55:00.000Z",
    };
    const outcome = stubExtractArticle(makeArticle(), new Date(), precise);

    expect(outcome.provenance.feedOrigin).toBe("atom");
    expect(outcome.provenance.feedUrl).toBe("https://example.com/atom.xml");
    expect(outcome.provenance.discoveredFromCategoryFeed).toBe(true);
  });

  it("falls back to conservative provenance when override is omitted", async () => {
    const { stubExtractArticle } = await import("./enrichment-runtime");
    const outcome = stubExtractArticle(makeArticle());

    expect(outcome.provenance.feedOrigin).toBeNull();
    expect(outcome.provenance.feedUrl).toBeNull();
  });
});

describe("runEnrichmentBatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configureAgent3PrismaMocks();
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1 }),
      makeArticle({ id: 2, canonicalUrl: null, sourceUrl: null }),
    ]);
    articleUpdateMock.mockResolvedValue({ id: 0 });
    artifactCreateMock.mockResolvedValue({ id: "art-x" });
    artifactFindManyMock.mockResolvedValue([]); // no ingest artifacts by default
    pipelineRunCreateMock.mockResolvedValue({ id: "run-batch" });
    pipelineRunUpdateMock.mockResolvedValue({});
    logAgentScanMock.mockResolvedValue(undefined);

    // Mock the real extractor to return a successful result for articles with URL.
    // This avoids needing actual HTTP calls in unit tests.
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => {
      if (!input.articleUrl) {
        return {
          ok: false,
          method: "none" as const,
          resolvedUrl: null,
          statusCode: null,
          rejectedReason: "missing_article_url" as const,
          detail: "No URL",
          confidence: 0,
          qualitySignals: [],
        };
      }
      return {
        ok: true,
        method: "http-dom" as const,
        resolvedUrl: input.articleUrl,
        statusCode: 200,
        title: input.existingTitle || "Extracted Title",
        excerpt: "An excerpt",
        bodyText: "Extracted body text content that is long enough to pass the minimum threshold. ".repeat(10),
        imageUrl: null,
        author: null,
        publishedAt: null,
        isPaywall: null,
        access: {
          classification: "UNKNOWN" as const,
          confidence: "LOW" as const,
          detectorVersion: "article-access-v1.0.0",
          evidence: [],
          contradictingEvidence: [],
          evidenceArticleScoped: false,
          usableBodyExtracted: true,
          bodyTruncationDetected: false,
          articleScopedGateOrOverlayDetected: false,
          isPaywall: null,
          decisive: false,
        },
        confidence: 0.7,
        qualitySignals: ["selector:article", "method:http-dom", "bodyLength:700"],
        diagnostics: {
          selectedContainerSelector: "article",
          selectedContainerScore: 50,
          selectedContainerParagraphCount: 10,
          selectedContainerTextLength: 700,
          candidateContainerCount: 1,
          bodyRejectedReason: null,
          scoreReasons: ["many_paragraphs", "long_text", "semantic_container"],
          excerptLength: 12,
          bodyEqualsExcerpt: false,
          bodySource: "dom" as const,
          linkTextRatio: 0.05,
          boilerplatePenalty: 0,
        },
      };
    });
  });

  it("selects articles, emits attempt markers, builds outcomes via real extractor, persists them, and logs start/finish", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch();

    expect(result.pipelineRunId).toBe("run-batch");
    expect(result.articleCount).toBe(2);
    // 1 SUCCESS (article 1 with URL → real extractor succeeds) + 1 SKIPPED (article 2 no URL)
    expect(result.persist.persisted).toBe(2);
    expect(result.persist.byKind.SUCCESS).toBe(1);
    expect(result.persist.byKind.SKIPPED).toBe(1);

    // article update called once per outcome
    expect(articleUpdateMock).toHaveBeenCalledTimes(2);
    // artifact create called: 2 attempt markers + 2 result artifacts
    expect(artifactCreateMock).toHaveBeenCalledTimes(4);

    // Phase 2: real extractor was called for article 1 (has URL).
    // Article 2 has no URL so extractAndBuildArticleOutcome returns SKIPPED
    // before calling the extractor.
    expect(extractArticleContentFromUrlMock).toHaveBeenCalledTimes(1);
    expect(extractArticleContentFromUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ articleUrl: "https://example.com/a" }),
    );

    // Verify attempt markers were created before result artifacts
    const createCalls = artifactCreateMock.mock.calls;
    const attemptMarkers = createCalls.filter(
      (c) => (c[0]?.data as Record<string, unknown>)?.artifactType === "article_enrichment_attempt",
    );
    const resultArtifacts = createCalls.filter(
      (c) => (c[0]?.data as Record<string, unknown>)?.artifactType !== "article_enrichment_attempt",
    );
    expect(attemptMarkers).toHaveLength(2);
    expect(resultArtifacts).toHaveLength(2);

    // Attempt marker payloads are lightweight
    for (const marker of attemptMarkers) {
      const payload = asObj((marker[0]?.data as Record<string, unknown>).payload);
      expect(payload.artifactKind).toBe("attempt_marker");
      expect(payload.articleId).toBeDefined();
      expect(payload.attemptNumber).toBeDefined();
      expect(payload.startedAt).toBeDefined();
    }

    // start + finish logged
    const statuses = logAgentScanMock.mock.calls.map((c) => c[0].status);
    expect(statuses).toContain("ARTICLE_CONTENT_ENRICHMENT_STARTED");
    expect(statuses).toContain("ARTICLE_CONTENT_ENRICHMENT_FINISHED");
  });

  it("writes the enrichment summary onto the pipeline run", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    await runEnrichmentBatch();

    // prisma.pipelineRun.update called with a summary object
    const updateCalls = pipelineRunUpdateMock.mock.calls;
    const summaryCall = updateCalls.find(
      (c) => (c[0]?.data as Record<string, unknown>)?.summary !== undefined,
    );
    expect(summaryCall).toBeDefined();
    const summary = asObj((summaryCall![0].data as Record<string, unknown>).summary);
    expect(summary.articleCount).toBe(2);
    expect(asObj(summary.byKind).SUCCESS).toBeGreaterThanOrEqual(1);
  });

  it("includes attempt markers in the pipeline run artifactCount", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    await runEnrichmentBatch();

    const updateCalls = pipelineRunUpdateMock.mock.calls;
    const runUpdate = updateCalls.find(
      (c) => (c[0]?.data as Record<string, unknown>)?.artifactCount !== undefined,
    );
    expect(runUpdate).toBeDefined();
    const data = asObj(runUpdate![0].data);
    // 2 attempt markers + 2 result artifacts = 4
    expect(data.artifactCount).toBe(4);
  });

  it("persists the recovered Agent 2 transition through the real runtime outcome and Agent 3 artifact payload", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([{
      id: "a2-artifact-runtime",
      pipelineRunId: "a2-run-runtime",
      sourceId: "src-1",
      artifactType: "article_discovery_candidates",
      createdAt: new Date("2026-07-16T10:00:00.000Z"),
      payload: {
        candidates: [{
          sourceId: "src-1",
          categoryId: "cat-1",
          sourceUrl: "https://example.com/category",
          canonicalUrl: "https://example.com/a",
          provenance: { origin: "web_discovery", feedUrl: null, discoveredFromCategoryFeed: true },
          accessEvidence: {
            classification: "PAYWALL_BLOCKED",
            sourceStage: "agent2",
            evidenceCodes: ["agent2_paywall_hint"],
            contradictingEvidenceCodes: ["agent2_contradiction"],
          },
        }],
      },
    }]);
    await runEnrichmentBatch();

    const firstUpdate = articleUpdateMock.mock.calls.find((call) => call[0]?.where?.id === 1);
    expect(firstUpdate).toBeDefined();
    const summary = asObj(firstUpdate![0].data.enrichmentOutcome);
    expect(asObj(summary.provenance).earlyAccessEvidence).toMatchObject({
      classification: "PAYWALL_BLOCKED",
      sourceStage: "agent2",
    });
    expect(asObj(summary.access)).toMatchObject({
      sourceStage: "agent3",
      earlyStageClassification: "PAYWALL_BLOCKED",
      earlyStageSource: "agent2",
      earlyStageEvidenceCodes: ["agent2_paywall_hint"],
      earlyStageContradictingEvidenceCodes: ["agent2_contradiction"],
      classification: "UNKNOWN",
      finalIsPaywall: false,
      previousIsPaywall: false,
    });

    const resultArtifact = artifactCreateMock.mock.calls
      .map((call) => call[0]?.data)
      .find((data) => data?.artifactType === "article_enrichment_result");
    expect(resultArtifact).toBeDefined();
    const resultPayload = asObj(resultArtifact.payload);
    expect(asObj(resultPayload.provenance).earlyAccessEvidence).toMatchObject({ sourceStage: "agent2" });
    expect(asObj(resultPayload.access)).toMatchObject({ earlyStageSource: "agent2", finalIsPaywall: false });
  });

  it("persists the newer sourceUrl-selected Agent 2 evidence through Article summary and detailed artifact", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
        id: "new-source-runtime",
        pipelineRunId: "new-source-run",
        sourceId: "src-1",
        artifactType: "article_discovery_candidates",
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
        payload: {
          candidates: [{
            sourceId: "src-1",
            categoryId: "cat-1",
            sourceUrl: "https://example.com/a?utm_source=newer",
            accessEvidence: {
              classification: "ACCESSIBLE",
              sourceStage: "agent2",
              evidenceCodes: ["new_source_runtime"],
              contradictingEvidenceCodes: [],
            },
          }],
        },
      },
      {
        id: "old-canonical-runtime",
        pipelineRunId: "old-canonical-run",
        sourceId: "src-1",
        artifactType: "rss_candidates",
        createdAt: new Date("2026-07-19T10:00:00.000Z"),
        payload: {
          candidates: [{
            sourceId: "src-1",
            categoryId: "cat-1",
            canonicalUrl: "https://example.com/a",
            accessEvidence: {
              classification: "PAYWALL_BLOCKED",
              sourceStage: "agent1",
              evidenceCodes: ["old_canonical_runtime"],
              contradictingEvidenceCodes: [],
            },
          }],
        },
      },
    ]);

    await runEnrichmentBatch();

    const firstUpdate = articleUpdateMock.mock.calls.find((call) => call[0]?.where?.id === 1);
    expect(firstUpdate).toBeDefined();
    const summary = asObj(firstUpdate![0].data.enrichmentOutcome);
    expect(asObj(summary.provenance).earlyAccessEvidence).toMatchObject({
      classification: "ACCESSIBLE",
      sourceStage: "agent2",
      evidenceCodes: ["new_source_runtime"],
    });
    expect(asObj(summary.provenance).ingestArtifactId).toBe("new-source-runtime");
    expect(asObj(summary.access)).toMatchObject({
      earlyStageSource: "agent2",
      earlyStageClassification: "ACCESSIBLE",
      finalIsPaywall: false,
    });

    const resultArtifact = artifactCreateMock.mock.calls
      .map((call) => call[0]?.data)
      .find((data) => data?.artifactType === "article_enrichment_result");
    expect(resultArtifact).toBeDefined();
    const payload = asObj(resultArtifact.payload);
    expect(asObj(payload.provenance).ingestArtifactId).toBe("new-source-runtime");
    expect(asObj(payload.provenance).earlyAccessEvidence).toMatchObject({ sourceStage: "agent2" });
    expect(asObj(payload.access)).toMatchObject({ earlyStageSource: "agent2", finalIsPaywall: false });
  });

  it("persists conservative QUERY_FAILED recovery diagnostics without an Agent 2 transition or paywall mutation", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockImplementation(async (args: any) => {
      if (args?.where?.artifactType?.in?.includes("rss_candidates")) {
        throw new Error("recovery unavailable");
      }
      return [];
    });

    await runEnrichmentBatch();

    const firstUpdate = articleUpdateMock.mock.calls.find((call) => call[0]?.where?.id === 1);
    expect(firstUpdate).toBeDefined();
    expect(firstUpdate![0].data.isPaywall).toBeUndefined();
    const summary = asObj(firstUpdate![0].data.enrichmentOutcome);
    const summaryProvenance = asObj(summary.provenance);
    expect(asObj(summaryProvenance.earlyAccessRecovery).status).toBe("QUERY_FAILED");
    expect(summaryProvenance.earlyAccessEvidence).toBeUndefined();
    expect(asObj(summary.access)).toMatchObject({
      sourceStage: "agent3",
      earlyStageClassification: null,
      earlyStageSource: null,
      finalIsPaywall: false,
    });

    const resultArtifact = artifactCreateMock.mock.calls
      .map((call) => call[0]?.data)
      .find((data) => data?.artifactType === "article_enrichment_result");
    expect(resultArtifact).toBeDefined();
    const payload = asObj(resultArtifact.payload);
    expect(asObj(payload.provenance).earlyAccessRecovery).toMatchObject({ status: "QUERY_FAILED" });
    expect(asObj(payload.provenance).earlyAccessEvidence).toBeUndefined();
    expect(asObj(payload.access)).toMatchObject({ earlyStageSource: null, finalIsPaywall: false });
  });

  it("uses recovered provenance from Agent 1 artifacts when available", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    // Mock ingest artifact with precise provenance
    artifactFindManyMock.mockResolvedValue([
      {
        sourceId: "src-1",
        payload: makeIngestArtifactPayload([
          makeIngestCandidate({ canonicalUrl: "https://example.com/a" }),
        ]),
      },
    ]);

    await runEnrichmentBatch();

    // The article update for article id=1 should carry the recovered provenance
    const updateCalls = articleUpdateMock.mock.calls;
    const firstUpdate = updateCalls.find(
      (c) => c[0]?.where?.id === 1,
    );
    expect(firstUpdate).toBeDefined();
    // The enrichmentOutcome summary should reflect the recovered provenance
    const summary = asObj(firstUpdate![0].data.enrichmentOutcome);
    const prov = asObj(summary.provenance);
    expect(prov.feedOrigin).toBe("atom");
    expect(prov.sourceId).toBe("src-1");
  });

  it("returns a stable, JSON-serializable result", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch();

    const json = JSON.stringify(result);
    expect(json).toBeTruthy();
    const parsed = JSON.parse(json);
    expect(parsed.pipelineRunId).toBe("run-batch");
    expect(parsed.articleCount).toBe(2);
  });

  it("continues extraction when attempt marker persistence fails", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    // Simulate attempt markers failing but result artifacts succeeding.
    // Immediate persistence order: marker-1 (fail), result-1 (ok),
    // marker-2 (fail), result-2 (ok).
    artifactCreateMock
      .mockRejectedValueOnce(new Error("marker failed"))
      .mockResolvedValueOnce({ id: "art-1" })
      .mockRejectedValueOnce(new Error("marker failed"))
      .mockResolvedValueOnce({ id: "art-2" });

    const result = await runEnrichmentBatch();

    // Both outcomes should still be persisted despite marker failures
    expect(result.persist.persisted).toBe(2);
    // 1 SUCCESS (article with URL) + 1 SKIPPED (no URL)
    expect(result.persist.byKind.SUCCESS + result.persist.byKind.SKIPPED).toBe(2);
  });

  it("persists the first outcome before beginning extraction of the second article", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const defaultExtractor = extractArticleContentFromUrlMock.getMockImplementation()!;
    const events: string[] = [];

    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1 }),
      makeArticle({ id: 2, canonicalUrl: "https://example.com/b", sourceUrl: "https://example.com/b" }),
    ]);
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => {
      events.push(`extract-${input.articleId}`);
      return defaultExtractor(input);
    });
    articleUpdateMock.mockImplementation(async (args: any) => {
      if (args?.where?.id !== undefined) events.push(`persist-${args.where.id}`);
      return { id: args?.where?.id ?? 0 };
    });

    const result = await runEnrichmentBatch();

    expect(result.persist.persisted).toBe(2);
    expect(events.indexOf("persist-1")).toBeGreaterThan(events.indexOf("extract-1"));
    expect(events.indexOf("persist-1")).toBeLessThan(events.indexOf("extract-2"));
  });

  it("excludes outcomes from success counters when the runtime loses the claim during persistence", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1 }),
      makeArticle({ id: 2, canonicalUrl: "https://example.com/b", sourceUrl: "https://example.com/b" }),
    ]);

    // Claims are acquired and attempt markers are created, but another worker
    // owns each claim by the time final Article/artifact persistence runs.
    claimDeleteManyMock.mockResolvedValue({ count: 0 });

    const result = await runEnrichmentBatch();

    expect(result.articleCount).toBe(2);
    expect(result.persist.persisted).toBe(0);
    expect(result.persist.claimLost).toBe(2);
    expect(result.persist.failed).toBe(0);
    expect(result.persist.byKind.SUCCESS).toBe(0);
    expect(result.persist.byKind.SKIPPED).toBe(0);
    expect(articleUpdateMock).not.toHaveBeenCalled();
    expect(artifactCreateMock).toHaveBeenCalledTimes(2); // attempt markers only
    expect(artifactCreateMock.mock.calls.every((call) => {
      const data = call[0]?.data as Record<string, unknown> | undefined;
      return data?.artifactType === "article_enrichment_attempt";
    })).toBe(true);
    expect(artifactCreateMock.mock.calls.some((call) => {
      const data = call[0]?.data as Record<string, unknown> | undefined;
      return data?.artifactType === "article_enrichment_result" || data?.artifactType === "article_enrichment_rejection";
    })).toBe(false);
  });

  it("uses the current wall clock for recovery and each claim, not options.now", async () => {
    vi.useFakeTimers();
    const leaseClock = new Date("2026-07-31T12:00:00.000Z");
    const historicalContentTime = new Date("2020-01-01T00:00:00.000Z");
    vi.setSystemTime(leaseClock);

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const defaultExtractor = extractArticleContentFromUrlMock.getMockImplementation()!;
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1 }),
      makeArticle({ id: 2, canonicalUrl: "https://example.com/b", sourceUrl: "https://example.com/b" }),
    ]);
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => {
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      return defaultExtractor(input);
    });

    const result = await runEnrichmentBatch({ now: historicalContentTime });

    expect(result.persist.persisted).toBe(2);
    expect(claimDeleteManyDirectMock).toHaveBeenCalledWith({
      where: { expiresAt: { lte: leaseClock } },
    });
    const claims = claimCreateMock.mock.calls.map((call: any[]) => call[0].data);
    expect(claims).toHaveLength(2);
    expect(claims[0].claimedAt).toEqual(leaseClock);
    expect(claims[0].claimedAt).not.toEqual(historicalContentTime);
    expect(claims[1].claimedAt.getTime()).toBeGreaterThan(claims[0].claimedAt.getTime());
    expect(claims[1].expiresAt.getTime() - claims[1].claimedAt.getTime()).toBe(30 * 60 * 1000);
  });

  it("keeps both outcomes valid when time advances between extractions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T12:00:00.000Z"));

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const defaultExtractor = extractArticleContentFromUrlMock.getMockImplementation()!;
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1 }),
      makeArticle({ id: 2, canonicalUrl: "https://example.com/b", sourceUrl: "https://example.com/b" }),
    ]);
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => {
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      return defaultExtractor(input);
    });

    const result = await runEnrichmentBatch();

    expect(result.persist.persisted).toBe(2);
    expect(result.persist.claimLost).toBe(0);
    expect(result.persist.failed).toBe(0);
    expect(result.persist.byKind.SUCCESS).toBe(2);
    const claims = claimCreateMock.mock.calls.map((call: any[]) => call[0].data);
    expect(claims[1].claimedAt.getTime()).toBeGreaterThan(claims[0].claimedAt.getTime());
    expect(claims[0].expiresAt.getTime()).toBeGreaterThan(claims[0].claimedAt.getTime());
    expect(claims[1].expiresAt.getTime()).toBeGreaterThan(claims[1].claimedAt.getTime());
  });

  it("treats an Article deleted between selection and claim as a harmless batch miss", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    articleFindManyMock.mockResolvedValue([makeArticle({ id: 1 })]);
    articleFindUniqueMock.mockResolvedValue(null);

    const result = await runEnrichmentBatch();

    expect(result.articleCount).toBe(0);
    expect(result.claimSkipped).toBe(1);
    expect(result.persist.persisted).toBe(0);
    expect(result.persist.failed).toBe(0);
    expect(extractArticleContentFromUrlMock).not.toHaveBeenCalled();
    expect(pipelineRunUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "COMPLETED" }),
    }));
  });

  it("emits ARTICLE_CONTENT_ENRICHMENT_FAILED and marks PipelineRun FAILED on top-level crash", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");

    // Simulate a batch-level crash by making articleFindMany throw
    // (selectEnrichmentEligibleArticles). This happens after the
    // PipelineRun is created but before extraction begins, so the
    // catch block can mark the run FAILED and emit the failure log.
    articleFindManyMock.mockRejectedValue(new Error("DB connection lost"));

    await expect(runEnrichmentBatch()).rejects.toThrow("DB connection lost");

    // ARTICLE_CONTENT_ENRICHMENT_FAILED should have been logged
    const statuses = logAgentScanMock.mock.calls.map((c: any[]) => c[0].status);
    expect(statuses).toContain("ARTICLE_CONTENT_ENRICHMENT_STARTED");
    expect(statuses).toContain("ARTICLE_CONTENT_ENRICHMENT_FAILED");
    // FINISHED should NOT be called since the batch crashed
    expect(statuses).not.toContain("ARTICLE_CONTENT_ENRICHMENT_FINISHED");

    // PipelineRun should have been marked FAILED
    const updateCalls = pipelineRunUpdateMock.mock.calls;
    const failedCall = updateCalls.find(
      (c: any[]) => (c[0]?.data as Record<string, unknown>)?.status === "FAILED",
    );
    expect(failedCall).toBeDefined();
  });

  it("does not invalidate a workflow-owned PipelineRun on a top-level crash", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    articleFindManyMock.mockRejectedValue(new Error("transient DB failure"));

    await expect(runEnrichmentBatch({
      pipelineRunId: "workflow-lock-run",
    })).rejects.toThrow("transient DB failure");

    expect(pipelineRunCreateMock).not.toHaveBeenCalled();
    expect(pipelineRunUpdateMock).not.toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "workflow-lock-run" },
      data: expect.objectContaining({ status: "FAILED" }),
    }));
    expect(logAgentScanMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "ARTICLE_CONTENT_ENRICHMENT_FAILED",
    }));
  });

  it("persists bodyText only when bodySource is dom, not when existing-fallback", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");

    // First article has URL → extractor returns bodySource:dom with bodyText
    // Second article has no URL → skipped
    // Verify that the article update for article 1 includes bodyText
    await runEnrichmentBatch();

    const updateCalls = articleUpdateMock.mock.calls;
    const articleUpdate = updateCalls.find(
      (c: any[]) => c[0]?.where?.id === 1,
    );
    expect(articleUpdate).toBeDefined();
    const data = articleUpdate![0].data;
    // bodyText should be set because the mock extractor returns bodySource: "dom"
    expect(data.bodyText).toBeTruthy();
    expect(data.bodyText.length).toBeGreaterThan(100);
  });

  it("forceReprocess=true updates bodyText when new extraction is materially better", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");

    // Article has a short existing body (100 chars)
    // Mock extractor returns a long body (2000 chars)
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1, bodyText: "Short existing body. ".repeat(5) }),
    ]);

    const longBody = "The comprehensive article body contains extensive analysis and detailed reporting on the subject matter. ".repeat(20);
    extractArticleContentFromUrlMock.mockImplementation(async () => ({
      ok: true,
      method: "http-dom" as const,
      resolvedUrl: "https://example.com/a",
      statusCode: 200,
      title: "Test Article",
      excerpt: "An excerpt",
      bodyText: longBody,
      imageUrl: null,
      author: null,
      publishedAt: null,
      isPaywall: null,
      confidence: 0.8,
      qualitySignals: ["selector:article", "method:http-dom"],
      diagnostics: {
        selectedContainerSelector: "article",
        selectedContainerScore: 60,
        selectedContainerParagraphCount: 20,
        selectedContainerTextLength: longBody.length,
        candidateContainerCount: 1,
        bodyRejectedReason: null,
        scoreReasons: ["many_paragraphs", "long_text", "semantic_container"],
        excerptLength: 12,
        bodyEqualsExcerpt: false,
        bodySource: "dom" as const,
        linkTextRatio: 0.05,
        boilerplatePenalty: 0,
        topCandidates: [],
        usedExpansion: false,
        expansionType: null,
        leadLikePenaltyApplied: false,
      },
    }));

    // Run with forceReprocess=true
    const result = await runEnrichmentBatch({ forceReprocess: true });

    // Should persist the new long body
    const updateCalls = articleUpdateMock.mock.calls;
    const articleUpdate = updateCalls.find((c: any[]) => c[0]?.where?.id === 1);
    expect(articleUpdate).toBeDefined();
    const data = articleUpdate![0].data;
    expect(data.bodyText).toBeTruthy();
    expect(data.bodyText.length).toBeGreaterThan(500);
    expect(data.bodyText).toContain("comprehensive article body");
  });

  it("runEnrichmentBatch forwards forceReprocess to selection for current-version non-retryable failures", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");

    articleFindManyMock.mockResolvedValue([
      makeArticle({
        id: 53834,
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentOutcome: {
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          kind: "LOW_CONTENT_QUALITY",
          rejectionCode: "LOW_CONTENT_QUALITY",
          rejectionDetail: "[no_article_text] No meaningful body text could be extracted from the page.",
        },
      }),
    ]);

    const bodyText = "Recovered article body with enough useful detail for a forced admin reprocess. ".repeat(20);
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: true,
      method: "http-dom" as const,
      resolvedUrl: "https://www.rte.ie/entertainment/example",
      statusCode: 200,
      title: "Recovered Article",
      excerpt: "Recovered excerpt",
      bodyText,
      imageUrl: null,
      author: null,
      publishedAt: null,
      isPaywall: null,
      confidence: 0.8,
      qualitySignals: ["selector:article", "method:http-dom"],
      diagnostics: {
        selectedContainerSelector: "article",
        selectedContainerScore: 60,
        selectedContainerParagraphCount: 5,
        selectedContainerTextLength: bodyText.length,
        candidateContainerCount: 1,
        bodyRejectedReason: null,
        scoreReasons: ["good_paragraphs", "semantic_container"],
        excerptLength: 17,
        bodyEqualsExcerpt: false,
        bodySource: "dom" as const,
        linkTextRatio: 0.05,
        boilerplatePenalty: 0,
        topCandidates: [],
        usedExpansion: false,
        expansionType: null,
        leadLikePenaltyApplied: false,
      },
    });

    const result = await runEnrichmentBatch({ forceReprocess: true });

    expect(result.articleCount).toBe(1);
    expect(result.persist.byKind.SUCCESS).toBe(1);
    expect(extractArticleContentFromUrlMock).toHaveBeenCalledTimes(1);
  });

  it("forceReprocess=true does NOT overwrite existing bodyText when new extraction is not materially better", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");

    // Article has a long existing body (2000 chars, 10 paragraphs)
    const existingBody = Array.from({ length: 10 }, (_, i) =>
      `Existing paragraph ${i + 1} provides detailed and comprehensive analysis of the topic with substantial evidence. `.repeat(3)
    ).join("\n\n");

    articleFindManyMock.mockImplementation(async (args) => {
      if (args?.where?.enrichmentStatus === "ENRICHED") {
        return [makeArticle({ id: 1, bodyText: existingBody, enrichmentStatus: "ENRICHED" })];
      }
      return [];
    });

    // Extractor returns a shorter body (not materially better)
    const shortBody = "The extracted body is shorter than the existing one and does not meet the materially better threshold for replacement. ".repeat(5);
    extractArticleContentFromUrlMock.mockImplementation(async () => ({
      ok: true,
      method: "http-dom" as const,
      resolvedUrl: "https://example.com/a",
      statusCode: 200,
      title: "Test Article",
      excerpt: "An excerpt",
      bodyText: shortBody,
      imageUrl: null,
      author: null,
      publishedAt: null,
      isPaywall: null,
      confidence: 0.7,
      qualitySignals: ["selector:article", "method:http-dom"],
      diagnostics: {
        selectedContainerSelector: "article",
        selectedContainerScore: 50,
        selectedContainerParagraphCount: 5,
        selectedContainerTextLength: shortBody.length,
        candidateContainerCount: 1,
        bodyRejectedReason: null,
        scoreReasons: ["good_paragraphs", "medium_text"],
        excerptLength: 12,
        bodyEqualsExcerpt: false,
        bodySource: "dom" as const,
        linkTextRatio: 0.05,
        boilerplatePenalty: 0,
        topCandidates: [],
        usedExpansion: false,
        expansionType: null,
        leadLikePenaltyApplied: false,
      },
    }));

    const result = await runEnrichmentBatch({ includeEnriched: true, forceReprocess: true });

    expect(result.persist.persisted).toBe(1);

    // Check that article update does NOT include bodyText (not materially better)
    const updateCalls = articleUpdateMock.mock.calls;
    const articleUpdate = updateCalls.find((c: any[]) => c[0]?.where?.id === 1);
    expect(articleUpdate).toBeDefined();
    const data = articleUpdate![0].data;
    // bodyText should NOT be set because the new extraction is not materially better
    // than the existing long body
    expect(data.bodyText).toBeUndefined();
  });

  it("returns optionsUsed in the result", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ includeEnriched: true, forceReprocess: true });

    expect(result.optionsUsed).toBeDefined();
    expect(result.optionsUsed.includeEnriched).toBe(true);
    expect(result.optionsUsed.forceReprocess).toBe(true);
  });

  it("persists bodyText when extractor returns readability bodySource", async () => {
    const readabilityBody = "Readability extracted paragraph with enough real article substance and useful context. ".repeat(20);
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => ({
      ok: true,
      method: "http-dom" as const,
      resolvedUrl: input.articleUrl,
      statusCode: 200,
      title: input.existingTitle || "Readability Title",
      excerpt: "Readability excerpt",
      bodyText: readabilityBody,
      imageUrl: null,
      author: null,
      publishedAt: null,
      isPaywall: null,
      confidence: 0.82,
      qualitySignals: ["selector:readability", "method:http-dom"],
      diagnostics: {
        selectedContainerSelector: "readability",
        selectedContainerScore: 60,
        selectedContainerParagraphCount: 5,
        selectedContainerTextLength: readabilityBody.length,
        candidateContainerCount: 1,
        bodyRejectedReason: null,
        scoreReasons: ["readability_candidate", "good_paragraphs"],
        excerptLength: 19,
        bodyEqualsExcerpt: false,
        bodySource: "readability" as const,
        linkTextRatio: 0.03,
        boilerplatePenalty: 0,
        topCandidates: [],
        usedExpansion: false,
        expansionType: null,
        leadLikePenaltyApplied: false,
      },
    }));

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch();

    expect(result.persist.byKind.SUCCESS).toBeGreaterThanOrEqual(1);

    const articleUpdate = articleUpdateMock.mock.calls.find(
      (c: any[]) => c[0]?.where?.id === 1,
    );
    expect(articleUpdate).toBeDefined();
    const data = articleUpdate![0].data;
    expect(data.bodyText).toBe(readabilityBody);
  });

  it("does not persist bodyText when extractor returns existing-fallback bodySource", async () => {
    // Override mock to return existing-fallback bodySource
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => {
      if (!input.articleUrl) {
        return {
          ok: false,
          method: "none" as const,
          resolvedUrl: null,
          statusCode: null,
          rejectedReason: "missing_article_url" as const,
          detail: "No URL",
          confidence: 0,
          qualitySignals: [],
          diagnostics: {
            selectedContainerSelector: null,
            selectedContainerScore: null,
            selectedContainerParagraphCount: null,
            selectedContainerTextLength: null,
            candidateContainerCount: 0,
            bodyRejectedReason: null,
            scoreReasons: [],
            excerptLength: null,
            bodyEqualsExcerpt: false,
            bodySource: "none" as const,
            linkTextRatio: null,
            boilerplatePenalty: null,
          },
        };
      }
      return {
        ok: true,
        method: "http-dom" as const,
        resolvedUrl: input.articleUrl,
        statusCode: 200,
        title: input.existingTitle || "Extracted Title",
        excerpt: "An excerpt",
        bodyText: input.existingBodyText || "Fallback body that was already on the article row.",
        imageUrl: null,
        author: null,
        publishedAt: null,
        isPaywall: null,
        confidence: 0.5,
        qualitySignals: ["selector:body-fallback", "method:http-dom"],
        diagnostics: {
          selectedContainerSelector: "body-fallback",
          selectedContainerScore: 20,
          selectedContainerParagraphCount: 2,
          selectedContainerTextLength: 200,
          candidateContainerCount: 1,
          bodyRejectedReason: null,
          scoreReasons: ["few_paragraphs"],
          excerptLength: 12,
          bodyEqualsExcerpt: false,
          bodySource: "existing-fallback" as const,
          linkTextRatio: 0.1,
          boilerplatePenalty: 0,
        },
      };
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch();

    // The batch should complete
    expect(result.articleCount).toBe(2);

    // Check that article 1 update does NOT include bodyText (since bodySource is existing-fallback)
    const updateCalls = articleUpdateMock.mock.calls;
    const articleUpdate = updateCalls.find(
      (c: any[]) => c[0]?.where?.id === 1,
    );
    expect(articleUpdate).toBeDefined();
    const data = articleUpdate![0].data;
    // bodyText should NOT be set because bodySource is existing-fallback, not dom
    expect(data.bodyText).toBeUndefined();
  });
});

describe("getAgent3Progress", () => {
  beforeEach(() => {
    articleCountMock.mockReset();
    articleFindManyMock.mockReset();
    pipelineRunFindFirstMock.mockReset();
    artifactFindFirstMock.mockReset();
    artifactFindFirstMock.mockResolvedValue(null);
  });

  it("counts INGESTED + ENRICHMENT_FAILED when includeEnriched=false", async () => {
    // 4 count queries: totalInScope, needingInitial, enriched, failedRetryable
    // + findMany for enriched articles + findMany for non-retryable failures
    let callIndex = 0;
    articleCountMock.mockImplementation(() => {
      callIndex++;
      const counts = [100, 60, 30, 10];
      return Promise.resolve(counts[callIndex - 1] ?? 0);
    });
    // Enriched articles: 2 with current version + good body, 1 with old version
    // Non-retryable failures: none (ENRICHMENT_FAILED query returns empty)
    articleFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.enrichmentStatus === "ENRICHMENT_FAILED") {
        return Promise.resolve([]); // No non-retryable failures
      }
      return Promise.resolve([
        { id: 1, bodyText: "A".repeat(600), enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION } },
        { id: 2, bodyText: "B".repeat(600), enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION } },
        { id: 3, bodyText: "C".repeat(600), enrichmentOutcome: { extractorVersion: "old-version" } },
      ]);
    });
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress({ includeEnriched: false });

    expect(progress.totalInScope).toBe(100);
    expect(progress.needingInitialEnrichment).toBe(60);
    expect(progress.enrichedInScope).toBe(30);
    // 1 needs reprocess (old version), 2 current complete
    expect(progress.needsCurrentVersionReprocess).toBe(1);
    expect(progress.currentVersionComplete).toBe(2);
    // includeEnriched=false: eligibleNow = needingInitialEnrichment only
    expect(progress.eligibleNow).toBe(60);
    expect(progress.selectedMode.includeEnriched).toBe(false);
    expect(articleCountMock).toHaveBeenCalledTimes(4);
  });

  it("also counts ENRICHED needing reprocess when includeEnriched=true", async () => {
    let callIndex = 0;
    articleCountMock.mockImplementation(() => {
      callIndex++;
      const counts = [100, 60, 30, 10];
      return Promise.resolve(counts[callIndex - 1] ?? 0);
    });
    // Enriched articles: 1 current+good, 1 old version, 1 short bodyText
    articleFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.enrichmentStatus === "ENRICHMENT_FAILED") {
        return Promise.resolve([]); // No non-retryable failures
      }
      return Promise.resolve([
        { id: 1, bodyText: "A".repeat(600), enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION } },
        { id: 2, bodyText: "B".repeat(600), enrichmentOutcome: { extractorVersion: "old-version" } },
        { id: 3, bodyText: "short", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION } },
      ]);
    });
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress({ includeEnriched: true });

    // 2 need reprocess (old version + short body), 1 current complete
    expect(progress.needsCurrentVersionReprocess).toBe(2);
    expect(progress.currentVersionComplete).toBe(1);
    // eligibleNow = needingInitial(60) + needsReprocess(2) = 62
    expect(progress.eligibleNow).toBe(62);
    expect(progress.selectedMode.includeEnriched).toBe(true);
  });

  it("explicit articleIds bypass freshness cutoff", async () => {
    let callIndex = 0;
    articleCountMock.mockImplementation(() => {
      callIndex++;
      return Promise.resolve(5);
    });
    articleFindManyMock.mockResolvedValue([]);
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress({ articleIds: [1, 2, 3] });

    expect(progress.selectedMode.hasArticleFilter).toBe(true);
    // Verify the first count query does NOT have a date filter (bypasses freshness)
    const firstCallWhere = articleCountMock.mock.calls[0]![0].where;
    expect(firstCallWhere.date).toBeUndefined();
    expect(firstCallWhere.id).toEqual({ in: [1, 2, 3] });
  });

  it("sourceIds filter applies", async () => {
    let callIndex = 0;
    articleCountMock.mockImplementation(() => {
      callIndex++;
      return Promise.resolve(10);
    });
    articleFindManyMock.mockResolvedValue([]);
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress({ sourceIds: ["src-1"] });

    expect(progress.selectedMode.hasSourceFilter).toBe(true);
    const firstCallWhere = articleCountMock.mock.calls[0]![0].where;
    expect(firstCallWhere.sourceId).toEqual({ in: ["src-1"] });
  });

  it("parses latest PipelineRun summary correctly", async () => {
    articleCountMock.mockResolvedValue(10);
    articleFindManyMock.mockResolvedValue([]);
    pipelineRunFindFirstMock.mockResolvedValue({
      id: "run-abc12345",
      candidatesFound: 50,
      inserted: 1,
      skipped: 0,
      failed: 0,
      finishedAt: new Date("2026-07-29T10:00:00Z"),
      summary: {
        agent: "enrichment",
        articleCount: 50,
        persisted: 50,
        byKind: { SUCCESS: 1, LOW_CONTENT_QUALITY: 28, UNSUPPORTED_STRUCTURE: 21 },
        durationMs: 15000,
        persistFailed: 0,
      },
    });

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress();

    expect(progress.latestRun).not.toBeNull();
    expect(progress.latestRun!.pipelineRunId).toBe("run-abc12345");
    expect(progress.latestRun!.processed).toBe(50);
    expect(progress.latestRun!.successfullyEnriched).toBe(1);
    expect(progress.latestRun!.rejected).toBe(49);
    expect(progress.latestRun!.systemPersistFailed).toBe(0);
    expect(progress.latestRun!.durationMs).toBe(15000);
    expect(progress.latestRun!.byKind).toEqual({ SUCCESS: 1, LOW_CONTENT_QUALITY: 28, UNSUPPORTED_STRUCTURE: 21 });
  });

  it("falls back to the latest orchestration Agent 3 diagnostic", async () => {
    articleCountMock.mockResolvedValue(0);
    articleFindManyMock.mockResolvedValue([]);
    pipelineRunFindFirstMock.mockResolvedValue(null);
    artifactFindFirstMock.mockResolvedValue({
      pipelineRunId: "local-pipeline-run",
      createdAt: new Date("2026-08-13T19:20:00Z"),
      payload: {
        enrichmentSummary: {
          articleCount: 10,
          persisted: 10,
          persistFailed: 0,
          durationMs: 4200,
          byKind: { SUCCESS: 7, HTTP_ACCESS_BLOCKED: 3 },
          browserFallbackStats: {
            enabled: true, attempted: 2, succeeded: 1, failed: 1,
            runtimeUnavailable: 0, rateLimited: 0, stoppedReason: null,
          },
          optionsUsed: {
            browserFallback: true, browserFallbackMaxAttempts: 2,
            browserTimeoutMs: 25000, includeEnriched: false,
            forceReprocess: false, maxArticles: 10, maxArticlesPerSource: 2,
          },
          agent3SourceCooldowns: [{
            sourceId: "source-1", hostname: "publisher.example", reason: "http_403",
            failureCount: 1, skippedInRun: 0,
            firstFailureAt: "2026-08-13T19:00:00.000Z",
            lastFailureAt: "2026-08-13T19:00:00.000Z",
          }],
        },
      },
    });

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress();

    expect(progress.latestRun).toMatchObject({
      pipelineRunId: "local-pipeline-run",
      processed: 10,
      successfullyEnriched: 7,
      rejected: 3,
      durationMs: 4200,
      byKind: { SUCCESS: 7, HTTP_ACCESS_BLOCKED: 3 },
      browserFallbackStats: { attempted: 2, succeeded: 1, failed: 1 },
      optionsUsed: { browserFallback: true, browserFallbackMaxAttempts: 2 },
      sourceCooldowns: [{ sourceId: "source-1", hostname: "publisher.example", reason: "http_403" }],
    });
    expect(artifactFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        artifactType: { in: ["agent3_orchestration_summary", "agent3_progress_diagnostic"] },
        status: "CAPTURED",
      },
    }));
  });

  it("prefers a newer orchestration diagnostic over an older standalone enrichment run", async () => {
    articleCountMock.mockResolvedValue(0);
    articleFindManyMock.mockResolvedValue([]);
    pipelineRunFindFirstMock.mockResolvedValue({
      id: "older-standalone-run",
      candidatesFound: 0,
      inserted: 0,
      skipped: 0,
      failed: 0,
      finishedAt: new Date("2026-08-23T09:00:00Z"),
      summary: { agent: "enrichment", articleCount: 0, persisted: 0, byKind: {} },
    });
    artifactFindFirstMock.mockResolvedValue({
      pipelineRunId: "newer-workflow-run",
      createdAt: new Date("2026-08-23T10:00:00Z"),
      payload: { enrichmentSummary: { articleCount: 10, persisted: 10, byKind: { SUCCESS: 8, LOW_CONTENT_QUALITY: 2 } } },
    });

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress();

    expect(progress.latestRun).toMatchObject({
      pipelineRunId: "newer-workflow-run",
      processed: 10,
      successfullyEnriched: 8,
      rejected: 2,
    });
  });

  it("remainingAfterLatestRun is recomputed from current DB state", async () => {
    let callIndex = 0;
    articleCountMock.mockImplementation(() => {
      callIndex++;
      // After a run, some articles may still be eligible
      return Promise.resolve(15);
    });
    articleFindManyMock.mockResolvedValue([]);
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress();

    // remainingAfterLatestRun should equal eligibleNow (recomputed, not naive subtraction)
    expect(progress.remainingAfterLatestRun).toBe(progress.eligibleNow);
  });
});

describe("needsAgent3CurrentVersionReprocess", () => {
  beforeEach(() => {
    articleFindManyMock.mockReset();
    articleCountMock.mockReset();
    pipelineRunFindFirstMock.mockReset();
  });

  it("Test A: ENRICHED with old extractorVersion is selected for reprocess", async () => {
    // Simulate: ENRICHED article with old extractorVersion, usable bodyText
    articleFindManyMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: 1, sourceId: "s1", categoryId: null, canonicalUrl: "https://example.com/1",
      sourceUrl: "https://example.com/1", title: "Test", bodyText: "A".repeat(600),
      publishedAt: new Date(), isPaywall: false, createdAt: new Date(),
      enrichmentStatus: "ENRICHED", enrichmentAttemptCount: 1,
      enrichmentOutcome: { schemaVersion: 1, extractorVersion: "old-v0", kind: "SUCCESS" },
    }]);
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const articles = await selectEnrichmentEligibleArticles(new Date(), 50, { includeEnriched: true });
    expect(articles.length).toBe(1);
    expect(articles[0]!.id).toBe(1);
  });

  it("Test B: ENRICHED with current extractorVersion and usable bodyText is NOT selected", async () => {
    articleFindManyMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: 2, sourceId: "s1", categoryId: null, canonicalUrl: "https://example.com/2",
      sourceUrl: "https://example.com/2", title: "Test", bodyText: "B".repeat(600),
      publishedAt: new Date(), isPaywall: false, createdAt: new Date(),
      enrichmentStatus: "ENRICHED", enrichmentAttemptCount: 1,
      enrichmentOutcome: { schemaVersion: 1, extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "SUCCESS" },
    }]);
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const articles = await selectEnrichmentEligibleArticles(new Date(), 50, { includeEnriched: true });
    // Should be filtered out by in-memory check
    expect(articles.length).toBe(0);
  });

  it("Test C: ENRICHED with current extractorVersion but too-short bodyText IS selected", async () => {
    articleFindManyMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: 3, sourceId: "s1", categoryId: null, canonicalUrl: "https://example.com/3",
      sourceUrl: "https://example.com/3", title: "Test", bodyText: "short",
      publishedAt: new Date(), isPaywall: false, createdAt: new Date(),
      enrichmentStatus: "ENRICHED", enrichmentAttemptCount: 1,
      enrichmentOutcome: { schemaVersion: 1, extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "SUCCESS" },
    }]);
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const articles = await selectEnrichmentEligibleArticles(new Date(), 50, { includeEnriched: true });
    expect(articles.length).toBe(1);
    expect(articles[0]!.id).toBe(3);
  });

  it("Test D: reprocess loop — progress decreases to 0 after successful enrichment", async () => {
    // Simulate: initially 1 stale article, then after enrichment it's current
    let enrichedArticles = [{
      id: 10, bodyText: "old short",
      enrichmentOutcome: { schemaVersion: 1, extractorVersion: "old-v0" },
    }];
    articleFindManyMock.mockImplementation(() => Promise.resolve(enrichedArticles));
    let callIndex = 0;
    articleCountMock.mockImplementation(() => {
      callIndex++;
      return Promise.resolve([50, 5, 1, 0][callIndex - 1] ?? 0);
    });
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { getAgent3Progress } = await import("./enrichment-runtime");

    // First progress: stale article exists
    const progressBefore = await getAgent3Progress({ includeEnriched: true });
    expect(progressBefore.needsCurrentVersionReprocess).toBe(1);
    expect(progressBefore.currentVersionComplete).toBe(0);

    // Simulate successful enrichment: article now has current version + good body
    enrichedArticles = [{
      id: 10, bodyText: "A".repeat(600),
      enrichmentOutcome: { schemaVersion: 1, extractorVersion: AGENT3_EXTRACTOR_VERSION },
    }];
    articleFindManyMock.mockImplementation(() => Promise.resolve(enrichedArticles));
    callIndex = 0; // reset count mock

    // Second progress: article is now current
    const progressAfter = await getAgent3Progress({ includeEnriched: true });
    expect(progressAfter.needsCurrentVersionReprocess).toBe(0);
    expect(progressAfter.currentVersionComplete).toBe(1);
  });

  it("Test E: forceReprocess=true does not keep current-version good articles eligible", async () => {
    articleFindManyMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: 5, sourceId: "s1", categoryId: null, canonicalUrl: "https://example.com/5",
      sourceUrl: "https://example.com/5", title: "Test", bodyText: "E".repeat(600),
      publishedAt: new Date(), isPaywall: false, createdAt: new Date(),
      enrichmentStatus: "ENRICHED", enrichmentAttemptCount: 1,
      enrichmentOutcome: { schemaVersion: 1, extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "SUCCESS" },
    }]);
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const articles = await selectEnrichmentEligibleArticles(new Date(), 50, { includeEnriched: true });
    // forceReprocess=true is passed to the batch runner, not selection. Selection
    // uses needsAgent3CurrentVersionReprocess which ignores forceReprocess.
    expect(articles.length).toBe(0);
  });
});

describe("getAgent3Progress paged scanning", () => {
  beforeEach(() => {
    articleCountMock.mockReset();
    articleFindManyMock.mockReset();
    pipelineRunFindFirstMock.mockReset();
  });

  it("accurately counts >50 old-version ENRICHED articles", async () => {
    // Simulate 75 old-version enriched articles across multiple pages
    const oldVersionArticles = Array.from({ length: 75 }, (_, i) => ({
      id: i + 1,
      bodyText: `Article body ${i + 1} `.repeat(20),
      enrichmentOutcome: { extractorVersion: "old-v0" },
    }));

    let callIndex = 0;
    articleCountMock.mockImplementation(() => {
      callIndex++;
      // totalInScope=100, needingInitial=25, enrichedInScope=75, failedRetryable=0
      return Promise.resolve([100, 25, 75, 0][callIndex - 1] ?? 0);
    });

    // findMany will be called multiple times by the paged scanner.
    // Return pages of 500, then empty for the next call.
    let findManyCallCount = 0;
    articleFindManyMock.mockImplementation(() => {
      findManyCallCount++;
      if (findManyCallCount === 1) return Promise.resolve(oldVersionArticles);
      return Promise.resolve([]);
    });
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress({ includeEnriched: true });

    expect(progress.needsCurrentVersionReprocess).toBe(75);
    expect(progress.currentVersionComplete).toBe(0);
    expect(progress.eligibleNow).toBe(100); // 25 initial + 75 reprocess
    expect(progress.progressScanned).toBe(75);
    expect(progress.progressTruncated).toBe(false);
  });

  it("accurately counts >50 current-version usable ENRICHED articles", async () => {
    const currentArticles = Array.from({ length: 75 }, (_, i) => ({
      id: i + 1,
      bodyText: `Good article body ${i + 1} `.repeat(80),
      enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION },
    }));

    let callIndex = 0;
    articleCountMock.mockImplementation(() => {
      callIndex++;
      return Promise.resolve([100, 25, 75, 0][callIndex - 1] ?? 0);
    });

    let findManyCallCount = 0;
    articleFindManyMock.mockImplementation(() => {
      findManyCallCount++;
      if (findManyCallCount === 1) return Promise.resolve(currentArticles);
      return Promise.resolve([]);
    });
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress({ includeEnriched: true });

    expect(progress.needsCurrentVersionReprocess).toBe(0);
    expect(progress.currentVersionComplete).toBe(75);
    expect(progress.eligibleNow).toBe(25); // only initial
    expect(progress.progressScanned).toBe(75);
  });

  it("counts mixed statuses correctly", async () => {
    // All 75 articles in one page (< 500 page size)
    const allArticles = [
      ...Array.from({ length: 30 }, (_, i) => ({
        id: i + 1, bodyText: `Body ${i + 1} `.repeat(20),
        enrichmentOutcome: { extractorVersion: "old-v0" },
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        id: i + 31, bodyText: `Body ${i + 31} `.repeat(80),
        enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION },
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: i + 51, bodyText: `Body ${i + 51} `.repeat(80),
        enrichmentOutcome: { extractorVersion: "old-v0" },
      })),
      ...Array.from({ length: 15 }, (_, i) => ({
        id: i + 56, bodyText: `Body ${i + 56} `.repeat(80),
        enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION },
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: i + 71, bodyText: "short",
        enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION },
      })),
    ];

    let callIndex = 0;
    articleCountMock.mockImplementation(() => {
      callIndex++;
      return Promise.resolve([100, 25, 75, 0][callIndex - 1] ?? 0);
    });
    // Route ENRICHMENT_FAILED queries to empty (no non-retryable failures)
    articleFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.enrichmentStatus === "ENRICHMENT_FAILED") {
        return Promise.resolve([]);
      }
      return Promise.resolve(allArticles);
    });
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress({ includeEnriched: true });

    // 30 old + 5 old + 5 short = 40 need reprocess
    expect(progress.needsCurrentVersionReprocess).toBe(40);
    // 20 current + 15 current = 35 current complete
    expect(progress.currentVersionComplete).toBe(35);
    expect(progress.progressScanned).toBe(75);
    expect(progress.eligibleNow).toBe(65); // 25 initial + 40 reprocess
  });

  it("selectEnrichmentEligibleArticles remains bounded by maxArticles", async () => {
    // Even with many articles in the DB, selection returns at most maxArticles
    const manyArticles = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1, sourceId: "s1", categoryId: null, canonicalUrl: `https://example.com/${i + 1}`,
      sourceUrl: `https://example.com/${i + 1}`, title: `Article ${i + 1}`,
      bodyText: null, publishedAt: new Date(), isPaywall: false, createdAt: new Date(),
      enrichmentStatus: "INGESTED", enrichmentAttemptCount: 0, enrichmentOutcome: null,
    }));
    articleFindManyMock.mockResolvedValue(manyArticles.slice(0, 10));
    articleCountMock.mockResolvedValue(100);
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const articles = await selectEnrichmentEligibleArticles(new Date(), 10);

    // Should return at most 10 (the limit passed), not all 100
    expect(articles.length).toBeLessThanOrEqual(10);
    // Verify findMany was called with take: 10 (the limit is still enforced).
    expect(articleFindManyMock).toHaveBeenCalledTimes(2);
    // The selector uses a bounded page floor so filtered rows can be scanned
    // without letting lower tiers displace NEW work.
    expect(articleFindManyMock.mock.calls[1]![0].take).toBe(50);
  });

  it("progressTruncated=true when safety cap is hit", async () => {
    // Simulate hitting the safety cap (20,000 articles)
    // The scanner fetches pages of 500, so 40 full pages = 20,000 articles
    const page = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1, bodyText: `Body ${i + 1} `.repeat(20),
      enrichmentOutcome: { extractorVersion: "old-v0" },
    }));

    let callIndex = 0;
    articleCountMock.mockImplementation(() => {
      callIndex++;
      // totalInScope=20001, needingInitial=0, enrichedInScope=20001, failedRetryable=0
      // + 1 count for truncation check
      return Promise.resolve([20001, 0, 20001, 0, 1][callIndex - 1] ?? 0);
    });

    // Route by query: ENRICHMENT_FAILED queries return empty (no non-retryable/blocked),
    // ENRICHED queries return paged data for the enriched scan.
    let enrichedCallCount = 0;
    articleFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.enrichmentStatus === "ENRICHMENT_FAILED") {
        return Promise.resolve([]); // No non-retryable failures, no recently blocked
      }
      // ENRICHED scan or countBlockedEligibleArticles
      if (args?.where?.enrichmentStatus === "ENRICHED" || args?.where?.enrichmentStatus?.in) {
        enrichedCallCount++;
        if (enrichedCallCount <= 40) return Promise.resolve(page);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    pipelineRunFindFirstMock.mockResolvedValue(null);

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress({ includeEnriched: true });

    expect(progress.progressTruncated).toBe(true);
    expect(progress.progressScanned).toBe(20000);
    expect(progress.needsCurrentVersionReprocess).toBe(20000);
    expect(progress.currentVersionComplete).toBe(0);
  });
});

describe("Agent 3 browser fallback integration", () => {
  /** Returns a standard mock browser extractor SUCCESS result. */
  const makeBrowserSuccess = (overrides: Record<string, unknown> = {}) => ({
    ok: true as const,
    method: "browser-dom" as const,
    resolvedUrl: "https://example.com/a",
    statusCode: 200,
    title: "Extracted Title",
    excerpt: "An excerpt",
    bodyText: "Browser-rendered body text content that is long enough to pass the minimum threshold. ".repeat(10),
    imageUrl: null,
    author: null,
    publishedAt: null,
    isPaywall: null,
    confidence: 0.8,
    qualitySignals: ["selector:article", "method:browser-dom", "bodyLength:800"],
    diagnostics: {
      selectedContainerSelector: "article",
      selectedContainerScore: 55,
      selectedContainerParagraphCount: 12,
      selectedContainerTextLength: 800,
      candidateContainerCount: 1,
      bodyRejectedReason: null,
      scoreReasons: ["many_paragraphs", "long_text", "semantic_container"],
      excerptLength: 12,
      bodyEqualsExcerpt: false,
      bodySource: "dom" as const,
      linkTextRatio: 0.04,
      boilerplatePenalty: 0,
      topCandidates: [],
      usedExpansion: false,
      expansionType: null,
      leadLikePenaltyApplied: false,
    },
    ...overrides,
  });

  /** Returns a standard mock browser extractor failure result. */
  const makeBrowserFailure = (overrides: Record<string, unknown> = {}) => ({
    ok: false as const,
    method: "browser-dom" as const,
    resolvedUrl: "https://example.com/a",
    statusCode: null as number | null,
    rejectedReason: "no_article_text" as const,
    detail: "Browser extraction found no article text.",
    confidence: 0,
    qualitySignals: ["browser_no_article_text"],
    diagnostics: {
      selectedContainerSelector: null,
      selectedContainerScore: null,
      selectedContainerParagraphCount: null,
      selectedContainerTextLength: null,
      candidateContainerCount: 0,
      bodyRejectedReason: "no_candidates",
      scoreReasons: [],
      excerptLength: null,
      bodyEqualsExcerpt: false,
      bodySource: "none" as const,
      linkTextRatio: null,
      boilerplatePenalty: null,
      topCandidates: [
        { selector: "div.content", score: 20, paragraphCount: 2, textLength: 150, scoreReasons: ["few_paragraphs"] },
        { selector: "main", score: 10, paragraphCount: 1, textLength: 80, scoreReasons: ["too_short"] },
      ],
      usedExpansion: false,
      expansionType: null,
      leadLikePenaltyApplied: false,
      stoppedAtText: "Related articles",
      stoppedAtClassOrId: "div.related",
      excludedBlockCount: 3,
    },
    ...overrides,
  });

  /** Returns a mock browser runtime unavailable result. */
  const makeBrowserUnavailable = () => ({
    ok: false as const,
    method: "none" as const,
    resolvedUrl: "https://example.com/a",
    statusCode: null as number | null,
    rejectedReason: "fetch_failed" as const,
    detail: "[browser_runtime_unavailable] Playwright not installed",
    confidence: 0,
    qualitySignals: ["browser_runtime_unavailable"],
    diagnostics: {
      selectedContainerSelector: null,
      selectedContainerScore: null,
      selectedContainerParagraphCount: null,
      selectedContainerTextLength: null,
      candidateContainerCount: 0,
      bodyRejectedReason: null,
      scoreReasons: [],
      excerptLength: null,
      bodyEqualsExcerpt: false,
      bodySource: "none" as const,
      linkTextRatio: null,
      boilerplatePenalty: null,
      topCandidates: [],
      usedExpansion: false,
      expansionType: null,
      leadLikePenaltyApplied: false,
    },
  });

  beforeEach(() => {
    vi.resetAllMocks();
    configureAgent3PrismaMocks();
    articleFindManyMock.mockResolvedValue([makeArticle({ id: 1 })]);
    articleUpdateMock.mockResolvedValue({ id: 0 });
    artifactCreateMock.mockResolvedValue({ id: "art-x" });
    artifactFindManyMock.mockResolvedValue([]);
    pipelineRunCreateMock.mockResolvedValue({ id: "run-bf" });
    pipelineRunUpdateMock.mockResolvedValue({});
    logAgentScanMock.mockResolvedValue(undefined);
    extractArticleContentWithBrowserMock.mockReset();
  });

  it("static SUCCESS does NOT call browser fallback", async () => {
    // Static extractor succeeds — browser fallback should never be attempted
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: true,
      method: "http-dom",
      resolvedUrl: "https://example.com/a",
      statusCode: 200,
      title: "Test Article",
      excerpt: "An excerpt",
      bodyText: "Good body text content. ".repeat(30),
      imageUrl: null,
      author: null,
      publishedAt: null,
      isPaywall: null,
      confidence: 0.7,
      qualitySignals: ["selector:article", "method:http-dom"],
      diagnostics: {
        selectedContainerSelector: "article",
        selectedContainerScore: 50,
        selectedContainerParagraphCount: 10,
        selectedContainerTextLength: 700,
        candidateContainerCount: 1,
        bodyRejectedReason: null,
        scoreReasons: ["many_paragraphs"],
        excerptLength: 12,
        bodyEqualsExcerpt: false,
        bodySource: "dom",
        linkTextRatio: 0.05,
        boilerplatePenalty: 0,
      },
    });
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserSuccess());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 3 });

    expect(result.persist.byKind.SUCCESS).toBe(1);
    expect(extractArticleContentWithBrowserMock).not.toHaveBeenCalled();
    // Browser stats should be all zeros
    expect(result.browserFallbackStats?.attempted).toBe(0);
  });

  it("static http_error 403 → browser fallback attempted; browser SUCCESS → final SUCCESS with bodyText persisted", async () => {
    // Static extractor fails with 403
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false,
      method: "http-dom",
      resolvedUrl: "https://example.com/a",
      statusCode: 403,
      rejectedReason: "http_error",
      detail: "HTTP 403 Forbidden",
      confidence: 0,
      qualitySignals: ["http_403"],
      diagnostics: {
        selectedContainerSelector: null,
        selectedContainerScore: null,
        selectedContainerParagraphCount: null,
        selectedContainerTextLength: null,
        candidateContainerCount: 0,
        bodyRejectedReason: null,
        scoreReasons: [],
        excerptLength: null,
        bodyEqualsExcerpt: false,
        bodySource: "none",
        linkTextRatio: null,
        boilerplatePenalty: null,
      },
    });

    // Browser fallback succeeds
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserSuccess());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const tracker = new StageBatchTelemetryTracker({
      orchestrationRunId: "run-test",
      stage: "agent3",
      batchSeq: 1,
      batchSizeLimit: 10,
      concurrencyLimit: 1,
      now: () => 1_750_000_000_000,
    });
    const result = await runEnrichmentBatch({
      browserFallback: true,
      browserFallbackMaxAttempts: 3,
      telemetry: tracker,
    });
    const actualWork = tracker.finalize({
      processed: 1, succeeded: 1, failedRetryable: 0, failedPermanent: 0,
      skipped: 0, deferred: 0, quarantined: 0,
      remainingBefore: 1, remainingAfter: 0, complete: true,
    });

    // Browser success → overall SUCCESS
    expect(result.persist.byKind.SUCCESS).toBe(1);
    expect(result.persist.byKind.UNSUPPORTED_STRUCTURE).toBe(0);

    // Browser fallback was attempted
    expect(result.browserFallbackStats?.attempted).toBe(1);
    expect(result.browserFallbackStats?.succeeded).toBe(1);
    expect(result.browserFallbackStats?.failed).toBe(0);

    // Verify browser extractor was called
    expect(extractArticleContentWithBrowserMock).toHaveBeenCalledTimes(1);
    expect(actualWork.networkRequests).toBe(1);
    expect(actualWork.browserAttempts).toBe(1);
    expect(result.httpEvidence).toEqual({
      static403: 1, static429: 0, browser403: 0, browser429: 0,
      accessDenied403: 1, rateLimited403: 0, rateLimited429: 0,
    });
    const summaryCall = pipelineRunUpdateMock.mock.calls.find(
      (call: any[]) => (call[0]?.data as Record<string, unknown>)?.summary !== undefined,
    );
    expect(summaryCall).toBeDefined();
    const summary = asObj(summaryCall![0].data.summary);
    expect(asObj(summary.browserFallbackStats)).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(asObj(summary.httpEvidence)).toEqual(result.httpEvidence);

    // Verify the outcome has browser fallback metadata
    const updateCalls = articleUpdateMock.mock.calls;
    const articleUpdate = updateCalls.find((c: any[]) => c[0]?.where?.id === 1);
    expect(articleUpdate).toBeDefined();
    // bodyText should be set from browser extraction
    expect(articleUpdate![0].data.bodyText).toBeTruthy();
  });

  it("treats a browser governor denial as a neutral claim release with no browser budget or final persistence", async () => {
    const originalMode = process.env.NUXT_DOMAIN_REQUEST_GOVERNOR_MODE;
    process.env.NUXT_DOMAIN_REQUEST_GOVERNOR_MODE = "enforce";
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false,
      method: "http-dom",
      resolvedUrl: "https://example.com/a",
      statusCode: 403,
      rejectedReason: "http_error",
      detail: "HTTP 403 Forbidden",
      confidence: 0,
      qualitySignals: ["http_403"],
      diagnostics: {
        selectedContainerSelector: null,
        selectedContainerScore: null,
        selectedContainerParagraphCount: null,
        selectedContainerTextLength: null,
        candidateContainerCount: 0,
        bodyRejectedReason: null,
        scoreReasons: [],
        excerptLength: null,
        bodyEqualsExcerpt: false,
        bodySource: "none",
        linkTextRatio: null,
        boilerplatePenalty: null,
      },
    });
    const tracker = new StageBatchTelemetryTracker({
      orchestrationRunId: "run-governor-denied",
      stage: "agent3",
      batchSeq: 1,
      batchSizeLimit: 10,
      concurrencyLimit: 1,
      now: () => 1_750_000_000_000,
    });

    try {
      const { runEnrichmentBatch } = await import("./enrichment-runtime");
      const result = await runEnrichmentBatch({
        browserFallback: true,
        browserFallbackMaxAttempts: 3,
        telemetry: tracker,
      });
      const actualWork = tracker.finalize({
        processed: 1,
        succeeded: 0,
        failedRetryable: 0,
        failedPermanent: 0,
        skipped: 0,
        deferred: 1,
        quarantined: 0,
        remainingBefore: 1,
        remainingAfter: 1,
        complete: false,
      });

      expect(result.governorDeferred).toBe(1);
      expect(result.persist.persisted).toBe(0);
      expect(result.browserFallbackStats).toMatchObject({ attempted: 0, succeeded: 0, failed: 0 });
      expect(extractArticleContentWithBrowserMock).not.toHaveBeenCalled();
      expect(actualWork.browserAttempts).toBe(0);
      expect(actualWork.networkRequests).toBe(0);
      expect(claimDeleteManyDirectMock).toHaveBeenCalled();
      expect(articleUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
        data: { enrichmentAttemptCount: { decrement: 1 } },
      }));
      expect(artifactDeleteManyMock).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ artifactType: "article_enrichment_attempt", status: "ATTEMPTED" }),
      }));
      const finalArtifacts = artifactCreateMock.mock.calls.filter(
        (call: any[]) => call[0]?.data?.artifactType === "article_enrichment_result",
      );
      expect(finalArtifacts).toHaveLength(0);
    } finally {
      if (originalMode === undefined) delete process.env.NUXT_DOMAIN_REQUEST_GOVERNOR_MODE;
      else process.env.NUXT_DOMAIN_REQUEST_GOVERNOR_MODE = originalMode;
    }
  });

  it("static HTTP 429 is a no-browser boundary and preserves retry evidence", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false,
      method: "http-dom",
      resolvedUrl: "https://example.com/a",
      statusCode: 429,
      rejectedReason: "http_error",
      detail: "HTTP 429 Too Many Requests",
      retryAfterAt: "2026-08-10T10:02:00.000Z",
      confidence: 0,
      qualitySignals: ["http_429"],
      diagnostics: {
        selectedContainerSelector: null,
        selectedContainerScore: null,
        selectedContainerParagraphCount: null,
        selectedContainerTextLength: null,
        candidateContainerCount: 0,
        bodyRejectedReason: null,
        scoreReasons: [],
        excerptLength: null,
        bodyEqualsExcerpt: false,
        bodySource: "none",
        linkTextRatio: null,
        boilerplatePenalty: null,
      },
    });

    // A static 429 must not invoke browser fallback at all.
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 3 });

    // Browser failed → static failure classified as HTTP_ACCESS_BLOCKED
    expect(result.persist.byKind.HTTP_ACCESS_BLOCKED).toBe(1);
    expect(result.persist.byKind.UNSUPPORTED_STRUCTURE).toBe(0);
    expect(result.browserFallbackStats?.attempted).toBe(0);
    expect(result.browserFallbackStats?.succeeded).toBe(0);
    expect(result.browserFallbackStats?.failed).toBe(0);
    expect(result.browserFallbackStats?.rateLimited).toBe(0);
    expect(extractArticleContentWithBrowserMock).not.toHaveBeenCalled();

    // Verify artifact payload has browser fallback metadata
    const createCalls = artifactCreateMock.mock.calls;
    const resultArtifact = createCalls.find(
      (c) => (c[0]?.data as Record<string, unknown>)?.artifactType === "article_enrichment_rejection",
    );
    expect(resultArtifact).toBeDefined();
    const payload = asObj((resultArtifact![0].data as Record<string, unknown>).payload);
    const bf = asObj(payload.browserFallback);
    expect(bf.attempted).toBe(false);
    expect(bf.succeeded).toBe(false);
    expect(bf.rateLimited).toBe(false);
    expect(bf.staticStatusCode).toBe(429);
    expect(asObj(payload.rejection).httpStatus).toBe(429);
    expect(asObj(payload.rejection).retryAfterAt).toBeDefined();
    expect(bf.staticRejectedReason).toBe("http_error");
  });

  it("persisted static 429 claim loss records no browser success counters or final writes", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false,
      method: "http-dom",
      resolvedUrl: "https://example.com/a",
      statusCode: 429,
      rejectedReason: "http_error",
      detail: "HTTP 429 Too Many Requests",
      retryAfterAt: "2026-08-10T10:02:00.000Z",
      confidence: 0,
      qualitySignals: ["http_429"],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null,
      },
    });
    claimDeleteManyMock.mockResolvedValue({ count: 0 });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true });

    expect(result.persist).toMatchObject({ persisted: 0, claimLost: 1, failed: 0 });
    expect(result.persist.byKind.HTTP_ACCESS_BLOCKED).toBe(0);
    expect(result.browserFallbackStats?.attempted).toBe(0);
    expect(result.browserFallbackStats?.succeeded).toBe(0);
    expect(result.browserFallbackStats?.failed).toBe(0);
    expect(result.browserFallbackStats?.rateLimited).toBe(0);
    expect(result.httpEvidence).toEqual({
      static403: 0, static429: 0, browser403: 0, browser429: 0,
      accessDenied403: 0, rateLimited403: 0, rateLimited429: 0,
    });
    const summaryCall = pipelineRunUpdateMock.mock.calls.find(
      (call: any[]) => (call[0]?.data as Record<string, unknown>)?.summary !== undefined,
    );
    expect(summaryCall).toBeDefined();
    expect(asObj(summaryCall![0].data.summary).httpEvidence).toEqual(result.httpEvidence);
    expect(extractArticleContentWithBrowserMock).not.toHaveBeenCalled();
    expect(articleUpdateMock).not.toHaveBeenCalled();
    expect(artifactCreateMock.mock.calls.some((call: any[]) =>
      call[0]?.data?.artifactType === "article_enrichment_rejection",
    )).toBe(false);
  });

  it("claim loss after a browser attempt keeps actual-work browserAttempts but durable counters at zero", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false,
      method: "http-dom",
      resolvedUrl: "https://example.com/a",
      statusCode: 403,
      rejectedReason: "http_error",
      detail: "HTTP 403 Forbidden",
      confidence: 0,
      qualitySignals: ["http_403"],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null,
      },
    });
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserFailure());
    claimDeleteManyMock.mockResolvedValue({ count: 0 });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const tracker = new StageBatchTelemetryTracker({
      orchestrationRunId: "run-test",
      stage: "agent3",
      batchSeq: 1,
      batchSizeLimit: 10,
      concurrencyLimit: 1,
      now: () => 1_750_000_000_000,
    });
    const result = await runEnrichmentBatch({
      browserFallback: true,
      browserFallbackMaxAttempts: 2,
      telemetry: tracker,
    });
    const actualWork = tracker.finalize({
      processed: 1, succeeded: 0, failedRetryable: 0, failedPermanent: 0,
      skipped: 0, deferred: 0, quarantined: 0, claimLost: 1,
      remainingBefore: 1, remainingAfter: 1, complete: false,
    });

    expect(extractArticleContentWithBrowserMock).toHaveBeenCalledTimes(1);
    expect(result.persist).toMatchObject({ persisted: 0, claimLost: 1, failed: 0 });
    expect(result.httpEvidence).toEqual({
      static403: 0, static429: 0, browser403: 0, browser429: 0,
      accessDenied403: 0, rateLimited403: 0, rateLimited429: 0,
    });
    expect(result.browserFallbackStats).toMatchObject({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      runtimeUnavailable: 0,
      rateLimited: 0,
    });
    // The runtime's returned durable counters stay zero; the separate stage
    // probe is the authority for physical browser work.
    expect(actualWork.browserAttempts).toBe(1);
    expect(actualWork.succeeded).toBe(0);
    expect(actualWork.claimLost).toBe(1);
    expect(articleUpdateMock).not.toHaveBeenCalled();
    expect(artifactCreateMock.mock.calls.some((call: any[]) =>
      call[0]?.data?.artifactType === "article_enrichment_rejection",
    )).toBe(false);
    expect(logAgentScanMock.mock.calls.some((call: any[]) =>
      ["ARTICLE_CONTENT_ENRICHMENT_SUCCESS", "ARTICLE_CONTENT_ENRICHMENT_FAILED"]
        .includes(call[0]?.status),
    )).toBe(false);
  });

  it("static 429 stops same-host browser recovery but leaves another host processable", async () => {
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1, sourceId: "src-rate-limited", canonicalUrl: "https://blocked.com/one", sourceUrl: "https://blocked.com/one" }),
      makeArticle({ id: 2, sourceId: "src-same-host", canonicalUrl: "https://blocked.com/two", sourceUrl: "https://blocked.com/two" }),
      makeArticle({ id: 3, sourceId: "src-other-host", canonicalUrl: "https://other.com/three", sourceUrl: "https://other.com/three" }),
    ]);
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => ({
      ok: false,
      method: "http-dom",
      resolvedUrl: input.articleUrl,
      statusCode: input.articleUrl.includes("blocked.com/one") ? 429 : 403,
      rejectedReason: "http_error",
      detail: input.articleUrl.includes("blocked.com/one") ? "HTTP 429 Too Many Requests" : "HTTP 403 Forbidden",
      confidence: 0,
      qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null,
      },
    }));
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserFailure());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({
      browserFallback: true,
      browserFallbackMaxAttempts: 2,
      maxArticlesPerSource: 10,
    });

    // The static 429 consumes no browser budget. The same-host second article
    // is skipped, while the independent host still gets one browser attempt.
    expect(extractArticleContentWithBrowserMock).toHaveBeenCalledTimes(1);
    expect(extractArticleContentWithBrowserMock.mock.calls[0]?.[0]?.articleUrl)
      .toBe("https://other.com/three");
    expect(result.browserFallbackStats?.attempted).toBe(1);
    expect(result.browserFallbackStats?.rateLimited).toBe(0);
    expect(result.persist.persisted).toBe(3);

    const rejectionPayloads = artifactCreateMock.mock.calls
      .filter((call: any[]) => call[0]?.data?.artifactType === "article_enrichment_rejection")
      .map((call: any[]) => asObj(call[0].data.payload));
    expect(rejectionPayloads.some((payload) =>
      asObj(payload.browserFallback).browserFallbackSkippedReason === "static_429_host",
    )).toBe(true);
  });

  it("observed static 429 stops same-host browser work even when first claim is lost", async () => {
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1, sourceId: "src-rate-limited", canonicalUrl: "https://blocked.com/one", sourceUrl: "https://blocked.com/one" }),
      makeArticle({ id: 2, sourceId: "src-sibling", canonicalUrl: "https://blocked.com/two", sourceUrl: "https://blocked.com/two" }),
      makeArticle({ id: 3, sourceId: "src-other", canonicalUrl: "https://other.com/three", sourceUrl: "https://other.com/three" }),
    ]);
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => ({
      ok: false,
      method: "http-dom",
      resolvedUrl: input.articleUrl,
      statusCode: input.articleUrl === "https://blocked.com/one" ? 429 : 403,
      rejectedReason: "http_error",
      detail: input.articleUrl === "https://blocked.com/one" ? "HTTP 429 Too Many Requests" : "HTTP 403 Forbidden",
      confidence: 0,
      qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null,
      },
    }));
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserFailure());
    claimDeleteManyMock.mockResolvedValue({ count: 0 });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 3 });

    // Same hostname is suppressed despite a different sourceId; the other
    // hostname remains independently browser-processable. Static 429 consumes
    // no browser budget and claim loss produces no durable outcome counters.
    expect(extractArticleContentWithBrowserMock).toHaveBeenCalledTimes(1);
    expect(extractArticleContentWithBrowserMock.mock.calls[0]?.[0]?.articleUrl)
      .toBe("https://other.com/three");
    expect(result.browserFallbackStats).toMatchObject({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
    });
    expect(result.persist).toMatchObject({ persisted: 0, claimLost: 3, failed: 0 });
    expect(articleUpdateMock).not.toHaveBeenCalled();
    expect(artifactCreateMock.mock.calls.some((call: any[]) =>
      call[0]?.data?.artifactType === "article_enrichment_rejection",
    )).toBe(false);
    expect(logAgentScanMock.mock.calls.some((call: any[]) =>
      ["ARTICLE_CONTENT_ENRICHMENT_SUCCESS", "ARTICLE_CONTENT_ENRICHMENT_FAILED"]
        .includes(call[0]?.status),
    )).toBe(false);
  });

  it("observed static 429 keeps the same-host stop after first persistence failure", async () => {
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1, sourceId: "src-rate-limited", canonicalUrl: "https://blocked.com/one", sourceUrl: "https://blocked.com/one" }),
      makeArticle({ id: 2, sourceId: "src-sibling", canonicalUrl: "https://blocked.com/two", sourceUrl: "https://blocked.com/two" }),
      makeArticle({ id: 3, sourceId: "src-other", canonicalUrl: "https://other.com/three", sourceUrl: "https://other.com/three" }),
    ]);
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => ({
      ok: false,
      method: "http-dom",
      resolvedUrl: input.articleUrl,
      statusCode: input.articleUrl === "https://blocked.com/one" ? 429 : 403,
      rejectedReason: "http_error",
      detail: input.articleUrl === "https://blocked.com/one" ? "HTTP 429 Too Many Requests" : "HTTP 403 Forbidden",
      confidence: 0,
      qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null,
      },
    }));
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserFailure());
    let failedFinalPersistence = false;
    artifactCreateMock.mockImplementation((args: any) => {
      if (args?.data?.artifactType === "article_enrichment_rejection" && !failedFinalPersistence) {
        failedFinalPersistence = true;
        throw new Error("simulated final rejection artifact persistence failure");
      }
      return { id: `artifact-${String(args?.data?.artifactType ?? "unknown")}` };
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 3 });

    expect(extractArticleContentWithBrowserMock).toHaveBeenCalledTimes(1);
    expect(extractArticleContentWithBrowserMock.mock.calls[0]?.[0]?.articleUrl)
      .toBe("https://other.com/three");
    expect(result.browserFallbackStats).toMatchObject({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      rateLimited: 0,
    });
    expect(result.httpEvidence).toEqual({
      static403: 2, static429: 0, browser403: 0, browser429: 0,
      accessDenied403: 2, rateLimited403: 0, rateLimited429: 0,
    });
    expect(result.persist.failed).toBe(1);
    expect(result.persist.persisted).toBe(2);
    expect(articleUpdateMock.mock.calls.some((call: any[]) => call[0]?.where?.id === 1)).toBe(false);
    expect(artifactCreateMock.mock.calls.some((call: any[]) =>
      call[0]?.data?.artifactType === "article_enrichment_rejection" &&
      (call[0]?.data?.payload as Record<string, unknown>)?.articleId === 1,
    )).toBe(false);
  });

  it("reports static_429_host and browserFallbackCouldHelp for a same-host HTTP 200 interstitial", async () => {
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1, sourceId: "src-rate-limited", canonicalUrl: "https://blocked.com/one", sourceUrl: "https://blocked.com/one" }),
      makeArticle({ id: 2, sourceId: "src-interstitial", canonicalUrl: "https://blocked.com/two", sourceUrl: "https://blocked.com/two" }),
    ]);
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => input.articleId === 1
      ? {
          ok: false, method: "http-dom", resolvedUrl: input.articleUrl, statusCode: 429,
          rejectedReason: "http_error", detail: "HTTP 429 Too Many Requests", confidence: 0,
          qualitySignals: [], diagnostics: {
            selectedContainerSelector: null, selectedContainerScore: null,
            selectedContainerParagraphCount: null, selectedContainerTextLength: null,
            candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
            excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
            linkTextRatio: null, boilerplatePenalty: null,
          },
        }
      : {
          ok: false, method: "http-dom", resolvedUrl: input.articleUrl, statusCode: 200,
          rejectedReason: "interstitial_or_challenge", detail: "Cookie challenge",
          confidence: 0, qualitySignals: ["http_200_interstitial"], diagnostics: {
            selectedContainerSelector: null, selectedContainerScore: null,
            selectedContainerParagraphCount: null, selectedContainerTextLength: null,
            candidateContainerCount: 0, bodyRejectedReason: "interstitial", scoreReasons: [],
            excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
            linkTextRatio: null, boilerplatePenalty: null,
          },
        });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true });
    const interstitialCall = artifactCreateMock.mock.calls.find((call: any[]) => {
      const data = call[0]?.data;
      return data?.artifactType === "article_enrichment_rejection" &&
        (data.payload as Record<string, unknown>)?.articleId === 2;
    });
    expect(interstitialCall).toBeDefined();
    const payload = asObj(interstitialCall![0].data.payload);
    expect(asObj(payload.browserFallback).browserFallbackSkippedReason).toBe("static_429_host");
    expect(asObj(payload.retryDiagnostics).browserFallbackCouldHelp).toBe(true);
    expect(extractArticleContentWithBrowserMock).not.toHaveBeenCalled();
    expect(result.persist.byKind.INTERSTITIAL_OR_CHALLENGE).toBe(1);
  });

  it("reports not_eligible for an inherently ineligible same-host failure", async () => {
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1, sourceId: "src-rate-limited", canonicalUrl: "https://blocked.com/one", sourceUrl: "https://blocked.com/one" }),
      makeArticle({ id: 2, sourceId: "src-paywall", canonicalUrl: "https://blocked.com/two", sourceUrl: "https://blocked.com/two" }),
    ]);
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => input.articleId === 1
      ? {
          ok: false, method: "http-dom", resolvedUrl: input.articleUrl, statusCode: 429,
          rejectedReason: "http_error", detail: "HTTP 429 Too Many Requests", confidence: 0,
          qualitySignals: [], diagnostics: {
            selectedContainerSelector: null, selectedContainerScore: null,
            selectedContainerParagraphCount: null, selectedContainerTextLength: null,
            candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
            excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
            linkTextRatio: null, boilerplatePenalty: null,
          },
        }
      : {
          ok: false, method: "http-dom", resolvedUrl: input.articleUrl, statusCode: 200,
          rejectedReason: "paywall_or_blocked", detail: "Article-specific access gate",
          confidence: 0, qualitySignals: [], diagnostics: {
            selectedContainerSelector: null, selectedContainerScore: null,
            selectedContainerParagraphCount: null, selectedContainerTextLength: null,
            candidateContainerCount: 0, bodyRejectedReason: "paywall", scoreReasons: [],
            excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
            linkTextRatio: null, boilerplatePenalty: null,
          },
        });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true });
    const paywallCall = artifactCreateMock.mock.calls.find((call: any[]) => {
      const data = call[0]?.data;
      return data?.artifactType === "article_enrichment_rejection" &&
        (data.payload as Record<string, unknown>)?.articleId === 2;
    });
    expect(paywallCall).toBeDefined();
    const payload = asObj(paywallCall![0].data.payload);
    expect(asObj(payload.browserFallback).browserFallbackSkippedReason).toBe("not_eligible");
    expect(asObj(payload.retryDiagnostics).browserFallbackCouldHelp).toBe(false);
    expect(extractArticleContentWithBrowserMock).not.toHaveBeenCalled();
    expect(result.persist.byKind.PAYWALL_BLOCKED).toBe(1);
  });

  it("browser 429 defers neutrally and stops later same-host browser attempts", async () => {
    // 3 articles, all fail with static 403, browser also fails with 429
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1 }),
      makeArticle({ id: 2, canonicalUrl: "https://example.com/b" }),
      makeArticle({ id: 3, canonicalUrl: "https://example.com/c" }),
    ]);

    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false, method: "http-dom", resolvedUrl: "https://example.com/a",
      statusCode: 403, rejectedReason: "http_error", detail: "HTTP 403", confidence: 0,
      qualitySignals: [],
      diagnostics: { selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null },
    });

    extractArticleContentWithBrowserMock.mockResolvedValue({
      ...makeBrowserFailure(), statusCode: 429, rejectedReason: "http_error",
      qualitySignals: ["browser_http_429"],
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    // maxAttempts=5 but rate limit threshold is 3
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 5 });

    // Browser 429 is actual work but a neutral durable boundary: the governor
    // owns cooldown state and Agent 3 records no persisted browser outcome.
    expect(extractArticleContentWithBrowserMock).toHaveBeenCalledTimes(1);
    expect(result.browserFallbackStats?.attempted).toBe(0);
    expect(result.browserFallbackStats?.rateLimited).toBe(0);
    expect(result.governorDeferred).toBe(1);
    expect(result.sourceCooldowns).toBeUndefined();
  });

  it("browser runtime unavailable stops browser fallback for the rest of the batch", async () => {
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1 }),
      makeArticle({ id: 2, canonicalUrl: "https://example.com/b" }),
    ]);

    // Static extractor fails with no_article_text
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false, method: "http-dom", resolvedUrl: "https://example.com/a",
      statusCode: 200, rejectedReason: "no_article_text", detail: "No text", confidence: 0,
      qualitySignals: [],
      diagnostics: { selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null },
    });

    // Browser runtime unavailable
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserUnavailable());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 3 });

    // Only first article attempted browser (runtime unavail stops further attempts)
    expect(result.browserFallbackStats?.attempted).toBe(1);
    expect(result.browserFallbackStats?.runtimeUnavailable).toBe(1);
    // Second article should NOT have been attempted
    expect(extractArticleContentWithBrowserMock).toHaveBeenCalledTimes(1);
  });

  it("browserFallbackMaxAttempts is respected and never exceeded", async () => {
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1 }),
      makeArticle({ id: 2, canonicalUrl: "https://example.com/b" }),
      makeArticle({ id: 3, canonicalUrl: "https://example.com/c" }),
      makeArticle({ id: 4, canonicalUrl: "https://example.com/d" }),
    ]);

    // All static extractions fail
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false, method: "http-dom", resolvedUrl: "https://example.com/a",
      statusCode: 403, rejectedReason: "http_error", detail: "HTTP 403", confidence: 0,
      qualitySignals: [],
      diagnostics: { selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null },
    });

    // Browser fallback also fails
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserFailure());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 2 });

    // maxAttempts=2, so only 2 browser attempts even though 4 articles failed
    expect(result.browserFallbackStats?.attempted).toBe(2);
    expect(extractArticleContentWithBrowserMock).toHaveBeenCalledTimes(2);
  });

  it("browserFallback=false preserves existing static rejection behavior", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false, method: "http-dom", resolvedUrl: "https://example.com/a",
      statusCode: 403, rejectedReason: "http_error", detail: "HTTP 403", confidence: 0,
      qualitySignals: [],
      diagnostics: { selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null },
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: false });

    // No browser fallback attempted
    expect(extractArticleContentWithBrowserMock).not.toHaveBeenCalled();
    expect(result.browserFallbackStats).toBeUndefined();
    // Static failure classified as HTTP_ACCESS_BLOCKED (403)
    expect(result.persist.byKind.HTTP_ACCESS_BLOCKED).toBe(1);
    expect(result.persist.byKind.UNSUPPORTED_STRUCTURE).toBe(0);
  });

  it("browser failure metadata includes browserDiagnostics in artifact payload", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false, method: "http-dom", resolvedUrl: "https://example.com/a",
      statusCode: 403, rejectedReason: "http_error", detail: "HTTP 403", confidence: 0,
      qualitySignals: [],
      diagnostics: { selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null },
    });

    // Browser fails with meaningful diagnostics
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserFailure());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 3 });

    // Find the rejection artifact
    const createCalls = artifactCreateMock.mock.calls;
    const rejectionArtifact = createCalls.find(
      (c) => (c[0]?.data as Record<string, unknown>)?.artifactType === "article_enrichment_rejection",
    );
    expect(rejectionArtifact).toBeDefined();
    const payload = asObj((rejectionArtifact![0].data as Record<string, unknown>).payload);
    const bf = asObj(payload.browserFallback);
    expect(bf.attempted).toBe(true);
    expect(bf.succeeded).toBe(false);
    // browserRejectedReason is set from the browser result's rejectedReason when not runtime-unavailable
    expect(bf.browserRejectedReason).toBe("no_article_text");

    // Browser diagnostics should be present
    const bd = asObj(bf.browserDiagnostics);
    expect(bd).toBeDefined();
    expect(bd.topCandidates).toBeDefined();
    // topCandidates should be capped at 5
    expect((bd.topCandidates as unknown[]).length).toBeLessThanOrEqual(5);
    // stoppedAtText should be capped
    if (bd.stoppedAtText) {
      expect((bd.stoppedAtText as string).length).toBeLessThanOrEqual(120);
    }
  });

  it("browser success updates extractorVersion to current version", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false, method: "http-dom", resolvedUrl: "https://example.com/a",
      statusCode: 403, rejectedReason: "http_error", detail: "HTTP 403", confidence: 0,
      qualitySignals: [],
      diagnostics: { selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null },
    });
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserSuccess());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true });

    // Verify the artifact payload uses current extractor version
    const createCalls = artifactCreateMock.mock.calls;
    const successArtifact = createCalls.find(
      (c) => (c[0]?.data as Record<string, unknown>)?.artifactType === "article_enrichment_result",
    );
    expect(successArtifact).toBeDefined();
    const payload = asObj((successArtifact![0].data as Record<string, unknown>).payload);
    expect(payload.extractorVersion).toBe(AGENT3_EXTRACTOR_VERSION);
    // Method should be browser-dom
    expect(asObj(payload.method).method).toBe("browser-dom");
    // Browser fallback metadata should be present
    const bf = asObj(payload.browserFallback);
    expect(bf.attempted).toBe(true);
    expect(bf.succeeded).toBe(true);
    expect(bf.staticRejectedReason).toBe("http_error");
  });

  it("persists browser fallback stats into PipelineRun.summary", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false, method: "http-dom", resolvedUrl: "https://example.com/a",
      statusCode: 403, rejectedReason: "http_error", detail: "HTTP 403", confidence: 0,
      qualitySignals: [],
      diagnostics: { selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null },
    });
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserSuccess());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 3, browserTimeoutMs: 20000 });

    // Verify PipelineRun.update was called with summary containing browser stats
    const updateCalls = pipelineRunUpdateMock.mock.calls;
    const summaryCall = updateCalls.find(
      (c) => (c[0]?.data as Record<string, unknown>)?.summary !== undefined,
    );
    expect(summaryCall).toBeDefined();
    const summary = asObj((summaryCall![0].data as Record<string, unknown>).summary);
    expect(summary.agent).toBe("enrichment");
    expect(summary.durationMs).toBeDefined();
    const bfs = asObj(summary.browserFallbackStats);
    expect(bfs.enabled).toBe(true);
    expect(bfs.attempted).toBe(1);
    expect(bfs.succeeded).toBe(1);
    expect(bfs.failed).toBe(0);
    const ou = asObj(summary.optionsUsed);
    expect(ou.browserFallback).toBe(true);
    expect(ou.browserFallbackMaxAttempts).toBe(3);
    expect(ou.browserTimeoutMs).toBe(20000);
  });

  it("getAgent3Progress parses browser fallback stats from persisted PipelineRun.summary", async () => {
    articleCountMock.mockResolvedValue(10);
    articleFindManyMock.mockResolvedValue([]);
    pipelineRunFindFirstMock.mockResolvedValue({
      id: "run-with-bfs",
      candidatesFound: 10,
      inserted: 3,
      skipped: 0,
      failed: 7,
      finishedAt: new Date("2026-07-29T10:00:00Z"),
      summary: {
        agent: "enrichment",
        articleCount: 10,
        persisted: 10,
        byKind: { SUCCESS: 3, LOW_CONTENT_QUALITY: 5, UNSUPPORTED_STRUCTURE: 2, HTTP_ACCESS_BLOCKED: 0 },
        durationMs: 45000,
        persistFailed: 0,
        browserFallbackStats: {
          enabled: true,
          attempted: 3,
          succeeded: 1,
          failed: 2,
          runtimeUnavailable: 0,
          rateLimited: 1,
          stoppedReason: "rate_limited",
        },
        optionsUsed: {
          browserFallback: true,
          browserFallbackMaxAttempts: 3,
          browserTimeoutMs: 25000,
          includeEnriched: true,
          forceReprocess: false,
          maxArticles: 50,
        },
      },
    });

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress();

    expect(progress.latestRun).not.toBeNull();
    expect(progress.latestRun!.browserFallbackStats).not.toBeNull();
    expect(progress.latestRun!.browserFallbackStats!.enabled).toBe(true);
    expect(progress.latestRun!.browserFallbackStats!.attempted).toBe(3);
    expect(progress.latestRun!.browserFallbackStats!.succeeded).toBe(1);
    expect(progress.latestRun!.browserFallbackStats!.failed).toBe(2);
    expect(progress.latestRun!.browserFallbackStats!.rateLimited).toBe(1);
    expect(progress.latestRun!.browserFallbackStats!.stoppedReason).toBe("rate_limited");

    expect(progress.latestRun!.optionsUsed).not.toBeNull();
    expect(progress.latestRun!.optionsUsed!.browserFallback).toBe(true);
    expect(progress.latestRun!.optionsUsed!.browserFallbackMaxAttempts).toBe(3);
    expect(progress.latestRun!.optionsUsed!.browserTimeoutMs).toBe(25000);
    expect(progress.latestRun!.optionsUsed!.includeEnriched).toBe(true);
  });

  it("getAgent3Progress handles missing browser stats gracefully", async () => {
    articleCountMock.mockResolvedValue(10);
    articleFindManyMock.mockResolvedValue([]);
    // Old run without browser stats
    pipelineRunFindFirstMock.mockResolvedValue({
      id: "run-old",
      candidatesFound: 5,
      inserted: 5,
      skipped: 0,
      failed: 0,
      finishedAt: new Date("2026-07-29T10:00:00Z"),
      summary: {
        articleCount: 5,
        persisted: 5,
        byKind: { SUCCESS: 5, LOW_CONTENT_QUALITY: 0, UNSUPPORTED_STRUCTURE: 0, HTTP_ACCESS_BLOCKED: 0 },
        // No agent, no browserFallbackStats, no optionsUsed
      },
    });

    const { getAgent3Progress } = await import("./enrichment-runtime");
    const progress = await getAgent3Progress();

    expect(progress.latestRun).not.toBeNull();
    // browserFallbackStats and optionsUsed should be null when absent
    expect(progress.latestRun!.browserFallbackStats).toBeNull();
    expect(progress.latestRun!.optionsUsed).toBeNull();
  });
});

describe("isBrowserFallbackEligibleForFailure", () => {
  it("eligible for http_error 403", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "http_error", statusCode: 403 })).toBe(true);
  });

  it("NOT eligible for http_error 429", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "http_error", statusCode: 429 })).toBe(false);
  });

  it("NOT eligible for http_error 500", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "http_error", statusCode: 500 })).toBe(false);
  });

  it("eligible for no_article_text", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "no_article_text", statusCode: 200 })).toBe(true);
  });

  it("eligible for empty_html", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "empty_html", statusCode: 200 })).toBe(true);
  });

  it("eligible for too_short", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "too_short", statusCode: 200 })).toBe(true);
  });

  it("NOT eligible for missing_article_url", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "missing_article_url", statusCode: null })).toBe(false);
  });

  it("NOT eligible for paywall_or_blocked", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "paywall_or_blocked", statusCode: 200 })).toBe(false);
  });

  it("NOT eligible for non_html_response", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "non_html_response", statusCode: 200 })).toBe(false);
  });

  it("NOT eligible for canonical_mismatch", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "canonical_mismatch", statusCode: 200 })).toBe(false);
  });

  it("NOT eligible for stale_or_invalid", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "stale_or_invalid", statusCode: null })).toBe(false);
  });

  it("NOT eligible for parse_error", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "parse_error", statusCode: 200 })).toBe(false);
  });

  it("NOT eligible for generic fetch_failed without signals", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({ rejectedReason: "fetch_failed", statusCode: null })).toBe(false);
  });

  it("eligible for fetch_failed with timeout detail", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({
      rejectedReason: "fetch_failed",
      statusCode: null,
      detail: "Request timeout after 30000ms",
    })).toBe(true);
  });

  it("eligible for fetch_failed with connection reset detail", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({
      rejectedReason: "fetch_failed",
      statusCode: null,
      detail: "read ECONNRESET",
    })).toBe(true);
  });

  it("eligible for fetch_failed with bot_blocked signal", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({
      rejectedReason: "fetch_failed",
      statusCode: null,
      qualitySignals: ["bot_blocked"],
    })).toBe(true);
  });

  it("NOT eligible for fetch_failed with unrelated detail", async () => {
    const { isBrowserFallbackEligibleForFailure } = await import("./article-content-browser-extractor");
    expect(isBrowserFallbackEligibleForFailure({
      rejectedReason: "fetch_failed",
      statusCode: null,
      detail: "DNS resolution failed for unknown host",
      qualitySignals: ["dns_error"],
    })).toBe(false);
  });
});

describe("applySourceDiversity", () => {
  it("round-robins articles across sources and caps per source", async () => {
    const { applySourceDiversity } = await import("./enrichment-runtime");
    const articles = [
      { sourceId: "src-1", id: 1 },
      { sourceId: "src-1", id: 2 },
      { sourceId: "src-1", id: 3 },
      { sourceId: "src-1", id: 4 },
      { sourceId: "src-1", id: 5 },
      { sourceId: "src-1", id: 6 },
      { sourceId: "src-2", id: 7 },
      { sourceId: "src-2", id: 8 },
      { sourceId: "src-3", id: 9 },
    ];

    // maxPerSource=5 should cap src-1 at 5
    const result = applySourceDiversity(articles, 5);

    // Total should be 5 (src-1 capped) + 2 (src-2) + 1 (src-3) = 8
    expect(result.length).toBe(8);
    expect(result.filter((a) => a.sourceId === "src-1").length).toBe(5);
    expect(result.filter((a) => a.sourceId === "src-2").length).toBe(2);
    expect(result.filter((a) => a.sourceId === "src-3").length).toBe(1);

    // Round-robin order: first 3 should be from different sources
    expect(result[0]!.sourceId).toBe("src-1");
    expect(result[1]!.sourceId).toBe("src-2");
    expect(result[2]!.sourceId).toBe("src-3");
  });

  it("clamps maxPerSource to MIN..MAX range", async () => {
    const { applySourceDiversity } = await import("./enrichment-runtime");
    const articles = Array.from({ length: 100 }, (_, i) => ({ sourceId: "src-1", id: i }));

    // maxPerSource=0 should be clamped to 1
    const result0 = applySourceDiversity(articles, 0);
    expect(result0.length).toBe(1);

    // maxPerSource=999 should be clamped to 25
    const result999 = applySourceDiversity(articles, 999);
    expect(result999.length).toBe(25);
  });

  it("backfills a bounded batch when the candidate pool is source-heavy", async () => {
    const { applySourceDiversity } = await import("./enrichment-runtime");
    const articles = [
      ...Array.from({ length: 12 }, (_, index) => ({ sourceId: "src-1", id: index + 1 })),
      ...Array.from({ length: 2 }, (_, index) => ({ sourceId: "src-2", id: index + 101 })),
    ];

    const result = applySourceDiversity(articles, 2, 10);

    expect(result).toHaveLength(10);
    expect(result.slice(0, 4).map((article) => article.sourceId)).toEqual([
      "src-1", "src-2", "src-1", "src-2",
    ]);
    expect(result.filter((article) => article.sourceId === "src-1")).toHaveLength(8);
  });

  it("preserves original order within each source group", async () => {
    const { applySourceDiversity } = await import("./enrichment-runtime");
    const articles = [
      { sourceId: "src-1", id: 10 },
      { sourceId: "src-1", id: 20 },
      { sourceId: "src-2", id: 30 },
      { sourceId: "src-2", id: 40 },
    ];

    const result = applySourceDiversity(articles, 5);
    const src1 = result.filter((a) => a.sourceId === "src-1");
    const src2 = result.filter((a) => a.sourceId === "src-2");
    expect(src1.map((a) => a.id)).toEqual([10, 20]);
    expect(src2.map((a) => a.id)).toEqual([30, 40]);
  });

  it("returns empty array for empty input", async () => {
    const { applySourceDiversity } = await import("./enrichment-runtime");
    expect(applySourceDiversity([], 5)).toEqual([]);
  });
});

describe("SourceCooldownTracker", () => {
  it("cools down a source after 3 consecutive HTTP 403 failures", async () => {
    const { SourceCooldownTracker } = await import("./enrichment-runtime");
    const tracker = new SourceCooldownTracker();

    // First two 403 failures: not cooled down yet
    expect(tracker.recordFailure("src-1", "example.com", "http_error", 403)).toBe(false);
    expect(tracker.isCoolingDown("src-1")).toBe(false);
    expect(tracker.recordFailure("src-1", "example.com", "http_error", 403)).toBe(false);
    expect(tracker.isCoolingDown("src-1")).toBe(false);

    // Third 403 failure: now cooled down
    expect(tracker.recordFailure("src-1", "example.com", "http_error", 403)).toBe(true);
    expect(tracker.isCoolingDown("src-1")).toBe(true);
  });

  it("cools down immediately on HTTP 429", async () => {
    const { SourceCooldownTracker } = await import("./enrichment-runtime");
    const tracker = new SourceCooldownTracker();

    expect(tracker.recordFailure("src-1", "example.com", "http_error", 429)).toBe(true);
    expect(tracker.isCoolingDown("src-1")).toBe(true);
  });

  it("success resets consecutive failure count", async () => {
    const { SourceCooldownTracker } = await import("./enrichment-runtime");
    const tracker = new SourceCooldownTracker();

    // Two 403 failures
    tracker.recordFailure("src-1", "example.com", "http_error", 403);
    tracker.recordFailure("src-1", "example.com", "http_error", 403);
    expect(tracker.isCoolingDown("src-1")).toBe(false);

    // Success resets the count
    tracker.recordSuccess("src-1");

    // Two more 403 failures should NOT trigger cooldown (counter was reset)
    tracker.recordFailure("src-1", "example.com", "http_error", 403);
    tracker.recordFailure("src-1", "example.com", "http_error", 403);
    expect(tracker.isCoolingDown("src-1")).toBe(false);
  });

  it("tracks skip counts for cooled-down sources", async () => {
    const { SourceCooldownTracker } = await import("./enrichment-runtime");
    const tracker = new SourceCooldownTracker();

    tracker.recordFailure("src-1", "example.com", "http_error", 429);
    expect(tracker.isCoolingDown("src-1")).toBe(true);

    // Track skips
    tracker.incrementSkip("src-1");
    tracker.incrementSkip("src-1");
    tracker.incrementSkip("src-1");

    const entries = tracker.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.sourceId).toBe("src-1");
    expect(entries[0]!.reason).toBe("http_429");
    expect(entries[0]!.skippedInRun).toBe(3);
  });

  it("returns empty entries when no cooldowns triggered", async () => {
    const { SourceCooldownTracker } = await import("./enrichment-runtime");
    const tracker = new SourceCooldownTracker();
    expect(tracker.getEntries()).toEqual([]);
  });

  it("ignores non-cooldown-eligible reasons", async () => {
    const { SourceCooldownTracker } = await import("./enrichment-runtime");
    const tracker = new SourceCooldownTracker();

    // paywall_or_blocked is not cooldown-eligible
    expect(tracker.recordFailure("src-1", "example.com", "paywall_or_blocked", null)).toBe(false);
    expect(tracker.isCoolingDown("src-1")).toBe(false);
  });
});

describe("isRecentlyBlocked", () => {
  it("returns false for INGESTED articles (never been tried)", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    expect(isRecentlyBlocked({
      enrichmentStatus: "INGESTED",
      enrichmentOutcome: null,
      enrichmentFinishedAt: null,
    })).toBe(false);
  });

  it("returns false for ENRICHMENT_FAILED without enrichmentOutcome", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: null,
      enrichmentFinishedAt: new Date(),
    })).toBe(false);
  });

  it("returns false for old extractor version", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: "old-version",
        rejection: { code: "UNKNOWN", detail: "[http_error] HTTP 403", httpStatus: 403 },
      },
      enrichmentFinishedAt: new Date(),
    })).toBe(false);
  });

  it("returns true for current-version HTTP 403 failure within 1h cooldown", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    // Finished 30 minutes ago — within 1h cooldown
    const finishedAt = new Date("2026-07-29T11:30:00Z");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        rejection: { code: "UNKNOWN", detail: "[http_error] HTTP 403 Forbidden", httpStatus: 403 },
      },
      enrichmentFinishedAt: finishedAt,
    }, now)).toBe(true);
  });

  it("returns false for HTTP 403 failure outside 1h cooldown", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    const now = new Date("2026-07-30T12:00:00Z");
    // Finished 25 hours ago — outside 1h cooldown
    const finishedAt = new Date("2026-07-29T11:00:00Z");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        rejection: { code: "UNKNOWN", detail: "[http_error] HTTP 403 Forbidden", httpStatus: 403 },
      },
      enrichmentFinishedAt: finishedAt,
    }, now)).toBe(false);
  });

  it("returns true for current-version HTTP 429 failure within 1h cooldown", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    const finishedAt = new Date("2026-07-29T11:30:00Z");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        rejection: { code: "UNKNOWN", detail: "[http_error] HTTP 429 Too Many Requests", httpStatus: 429 },
      },
      enrichmentFinishedAt: finishedAt,
    }, now)).toBe(true);
  });

  it("returns false for HTTP 429 failure outside 1h cooldown", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:30:00Z");
    // Finished 1.5 hours ago — outside 1h cooldown
    const finishedAt = new Date("2026-07-29T11:00:00Z");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        rejection: { code: "UNKNOWN", detail: "[http_error] HTTP 429", httpStatus: 429 },
      },
      enrichmentFinishedAt: finishedAt,
    }, now)).toBe(false);
  });

  it("returns true for browser runtime unavailable within 30min cooldown", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    const finishedAt = new Date("2026-07-29T11:45:00Z");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        rejection: { code: "UNKNOWN", detail: "[http_error] HTTP 403", httpStatus: 403 },
        browserFallback: { runtimeUnavailable: true, rateLimited: false },
      },
      enrichmentFinishedAt: finishedAt,
    }, now)).toBe(true);
  });

  it("returns false for ENRICHED articles even with current version", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        rejection: { code: "UNKNOWN", detail: "[http_error] HTTP 403", httpStatus: 403 },
      },
      enrichmentFinishedAt: new Date(),
    })).toBe(false);
  });

  it("returns true for row-summary HTTP 429 metadata without full rejection object", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        rejectionCode: "UNKNOWN",
        rejectionHttpStatus: 429,
        rejectionDetail: "[http_error] HTTP 429",
        browserFallback: { runtimeUnavailable: false, rateLimited: true, statusCode: 429 },
      },
      enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
    }, new Date("2026-07-29T12:00:00Z"))).toBe(true);
  });

  it("returns true for row-summary with kind HTTP_ACCESS_BLOCKED and rejectionCode HTTP_FORBIDDEN within 1h", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    // Finished 30 minutes ago — within 1h cooldown
    const finishedAt = new Date("2026-07-29T11:30:00Z");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejectionHttpStatus: 403,
        rejectionDetail: "[http_error] HTTP 403 Forbidden",
      },
      enrichmentFinishedAt: finishedAt,
    }, now)).toBe(true);
  });

  it("returns true for row-summary with kind HTTP_ACCESS_BLOCKED and 429 within 1h", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    const finishedAt = new Date("2026-07-29T11:30:00Z");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejectionHttpStatus: 429,
        rejectionDetail: "[http_error] HTTP 429 Too Many Requests",
        browserFallback: { runtimeUnavailable: false, rateLimited: true, statusCode: 429 },
      },
      enrichmentFinishedAt: finishedAt,
    }, now)).toBe(true);
  });

  it("returns false for kind HTTP_ACCESS_BLOCKED outside cooldown window", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    // 403 cooldown is 1h. Finished 25h ago.
    const now = new Date("2026-07-30T13:00:00Z");
    const finishedAt = new Date("2026-07-29T12:00:00Z");
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejectionHttpStatus: 403,
      },
      enrichmentFinishedAt: finishedAt,
    }, now)).toBe(false);
  });
});

describe("selectEnrichmentEligibleArticles with recently-blocked filter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configureAgent3PrismaMocks();
  });

  it("excludes current-version HTTP 403 ENRICHMENT_FAILED articles by default", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    // Two articles: one INGESTED (eligible), one recently-blocked ENRICHMENT_FAILED
    const now = new Date("2026-07-29T12:00:00Z");
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1, canonicalUrl: "https://fresh.example/a", enrichmentStatus: "INGESTED" }),
      makeArticle({
        id: 2,
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentOutcome: {
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          kind: "HTTP_ACCESS_BLOCKED",
          rejectionCode: "HTTP_FORBIDDEN",
          rejection: { code: "HTTP_FORBIDDEN", detail: "[http_error] HTTP 403", httpStatus: 403 },
        },
        enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
      }),
    ]);

    const articles = await selectEnrichmentEligibleArticles(now);
    // Article 2 should be filtered out (recently blocked)
    expect(articles.length).toBe(1);
    expect(articles[0]!.id).toBe(1);
  });

  it("excludes other articles on a hostname with an active current-version HTTP block", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    articleFindManyMock.mockResolvedValue([
      makeArticle({
        id: 1,
        canonicalUrl: "https://blocked.example/new",
        enrichmentStatus: "INGESTED",
      }),
      makeArticle({
        id: 2,
        canonicalUrl: "https://blocked.example/failed",
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentOutcome: {
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          kind: "HTTP_ACCESS_BLOCKED",
          rejectionCode: "HTTP_FORBIDDEN",
          rejection: { code: "HTTP_FORBIDDEN", detail: "[http_error] HTTP 403", httpStatus: 403 },
        },
        enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
      }),
      makeArticle({
        id: 3,
        canonicalUrl: "https://retry.example/ok",
        enrichmentStatus: "INGESTED",
      }),
    ]);

    const articles = await selectEnrichmentEligibleArticles(now);

    expect(articles.map((a) => a.id)).toEqual([3]);
  });

  it("includes recently-blocked articles when includeRecentlyBlocked=true", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1, canonicalUrl: "https://fresh.example/a", enrichmentStatus: "INGESTED" }),
      makeArticle({
        id: 2,
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentOutcome: {
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          kind: "HTTP_ACCESS_BLOCKED",
          rejectionCode: "HTTP_FORBIDDEN",
          rejection: { code: "HTTP_FORBIDDEN", detail: "[http_error] HTTP 403", httpStatus: 403 },
        },
        enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
      }),
    ]);

    const articles = await selectEnrichmentEligibleArticles(now, 50, { includeRecentlyBlocked: true });
    // Both articles should be included (includeRecentlyBlocked skips cooldown filter,
    // HTTP_ACCESS_BLOCKED passes retryable filter)
    expect(articles.length).toBe(2);
  });

  it("allows browser recovery for own HTTP 403 cooldown but not HTTP 429", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    articleFindManyMock.mockResolvedValue([
      makeArticle({
        id: 2,
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentOutcome: {
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          kind: "HTTP_ACCESS_BLOCKED",
          rejection: { code: "HTTP_FORBIDDEN", httpStatus: 403 },
        },
        enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
      }),
      makeArticle({
        id: 3,
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentOutcome: {
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          kind: "HTTP_ACCESS_BLOCKED",
          rejection: { code: "HTTP_429", httpStatus: 429 },
        },
        enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
      }),
    ]);

    const articles = await selectEnrichmentEligibleArticles(now, 2, {
      allowBrowserRecoveryDuringHttp403Cooldown: true,
    });

    expect(articles.map((article) => article.id)).toEqual([2]);
  });

  it("allows bounded browser recovery for a new sibling on an HTTP 403 host but not an HTTP 429 host", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    articleFindManyMock.mockResolvedValue([
      makeArticle({
        id: 1,
        canonicalUrl: "https://blocked.example/failed",
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentOutcome: {
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          kind: "HTTP_ACCESS_BLOCKED",
          rejection: { code: "HTTP_FORBIDDEN", httpStatus: 403 },
        },
        enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
      }),
      makeArticle({ id: 2, canonicalUrl: "https://blocked.example/new" }),
      makeArticle({
        id: 3,
        canonicalUrl: "https://limited.example/failed",
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentOutcome: {
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          kind: "HTTP_ACCESS_BLOCKED",
          rejection: { code: "HTTP_429", httpStatus: 429 },
        },
        enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
      }),
      makeArticle({ id: 4, canonicalUrl: "https://limited.example/new" }),
    ]);

    const normallySelected = await selectEnrichmentEligibleArticles(now, 1);
    const recoverySelected = await selectEnrichmentEligibleArticles(now, 1, {
      allowBrowserRecoveryDuringHttp403Cooldown: true,
    });

    expect(normallySelected).toEqual([]);
    expect(recoverySelected.map((article) => article.id)).toEqual([2]);
  });

  it("bypasses recently-blocked filter when explicit articleIds are provided", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    articleFindManyMock.mockResolvedValue([
      makeArticle({
        id: 2,
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentOutcome: {
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          kind: "HTTP_ACCESS_BLOCKED",
          rejectionCode: "HTTP_FORBIDDEN",
          rejection: { code: "HTTP_FORBIDDEN", detail: "[http_error] HTTP 403", httpStatus: 403 },
        },
        enrichmentFinishedAt: new Date("2026-07-29T11:00:00Z"),
      }),
    ]);

    const articles = await selectEnrichmentEligibleArticles(now, 50, { articleIds: [2] });
    // Explicit articleIds bypass both recently-blocked and retryable filters
    expect(articles.length).toBe(1);
    expect(articles[0]!.id).toBe(2);
  });
});

describe("browser fallback skipped reason in runEnrichmentBatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configureAgent3PrismaMocks();
    articleUpdateMock.mockResolvedValue({ id: 0 });
    artifactCreateMock.mockResolvedValue({ id: "art-x" });
    artifactFindManyMock.mockResolvedValue([]);
    pipelineRunCreateMock.mockResolvedValue({ id: "run-batch" });
    pipelineRunUpdateMock.mockResolvedValue({});
    logAgentScanMock.mockResolvedValue(undefined);
  });

  it("persists browserFallbackSkippedReason=max_attempts_exhausted when browser budget exhausted", async () => {
    const articles = [
      makeArticle({ id: 1, sourceId: "src-1", canonicalUrl: "https://blocked.com/1" }),
      makeArticle({ id: 2, sourceId: "src-2", canonicalUrl: "https://blocked.com/2" }),
      makeArticle({ id: 3, sourceId: "src-3", canonicalUrl: "https://blocked.com/3" }),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    extractArticleContentFromUrlMock.mockImplementation(async () => ({
      ok: false, method: "http-dom" as const, resolvedUrl: "https://blocked.com",
      statusCode: 403, rejectedReason: "http_error" as const,
      detail: "HTTP 403", confidence: 0, qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
        linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
        usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
        stoppedAtClassOrId: null, excludedBlockCount: 0,
      },
    }));

    // Browser fallback also fails
    extractArticleContentWithBrowserMock.mockResolvedValue({
      ok: false, method: "browser-dom", resolvedUrl: "https://blocked.com",
      statusCode: 403, rejectedReason: "http_error",
      detail: "Browser also got 403", confidence: 0, qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
        usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
        stoppedAtClassOrId: null, excludedBlockCount: 0,
      },
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({
      browserFallback: true,
      browserFallbackMaxAttempts: 1,
      maxArticlesPerSource: 10,
    });

    // 1 browser attempt used, 2 remaining articles should have skipped reason
    expect(result.browserFallbackStats!.attempted).toBe(1);

    // Check that the persisted artifacts include skipped reason
    const artifactCalls = artifactCreateMock.mock.calls;
    const resultArtifacts = artifactCalls.filter(
      (c) => (c[0]?.data as Record<string, unknown>)?.artifactType === "article_enrichment_rejection",
    );
    // Find artifacts with browserFallback metadata
    const withSkippedReason = resultArtifacts.filter((c) => {
      const payload = (c[0]?.data as Record<string, unknown>)?.payload as Record<string, unknown>;
      const bf = payload?.browserFallback as Record<string, unknown> | undefined;
      return bf?.browserFallbackSkippedReason === "max_attempts_exhausted";
    });
    expect(withSkippedReason.length).toBeGreaterThanOrEqual(1);
  });

  it("source cooldown skips articles entirely and records skippedInRun in summary", async () => {
    const articles = [
      ...Array.from({ length: 6 }, (_, i) => makeArticle({ id: i + 1, sourceId: "src-blocked", canonicalUrl: `https://blocked.com/${i + 1}` })),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    extractArticleContentFromUrlMock.mockImplementation(async () => ({
      ok: false, method: "http-dom" as const, resolvedUrl: "https://blocked.com",
      statusCode: 403, rejectedReason: "http_error" as const,
      detail: "HTTP 403", confidence: 0, qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
        linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
        usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
        stoppedAtClassOrId: null, excludedBlockCount: 0,
      },
    }));

    extractArticleContentWithBrowserMock.mockResolvedValue({
      ok: false, method: "browser-dom", resolvedUrl: "https://blocked.com",
      statusCode: 403, rejectedReason: "http_error",
      detail: "Browser 403", confidence: 0, qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
        usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
        stoppedAtClassOrId: null, excludedBlockCount: 0,
      },
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({
      browserFallback: true,
      browserFallbackMaxAttempts: 10,
      maxArticlesPerSource: 10,
    });

    // After 3 consecutive 403s, source cooldown kicks in.
    // Remaining articles from src-blocked are skipped entirely (no extraction, no artifact).
    // Extractor should have been called fewer times than total articles.
    const extractorCalls = extractArticleContentFromUrlMock.mock.calls;
    expect(extractorCalls.length).toBeLessThan(6);

    // Source cooldowns should be persisted with skippedInRun > 0
    expect(result.sourceCooldowns).toBeDefined();
    const blockedCooldown = result.sourceCooldowns!.find((c) => c.sourceId === "src-blocked");
    expect(blockedCooldown).toBeDefined();
    expect(blockedCooldown!.reason).toBe("http_403");
    expect(blockedCooldown!.skippedInRun).toBeGreaterThanOrEqual(1);
  });

  it("persists browserFallbackSkippedReason=not_eligible when failure is not browser-eligible", async () => {
    const articles = [
      makeArticle({ id: 1, sourceId: "src-1", canonicalUrl: "https://example.com/1" }),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    // Return a non-browser-eligible failure (paywall_or_blocked)
    extractArticleContentFromUrlMock.mockImplementation(async () => ({
      ok: false, method: "http-dom" as const, resolvedUrl: "https://example.com/1",
      statusCode: null, rejectedReason: "paywall_or_blocked" as const,
      detail: "Paywall detected", confidence: 0, qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
        linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
        usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
        stoppedAtClassOrId: null, excludedBlockCount: 0,
      },
    }));

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    await runEnrichmentBatch({
      browserFallback: true,
      browserFallbackMaxAttempts: 3,
      maxArticlesPerSource: 10,
    });

    const artifactCalls = artifactCreateMock.mock.calls;
    const resultArtifacts = artifactCalls.filter(
      (c) => (c[0]?.data as Record<string, unknown>)?.artifactType === "article_enrichment_rejection",
    );
    const withNotEligible = resultArtifacts.filter((c) => {
      const payload = (c[0]?.data as Record<string, unknown>)?.payload as Record<string, unknown>;
      const bf = payload?.browserFallback as Record<string, unknown> | undefined;
      return bf?.browserFallbackSkippedReason === "not_eligible";
    });
    expect(withNotEligible.length).toBeGreaterThanOrEqual(1);
  });
});

describe("extractHostname", () => {
  it("extracts hostname from a valid URL", async () => {
    const { extractHostname } = await import("./enrichment-runtime");
    expect(extractHostname("https://www.independent.ie/article/123")).toBe("www.independent.ie");
  });

  it("returns unknown for null URL", async () => {
    const { extractHostname } = await import("./enrichment-runtime");
    expect(extractHostname(null)).toBe("unknown");
  });

  it("returns unknown for malformed URL", async () => {
    const { extractHostname } = await import("./enrichment-runtime");
    expect(extractHostname("not-a-url")).toBe("unknown");
  });
});

describe("runEnrichmentBatch with source diversity and cooldown", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configureAgent3PrismaMocks();
    articleUpdateMock.mockResolvedValue({ id: 0 });
    artifactCreateMock.mockResolvedValue({ id: "art-x" });
    artifactFindManyMock.mockResolvedValue([]);
    pipelineRunCreateMock.mockResolvedValue({ id: "run-batch" });
    pipelineRunUpdateMock.mockResolvedValue({});
    logAgentScanMock.mockResolvedValue(undefined);
  });

  it("maxArticlesPerSource caps one blocked source, continues with others", async () => {
    // 10 articles from src-blocked, 3 from src-good
    // All from src-blocked return HTTP 403
    const articles = [
      ...Array.from({ length: 10 }, (_, i) => makeArticle({ id: i + 1, sourceId: "src-blocked", canonicalUrl: `https://blocked.com/${i + 1}` })),
      makeArticle({ id: 11, sourceId: "src-good", canonicalUrl: "https://good.com/1" }),
      makeArticle({ id: 12, sourceId: "src-good", canonicalUrl: "https://good.com/2" }),
      makeArticle({ id: 13, sourceId: "src-good", canonicalUrl: "https://good.com/3" }),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    let callCount = 0;
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => {
      callCount++;
      if (input.articleUrl?.includes("blocked.com")) {
        return {
          ok: false,
          method: "http-dom" as const,
          resolvedUrl: input.articleUrl,
          statusCode: 403,
          rejectedReason: "http_error" as const,
          detail: "HTTP 403 Forbidden",
          confidence: 0,
          qualitySignals: ["browser_http_403"],
          diagnostics: {
            selectedContainerSelector: null, selectedContainerScore: null,
            selectedContainerParagraphCount: null, selectedContainerTextLength: null,
            candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
            excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
            linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
            usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
            stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
            stoppedAtClassOrId: null, excludedBlockCount: 0,
          },
        };
      }
      return {
        ok: true,
        method: "http-dom" as const,
        resolvedUrl: input.articleUrl,
        statusCode: 200,
        title: input.existingTitle || "Title",
        excerpt: "An excerpt",
        bodyText: "Good body text content that is long enough. ".repeat(15),
        imageUrl: null,
        author: null,
        publishedAt: null,
        isPaywall: null,
        confidence: 0.8,
        qualitySignals: ["selector:article", "method:http-dom"],
        diagnostics: {
          selectedContainerSelector: "article", selectedContainerScore: 50,
          selectedContainerParagraphCount: 10, selectedContainerTextLength: 700,
          candidateContainerCount: 1, bodyRejectedReason: null,
          scoreReasons: ["many_paragraphs"], excerptLength: 12,
          bodyEqualsExcerpt: false, bodySource: "dom" as const,
          linkTextRatio: 0.05, boilerplatePenalty: 0, topCandidates: [],
          usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        },
      };
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    // maxArticlesPerSource=5: only 5 of the 10 blocked articles processed
    const result = await runEnrichmentBatch({ maxArticlesPerSource: 5 });

    // The blocked source enters cooldown after its first failure, so only
    // 3 blocked attempts plus the 3 good articles reach extraction.
    expect(result.articleCount).toBe(6);
    // All blocked articles should be HTTP_ACCESS_BLOCKED (403 → HTTP_FORBIDDEN)
    expect(result.persist.byKind.HTTP_ACCESS_BLOCKED).toBeGreaterThanOrEqual(3);
    expect(result.persist.byKind.UNSUPPORTED_STRUCTURE).toBe(0);
    // Good articles should succeed
    expect(result.persist.byKind.SUCCESS).toBe(3);
    // Source cooldowns should be persisted
    expect(result.sourceCooldowns).toBeDefined();
    expect(result.sourceCooldowns!.length).toBeGreaterThanOrEqual(1);
    expect(result.sourceCooldowns![0]!.sourceId).toBe("src-blocked");
  });

  it("3 HTTP 403 failures create in-run source cooldown, later articles skipped", async () => {
    // 6 articles from src-blocked, 2 from src-good
    const articles = [
      ...Array.from({ length: 6 }, (_, i) => makeArticle({ id: i + 1, sourceId: "src-blocked", canonicalUrl: `https://blocked.com/${i + 1}` })),
      makeArticle({ id: 7, sourceId: "src-good", canonicalUrl: "https://good.com/1" }),
      makeArticle({ id: 8, sourceId: "src-good", canonicalUrl: "https://good.com/2" }),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => {
      if (input.articleUrl?.includes("blocked.com")) {
        return {
          ok: false, method: "http-dom" as const, resolvedUrl: input.articleUrl,
          statusCode: 403, rejectedReason: "http_error" as const,
          detail: "HTTP 403", confidence: 0, qualitySignals: [],
          diagnostics: {
            selectedContainerSelector: null, selectedContainerScore: null,
            selectedContainerParagraphCount: null, selectedContainerTextLength: null,
            candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
            excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
            linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
            usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
            stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
            stoppedAtClassOrId: null, excludedBlockCount: 0,
          },
        };
      }
      return {
        ok: true, method: "http-dom" as const, resolvedUrl: input.articleUrl,
        statusCode: 200, title: "Good", excerpt: "Excerpt",
        bodyText: "Good body text that passes quality gate. ".repeat(15),
        imageUrl: null, author: null, publishedAt: null, isPaywall: null,
        confidence: 0.8, qualitySignals: ["selector:article"],
        diagnostics: {
          selectedContainerSelector: "article", selectedContainerScore: 50,
          selectedContainerParagraphCount: 10, selectedContainerTextLength: 700,
          candidateContainerCount: 1, bodyRejectedReason: null,
          scoreReasons: ["many_paragraphs"], excerptLength: 12,
          bodyEqualsExcerpt: false, bodySource: "dom" as const,
          linkTextRatio: 0.05, boilerplatePenalty: 0, topCandidates: [],
          usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        },
      };
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    // maxArticlesPerSource=10 so all 6 blocked articles are in the batch,
    // but cooldown kicks in after 3 consecutive 403s
    const result = await runEnrichmentBatch({ maxArticlesPerSource: 10 });

    // Cooldown should be recorded
    expect(result.sourceCooldowns).toBeDefined();
    const blockedCooldown = result.sourceCooldowns!.find((c) => c.sourceId === "src-blocked");
    expect(blockedCooldown).toBeDefined();
    expect(blockedCooldown!.reason).toBe("http_403");
    // Skipped articles should be > 0 (articles after 3rd failure)
    expect(blockedCooldown!.skippedInRun).toBeGreaterThanOrEqual(1);

    // Extractor should have been called fewer times than total blocked articles
    // (some were skipped due to cooldown)
    const extractorCalls = extractArticleContentFromUrlMock.mock.calls;
    const blockedCalls = extractorCalls.filter((c: any) => c[0].articleUrl?.includes("blocked.com"));
    expect(blockedCalls.length).toBeLessThan(6);

    // Good articles should still be processed
    expect(result.persist.byKind.SUCCESS).toBeGreaterThanOrEqual(2);
  });

  it("persists source cooldowns in PipelineRun.summary", async () => {
    const articles = [
      ...Array.from({ length: 5 }, (_, i) => makeArticle({ id: i + 1, sourceId: "src-403", canonicalUrl: `https://blocked.com/${i + 1}` })),
      makeArticle({ id: 6, sourceId: "src-good", canonicalUrl: "https://good.com/1" }),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => {
      if (input.articleUrl?.includes("blocked.com")) {
        return {
          ok: false, method: "http-dom" as const, resolvedUrl: input.articleUrl,
          statusCode: 403, rejectedReason: "http_error" as const,
          detail: "HTTP 403", confidence: 0, qualitySignals: [],
          diagnostics: {
            selectedContainerSelector: null, selectedContainerScore: null,
            selectedContainerParagraphCount: null, selectedContainerTextLength: null,
            candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
            excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
            linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
            usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
            stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
            stoppedAtClassOrId: null, excludedBlockCount: 0,
          },
        };
      }
      return {
        ok: true, method: "http-dom" as const, resolvedUrl: input.articleUrl,
        statusCode: 200, title: "Good", excerpt: "Excerpt",
        bodyText: "Good body. ".repeat(20), imageUrl: null, author: null,
        publishedAt: null, isPaywall: null, confidence: 0.8,
        qualitySignals: ["selector:article"],
        diagnostics: {
          selectedContainerSelector: "article", selectedContainerScore: 50,
          selectedContainerParagraphCount: 10, selectedContainerTextLength: 700,
          candidateContainerCount: 1, bodyRejectedReason: null,
          scoreReasons: ["many_paragraphs"], excerptLength: 12,
          bodyEqualsExcerpt: false, bodySource: "dom" as const,
          linkTextRatio: 0.05, boilerplatePenalty: 0, topCandidates: [],
          usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        },
      };
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    await runEnrichmentBatch({ maxArticlesPerSource: 10 });

    // Check that PipelineRun.update was called with cooldowns in the summary
    const updateCalls = pipelineRunUpdateMock.mock.calls;
    const runUpdate = updateCalls.find(
      (c) => (c[0]?.data as Record<string, unknown>)?.summary !== undefined,
    );
    expect(runUpdate).toBeDefined();
    const summary = asObj((runUpdate![0].data as Record<string, unknown>).summary);
    const cooldowns = summary.agent3SourceCooldowns;
    expect(Array.isArray(cooldowns)).toBe(true);
    expect((cooldowns as any[]).length).toBeGreaterThanOrEqual(1);
    expect((cooldowns as any[])[0].sourceId).toBe("src-403");
    expect((cooldowns as any[])[0].reason).toBe("http_403");
  });

  it("browser runtime unavailable stops browser attempts but not static processing", async () => {
    const articles = [
      makeArticle({ id: 1, sourceId: "src-1", canonicalUrl: "https://blocked.com/1" }),
      makeArticle({ id: 2, sourceId: "src-2", canonicalUrl: "https://blocked.com/2" }),
      makeArticle({ id: 3, sourceId: "src-3", canonicalUrl: "https://good.com/3" }),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => {
      if (input.articleUrl?.includes("blocked.com")) {
        return {
          ok: false, method: "http-dom" as const, resolvedUrl: input.articleUrl,
          statusCode: 403, rejectedReason: "http_error" as const,
          detail: "HTTP 403", confidence: 0, qualitySignals: [],
          diagnostics: {
            selectedContainerSelector: null, selectedContainerScore: null,
            selectedContainerParagraphCount: null, selectedContainerTextLength: null,
            candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
            excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
            linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
            usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
            stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
            stoppedAtClassOrId: null, excludedBlockCount: 0,
          },
        };
      }
      return {
        ok: true, method: "http-dom" as const, resolvedUrl: input.articleUrl,
        statusCode: 200, title: "Good", excerpt: "Excerpt",
        bodyText: "Good body. ".repeat(20), imageUrl: null, author: null,
        publishedAt: null, isPaywall: null, confidence: 0.8,
        qualitySignals: ["selector:article"],
        diagnostics: {
          selectedContainerSelector: "article", selectedContainerScore: 50,
          selectedContainerParagraphCount: 10, selectedContainerTextLength: 700,
          candidateContainerCount: 1, bodyRejectedReason: null,
          scoreReasons: ["many_paragraphs"], excerptLength: 12,
          bodyEqualsExcerpt: false, bodySource: "dom" as const,
          linkTextRatio: 0.05, boilerplatePenalty: 0, topCandidates: [],
          usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        },
      };
    });

    // Browser fallback returns runtime unavailable
    extractArticleContentWithBrowserMock.mockResolvedValue({
      ok: false, method: "none", resolvedUrl: "https://blocked.com", statusCode: null,
      rejectedReason: "fetch_failed", detail: "Runtime unavailable",
      confidence: 0, qualitySignals: ["browser_runtime_unavailable"],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
        usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
        stoppedAtClassOrId: null, excludedBlockCount: 0,
      },
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({
      browserFallback: true,
      browserFallbackMaxAttempts: 3,
      maxArticlesPerSource: 10,
    });

    // Browser should have been attempted once, then stopped
    expect(result.browserFallbackStats).toBeDefined();
    expect(result.browserFallbackStats!.attempted).toBeGreaterThanOrEqual(1);
    expect(result.browserFallbackStats!.runtimeUnavailable).toBeGreaterThanOrEqual(1);

    // Static extraction should still process all articles
    expect(result.articleCount).toBe(3);
  });

  it("browser fallback skipped reason appears when attempts exhausted", async () => {
    const articles = [
      makeArticle({ id: 1, sourceId: "src-1", canonicalUrl: "https://blocked.com/1" }),
      makeArticle({ id: 2, sourceId: "src-2", canonicalUrl: "https://blocked.com/2" }),
      makeArticle({ id: 3, sourceId: "src-3", canonicalUrl: "https://blocked.com/3" }),
      makeArticle({ id: 4, sourceId: "src-4", canonicalUrl: "https://blocked.com/4" }),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    extractArticleContentFromUrlMock.mockImplementation(async () => ({
      ok: false, method: "http-dom" as const, resolvedUrl: "https://blocked.com",
      statusCode: 403, rejectedReason: "http_error" as const,
      detail: "HTTP 403", confidence: 0, qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
        linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
        usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
        stoppedAtClassOrId: null, excludedBlockCount: 0,
      },
    }));

    // Browser fallback also fails
    extractArticleContentWithBrowserMock.mockResolvedValue({
      ok: false, method: "browser-dom", resolvedUrl: "https://blocked.com",
      statusCode: 403, rejectedReason: "http_error",
      detail: "Browser also got 403", confidence: 0, qualitySignals: [],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none",
        linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
        usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
        stoppedAtClassOrId: null, excludedBlockCount: 0,
      },
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({
      browserFallback: true,
      browserFallbackMaxAttempts: 2,
      maxArticlesPerSource: 10,
    });

    // Only 2 browser attempts allowed, but all 4 articles have HTTP 403 eligible for browser
    expect(result.browserFallbackStats!.attempted).toBe(2);
    expect(result.browserFallbackStats!.failed).toBe(2);

    // The pipeline run summary should have stoppedReason = max_attempts
    const updateCalls = pipelineRunUpdateMock.mock.calls;
    const runUpdate = updateCalls.find(
      (c) => (c[0]?.data as Record<string, unknown>)?.summary !== undefined,
    );
    const summary = asObj((runUpdate![0].data as Record<string, unknown>).summary);
    const bfs = asObj(summary.browserFallbackStats);
    expect(bfs.stoppedReason).toBe("max_attempts");
  });
});

describe("HTTP_ACCESS_BLOCKED source cooldown ordering", () => {
  /** Standard mock static extractor failure. */
  const makeStaticFailure = (overrides: Record<string, unknown> = {}) => ({
    ok: false as const,
    method: "http-dom" as const,
    resolvedUrl: "https://blocked.com/a",
    statusCode: 403 as number | null,
    rejectedReason: "http_error" as const,
    detail: "HTTP 403 Forbidden",
    confidence: 0,
    qualitySignals: ["http_403"],
    diagnostics: {
      selectedContainerSelector: null, selectedContainerScore: null,
      selectedContainerParagraphCount: null, selectedContainerTextLength: null,
      candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
      excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
      linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
      usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
      stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
      stoppedAtClassOrId: null, excludedBlockCount: 0,
    },
    ...overrides,
  });

  /** Standard mock browser extractor failure. */
  const makeBrowser429Failure = () => ({
    ok: false as const,
    method: "browser-dom" as const,
    resolvedUrl: "https://blocked.com/a",
    statusCode: 429 as number | null,
    rejectedReason: "http_error" as const,
    detail: "Browser got HTTP 429",
    confidence: 0,
    qualitySignals: ["browser_http_429"],
    diagnostics: {
      selectedContainerSelector: null, selectedContainerScore: null,
      selectedContainerParagraphCount: null, selectedContainerTextLength: null,
      candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
      excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
      linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
      usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
      stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
      stoppedAtClassOrId: null, excludedBlockCount: 0,
    },
  });

  beforeEach(() => {
    vi.resetAllMocks();
    configureAgent3PrismaMocks();
    articleUpdateMock.mockResolvedValue({ id: 0 });
    artifactCreateMock.mockResolvedValue({ id: "art-x" });
    artifactFindManyMock.mockResolvedValue([]);
    pipelineRunCreateMock.mockResolvedValue({ id: "run-test" });
    pipelineRunUpdateMock.mockResolvedValue({});
    logAgentScanMock.mockResolvedValue(undefined);
    pipelineRunFindFirstMock.mockResolvedValue(null);
  });

  it("static non-429 failure plus browser 429 defers without source cooldown side effects", async () => {
    // 3 articles from same source: static fails with no_article_text (not 429),
    // browser fallback returns 429 for the first article. Source cooldown
    // should be immediate (429), skipping articles 2 and 3.
    const articles = [
      makeArticle({ id: 1, sourceId: "src-blocked", canonicalUrl: "https://blocked.com/1" }),
      makeArticle({ id: 2, sourceId: "src-blocked", canonicalUrl: "https://blocked.com/2" }),
      makeArticle({ id: 3, sourceId: "src-blocked", canonicalUrl: "https://blocked.com/3" }),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    // Static extractor fails with no_article_text (not 429)
    extractArticleContentFromUrlMock.mockResolvedValue(
      makeStaticFailure({ statusCode: null, rejectedReason: "no_article_text", detail: "No article text found" }),
    );

    // Browser fallback returns 429
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowser429Failure());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({
      browserFallback: true,
      browserFallbackMaxAttempts: 5,
      maxArticlesPerSource: 10,
    });

    expect(extractArticleContentWithBrowserMock).toHaveBeenCalledTimes(1);
    expect(result.browserFallbackStats!.attempted).toBe(0);
    expect(result.browserFallbackStats!.rateLimited).toBe(0);
    expect(result.governorDeferred).toBe(1);
    expect(result.sourceCooldowns).toBeUndefined();
    expect(artifactCreateMock.mock.calls.some((call: any[]) =>
      call[0]?.data?.artifactType === "article_enrichment_rejection" &&
      (call[0]?.data?.payload as Record<string, unknown>)?.articleId === 1,
    )).toBe(false);
  });

  it("static 403 plus browser 429 creates no final Article outcome or source cooldown", async () => {
    // 2 articles from same source: static 403 + browser 429
    const articles = [
      makeArticle({ id: 1, sourceId: "src-blocked", canonicalUrl: "https://blocked.com/1" }),
      makeArticle({ id: 2, sourceId: "src-blocked", canonicalUrl: "https://blocked.com/2" }),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    // Static extractor fails with 403
    extractArticleContentFromUrlMock.mockResolvedValue(makeStaticFailure({ statusCode: 403 }));

    // Browser fallback returns 429
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowser429Failure());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({
      browserFallback: true,
      browserFallbackMaxAttempts: 5,
      maxArticlesPerSource: 10,
    });

    expect(result.governorDeferred).toBe(1);
    expect(result.browserFallbackStats).toMatchObject({ attempted: 0, rateLimited: 0 });
    expect(result.sourceCooldowns).toBeUndefined();
    expect(articleUpdateMock.mock.calls.some((call: any[]) => call[0]?.where?.id === 1)).toBe(false);
    expect(artifactCreateMock.mock.calls.some((call: any[]) =>
      call[0]?.data?.artifactType === "article_enrichment_rejection" &&
      (call[0]?.data?.payload as Record<string, unknown>)?.articleId === 1,
    )).toBe(false);
  });

  it("persisted outcome with HTTP_ACCESS_BLOCKED + httpStatus 429 is detected by isRecentlyBlocked within 1h cooldown", async () => {
    const { isRecentlyBlocked } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");

    // Simulates what the row summary would look like after classifyHttpAccessBlocked
    // ran and the outcome was persisted via serializeOutcomeSummary.    // Realistic scenario: static fetch got 403, browser got 429.
      // classifyHttpAccessBlocked updates httpStatus to 429 AND detail from "HTTP 403" to "HTTP 429".
      const summaryLike = {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejectionHttpStatus: 429,
        rejectionDetail: "[http_error] HTTP 429 Too Many Requests",
      browserFallback: {
        attempted: true,
        succeeded: false,
        runtimeUnavailable: false,
        rateLimited: true,
        statusCode: 429,
        browserRejectedReason: "http_error",
      },
    };

    // Within 1h cooldown → blocked
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: summaryLike,
      enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
    }, now)).toBe(true);

    // Outside 1h cooldown → not blocked
    expect(isRecentlyBlocked({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: summaryLike,
      enrichmentFinishedAt: new Date("2026-07-29T10:30:00Z"),
    }, now)).toBe(false);
  });

  it("pure static 403 without browser fallback preserves threshold-based source cooldown (3 failures)", async () => {
    // 5 articles from same source, all static 403, no browser fallback.
    // Cooldown should require 3 consecutive failures (threshold-based).
    const articles = [
      makeArticle({ id: 1, sourceId: "src-blocked", canonicalUrl: "https://blocked.com/1" }),
      makeArticle({ id: 2, sourceId: "src-blocked", canonicalUrl: "https://blocked.com/2" }),
      makeArticle({ id: 3, sourceId: "src-blocked", canonicalUrl: "https://blocked.com/3" }),
      makeArticle({ id: 4, sourceId: "src-blocked", canonicalUrl: "https://blocked.com/4" }),
      makeArticle({ id: 5, sourceId: "src-blocked", canonicalUrl: "https://blocked.com/5" }),
    ];
    articleFindManyMock.mockResolvedValue(articles);

    extractArticleContentFromUrlMock.mockResolvedValue(makeStaticFailure());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    // No browser fallback
    const result = await runEnrichmentBatch({ maxArticlesPerSource: 10 });

    // Source cooldown should be http_403 (threshold-based)
    expect(result.sourceCooldowns).toBeDefined();
    const blockedCooldown = result.sourceCooldowns!.find((c) => c.sourceId === "src-blocked");
    expect(blockedCooldown).toBeDefined();
    expect(blockedCooldown!.reason).toBe("http_403");

    // All outcomes should be HTTP_ACCESS_BLOCKED
    expect(result.persist.byKind.HTTP_ACCESS_BLOCKED).toBeGreaterThanOrEqual(3);
    expect(result.persist.byKind.UNSUPPORTED_STRUCTURE).toBe(0);

    // Extractor should have been called for at least 3 articles (threshold)
    // but fewer than 5 (cooldown kicks in after 3)
    const blockedCalls = extractArticleContentFromUrlMock.mock.calls
      .filter((c: any) => c[0].articleUrl?.includes("blocked.com"));
    expect(blockedCalls.length).toBeGreaterThanOrEqual(3);
    expect(blockedCalls.length).toBeLessThan(5);
  });
});

// ─── isAgent3FailureRetryableNow ────────────────────────────────────────────

describe("isAgent3FailureRetryableNow", () => {
  const now = new Date("2026-07-29T12:00:00Z");

  it("INGESTED → retryable true (not yet attempted)", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "INGESTED",
    }, now)).toBe(true);
  });

  it("ENRICHMENT_FAILED with no outcome → retryable true (legacy/unknown)", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: null,
    }, now)).toBe(true);
  });

  it("ENRICHMENT_FAILED with old extractorVersion → retryable true (version bump)", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: "old-extractor-v0",
        kind: "LOW_CONTENT_QUALITY",
        rejectionCode: "LOW_CONTENT_QUALITY",
      },
    }, now)).toBe(true);
  });

  it("ENRICHMENT_FAILED current version + LOW_CONTENT_QUALITY → retryable false", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "LOW_CONTENT_QUALITY",
        rejectionCode: "LOW_CONTENT_QUALITY",
        rejectionDetail: "[no_article_text] No meaningful body text could be extracted from the page.",
      },
    }, now)).toBe(false);
  });

  it("ENRICHMENT_FAILED current version + UNSUPPORTED_STRUCTURE → retryable false", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "UNSUPPORTED_STRUCTURE",
        rejectionCode: "UNSUPPORTED_STRUCTURE",
      },
    }, now)).toBe(false);
  });

  it("ENRICHMENT_FAILED current version + PAYWALL_BLOCKED → retryable false", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "PAYWALL_BLOCKED",
        rejectionCode: "PAYWALL_BLOCKED",
      },
    }, now)).toBe(false);
  });

  it("ENRICHMENT_FAILED current version + CANONICAL_MISMATCH → retryable false", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "CANONICAL_MISMATCH",
      },
    }, now)).toBe(false);
  });

  it("ENRICHMENT_FAILED current version + HTTP_ACCESS_BLOCKED 403 inside cooldown → retryable true (cooldown handled by isRecentlyBlocked)", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    // HTTP_ACCESS_BLOCKED is always retryable — cooldown exclusion is handled
    // separately by isRecentlyBlocked/recentlyBlocked in selection and progress.
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejectionHttpStatus: 403,
      },
      enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
    }, now)).toBe(true);
  });

  it("ENRICHMENT_FAILED current version + HTTP_ACCESS_BLOCKED 403 outside cooldown → retryable true", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejectionHttpStatus: 403,
      },
      enrichmentFinishedAt: new Date("2026-07-28T11:00:00Z"),
    }, now)).toBe(true);
  });

  it("ENRICHMENT_FAILED current version + HTTP_ACCESS_BLOCKED 429 inside cooldown → retryable true (cooldown handled by isRecentlyBlocked)", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    // HTTP_ACCESS_BLOCKED is always retryable — cooldown exclusion is handled
    // separately by isRecentlyBlocked/recentlyBlocked in selection and progress.
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejectionHttpStatus: 429,
      },
      enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
    }, now)).toBe(true);
  });

  it("ENRICHMENT_FAILED current version + HTTP_ACCESS_BLOCKED 429 outside cooldown → retryable true", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejectionHttpStatus: 429,
      },
      enrichmentFinishedAt: new Date("2026-07-29T10:00:00Z"),
    }, now)).toBe(true);
  });

  it("ENRICHMENT_FAILED current version + FETCH_TIMEOUT (rejectionCode) → retryable true", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "UNSUPPORTED_STRUCTURE",
        rejectionCode: "FETCH_TIMEOUT",
      },
    }, now)).toBe(true);
  });

  it("ENRICHMENT_FAILED current version + RETRYABLE_FAILURE kind → retryable true", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "RETRYABLE_FAILURE",
      },
    }, now)).toBe(true);
  });

  it("ENRICHMENT_FAILED current version + HEADLESS_REQUIRED → retryable false", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HEADLESS_REQUIRED",
      },
    }, now)).toBe(false);
  });

  it("ENRICHMENT_FAILED current version + UNKNOWN kind → retryable false", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "UNSUPPORTED_STRUCTURE",
        rejectionCode: "UNKNOWN",
      },
    }, now)).toBe(false);
  });

  it("ENRICHED status → retryable false (not applicable)", async () => {
    const { isAgent3FailureRetryableNow } = await import("./enrichment-runtime");
    expect(isAgent3FailureRetryableNow({
      enrichmentStatus: "ENRICHED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "SUCCESS",
      },
    }, now)).toBe(false);
  });
});

// ─── selectEnrichmentEligibleArticles with non-retryable filtering ──────────

describe("selectEnrichmentEligibleArticles with non-retryable filtering", () => {
  beforeEach(() => {
    articleCountMock.mockResolvedValue(0);
    pipelineRunFindFirstMock.mockResolvedValue(null);
    artifactFindManyMock.mockResolvedValue([]);
  });

  it("excludes current-version LOW_CONTENT_QUALITY/no_body_found by default", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const ingested = makeArticle({ id: 1, enrichmentStatus: "INGESTED" });
    const nonRetryable = makeArticle({
      id: 2,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "LOW_CONTENT_QUALITY",
        rejectionCode: "LOW_CONTENT_QUALITY",
        rejectionDetail: "[no_article_text] No meaningful body text could be extracted from the page.",
      },
    });
    articleFindManyMock.mockResolvedValue([ingested, nonRetryable]);

    const articles = await selectEnrichmentEligibleArticles(new Date(), 50);

    // Only the INGESTED article should be selected; non-retryable is filtered out
    expect(articles).toHaveLength(1);
    expect(articles[0]!.id).toBe(1);
  });

  it("forceReprocess=true includes non-retryable failures", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const ingested = makeArticle({ id: 1, enrichmentStatus: "INGESTED" });
    const nonRetryable = makeArticle({
      id: 2,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "LOW_CONTENT_QUALITY",
      },
    });
    articleFindManyMock.mockResolvedValue([ingested, nonRetryable]);

    const articles = await selectEnrichmentEligibleArticles(new Date(), 50, { forceReprocess: true });

    // Both should be included when forceReprocess is true
    expect(articles).toHaveLength(2);
  });

  it("explicit articleIds includes non-retryable failures", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const nonRetryable = makeArticle({
      id: 2,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "UNSUPPORTED_STRUCTURE",
      },
    });
    articleFindManyMock.mockResolvedValue([nonRetryable]);

    const articles = await selectEnrichmentEligibleArticles(new Date(), 50, { articleIds: [2] });

    // Should be included when explicit articleIds are provided
    expect(articles).toHaveLength(1);
    expect(articles[0]!.id).toBe(2);
  });

  it("old extractor version failed LOW_CONTENT_QUALITY is included (version bump retry)", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const oldVersion = makeArticle({
      id: 1,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentOutcome: {
        extractorVersion: "old-v0",
        kind: "LOW_CONTENT_QUALITY",
      },
    });
    articleFindManyMock.mockResolvedValue([oldVersion]);

    const articles = await selectEnrichmentEligibleArticles(new Date(), 50);

    // Old version failures should be retried
    expect(articles).toHaveLength(1);
    expect(articles[0]!.id).toBe(1);
  });

  it("recently blocked HTTP_ACCESS_BLOCKED is still excluded until cooldown expires (via recentlyBlocked, not retryable filter)", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    // Blocked article — finished 30 min ago, 403 cooldown is 24h
    const blocked = makeArticle({
      id: 1,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejection: { code: "HTTP_FORBIDDEN", detail: "[http_error] HTTP 403", httpStatus: 403 },
      },
    });
    articleFindManyMock.mockResolvedValue([blocked]);

    const articles = await selectEnrichmentEligibleArticles(now, 50);

    // Blocked article passes retryable filter (HTTP_ACCESS_BLOCKED always retryable)
    // but is excluded by recently-blocked filter (cooldown not expired)
    expect(articles).toHaveLength(0);
  });

  it("forceReprocess=true includes recently blocked HTTP_ACCESS_BLOCKED failures", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    const blocked = makeArticle({
      id: 1,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z"),
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejection: { code: "HTTP_FORBIDDEN", detail: "[http_error] HTTP 403", httpStatus: 403 },
      },
    });
    articleFindManyMock.mockResolvedValue([blocked]);

    const articles = await selectEnrichmentEligibleArticles(now, 50, { forceReprocess: true });

    expect(articles).toHaveLength(1);
    expect(articles[0]!.id).toBe(1);
  });

  it("expired HTTP_ACCESS_BLOCKED cooldown is included (retryable)", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    // Expired block — finished 25 hours ago, 403 cooldown is 24h
    const expired = makeArticle({
      id: 1,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentFinishedAt: new Date("2026-07-28T11:00:00Z"),
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "HTTP_ACCESS_BLOCKED",
        rejectionCode: "HTTP_FORBIDDEN",
        rejectionHttpStatus: 403,
      },
    });
    articleFindManyMock.mockResolvedValue([expired]);

    const articles = await selectEnrichmentEligibleArticles(now, 50);

    // Expired cooldown should be retried
    expect(articles).toHaveLength(1);
    expect(articles[0]!.id).toBe(1);
  });
});

// ─── getAgent3Progress with non-retryable counts ────────────────────────────

describe("getAgent3Progress with non-retryable counts", () => {
  beforeEach(() => {
    pipelineRunFindFirstMock.mockResolvedValue(null);
  });

  it("counts nonRetryableCurrentVersionFailures separately", async () => {
    const { getAgent3Progress } = await import("./enrichment-runtime");
    // total=20, INGESTED/FAILED=12, ENRICHED=8, FAILED=5
    articleCountMock.mockImplementation((args: any) => {
      if (!args?.where?.enrichmentStatus) return Promise.resolve(20);
      const status = args.where.enrichmentStatus;
      if (status === "ENRICHED") return Promise.resolve(8);
      if (status === "ENRICHMENT_FAILED") return Promise.resolve(5);
      if (status?.in?.includes("INGESTED") && status?.in?.includes("ENRICHMENT_FAILED")) return Promise.resolve(12);
      return Promise.resolve(0);
    });
    // 3 of 5 ENRICHMENT_FAILED are non-retryable (current version + permanent)
    // 2 need reprocess (ENRICHED with old version)
    const failedArticles = [
      { id: 10, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "LOW_CONTENT_QUALITY" }, enrichmentFinishedAt: new Date("2026-07-29T11:00:00Z") },
      { id: 11, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "UNSUPPORTED_STRUCTURE" }, enrichmentFinishedAt: new Date("2026-07-29T11:00:00Z") },
      { id: 12, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "PAYWALL_BLOCKED" }, enrichmentFinishedAt: new Date("2026-07-29T11:00:00Z") },
      { id: 13, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "HTTP_ACCESS_BLOCKED", rejectionCode: "HTTP_FORBIDDEN", rejectionHttpStatus: 403 }, enrichmentFinishedAt: new Date("2026-07-29T11:00:00Z") },
      { id: 14, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "HTTP_ACCESS_BLOCKED", rejectionCode: "HTTP_FORBIDDEN", rejectionHttpStatus: 429 }, enrichmentFinishedAt: new Date("2026-07-29T10:00:00Z") },
    ];
    articleFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.enrichmentStatus === "ENRICHED") {
        return Promise.resolve([
          { id: 100, bodyText: null, enrichmentOutcome: null },
          { id: 101, bodyText: "short", enrichmentOutcome: { extractorVersion: "old-v0" } },
          { id: 102, bodyText: "a" .repeat(600), enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION } },
          { id: 103, bodyText: "b" .repeat(600), enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION } },
          { id: 104, bodyText: "c" .repeat(600), enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION } },
          { id: 105, bodyText: "d" .repeat(600), enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION } },
          { id: 106, bodyText: "e" .repeat(600), enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION } },
          { id: 107, bodyText: "f" .repeat(600), enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION } },
        ]);
      }
      if (args?.where?.enrichmentStatus === "ENRICHMENT_FAILED") {
        return Promise.resolve(failedArticles);
      }
      // countBlockedEligibleArticles queries with { in: [...] } — return failed articles for blocked check
      if (args?.where?.enrichmentStatus?.in) {
        return Promise.resolve(failedArticles);
      }
      return Promise.resolve([]);
    });

    const progress = await getAgent3Progress({
      includeEnriched: false,
      now: new Date("2026-07-29T11:30:00Z"),
    });

    // nonRetryableCurrentVersionFailures = 3 (LOW_CONTENT, UNSUPPORTED, PAYWALL)
    // HTTP_ACCESS_BLOCKED items are always retryable (cooldown handled by recentlyBlocked)
    expect(progress.nonRetryableCurrentVersionFailures).toBe(3);

    // eligibleNow = (INGESTED + ENRICHMENT_FAILED) - nonRetryable = 12 - 3 = 9
    expect(progress.eligibleNow).toBe(9);

    // retryableNow = eligibleNow - recentlyBlocked
    // The 403 article (id 13) is recently blocked (30 min ago, 1h cooldown)
    // Its host gets excluded too. The 429 article (id 14) finished 2h ago (outside 1h cooldown) → not blocked.
    // So recentlyBlocked >= 1 (the 403 article itself + host exclusion)
    expect(progress.recentlyBlocked).toBeGreaterThanOrEqual(1);
    expect(progress.retryableNow).toBeLessThan(progress.eligibleNow);
  });

  it("eligibleNow/retryableNow excludes non-retryable current-version failures", async () => {
    const { getAgent3Progress } = await import("./enrichment-runtime");
    articleCountMock.mockImplementation((args: any) => {
      if (!args?.where?.enrichmentStatus) return Promise.resolve(10);
      const status = args.where.enrichmentStatus;
      if (status === "ENRICHED") return Promise.resolve(0);
      if (status === "ENRICHMENT_FAILED") return Promise.resolve(5);
      if (status?.in?.includes("INGESTED") && status?.in?.includes("ENRICHMENT_FAILED")) return Promise.resolve(8);
      return Promise.resolve(0);
    });
    articleFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.enrichmentStatus === "INGESTED") {
        return Promise.resolve([
          { id: 1, enrichmentStatus: "INGESTED", enrichmentAttemptCount: 0, enrichmentOutcome: null, canonicalUrl: "https://new.example/1", sourceUrl: null },
          { id: 2, enrichmentStatus: "INGESTED", enrichmentAttemptCount: 0, enrichmentOutcome: null, canonicalUrl: "https://new.example/2", sourceUrl: null },
          { id: 3, enrichmentStatus: "INGESTED", enrichmentAttemptCount: 0, enrichmentOutcome: null, canonicalUrl: "https://new.example/3", sourceUrl: null },
        ]);
      }
      if (args?.where?.enrichmentStatus === "ENRICHMENT_FAILED") {
        // All 5 are non-retryable (no HTTP_ACCESS_BLOCKED)
        return Promise.resolve([
          { id: 10, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "LOW_CONTENT_QUALITY" }, enrichmentFinishedAt: null },
          { id: 11, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "UNSUPPORTED_STRUCTURE" }, enrichmentFinishedAt: null },
          { id: 12, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "PAYWALL_BLOCKED" }, enrichmentFinishedAt: null },
          { id: 13, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "CANONICAL_MISMATCH" }, enrichmentFinishedAt: null },
          { id: 14, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "HEADLESS_REQUIRED" }, enrichmentFinishedAt: null },
        ]);
      }
      return Promise.resolve([]);
    });

    const progress = await getAgent3Progress({ includeEnriched: false });

    // 5 non-retryable out of 8 total needing initial enrichment
    // eligibleNow = 8 - 5 = 3
    // HEADLESS_REQUIRED is not actionable in the normal browser-disabled path.
    expect(progress.nonRetryableCurrentVersionFailures).toBe(5);
    expect(progress.eligibleNow).toBe(3);
    // No recently-blocked items (no HTTP_ACCESS_BLOCKED)
    expect(progress.recentlyBlocked).toBe(0);
    expect(progress.retryableNow).toBe(3);
  });

  it("recentlyBlocked remains separate from nonRetryableCurrentVersionFailures", async () => {
    const { getAgent3Progress } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    articleCountMock.mockImplementation((args: any) => {
      if (!args?.where?.enrichmentStatus) return Promise.resolve(10);
      const status = args.where.enrichmentStatus;
      if (status === "ENRICHED") return Promise.resolve(0);
      if (status === "ENRICHMENT_FAILED") return Promise.resolve(4);
      if (status?.in?.includes("INGESTED") && status?.in?.includes("ENRICHMENT_FAILED")) return Promise.resolve(6);
      return Promise.resolve(0);
    });
    const failedArticles2 = [
      // 2 non-retryable permanent failures
      { id: 10, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "LOW_CONTENT_QUALITY" }, enrichmentFinishedAt: null },
      { id: 11, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "UNSUPPORTED_STRUCTURE" }, enrichmentFinishedAt: null },
      // 1 recently blocked (403, 30 min ago — inside 1h cooldown)
      { id: 12, enrichmentStatus: "ENRICHMENT_FAILED", canonicalUrl: "https://blocked.example/failure", sourceUrl: null, enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "HTTP_ACCESS_BLOCKED", rejectionCode: "HTTP_FORBIDDEN", rejectionHttpStatus: 403 }, enrichmentFinishedAt: new Date("2026-07-29T11:30:00Z") },
      // 1 HTTP_ACCESS_BLOCKED 429 outside cooldown (finished 2h ago)
      { id: 13, enrichmentStatus: "ENRICHMENT_FAILED", enrichmentOutcome: { extractorVersion: AGENT3_EXTRACTOR_VERSION, kind: "HTTP_ACCESS_BLOCKED", rejectionCode: "HTTP_FORBIDDEN", rejectionHttpStatus: 429 }, enrichmentFinishedAt: new Date("2026-07-29T10:00:00Z") },
    ];
    const ingestedArticles = [
      { id: 1, enrichmentStatus: "INGESTED", enrichmentAttemptCount: 0, enrichmentOutcome: null, canonicalUrl: "https://blocked.example/new", sourceUrl: null },
      { id: 2, enrichmentStatus: "INGESTED", enrichmentAttemptCount: 0, enrichmentOutcome: null, canonicalUrl: "https://open.example/new", sourceUrl: null },
    ];
    articleFindManyMock.mockImplementation((args: any) => {
      if (args?.where?.enrichmentStatus === "INGESTED") {
        return Promise.resolve(ingestedArticles);
      }
      if (args?.where?.enrichmentStatus === "ENRICHMENT_FAILED") {
        return Promise.resolve(failedArticles2);
      }
      // countBlockedEligibleArticles queries with { in: [...] }
      if (args?.where?.enrichmentStatus?.in) {
        return Promise.resolve([...failedArticles2, ...ingestedArticles]);
      }
      return Promise.resolve([]);
    });

    const progress = await getAgent3Progress({ now, includeEnriched: false });

    // nonRetryable = 2 (LOW_CONTENT + UNSUPPORTED)
    // HTTP_ACCESS_BLOCKED items are always retryable (cooldown handled by recentlyBlocked)
    expect(progress.nonRetryableCurrentVersionFailures).toBe(2);

    // eligibleNow = 6 (INGESTED+FAILED) - 2 (nonRetryable) = 4
    expect(progress.eligibleNow).toBe(4);

    // recentlyBlocked: article 12 (403, 30 min ago → inside 1h cooldown) + host exclusion
    expect(progress.recentlyBlocked).toBeGreaterThanOrEqual(1);

    // Only the open-host NEW article and the expired-429 retry are actionable.
    expect(progress.retryableNow).toBe(2);
    expect(progress.readyNew).toBe(1);
    expect(progress.readyRetry).toBe(1);
    expect(progress.deferred).toBe(2);
    expect(progress.deferredByReason).toEqual({
      http_403: 2,
      http_429: 0,
      browser_runtime_unavailable: 0,
      interstitial_or_challenge: 0,
      other_retry: 0,
    });
  });
});

describe("collectAgent3HttpEvidence", () => {
  const outcomeWith = (browserFallback: Record<string, unknown> | null, staticStatus = 200) => ({
    browserFallback,
    rejection: { httpStatus: staticStatus },
  }) as unknown as ArticleEnrichmentOutcome;

  it("counts static 403 and browser 429 exactly once each", () => {
    expect(collectAgent3HttpEvidence(outcomeWith({
      attempted: true,
      staticStatusCode: 403,
      statusCode: 429,
    }))).toMatchObject({
      static403: 1,
      browser429: 1,
      accessDenied403: 1,
      rateLimited429: 1,
      rateLimited403: 0,
    });
  });

  it("preserves static 429 evidence when browser extraction succeeds", () => {
    expect(collectAgent3HttpEvidence(outcomeWith({
      attempted: true,
      succeeded: true,
      staticStatusCode: 429,
      statusCode: 200,
    }))).toMatchObject({
      static429: 1,
      browser429: 0,
      rateLimited429: 1,
      accessDenied403: 0,
    });
  });

  it("treats generic static and browser 403 responses as access denied, not rate limits", () => {
    expect(collectAgent3HttpEvidence(outcomeWith({
      attempted: true,
      staticStatusCode: 403,
      statusCode: 403,
    }))).toMatchObject({
      static403: 1,
      browser403: 1,
      accessDenied403: 2,
      rateLimited403: 0,
      rateLimited429: 0,
    });
  });
});

// ─── HTTP 202 interstitial/challenge recovery (Prompt 14) ───────────────────

describe("HTTP 202 INTERSTITIAL_OR_CHALLENGE recovery", () => {
  const makeInterstitialStaticFail = () => ({
    ok: false as const,
    method: "http-dom" as const,
    resolvedUrl: "https://example.com/a",
    statusCode: 202 as number | null,
    rejectedReason: "interstitial_or_challenge" as const,
    detail: "HTTP 202 response without a usable article body — page resembles an interstitial/challenge.",
    confidence: 0,
    qualitySignals: ["http_202_interstitial"],
    diagnostics: {
      selectedContainerSelector: null, selectedContainerScore: null,
      selectedContainerParagraphCount: null, selectedContainerTextLength: null,
      candidateContainerCount: 0, bodyRejectedReason: "interstitial_or_challenge",
      scoreReasons: [], excerptLength: null, bodyEqualsExcerpt: false,
      bodySource: "none" as const, linkTextRatio: null, boilerplatePenalty: null,
      topCandidates: [], usedExpansion: false, expansionType: null,
      leadLikePenaltyApplied: false, stopReason: null, boundaryMarkersSeen: 0,
      stoppedAtText: null, stoppedAtClassOrId: null, excludedBlockCount: 0,
      skippedCandidateReasons: [],
    },
  });

  const makeInterstitialBrowserFailure = () => ({
    ok: false as const,
    method: "browser-dom" as const,
    resolvedUrl: "https://example.com/a",
    statusCode: 202 as number | null,
    rejectedReason: "interstitial_or_challenge" as const,
    detail: "Browser also observed the interstitial.",
    confidence: 0,
    qualitySignals: ["browser_http_202"],
    diagnostics: {
      selectedContainerSelector: null, selectedContainerScore: null,
      selectedContainerParagraphCount: null, selectedContainerTextLength: null,
      candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
      excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
      linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
      usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
      stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
      stoppedAtClassOrId: null, excludedBlockCount: 0, skippedCandidateReasons: [],
    },
  });

  const makeBrowserSuccessLocal = (overrides: Record<string, unknown> = {}) => ({
    ok: true as const,
    method: "browser-dom" as const,
    resolvedUrl: "https://example.com/a",
    statusCode: 200,
    title: "Extracted Title",
    excerpt: "An excerpt",
    bodyText: "Browser-rendered body text content that is long enough to pass the minimum threshold. ".repeat(10),
    imageUrl: null,
    author: null,
    publishedAt: null,
    isPaywall: null,
    confidence: 0.8,
    qualitySignals: ["selector:article", "method:browser-dom", "bodyLength:800"],
    diagnostics: {
      selectedContainerSelector: "article", selectedContainerScore: 55,
      selectedContainerParagraphCount: 12, selectedContainerTextLength: 800,
      candidateContainerCount: 1, bodyRejectedReason: null, scoreReasons: [],
      excerptLength: 12, bodyEqualsExcerpt: false, bodySource: "dom" as const,
      linkTextRatio: 0.04, boilerplatePenalty: 0, topCandidates: [],
      usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
      stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
      stoppedAtClassOrId: null, excludedBlockCount: 0, skippedCandidateReasons: [],
    },
    ...overrides,
  });

  const findRejectionArtifact = () => {
    const createCalls = artifactCreateMock.mock.calls;
    const artifact = createCalls.find(
      (c) => (c[0]?.data as Record<string, unknown>)?.artifactType === "article_enrichment_rejection",
    );
    expect(artifact).toBeDefined();
    return asObj((artifact![0].data as Record<string, unknown>).payload);
  };

  beforeEach(() => {
    vi.resetAllMocks();
    configureAgent3PrismaMocks();
    articleFindManyMock.mockResolvedValue([makeArticle({ id: 1 })]);
    articleUpdateMock.mockResolvedValue({ id: 0 });
    artifactCreateMock.mockResolvedValue({ id: "art-x" });
    artifactFindManyMock.mockResolvedValue([]);
    pipelineRunCreateMock.mockResolvedValue({ id: "run-int" });
    pipelineRunUpdateMock.mockResolvedValue({});
    logAgentScanMock.mockResolvedValue(undefined);
    extractArticleContentWithBrowserMock.mockReset();
  });

  it("D: INTERSTITIAL_OR_CHALLENGE triggers one bounded browser attempt; browser success → SUCCESS", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue(makeInterstitialStaticFail());
    extractArticleContentWithBrowserMock.mockResolvedValue(makeBrowserSuccessLocal());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 3 });

    expect(extractArticleContentWithBrowserMock).toHaveBeenCalledTimes(1);
    expect(result.persist.byKind.SUCCESS).toBe(1);
    expect(result.persist.byKind.INTERSTITIAL_OR_CHALLENGE).toBe(0);
    expect(result.browserFallbackStats?.attempted).toBe(1);
    expect(result.browserFallbackStats?.succeeded).toBe(1);

    const createCalls = artifactCreateMock.mock.calls;
    const successArtifact = createCalls.find(
      (c) => (c[0]?.data as Record<string, unknown>)?.artifactType === "article_enrichment_result",
    );
    expect(successArtifact).toBeDefined();
    const payload = asObj((successArtifact![0].data as Record<string, unknown>).payload);
    expect(payload.kind).toBe("SUCCESS");
    const bf = asObj(payload.browserFallback);
    expect(bf.attempted).toBe(true);
    expect(bf.succeeded).toBe(true);
    expect(bf.staticRejectedReason).toBe("interstitial_or_challenge");
  });

  it("E: browser disabled → INTERSTITIAL_OR_CHALLENGE stays deferred with browser_disabled and retryAfterAt", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue(makeInterstitialStaticFail());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: false });

    expect(extractArticleContentWithBrowserMock).not.toHaveBeenCalled();
    expect(result.persist.byKind.INTERSTITIAL_OR_CHALLENGE).toBe(1);
    expect(result.persist.byKind.LOW_CONTENT_QUALITY).toBe(0);

    const payload = findRejectionArtifact();
    expect(payload.kind).toBe("INTERSTITIAL_OR_CHALLENGE");
    expect(asObj(payload.rejection).code).toBe("INTERSTITIAL_OR_CHALLENGE");
    const bf = asObj(payload.browserFallback);
    expect(bf.attempted).toBe(false);
    expect(bf.browserFallbackSkippedReason).toBe("browser_disabled");
    // Bounded retry time persisted on the rejection summary (30min interstitial cooldown).
    expect(typeof asObj(payload.rejection).retryAfterAt).toBe("string");
    expect(Number.isFinite(Date.parse(asObj(payload.rejection).retryAfterAt as string))).toBe(true);
    const rd = asObj(payload.retryDiagnostics);
    expect(rd.disposition).toBe("DEFERRED");
    expect(typeof rd.retryAfter).toBe("string");
    expect(rd.browserFallbackCouldHelp).toBe(true);
  });

  it("E2: recoverable interstitial persists publicationStatus=PROCESSING and reports deferred disposition counts", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue(makeInterstitialStaticFail());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: false });

    expect(result.persist.persisted).toBe(1);
    expect(result.persist.claimLost).toBe(0);
    expect(result.persist.failed).toBe(0);
    expect(result.persist.byKind.INTERSTITIAL_OR_CHALLENGE).toBe(1);
    // Authoritative retry-policy queue state: DEFERRED (30min interstitial
    // cooldown), not terminal — telemetry must never re-derive it from byKind.
    expect(result.interstitialDispositionCounts).toEqual({
      deferred: 1,
      quarantined: 0,
      readyRetry: 0,
      nonRetryable: 0,
    });

    // The persisted Article row keeps the recoverable interstitial in
    // PROCESSING (only a quarantined interstitial becomes REJECTED).
    const updateCall = articleUpdateMock.mock.calls.find((c: any[]) => c[0]?.where?.id === 1);
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data.publicationStatus).toBe("PROCESSING");
    expect(updateCall![0].data.publicationReadyAt).toBeNull();
  });

  it("14B-B: claim-lost DEFERRED interstitial contributes no persisted disposition telemetry", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue(makeInterstitialStaticFail());
    claimDeleteManyMock.mockImplementation(async (args: any) =>
      args?.where?.token ? { count: 0 } : { count: 0 },
    );

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: false });

    expect(result.persist).toMatchObject({
      persisted: 0,
      claimLost: 1,
      failed: 0,
      byKind: { INTERSTITIAL_OR_CHALLENGE: 0 },
    });
    expect(result.interstitialDispositionCounts).toEqual({
      deferred: 0,
      quarantined: 0,
      readyRetry: 0,
      nonRetryable: 0,
    });
  });

  it("14B-C-success: persisted READY_RETRY interstitial is counted once and stays PROCESSING", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    extractArticleContentFromUrlMock.mockResolvedValue({
      ...makeInterstitialStaticFail(),
      retryAfterAt: "2026-07-01T00:00:00.000Z",
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({
      browserFallback: false,
      now: new Date("2026-07-01T01:00:00.000Z"),
    });

    expect(result.persist).toMatchObject({
      persisted: 1,
      claimLost: 0,
      failed: 0,
      byKind: { INTERSTITIAL_OR_CHALLENGE: 1 },
    });
    expect(result.interstitialDispositionCounts).toEqual({
      deferred: 0,
      quarantined: 0,
      readyRetry: 1,
      nonRetryable: 0,
    });
    const updateCall = articleUpdateMock.mock.calls.find((c: any[]) => c[0]?.where?.id === 1);
    expect(updateCall?.[0]?.data?.publicationStatus).toBe("PROCESSING");
    const rejectionArtifact = artifactCreateMock.mock.calls.find((c: any[]) =>
      c[0]?.data?.artifactType === "article_enrichment_rejection",
    );
    expect(asObj((rejectionArtifact?.[0]?.data as Record<string, unknown>)?.payload).retryDiagnostics)
      .toMatchObject({ disposition: "READY_RETRY" });
  });

  it("14B-C: persistence-failed READY_RETRY interstitial contributes no persisted disposition telemetry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    extractArticleContentFromUrlMock.mockResolvedValue(makeInterstitialStaticFail());
    artifactCreateMock.mockImplementation(async (args: any) => {
      const type = args?.data?.artifactType;
      if (type === "article_enrichment_rejection") {
        throw new Error("artifact persistence failed");
      }
      return { id: "attempt-marker" };
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    // The persisted outcome finishes at 00:00 while the policy evaluates at
    // 01:00, so the exact computed state is READY_RETRY.
    const result = await runEnrichmentBatch({
      browserFallback: false,
      now: new Date("2026-07-01T01:00:00.000Z"),
    });

    expect(result.persist).toMatchObject({
      persisted: 0,
      claimLost: 0,
      failed: 1,
      byKind: { INTERSTITIAL_OR_CHALLENGE: 0 },
    });
    expect(result.interstitialDispositionCounts).toEqual({
      deferred: 0,
      quarantined: 0,
      readyRetry: 0,
      nonRetryable: 0,
    });
  });

  it("14B-D: persisted QUARANTINED interstitial is counted once and published as REJECTED", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue(makeInterstitialStaticFail());
    articleFindManyMock.mockResolvedValue([makeArticle({
      id: 1,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentAttemptCount: 2,
      enrichmentFinishedAt: new Date("2026-07-28T11:00:00.000Z"),
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "INTERSTITIAL_OR_CHALLENGE",
        rejectionCode: "INTERSTITIAL_OR_CHALLENGE",
      },
    })]);

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({
      browserFallback: false,
      now: new Date("2026-07-29T12:00:00.000Z"),
    });

    expect(result.persist).toMatchObject({
      persisted: 1,
      claimLost: 0,
      failed: 0,
      byKind: { INTERSTITIAL_OR_CHALLENGE: 1 },
    });
    expect(result.interstitialDispositionCounts).toEqual({
      deferred: 0,
      quarantined: 1,
      readyRetry: 0,
      nonRetryable: 0,
    });
    const updateCall = articleUpdateMock.mock.calls.find((c: any[]) => c[0]?.where?.id === 1);
    expect(updateCall?.[0]?.data?.publicationStatus).toBe("REJECTED");
  });

  it("14B-E: mixed persistence outcomes count only the persisted DEFERRED interstitial", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    extractArticleContentFromUrlMock.mockImplementation(async (input: any) => {
      if (input.articleId === 1) {
        return {
          ...makeInterstitialStaticFail(),
          retryAfterAt: "2026-07-29T23:00:00.000Z",
        };
      }
      if (input.articleId === 2) {
        return {
          ...makeInterstitialStaticFail(),
          retryAfterAt: "2026-07-29T00:00:00.000Z",
        };
      }
      return {
        ...makeInterstitialStaticFail(),
        retryAfterAt: "2026-07-29T00:00:00.000Z",
      };
    });
    articleFindManyMock.mockResolvedValue([
      makeArticle({ id: 1, sourceId: "src-1" }),
      makeArticle({ id: 2, sourceId: "src-2", canonicalUrl: "https://example.com/b", sourceUrl: "https://example.com/b" }),
      makeArticle({
        id: 3,
        sourceId: "src-3",
        canonicalUrl: "https://example.com/c",
        sourceUrl: "https://example.com/c",
        enrichmentStatus: "ENRICHMENT_FAILED",
        enrichmentAttemptCount: 2,
        enrichmentFinishedAt: new Date("2026-07-28T11:00:00.000Z"),
        enrichmentOutcome: {
          extractorVersion: AGENT3_EXTRACTOR_VERSION,
          kind: "INTERSTITIAL_OR_CHALLENGE",
          rejectionCode: "INTERSTITIAL_OR_CHALLENGE",
        },
      }),
    ]);
    claimDeleteManyMock.mockImplementation(async (args: any) => {
      if (!args?.where?.token) return { count: 0 };
      // Article 2 loses its claim; this is keyed by the actual persistence
      // request rather than loop position so the test proves per-article state.
      return { count: args.where.articleId === 2 ? 0 : 1 };
    });
    artifactCreateMock.mockImplementation(async (args: any) => {
      const payload = asObj(args?.data?.payload);
      if (
        args?.data?.artifactType === "article_enrichment_rejection" &&
        payload.articleId === 3
      ) {
        throw new Error("quarantined artifact persistence failed");
      }
      return { id: `artifact-${String(args?.data?.artifactType ?? "unknown")}` };
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({
      browserFallback: false,
      now: new Date("2026-07-29T12:00:00.000Z"),
    });

    expect(result.persist).toMatchObject({ persisted: 1, claimLost: 1, failed: 1 });
    expect(result.persist.byKind.INTERSTITIAL_OR_CHALLENGE).toBe(1);
    expect(result.interstitialDispositionCounts).toEqual({
      deferred: 1,
      quarantined: 0,
      readyRetry: 0,
      nonRetryable: 0,
    });
  });

  it("F: browser runtime unavailable → interstitial outcome stays deferred and respects the runtime cooldown", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue(makeInterstitialStaticFail());
    extractArticleContentWithBrowserMock.mockResolvedValue({
      ok: false as const,
      method: "none" as const,
      resolvedUrl: "https://example.com/a",
      statusCode: null,
      rejectedReason: "fetch_failed" as const,
      detail: "[browser_runtime_unavailable] Playwright not installed",
      confidence: 0,
      qualitySignals: ["browser_runtime_unavailable"],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
        linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
        usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
        stoppedAtClassOrId: null, excludedBlockCount: 0, skippedCandidateReasons: [],
      },
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 3 });

    expect(result.persist.byKind.INTERSTITIAL_OR_CHALLENGE).toBe(1);
    expect(result.browserFallbackStats?.runtimeUnavailable).toBe(1);
    const payload = findRejectionArtifact();
    const bf = asObj(payload.browserFallback);
    expect(bf.attempted).toBe(true);
    expect(bf.runtimeUnavailable).toBe(true);
    const rd = asObj(payload.retryDiagnostics);
    expect(rd.disposition).toBe("DEFERRED");
    expect(rd.reasonCode).toBe("BROWSER_RUNTIME_UNAVAILABLE");
    expect(typeof rd.retryAfter).toBe("string");
  });

  it("G: exhausted browser budget → no extra browser attempt, interstitial stays bounded by retry policy", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue(makeInterstitialStaticFail());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 0 });

    expect(extractArticleContentWithBrowserMock).not.toHaveBeenCalled();
    expect(result.persist.byKind.INTERSTITIAL_OR_CHALLENGE).toBe(1);
    const payload = findRejectionArtifact();
    const bf = asObj(payload.browserFallback);
    expect(bf.browserFallbackSkippedReason).toBe("max_attempts_exhausted");
    expect(asObj(payload.retryDiagnostics).disposition).toBe("DEFERRED");
  });

  it("G2: browser also sees the interstitial → outcome remains deferred, not terminal LOW_CONTENT_QUALITY", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue(makeInterstitialStaticFail());
    extractArticleContentWithBrowserMock.mockResolvedValue(makeInterstitialBrowserFailure());

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: true, browserFallbackMaxAttempts: 3 });

    expect(result.persist.byKind.INTERSTITIAL_OR_CHALLENGE).toBe(1);
    expect(result.persist.byKind.LOW_CONTENT_QUALITY).toBe(0);
    const payload = findRejectionArtifact();
    const bf = asObj(payload.browserFallback);
    expect(bf.attempted).toBe(true);
    expect(bf.succeeded).toBe(false);
    expect(bf.browserRejectedReason).toBe("interstitial_or_challenge");
    expect(asObj(payload.retryDiagnostics).disposition).toBe("DEFERRED");
  });

  it("I: HTTP 429 static failure is never classified as interstitial and keeps its cooldown", async () => {
    extractArticleContentFromUrlMock.mockResolvedValue({
      ok: false as const,
      method: "http-dom" as const,
      resolvedUrl: "https://example.com/a",
      statusCode: 429 as number | null,
      rejectedReason: "http_error" as const,
      detail: "[http_error] HTTP 429 Too Many Requests",
      confidence: 0,
      qualitySignals: ["http_429"],
      diagnostics: {
        selectedContainerSelector: null, selectedContainerScore: null,
        selectedContainerParagraphCount: null, selectedContainerTextLength: null,
        candidateContainerCount: 0, bodyRejectedReason: null, scoreReasons: [],
        excerptLength: null, bodyEqualsExcerpt: false, bodySource: "none" as const,
        linkTextRatio: null, boilerplatePenalty: null, topCandidates: [],
        usedExpansion: false, expansionType: null, leadLikePenaltyApplied: false,
        stopReason: null, boundaryMarkersSeen: 0, stoppedAtText: null,
        stoppedAtClassOrId: null, excludedBlockCount: 0, skippedCandidateReasons: [],
      },
    });

    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch({ browserFallback: false });

    expect(result.persist.byKind.HTTP_ACCESS_BLOCKED).toBe(1);
    expect(result.persist.byKind.INTERSTITIAL_OR_CHALLENGE).toBe(0);
    const payload = findRejectionArtifact();
    expect(asObj(payload.rejection).httpStatus).toBe(429);
  });

  it("H: interstitial attempt budget exhaustion → article quarantined, not retried indefinitely", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    articleFindManyMock.mockResolvedValue([makeArticle({
      id: 1,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentAttemptCount: 3,
      enrichmentFinishedAt: new Date("2026-07-29T11:00:00Z"),
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "INTERSTITIAL_OR_CHALLENGE",
        rejectionCode: "INTERSTITIAL_OR_CHALLENGE",
      },
    })]);

    const articles = await selectEnrichmentEligibleArticles(now, 50);
    expect(articles).toHaveLength(0);
  });

  it("J: same-run attempted interstitial articles remain excluded from selection", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    articleFindManyMock.mockResolvedValue([makeArticle({
      id: 1,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentAttemptCount: 1,
      enrichmentFinishedAt: new Date("2026-07-29T11:00:00Z"),
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "INTERSTITIAL_OR_CHALLENGE",
        rejectionCode: "INTERSTITIAL_OR_CHALLENGE",
      },
    })]);
    // Same-run attempt marker exists for article 1.
    artifactFindManyMock.mockResolvedValue([{ payload: { articleId: 1 } }]);

    const articles = await selectEnrichmentEligibleArticles(now, 50, { pipelineRunId: "run-1" });
    expect(articles).toHaveLength(0);
  });

  it("K: same-run final artifacts exclude retryable rows even when an attempt marker was unavailable", async () => {
    const { selectEnrichmentEligibleArticles } = await import("./enrichment-runtime");
    const now = new Date("2026-07-29T12:00:00Z");
    articleFindManyMock.mockResolvedValue([makeArticle({
      id: 1,
      enrichmentStatus: "ENRICHMENT_FAILED",
      enrichmentAttemptCount: 1,
      enrichmentFinishedAt: new Date("2026-07-29T11:00:00Z"),
      enrichmentOutcome: {
        extractorVersion: AGENT3_EXTRACTOR_VERSION,
        kind: "RETRYABLE_FAILURE",
        rejectionCode: "FETCH_TIMEOUT",
      },
    })]);
    artifactFindManyMock.mockResolvedValue([{ payload: { articleId: 1 } }]);

    const articles = await selectEnrichmentEligibleArticles(now, 50, { pipelineRunId: "run-1" });
    expect(articles).toHaveLength(0);
  });
});
