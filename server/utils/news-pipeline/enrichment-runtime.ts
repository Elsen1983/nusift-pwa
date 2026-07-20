import { prisma } from "../prisma";
import {
  buildFailureOutcome,
  buildHeadlessRequiredOutcome,
  buildSkippedOutcome,
  buildSuccessOutcome,
  createEnrichmentOutcome,
  type ArticleEnrichmentOutcome,
  type ArticleUpstreamProvenance,
  type EnrichmentTiming,
} from "./enrichment";
import {
  buildEnrichmentRunSummary,
  persistAttemptMarker,
  persistEnrichmentBatch,
  type EnrichmentBatchPersistResult,
} from "./enrichment-persist";
import { createPipelineRun } from "./artifacts";
import { logAgentScan } from "./log";

// ─────────────────────────────────────────────────────────────────────────────
// Agent 3 — Article enrichment runtime batch path (Phase 1)
// ─────────────────────────────────────────────────────────────────────────────
//
// Wires the canonical `ArticleEnrichmentOutcome` contract into a runnable
// batch: select eligible articles → recover precise upstream provenance from
// Agent 1 ingest artifacts → emit attempt markers → run a controlled stub
// extractor → persist outcomes (row summary + result artifact).
//
// The real HTTP extraction crawler is Phase 2 and is intentionally NOT
// implemented here. `stubExtractArticle` is a placeholder that exercises the
// full persistence contract end-to-end so Phase 2 only needs to swap in the
// real extractor. It is deliberately conservative: it SKIPS articles that are
// already enriched and otherwise emits a SUCCESS with feed-only provenance
// (no field overrides), so no real data is mutated destructively.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum article age considered eligible for enrichment (Agent 3 dev plan
 * §6.2: at most 7 days old).
 */
export const ENRICHMENT_FRESHNESS_DAYS = 7;

/**
 * Per-batch safety caps (Agent 3 dev plan §11: max concurrency / per-run limit).
 * Phase 1 runs sequentially, so MAX_ARTICLES_PER_RUN bounds the batch size.
 */
export const MAX_ARTICLES_PER_RUN = 50;

/**
 * Fields selected for enrichment eligibility + provenance construction.
 * Minimal select to keep DB reads cheap (Agent 3 dev plan §10).
 */
type EnrichmentEligibleArticle = {
  id: number;
  sourceId: string;
  categoryId: string | null;
  canonicalUrl: string | null;
  sourceUrl: string | null;
  title: string;
  bodyText: string | null;
  publishedAt: Date | null;
  isPaywall: boolean;
  createdAt: Date;
  enrichmentStatus: string;
  enrichmentAttemptCount: number;
};

/**
 * Select articles eligible for Agent 3 enrichment (dev plan §6.2):
 *  - successfully stored by Agent 1
 *  - at most ENRICHMENT_FRESHNESS_DAYS old
 *  - not yet successfully enriched, OR failed earlier for a retryable reason
 *
 * Uses the `Article_enrichmentStatus_date_idx` index added in Phase 1.
 * Capped at MAX_ARTICLES_PER_RUN per batch.
 */
export const selectEnrichmentEligibleArticles = async (
  now: Date = new Date(),
  limit: number = MAX_ARTICLES_PER_RUN,
): Promise<EnrichmentEligibleArticle[]> => {
  const cutoff = new Date(
    now.getTime() - ENRICHMENT_FRESHNESS_DAYS * 24 * 60 * 60 * 1000,
  );

  return prisma.article.findMany({
    where: {
      date: { gte: cutoff },
      // Eligible: never attempted, or retryable failure.
      // Already-enriched / skipped / queued-headless are excluded.
      enrichmentStatus: { in: ["INGESTED", "ENRICHMENT_FAILED"] },
    },
    select: {
      id: true,
      sourceId: true,
      categoryId: true,
      canonicalUrl: true,
      sourceUrl: true,
      title: true,
      bodyText: true,
      publishedAt: true,
      isPaywall: true,
      createdAt: true,
      enrichmentStatus: true,
      enrichmentAttemptCount: true,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(1, limit), MAX_ARTICLES_PER_RUN),
  });
};

