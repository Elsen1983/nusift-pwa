import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import type { ArticleEnrichmentOutcome, EnrichmentOutcomeKind } from "./enrichment";
import {
  outcomeKindToStatus,
  serializeEnrichmentPayload,
  serializeOutcomeSummary,
  validateEnrichmentOutcome,
} from "./enrichment";

// ─────────────────────────────────────────────────────────────────────────────
// Agent 2 — Article enrichment persistence wiring (Phase 1)
// ─────────────────────────────────────────────────────────────────────────────
//
// Single source of truth for persisting Agent 2 `ArticleEnrichmentOutcome`
// results to the database. Mirrors the Agent 1 `artifacts.ts` pattern:
//  - a canonical artifact payload built via `serializeEnrichmentPayload`
//  - a minimal row summary built via `serializeOutcomeSummary`
//  - status derived from the outcome kind via `outcomeKindToStatus`
//
// Detailed evidence lives in the `PipelineArtifact` payload; only short
// summary fields land on the `Article` row to keep DB pressure low.
//
// Phase 1 scope: persistence contract + batch helpers. The real HTTP
// extraction crawler is Phase 2 and is NOT implemented here — this module
// is called with already-built outcomes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical Agent 2 artifact types, matching the Agent 2 dev plan §9.
 * Used as `PipelineArtifact.artifactType`.
 */
export const ENRICHMENT_ARTIFACT_TYPES = [
  "article_enrichment_attempt",
  "article_enrichment_result",
  "article_enrichment_rejection",
  "article_headless_queue_candidate",
] as const;
export type EnrichmentArtifactType = (typeof ENRICHMENT_ARTIFACT_TYPES)[number];

/**
 * Map a canonical outcome kind to the Agent 2 artifact type + artifact status.
 * Single source of truth so persistence stays consistent with the contract.
 *
 * - SUCCESS/SKIPPED → `article_enrichment_result` (CAPTURED / SKIPPED)
 * - RETRYABLE_FAILURE/terminal failures → `article_enrichment_rejection` (FAILED)
 * - HEADLESS_REQUIRED → `article_headless_queue_candidate` (PENDING_HEADLESS)
 *
 * `article_enrichment_attempt` is reserved for a future Phase 2 per-attempt
 * "started" marker and is not produced here yet.
 */
export const outcomeKindToArtifact = (
  kind: EnrichmentOutcomeKind,
): { artifactType: EnrichmentArtifactType; status: string } => {
  switch (kind) {
    case "SUCCESS":
      return { artifactType: "article_enrichment_result", status: "CAPTURED" };
    case "SKIPPED":
      return { artifactType: "article_enrichment_result", status: "SKIPPED" };
    case "HEADLESS_REQUIRED":
      return {
        artifactType: "article_headless_queue_candidate",
        status: "PENDING_HEADLESS",
      };
    case "RETRYABLE_FAILURE":
    case "PAYWALL_BLOCKED":
    case "CANONICAL_MISMATCH":
    case "LOW_CONTENT_QUALITY":
    case "UNSUPPORTED_STRUCTURE":
      return {
        artifactType: "article_enrichment_rejection",
        status: "FAILED",
      };
    default:
      return {
        artifactType: "article_enrichment_rejection",
        status: "FAILED",
      };
  }
};

/**
 * Build the minimal `Article` row update object from a canonical outcome.
 *
 * Only short summary/status fields are written to the row. The full
 * structured outcome is persisted as a `PipelineArtifact` payload via
 * `persistEnrichmentOutcome`. `enrichmentOutcome` stores the small summary
 * (kind/method/confidence/rejectionCode/provenance) via
 * `serializeOutcomeSummary` — enough for quick status reads without a join.
 *
 * `enrichmentAttemptCount` is incremented atomically using Prisma's `increment`
 * so concurrent attempts never clobber each other.
 */
export const buildArticleEnrichmentUpdate = (
  outcome: ArticleEnrichmentOutcome,
): Prisma.ArticleUpdateInput => {
  const status = outcomeKindToStatus(outcome.kind);
  return {
    enrichmentStatus: status,
    enrichmentStartedAt: new Date(outcome.timing.startedAt),
    enrichmentFinishedAt: new Date(outcome.timing.finishedAt),
    enrichmentAttemptCount: { increment: 1 },
    enrichmentMethod: outcome.method.method,
    enrichmentConfidence: outcome.quality.confidence,
    enrichmentOutcome: serializeOutcomeSummary(outcome),
  };
};

/**
 * Build the `PipelineArtifact` create payload for a single enrichment outcome.
 *
 * The artifact `payload` is the canonical full outcome via
 * `serializeEnrichmentPayload` (detailed evidence: field-by-field provenance,
 * selectors, timing, paywall signals). The artifact `status`/`artifactType`
 * come from `outcomeKindToArtifact`. Source/category provenance is preserved
 * on the artifact row (sourceId/categoryId) AND inside the payload.
 */
