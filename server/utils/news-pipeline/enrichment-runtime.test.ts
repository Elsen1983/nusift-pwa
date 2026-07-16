import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleEnrichmentOutcome, ArticleUpstreamProvenance } from "./enrichment";

// ─── Mock prisma ────────────────────────────────────────────────────────────
const articleFindManyMock = vi.fn();
const articleUpdateMock = vi.fn();
const artifactCreateMock = vi.fn();
const artifactFindManyMock = vi.fn();
const pipelineRunCreateMock = vi.fn();
const pipelineRunUpdateMock = vi.fn();
const logAgentScanMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    article: {
      findMany: (...args: any[]) => articleFindManyMock(...args),
      update: (...args: any[]) => articleUpdateMock(...args),
    },
    pipelineArtifact: {
      create: (...args: any[]) => artifactCreateMock(...args),
      findMany: (...args: any[]) => artifactFindManyMock(...args),
    },
    pipelineRun: {
      create: (...args: any[]) => pipelineRunCreateMock(...args),
      update: (...args: any[]) => pipelineRunUpdateMock(...args),
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

describe("buildArticleProvenance", () => {
  it("builds upstream provenance from an Article row preserving source/category", async () => {
    const { buildArticleProvenance } = await import("./enrichment-runtime");
    const provenance = buildArticleProvenance(makeArticle());

    expect(provenance.sourceId).toBe("src-1");
    expect(provenance.categoryId).toBe("cat-1");
    expect(provenance.feedOrigin).toBe("rss"); // conservative default
    expect(provenance.discoveredFromCategoryFeed).toBe(true);
    expect(provenance.arrivedViaHardCaseRerun).toBe(false);
    expect(provenance.ingestedAt).toBe("2026-07-15T08:00:00.000Z");
  });

  it("sets discoveredFromCategoryFeed=false when categoryId is null", async () => {
    const { buildArticleProvenance } = await import("./enrichment-runtime");
    const provenance = buildArticleProvenance(makeArticle({ categoryId: null }));
    expect(provenance.discoveredFromCategoryFeed).toBe(false);
    expect(provenance.categoryId).toBeNull();
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
    articleFindManyMock.mockResolvedValue([makeArticle()]);
  });

  it("queries with the freshness cutoff + eligible statuses + capped take", async () => {
    const { selectEnrichmentEligibleArticles, MAX_ARTICLES_PER_RUN } = await import("./enrichment-runtime");
    const now = new Date("2026-07-16T12:00:00.000Z");
    const articles = await selectEnrichmentEligibleArticles(now);

    expect(articles).toHaveLength(1);
    expect(articleFindManyMock).toHaveBeenCalledTimes(1);
    const args = articleFindManyMock.mock.calls[0]![0];

    // cutoff is 7 days before now
    const cutoff = args.where.date.gte as Date;
    expect(cutoff.getTime()).toBe(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    );

    // eligible statuses
    expect(args.where.enrichmentStatus.in).toEqual(["INGESTED", "ENRICHMENT_FAILED"]);

    // capped at MAX_ARTICLES_PER_RUN
    expect(args.take).toBe(MAX_ARTICLES_PER_RUN);
  });

  it("clamps a custom limit to MAX_ARTICLES_PER_RUN", async () => {
    const { selectEnrichmentEligibleArticles, MAX_ARTICLES_PER_RUN } = await import("./enrichment-runtime");
    await selectEnrichmentEligibleArticles(new Date(), 9999);
    const args = articleFindManyMock.mock.calls[0]![0];
    expect(args.take).toBe(MAX_ARTICLES_PER_RUN);
  });
});

describe("recoverUpstreamProvenanceBatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("recovers precise provenance when Agent 1 ingest artifacts exist", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([
      {
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
    // arrivedViaHardCaseRerun falls back to false in Phase 1
    expect(provenance.arrivedViaHardCaseRerun).toBe(false);
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

  it("falls back to conservative defaults when no ingest artifacts exist", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockResolvedValue([]);

    const result = await recoverUpstreamProvenanceBatch([makeArticle()]);
    const provenance = result.get(42)!;

    // Conservative fallback
    expect(provenance.feedOrigin).toBe("rss");
    expect(provenance.feedUrl).toBeNull();
    expect(provenance.discoveredFromCategoryFeed).toBe(true);
    expect(provenance.arrivedViaHardCaseRerun).toBe(false);
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
    expect(provenance.feedOrigin).toBe("rss"); // conservative
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
    expect(provenance.feedOrigin).toBe("rss"); // conservative (no provenance on candidate)
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
    expect(provenance.feedOrigin).toBe("rss"); // conservative (no URL to match)
  });

  it("falls back when the DB query fails", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    artifactFindManyMock.mockRejectedValue(new Error("DB connection failed"));

    const result = await recoverUpstreamProvenanceBatch([makeArticle()]);
    const provenance = result.get(42)!;
    expect(provenance.feedOrigin).toBe("rss"); // conservative fallback
    expect(provenance.sourceId).toBe("src-1");
  });

  it("returns empty map for empty input", async () => {
    const { recoverUpstreamProvenanceBatch } = await import("./enrichment-runtime");
    const result = await recoverUpstreamProvenanceBatch([]);
    expect(result.size).toBe(0);
    expect(artifactFindManyMock).not.toHaveBeenCalled();
  });

  it("normalizes unknown feedOrigin values to rss", async () => {
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
    expect(result.get(42)!.feedOrigin).toBe("rss"); // "xml" is not valid
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

    expect(outcome.provenance.feedOrigin).toBe("rss");
    expect(outcome.provenance.feedUrl).toBeNull();
  });
});

describe("runEnrichmentBatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
  });

  it("selects articles, emits attempt markers, builds outcomes, persists them, and logs start/finish", async () => {
    const { runEnrichmentBatch } = await import("./enrichment-runtime");
    const result = await runEnrichmentBatch();

    expect(result.pipelineRunId).toBe("run-batch");
    expect(result.articleCount).toBe(2);
    // 1 SUCCESS + 1 SKIPPED (no URL)
    expect(result.persist.persisted).toBe(2);
    expect(result.persist.byKind.SUCCESS).toBe(1);
    expect(result.persist.byKind.SKIPPED).toBe(1);

    // article update called once per outcome
    expect(articleUpdateMock).toHaveBeenCalledTimes(2);
    // artifact create called: 2 attempt markers + 2 result artifacts
    expect(artifactCreateMock).toHaveBeenCalledTimes(4);

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
    expect(asObj(summary.byKind).SUCCESS).toBe(1);
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
    // Call order: marker-1 (fail), marker-2 (fail), result-1 (ok), result-2 (ok)
    artifactCreateMock
      .mockRejectedValueOnce(new Error("marker failed"))
      .mockRejectedValueOnce(new Error("marker failed"))
      .mockResolvedValueOnce({ id: "art-1" })
      .mockResolvedValueOnce({ id: "art-2" });

    const result = await runEnrichmentBatch();

    // Both outcomes should still be persisted despite marker failures
    expect(result.persist.persisted).toBe(2);
    expect(result.persist.byKind.SUCCESS).toBe(1);
    expect(result.persist.byKind.SKIPPED).toBe(1);
  });
});