/**
 * Build the upstream Agent 1 provenance object from an Article row.
 *
 * Agent 3 must NOT re-derive or overwrite upstream provenance — it preserves
 * traceability of where the article came from. The Article row does not store
 * the exact feed origin/feedUrl that Agent 1 recorded (that lives in the
 * ingest artifact payload), so we reconstruct a conservative provenance:
 *  - feedOrigin defaults to "rss" (the common case); a future Phase 2 can
 *    join the ingest artifact to recover the precise origin.
 *  - arrivedViaHardCaseRerun is unknown at the row level and left false; a
 *    future Phase 2 can recover it from the source/category discovery evidence.
 *  - ingestedAt = article.createdAt.
 *
 * This conservative reconstruction is safe because it never claims more
 * precision than the row actually holds.
 */
export const buildArticleProvenance = (
  article: EnrichmentEligibleArticle,
): ArticleUpstreamProvenance => ({
  sourceId: article.sourceId,
  categoryId: article.categoryId,
  // Article row does not persist the exact feed origin; default to "rss".
  // Phase 2 can recover the precise origin from the ingest PipelineArtifact.
  feedOrigin: "rss",
  feedUrl: null,
  discoveredFromCategoryFeed: Boolean(article.categoryId),
  arrivedViaHardCaseRerun: false,
  ingestedAt: article.createdAt.toISOString(),
});

/**
 * Recover precise upstream provenance from Agent 1 ingest artifacts.
 *
 * Queries the most recent `rss_candidates` PipelineArtifact for each
 * unique sourceId in the batch, then looks up the matching candidate by
 * canonicalUrl to extract the exact feed origin, feed URL, and
 * discoveredFromCategoryFeed flag that Agent 1 recorded.
 *
 * Falls back to the conservative `buildArticleProvenance` defaults when:
 *  - no ingest artifact exists for the source
 *  - no candidate matches the article's canonicalUrl
 *  - the candidate provenance is malformed
 *  - any DB query fails
 *
 * `arrivedViaHardCaseRerun` falls back to `false` (the conservative default)
 * because determining it precisely requires cross-referencing pipeline run
 * timelines, which is deferred to Phase 2.
 *
 * Returns a Map from article.id → recovered provenance.
 */
export const recoverUpstreamProvenanceBatch = async (
  articles: EnrichmentEligibleArticle[],
): Promise<Map<number, ArticleUpstreamProvenance>> => {
  const result = new Map<number, ArticleUpstreamProvenance>();

  if (articles.length === 0) return result;

  const sourceIds = [...new Set(articles.map((a) => a.sourceId))];

  try {
    // Pre-fetch all ingest artifacts for these sources in a single query.
    // Ordered by recency so the first payload per sourceId is the most recent.
    const ingestArtifacts = await prisma.pipelineArtifact.findMany({
      where: {
        sourceId: { in: sourceIds },
        artifactType: "rss_candidates",
        status: "CAPTURED",
      },
      orderBy: { createdAt: "desc" },
      select: { sourceId: true, payload: true },
    });

    // Build lookup: sourceId → list of payloads (most recent first).
    // We search through all payloads for the source because an article
    // may have been ingested in an earlier run, not just the most recent.
    // Note: PipelineArtifact.sourceId is nullable; filter out nulls.
    const ingestBySource = new Map<string, Array<Record<string, unknown>>>();
    for (const artifact of ingestArtifacts) {
      if (!artifact.sourceId) continue;
      const existing = ingestBySource.get(artifact.sourceId) ?? [];
      existing.push(artifact.payload as Record<string, unknown>);
      ingestBySource.set(artifact.sourceId, existing);
    }

    const validOrigins: ReadonlySet<string> = new Set([
      "rss",
      "atom",
      "json",
      "html_fallback",
      "web_discovery",
    ]);

    for (const article of articles) {
      const conservative = buildArticleProvenance(article);
      const articleUrl = article.canonicalUrl || article.sourceUrl;

      if (!articleUrl) {
        result.set(article.id, conservative);
        continue;
      }

      const payloads = ingestBySource.get(article.sourceId);
      if (!payloads || payloads.length === 0) {
        result.set(article.id, conservative);
        continue;
      }

      // Search through artifacts (most recent first) for the matching candidate.
      let matched = false;
      for (const payload of payloads) {
        const candidates = Array.isArray(payload.candidates)
          ? (payload.candidates as Array<Record<string, unknown>>)
          : [];

        const match = candidates.find(
          (c) => c?.canonicalUrl === articleUrl || c?.canonicalUrl === article.canonicalUrl,
        );

        if (!match || typeof match.provenance !== "object" || match.provenance === null) {
          continue;
        }

        const prov = match.provenance as Record<string, unknown>;
        const origin = typeof prov.origin === "string" ? prov.origin : null;

        result.set(article.id, {
          sourceId: article.sourceId,
          categoryId: article.categoryId,
          feedOrigin: origin && validOrigins.has(origin)
            ? (origin as ArticleUpstreamProvenance["feedOrigin"])
            : "rss",
          feedUrl: typeof prov.feedUrl === "string" ? prov.feedUrl : null,
          discoveredFromCategoryFeed:
            typeof prov.discoveredFromCategoryFeed === "boolean"
              ? prov.discoveredFromCategoryFeed
              : Boolean(article.categoryId),
          // Phase 1 conservative fallback: precise hard-case detection requires
          // cross-referencing pipeline run timelines, deferred to Phase 2.
          arrivedViaHardCaseRerun: false,
          ingestedAt: article.createdAt.toISOString(),
        });
        matched = true;
        break;
      }

      if (!matched) {
        result.set(article.id, conservative);
      }
    }
  } catch {
    // DB query failed — fall back to conservative provenance for all articles.
    for (const article of articles) {
      if (!result.has(article.id)) {
        result.set(article.id, buildArticleProvenance(article));
      }
    }
  }

  return result;
};