export const buildEnrichmentArtifactCreate = (
  outcome: ArticleEnrichmentOutcome,
  pipelineRunId: string,
): Prisma.PipelineArtifactCreateArgs["data"] => {
  const { artifactType, status } = outcomeKindToArtifact(outcome.kind);
  return {
    pipelineRunId,
    sourceId: outcome.provenance.sourceId,
    categoryId: outcome.provenance.categoryId ?? null,
    artifactType,
    status,
    candidateCount: outcome.kind === "SUCCESS" ? 1 : 0,
    payload: serializeEnrichmentPayload(outcome),
    errorLog: outcome.error
      ? `${outcome.kind}: ${outcome.error}`
      : outcome.rejection
        ? `${outcome.kind}: ${outcome.rejection.code}${outcome.rejection.detail ? ` — ${outcome.rejection.detail}` : ""}`
        : null,
  };
};

/**
 * Build a lightweight `article_enrichment_attempt` artifact.
 *
 * This is an attempt marker — it records that an enrichment attempt was started
 * for an article, before the final result/skip/failure artifact is created.
 * The payload is intentionally small (no full outcome, no field provenance)
 * to keep DB usage lean while enabling audit trails that show:
 *   attempt started → attempt finished → final outcome kind
 *
 * The marker is aligned with the canonical outcome contract but does NOT
 * duplicate the full result payload — only the fields needed for the audit
 * trail (articleId, attemptNumber, startedAt) are included.
 */
export const buildAttemptMarkerArtifact = (
  articleId: number,
  attemptNumber: number,
  startedAt: string,
  pipelineRunId: string,
  sourceId: string,
  categoryId: string | null,
): Prisma.PipelineArtifactCreateArgs["data"] => ({
  pipelineRunId,
  sourceId,
  categoryId: categoryId ?? null,
  artifactType: "article_enrichment_attempt" as EnrichmentArtifactType,
  status: "ATTEMPTED",
  candidateCount: 0,
  payload: {
    schemaVersion: 1,
    artifactKind: "attempt_marker",
    articleId,
    attemptNumber,
    startedAt,
  } satisfies Prisma.InputJsonValue,
  errorLog: null,
});

/**
 * Persist a lightweight attempt marker artifact.
 *
 * Called before the enrichment extractor runs so the audit trail shows
 * "attempt started" before "attempt finished / result".
 * Persistence failure is non-fatal — callers should catch and continue.
 *
 * Returns the created artifact id.
 */
export const persistAttemptMarker = async (
  articleId: number,
  attemptNumber: number,
  startedAt: string,
  pipelineRunId: string,
  sourceId: string,
  categoryId: string | null,
): Promise<string> => {
  const artifact = await prisma.pipelineArtifact.create({
    data: buildAttemptMarkerArtifact(
      articleId,
      attemptNumber,
      startedAt,
      pipelineRunId,
      sourceId,
      categoryId,
    ),
    select: { id: true },
  });
  return artifact.id;
};

/**
 * Persist a single canonical enrichment outcome atomically:
 *  1. update the `Article` row with status + summary
 *  2. create a matching `PipelineArtifact` record with the full payload
 *
 * Both writes happen in a single `prisma.$transaction` so an article is never
 * left in a status that has no matching artifact evidence, and vice versa.
 *
 * Returns the created artifact id (null when the article was not found, which
 * is treated as a no-op skip — the caller's selection logic should already
 * guarantee existence, but this keeps persistence safe against races).
 */
export const persistEnrichmentOutcome = async (
  outcome: ArticleEnrichmentOutcome,
  pipelineRunId: string,
): Promise<{ artifactId: string | null; applied: boolean }> => {
  // prisma.$transaction with an array runs both writes in order inside one
  // transaction. If the article id does not exist, Prisma throws P2025
  // (record not found); callers (persistEnrichmentBatch) wrap in try/catch.
  const [, artifact] = await prisma.$transaction([
    prisma.article.update({
      where: { id: outcome.articleId },
      data: buildArticleEnrichmentUpdate(outcome),
      select: { id: true },
    }),
    prisma.pipelineArtifact.create({
      data: buildEnrichmentArtifactCreate(outcome, pipelineRunId),
      select: { id: true },
    }),
  ]);

  return { artifactId: artifact.id, applied: true };
};

/**
 * Result of persisting a batch of enrichment outcomes.
 */