/**
 * Controlled stub extractor (Phase 1 placeholder).
 *
 * This is NOT a real extractor. It exercises the full persistence contract
 * so Phase 2 only needs to swap in the real HTTP/meta/DOM extraction. It is
 * deliberately conservative and non-destructive:
 *  - If the article has no canonical/source URL → SKIPPED (NO_ARTICLE_URL).
 *  - If the article is already enriched (defensive; selection should filter)
 *    → SKIPPED (ALREADY_ENRICHED).
 *  - Otherwise → SUCCESS with feed-only provenance and NO field overrides
 *    (every field marked `unchanged`), so no real data is mutated.
 *
 * Phase 2 will replace this function with the real HTTP-based extraction
 * (canonical check, meta/DOM selectors, paywall detection, quality scoring,
 * field comparison + override) per the Agent 3 dev plan §7.
 *
 * @param provenanceOverride Optional precise provenance recovered from Agent 1
 *   artifacts. When omitted, the conservative `buildArticleProvenance` fallback
 *   is used (backward-compatible with existing callers).
 */
export const stubExtractArticle = (
  article: EnrichmentEligibleArticle,
  now: Date = new Date(),
  provenanceOverride?: ArticleUpstreamProvenance,
): ArticleEnrichmentOutcome => {
  const provenance = provenanceOverride ?? buildArticleProvenance(article);
  const articleUrl = article.canonicalUrl || article.sourceUrl || null;

  const timing: EnrichmentTiming = {
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: 0,
  };

  if (!articleUrl) {
    return buildSkippedOutcome({
      articleId: article.id,
      articleUrl: null,
      provenance,
      reasonCode: "NO_ARTICLE_URL",
      detail: "Article has no canonicalUrl or sourceUrl.",
      timing,
    });
  }

  if (article.enrichmentStatus === "ENRICHED") {
    return buildSkippedOutcome({
      articleId: article.id,
      articleUrl,
      provenance,
      reasonCode: "ALREADY_ENRICHED",
      detail: "Article already enriched; skipped by stub.",
      timing,
    });
  }

  // Conservative SUCCESS: keep all feed values, mark every field `unchanged`.
  // Phase 2 will replace this with real extraction + field comparison.
  return buildSuccessOutcome({
    articleId: article.id,
    articleUrl,
    provenance,
    method: {
      method: "http-meta",
      detail: "stub-extractor (Phase 1 placeholder)",
      resolvedCanonicalUrl: articleUrl,
      redirected: false,
    },
    timing,
    quality: {
      confidence: 0.5,
      qualityScore: 50,
      signals: ["stub_extractor"],
      bodyLength: article.bodyText ? article.bodyText.length : 0,
    },
    fields: {
      title: {
        raw: article.title,
        chosenValue: article.title,
        chosenFrom: "unchanged",
        overrideReason: "Stub: no field override (Phase 1 placeholder).",
      },
      ...(article.bodyText
        ? {
            bodyText: {
              raw: article.bodyText,
              chosenValue: article.bodyText,
              chosenFrom: "unchanged",
              overrideReason: "Stub: kept feed body (Phase 1 placeholder).",
            },
          }
        : {}),
      isPaywall: {
        raw: article.isPaywall,
        chosenValue: article.isPaywall,
        chosenFrom: "unchanged",
        overrideReason: "Stub: kept Agent 1 paywall hint (Phase 1 placeholder).",
      },
    },
  });
};

/**
 * Result of a full Agent 3 enrichment batch run.
 */
export interface EnrichmentRunResult {
  pipelineRunId: string;
  articleCount: number;
  persist: EnrichmentBatchPersistResult;
}

/**
 * Run a full Agent 3 enrichment batch:
 *  1. create a `PipelineRun` to track the batch
 *  2. select eligible articles
 *  3. build canonical outcomes via the stub extractor
 *  4. persist outcomes (row summary + artifacts)
 *  5. finalize the `PipelineRun` with an enrichment summary
 *  6. log start/finish
 *
 * No real extraction is performed — this exercises the persistence contract
 * end-to-end. Phase 2 swaps `stubExtractArticle` for the real extractor.
 */
export const runEnrichmentBatch = async (
  now: Date = new Date(),
): Promise<EnrichmentRunResult> => {
  const startedAt = Date.now();

  const pipelineRun = await createPipelineRun(0);

  await logAgentScan({
    status: "ARTICLE_CONTENT_ENRICHMENT_STARTED",
    executionTimeMs: 0,
    errorLog: "Agent 3 article enrichment batch started (Phase 1 stub extractor).",
  });

  const articles = await selectEnrichmentEligibleArticles(now);

  // Recover precise upstream provenance from Agent 1 ingest artifacts.
  // This replaces the conservative fallback when artifact data exists.
  const provenanceMap = await recoverUpstreamProvenanceBatch(articles);

  const outcomes: ArticleEnrichmentOutcome[] = [];
  const attemptMarkerIds: string[] = [];

  for (const article of articles) {
    const provenance =
      provenanceMap.get(article.id) ?? buildArticleProvenance(article);
    const attemptNumber = article.enrichmentAttemptCount + 1;
    const attemptStartedAt = now.toISOString();

    // Emit a lightweight attempt marker before running extraction.
    // Non-fatal: if the marker fails, we still proceed with the outcome.
    try {
      const markerId = await persistAttemptMarker(
        article.id,
        attemptNumber,
        attemptStartedAt,
        pipelineRun.id,
        article.sourceId,
        article.categoryId,
      );
      attemptMarkerIds.push(markerId);
    } catch {
      // Attempt marker failure is non-fatal; the final result artifact is
      // the authoritative record. Continue with extraction.
    }

    outcomes.push(stubExtractArticle(article, now, provenance));
  }

  const persistResult = await persistEnrichmentBatch(outcomes, pipelineRun.id);

  // Single PipelineRun update: finalize status + counts AND set the canonical
  // enrichment summary in one write. We avoid finalizePipelineRun here because
  // its PipelineResult summary shape is Agent 1-specific (sourcesScanned etc.
  // do not map cleanly onto an article-enrichment run), and calling it would
  // force a second update to overwrite the summary. One write is cheaper and
  // gives full control over the enrichment-specific summary shape.
  // Single PipelineRun update: finalize status + counts AND set the canonical
  // enrichment summary in one write. We avoid finalizePipelineRun here because
  // its PipelineResult summary shape is Agent 1-specific (sourcesScanned etc.
  // do not map cleanly onto an article-enrichment run), and calling it would
  // force a second update to overwrite the summary.
  //
  // Note on field-name reuse: PipelineRun uses Agent 1 field names (candidates
  // = articles eligible for enrichment, inserted = successfully enriched).
  // These are the best available fits in the shared run-tracking schema; the
  // canonical per-kind breakdown lives in the `summary` JSON below.
  await prisma.pipelineRun.update({
    where: { id: pipelineRun.id },
    data: {
      status: persistResult.failed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
      finishedAt: new Date(),
      targetCount: articles.length,
      candidatesFound: articles.length,
      inserted: persistResult.byKind.SUCCESS,
      skipped: persistResult.byKind.SKIPPED,
      failed: persistResult.failed + persistResult.byKind.RETRYABLE_FAILURE,
      artifactCount: attemptMarkerIds.length + persistResult.artifactIds.length,
      summary: buildEnrichmentRunSummary(persistResult, articles.length),
    },
  });

  await logAgentScan({
    status: "ARTICLE_CONTENT_ENRICHMENT_FINISHED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Agent 3 article enrichment batch finished. articles=${articles.length}, attemptMarkers=${attemptMarkerIds.length}, persisted=${persistResult.persisted}, failed=${persistResult.failed}, byKind=${JSON.stringify(persistResult.byKind)}.`,
  });

  return {
    pipelineRunId: pipelineRun.id,
    articleCount: articles.length,
    persist: persistResult,
  };
};