export interface EnrichmentBatchPersistResult {
  /** Number of outcomes persisted successfully. */
  persisted: number;
  /** Number of outcomes that failed to persist (e.g. article deleted concurrently). */
  failed: number;
  /** Per-kind counts of persisted outcomes. */
  byKind: Record<EnrichmentOutcomeKind, number>;
  /** Created artifact ids. */
  artifactIds: string[];
}

const emptyByKind = (): Record<EnrichmentOutcomeKind, number> => ({
  SUCCESS: 0,
  SKIPPED: 0,
  RETRYABLE_FAILURE: 0,
  HEADLESS_REQUIRED: 0,
  PAYWALL_BLOCKED: 0,
  CANONICAL_MISMATCH: 0,
  LOW_CONTENT_QUALITY: 0,
  UNSUPPORTED_STRUCTURE: 0,
});

/**
 * Persist a batch of enrichment outcomes sequentially.
 *
 * Each outcome is persisted in its own transaction (via
 * `persistEnrichmentOutcome`) so a single failure does not roll back the
 * whole batch. A failure (e.g. P2025 record-not-found from a concurrently
 * deleted article) is counted and skipped, not thrown — the batch is
 * best-effort and auditable via the per-kind counts.
 *
 * Sequential persistence keeps DB load predictable and avoids overwhelming
 * the connection pool. For higher throughput, a future Phase 2 can batch the
 * artifact creates with `createMany` and the article updates in a single
 * transaction.
 */
export const persistEnrichmentBatch = async (
  outcomes: ArticleEnrichmentOutcome[],
  pipelineRunId: string,
): Promise<EnrichmentBatchPersistResult> => {
  const result: EnrichmentBatchPersistResult = {
    persisted: 0,
    failed: 0,
    byKind: emptyByKind(),
    artifactIds: [],
  };

  for (const outcome of outcomes) {
    try {
      const { artifactId } = await persistEnrichmentOutcome(outcome, pipelineRunId);
      result.persisted += 1;
      result.byKind[outcome.kind] += 1;
      if (artifactId) result.artifactIds.push(artifactId);
    } catch {
      // Article may have been deleted concurrently, or a constraint violation.
      // Count as failed and continue — the batch is best-effort.
      result.failed += 1;
    }
  }

  return result;
};

/**
 * Build the `PipelineRun.summary` JSON for an Agent 2 enrichment batch.
 * Mirrors the Agent 1 `finalizePipelineRun` summary shape but with
 * enrichment-specific counts.
 */
export const buildEnrichmentRunSummary = (
  result: EnrichmentBatchPersistResult,
  articleCount: number,
): Prisma.InputJsonValue =>
  ({
    articleCount,
    persisted: result.persisted,
    failed: result.failed,
    byKind: result.byKind,
    artifactCount: result.artifactIds.length,
  }) as Prisma.InputJsonValue;

/**
 * Read a persisted `Article.enrichmentOutcome` summary back into a structured
 * form. This is a lightweight reader for the row-level summary subset — it
 * validates the fields the summary actually carries (`kind`/`method`/
 * `confidence`/`rejectionCode`/`provenance`) directly, since the summary does
 * not have the full `ArticleEnrichmentOutcome` shape (no timing/full fields).
 * For the full outcome, read the `PipelineArtifact` payload and validate it
 * with `validateEnrichmentOutcome`.
 *
 * Returns the validated summary fields or null when malformed.
 */
export const readEnrichmentSummary = (
  raw: unknown,
): {
  kind: EnrichmentOutcomeKind;
  method: string;
  confidence: number;
  rejectionCode: string | null;
  provenance: { sourceId: string; categoryId: string | null; feedOrigin: string };
} | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.kind !== "string") return null;
  // Reuse the full validator on the summary by treating it as a minimal
  // outcome-like object — it won't have timing/provenance full shape, so we
  // validate the lightweight fields directly instead.
  const provenance = s.provenance;
  if (
    typeof provenance !== "object" ||
    provenance === null ||
    Array.isArray(provenance)
  ) {
    return null;
  }
  const p = provenance as Record<string, unknown>;
  if (typeof p.sourceId !== "string") return null;
  return {
    kind: s.kind as EnrichmentOutcomeKind,
    method: typeof s.method === "string" ? s.method : "none",
    confidence: typeof s.confidence === "number" ? s.confidence : 0,
    rejectionCode: typeof s.rejectionCode === "string" ? s.rejectionCode : null,
    provenance: {
      sourceId: p.sourceId,
      categoryId: typeof p.categoryId === "string" ? p.categoryId : null,
      feedOrigin: typeof p.feedOrigin === "string" ? p.feedOrigin : "rss",
    },
  };
};

// Re-export the validator for callers that want to read full outcomes from
// artifact payloads (keeps the single-entry-point guarantee).
export { validateEnrichmentOutcome };
