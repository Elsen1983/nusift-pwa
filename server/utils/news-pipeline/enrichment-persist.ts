import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import type { ArticleEnrichmentOutcome, EnrichmentOutcomeKind } from "./enrichment";
import {
  outcomeKindToStatus,
  serializeEnrichmentPayload,
  serializeOutcomeSummary,
  validateEnrichmentOutcome,
} from "./enrichment";
import {
  buildPublicationGateUpdate,
  hasUsableAgent3BodyText,
} from "./publication-gate";

// ─────────────────────────────────────────────────────────────────────────────
// Agent 3 — Article enrichment persistence wiring (Phase 1)
// ─────────────────────────────────────────────────────────────────────────────
//
// Single source of truth for persisting Agent 3 `ArticleEnrichmentOutcome`
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
 * Canonical Agent 3 artifact types, matching the Agent 3 dev plan §9.
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
 * Map a canonical outcome kind to the Agent 3 artifact type + artifact status.
 * Single source of truth so persistence stays consistent with the contract.
 *
 * - SUCCESS/SKIPPED → `article_enrichment_result` (CAPTURED / SKIPPED)
 * - RETRYABLE_FAILURE/terminal failures → `article_enrichment_rejection` (FAILED)
 * - HEADLESS_REQUIRED → `article_headless_queue_candidate` (PENDING_HEADLESS)
 *
 * `article_enrichment_attempt` is emitted separately when a durable claim is
 * acquired, before the final outcome is persisted.
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
    case "HTTP_ACCESS_BLOCKED":
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
  options?: {
    existingBodyText?: string | null;
    existingTitle?: string | null;
    existingCanonicalUrl?: string | null;
  },
): Prisma.ArticleUpdateInput => {
  const status = outcomeKindToStatus(outcome.kind);
  const bodyTextUpdate =
    outcome.kind === "SUCCESS" &&
    outcome.fields.bodyText?.chosenFrom === "dom" &&
    outcome.fields.bodyText.chosenValue
      ? outcome.fields.bodyText.chosenValue
      : undefined;
  // Only values that will actually be durable on Article.bodyText may decide
  // publication. An arbitrary outcome value marked "unchanged" is evidence,
  // not a write, and must not be treated as the persisted body.
  const finalBodyText = bodyTextUpdate ?? options?.existingBodyText ?? null;
  const update: Prisma.ArticleUpdateInput = {
    enrichmentStatus: status,
    enrichmentStartedAt: new Date(outcome.timing.startedAt),
    enrichmentFinishedAt: new Date(outcome.timing.finishedAt),
    // The attempt count is incremented atomically when the claim is acquired.
    // Final writes must not increment it again, especially after retries.
    enrichmentMethod: outcome.method.method,
    enrichmentConfidence: outcome.quality.confidence,
    enrichmentOutcome: serializeOutcomeSummary(outcome),
    ...buildPublicationGateUpdate({
      stage: "agent3",
      // A SUCCESS kind is not sufficient for publication: the final body that
      // will be durable on the Article row must pass the same quality boundary
      // used by feed visibility and reprocessing selection. When no replacement
      // body is supplied, preserve the existing Article body as the final value.
      publishable:
        outcome.kind === "SUCCESS" &&
        Boolean(options?.existingTitle?.trim()) &&
        Boolean(options?.existingCanonicalUrl?.trim()) &&
        hasUsableAgent3BodyText(finalBodyText),
      nonPublishableStatus:
        outcome.kind === "PAYWALL_BLOCKED" ||
        outcome.kind === "CANONICAL_MISMATCH" ||
        outcome.kind === "LOW_CONTENT_QUALITY" ||
        outcome.kind === "UNSUPPORTED_STRUCTURE" ||
        outcome.kind === "HTTP_ACCESS_BLOCKED"
          ? "REJECTED"
          : "PROCESSING",
      completedAt: new Date(outcome.timing.finishedAt),
    }),
  };

  // Phase 2: persist extracted bodyText on SUCCESS when the extractor
  // produced a better value than the existing one.
  if (outcome.kind === "SUCCESS" && outcome.fields.bodyText) {
    const bp = outcome.fields.bodyText;
    if (bodyTextUpdate) {
      update.bodyText = bodyTextUpdate;
    }
  }

  // Phase 2: persist isPaywall when the extractor produced a definitive value.
  if (outcome.kind === "SUCCESS" && outcome.fields.isPaywall) {
    const pp = outcome.fields.isPaywall;
    if (pp.chosenFrom === "dom" && typeof pp.chosenValue === "boolean") {
      update.isPaywall = pp.chosenValue;
    }
  }

  return update;
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

export const ENRICHMENT_CLAIM_TTL_MS = 30 * 60 * 1000;

export interface EnrichmentClaim {
  articleId: number;
  pipelineRunId: string;
  token: string;
  claimedAt: Date;
  expiresAt: Date;
  attemptNumber: number;
}

/**
 * Release claims whose lease has expired. This is explicit recovery: an
 * abandoned worker never makes an article permanently ineligible.
 */
export const recoverExpiredEnrichmentClaims = async (
  now: Date = new Date(),
): Promise<number> => {
  const result = await prisma.articleEnrichmentClaim.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  return result.count;
};

/**
 * Atomically acquire one article lease. The unique articleId constraint makes
 * concurrent workers mutually exclusive; the attempt counter increments in
 * the same transaction as the claim creation.
 */
export const claimEnrichmentArticle = async (
  articleId: number,
  pipelineRunId: string,
  now: Date = new Date(),
  leaseMs: number = ENRICHMENT_CLAIM_TTL_MS,
  expectedAttemptCount?: number,
  expectedEnrichmentStatus?: string,
): Promise<EnrichmentClaim | null> => {
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + leaseMs);

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.articleEnrichmentClaim.deleteMany({
        where: { articleId, expiresAt: { lte: now } },
      });

      const current = await tx.article.findUnique({
        where: { id: articleId },
        select: { enrichmentAttemptCount: true, enrichmentStatus: true },
      });
      // A row can disappear between eligibility selection and claim acquisition.
      // Treat that as a harmless claim miss; the transaction rolls back any
      // attempted state change and unrelated database errors remain visible.
      if (!current) return null;

      const selectedAttemptCount = expectedAttemptCount ?? current.enrichmentAttemptCount;
      const selectedStatus = expectedEnrichmentStatus ?? current.enrichmentStatus;
      const updated = await tx.article.updateMany({
        where: {
          id: articleId,
          enrichmentAttemptCount: selectedAttemptCount,
          enrichmentStatus: selectedStatus,
        },
        data: { enrichmentAttemptCount: { increment: 1 } },
      });
      // A stale selection snapshot is also a claim miss. Returning null keeps
      // the CAS failure distinct from a real database error.
      if (updated.count !== 1) return null;

      const claim = await tx.articleEnrichmentClaim.create({
        data: {
          articleId,
          pipelineRunId,
          token,
          attemptNumber: selectedAttemptCount + 1,
          expectedStatus: selectedStatus,
          claimedAt: now,
          expiresAt,
        },
      });
      return { ...claim };
    });
  } catch (error: any) {
    // P2002 means another worker owns the unique article claim. The
    // transaction returns null for row disappearance/CAS misses; every other
    // database error remains visible to the caller.
    if (error?.code === "P2002") return null;
    throw error;
  }
};

/**
 * Persist one outcome only while the matching, unexpired claim is owned.
 * Claim deletion, Article update, and artifact creation are one transaction:
 * a lost/stale worker performs none of the final writes.
 */
export const persistEnrichmentOutcome = async (
  outcome: ArticleEnrichmentOutcome,
  pipelineRunId: string,
  claimToken: string,
  now: Date = new Date(),
): Promise<{ artifactId: string | null; applied: boolean; claimLost: boolean }> => {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.articleEnrichmentClaim.findUnique({
      where: { token: claimToken },
      select: {
        articleId: true,
        pipelineRunId: true,
        token: true,
        attemptNumber: true,
        expectedStatus: true,
        expiresAt: true,
      },
    });
    if (
      !claim ||
      claim.articleId !== outcome.articleId ||
      claim.pipelineRunId !== pipelineRunId ||
      claim.expiresAt <= now
    ) {
      return { artifactId: null, applied: false, claimLost: true };
    }

    // Consume the lease first. DELETE takes a row lock, so expiry recovery or
    // a new claimant cannot interleave with the CAS and final writes below.
    const currentArticle = await tx.article.findUnique({
      where: { id: outcome.articleId },
      select: { bodyText: true, title: true, canonicalUrl: true },
    });
    if (!currentArticle) {
      return { artifactId: null, applied: false, claimLost: true };
    }

    const released = await tx.articleEnrichmentClaim.deleteMany({
      where: {
        articleId: claim.articleId,
        pipelineRunId: claim.pipelineRunId,
        token: claim.token,
        expiresAt: { gt: now },
      },
    });
    if (released.count !== 1) {
      return { artifactId: null, applied: false, claimLost: true };
    }

    const updated = await tx.article.updateMany({
      where: {
        id: outcome.articleId,
        enrichmentAttemptCount: claim.attemptNumber,
        ...(claim.expectedStatus !== null
          ? { enrichmentStatus: claim.expectedStatus }
          : {}),
        // The publication decision is based on the transaction read above.
        // Include those values in the CAS so a concurrent metadata/body change
        // cannot be overwritten or cause a stale worker to publish.
        title: currentArticle.title,
        canonicalUrl: currentArticle.canonicalUrl,
        bodyText: currentArticle.bodyText,
      },
      data: buildArticleEnrichmentUpdate(outcome, {
        existingBodyText: currentArticle.bodyText,
        existingTitle: currentArticle.title,
        existingCanonicalUrl: currentArticle.canonicalUrl,
      }),
    });
    if (updated.count !== 1) {
      return { artifactId: null, applied: false, claimLost: true };
    }

    const artifact = await tx.pipelineArtifact.create({
      data: buildEnrichmentArtifactCreate(outcome, pipelineRunId),
      select: { id: true },
    });

    return { artifactId: artifact.id, applied: true, claimLost: false };
  });
};

/**
 * Result of persisting a batch of enrichment outcomes.
 */
export interface EnrichmentBatchPersistResult {
  /** Number of outcomes persisted successfully. */
  persisted: number;
  /** Number of outcomes that failed to persist for a system/database reason. */
  failed: number;
  /** Number of outcomes discarded because the worker lost its claim. */
  claimLost: number;
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
  HTTP_ACCESS_BLOCKED: 0,
});

export const createEmptyEnrichmentBatchPersistResult = (): EnrichmentBatchPersistResult => ({
  persisted: 0,
  failed: 0,
  claimLost: 0,
  byKind: emptyByKind(),
  artifactIds: [],
});

/** Add one per-article persistence result to the batch aggregate in place. */
export const mergeEnrichmentBatchPersistResult = (
  target: EnrichmentBatchPersistResult,
  addition: EnrichmentBatchPersistResult,
): void => {
  target.persisted += addition.persisted;
  target.failed += addition.failed;
  target.claimLost += addition.claimLost;
  for (const kind of Object.keys(target.byKind) as EnrichmentOutcomeKind[]) {
    target.byKind[kind] += addition.byKind[kind];
  }
  target.artifactIds.push(...addition.artifactIds);
};

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
  claimTokens: ReadonlyMap<number, string>,
): Promise<EnrichmentBatchPersistResult> => {
  const result = createEmptyEnrichmentBatchPersistResult();

  for (const outcome of outcomes) {
    const claimToken = claimTokens.get(outcome.articleId);
    if (!claimToken) {
      result.claimLost += 1;
      continue;
    }
    try {
      const persisted = await persistEnrichmentOutcome(outcome, pipelineRunId, claimToken);
      if (persisted.claimLost) {
        result.claimLost += 1;
        continue;
      }
      result.persisted += 1;
      result.byKind[outcome.kind] += 1;
      if (persisted.artifactId) result.artifactIds.push(persisted.artifactId);
    } catch {
      // Article may have been deleted concurrently, or a constraint violation.
      // Count as failed and continue — the batch is best-effort.
      result.failed += 1;
    }
  }

  return result;
};

/**
 * Build the `PipelineRun.summary` JSON for an Agent 3 enrichment batch.
 * Mirrors the Agent 1 `finalizePipelineRun` summary shape but with
 * enrichment-specific counts and optional browser fallback statistics.
 *
 * The `agent` field allows getAgent3Progress to filter for enrichment runs.
 * Browser fallback stats survive page refresh because they are persisted here.
 */
export const buildEnrichmentRunSummary = (
  result: EnrichmentBatchPersistResult,
  articleCount: number,
  options?: {
    browserFallbackStats?: {
      enabled: boolean;
      attempted: number;
      succeeded: number;
      failed: number;
      runtimeUnavailable: number;
      rateLimited: number;
      stoppedReason?: "max_attempts" | "runtime_unavailable" | "rate_limited" | null;
    };
    optionsUsed?: {
      browserFallback: boolean;
      browserFallbackMaxAttempts: number;
      browserTimeoutMs: number;
      includeEnriched: boolean;
      forceReprocess: boolean;
      maxArticles: number;
      maxArticlesPerSource: number;
    };
    durationMs?: number;
    agent3SourceCooldowns?: Array<{
      sourceId: string;
      hostname: string;
      reason: string;
      failureCount: number;
      skippedInRun: number;
      firstFailureAt: string;
      lastFailureAt: string;
    }>;
    claimSkipped?: number;
    expiredClaimsRecovered?: number;
    /** Per-outcome HTTP evidence from the enrichment runtime. */
    httpEvidence?: Record<string, number>;
  },
): Prisma.InputJsonValue =>
  ({
    agent: "enrichment",
    articleCount,
    persisted: result.persisted,
    failed: result.failed,
    claimLost: result.claimLost,
    byKind: result.byKind,
    artifactCount: result.artifactIds.length,
    durationMs: options?.durationMs ?? null,
    ...(options?.optionsUsed ? { optionsUsed: options.optionsUsed } : {}),
    ...(options?.browserFallbackStats ? { browserFallbackStats: options.browserFallbackStats } : {}),
    ...(options?.agent3SourceCooldowns ? { agent3SourceCooldowns: options.agent3SourceCooldowns } : {}),
    ...(options?.claimSkipped !== undefined ? { claimSkipped: options.claimSkipped } : {}),
    ...(options?.expiredClaimsRecovered !== undefined ? { expiredClaimsRecovered: options.expiredClaimsRecovered } : {}),
    ...(options?.httpEvidence ? { httpEvidence: { ...options.httpEvidence } } : {}),
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
  extractorVersion: string | null;
  provenance: {
    sourceId: string;
    categoryId: string | null;
    feedOrigin: string | null;
    feedUrl: string | null;
    ingestArtifactId: string | null;
    ingestPipelineRunId: string | null;
  };
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
    extractorVersion: typeof s.extractorVersion === "string" ? s.extractorVersion : null,
    provenance: {
      sourceId: p.sourceId,
      categoryId: typeof p.categoryId === "string" ? p.categoryId : null,
      feedOrigin: typeof p.feedOrigin === "string" ? p.feedOrigin : null,
      feedUrl: typeof p.feedUrl === "string" ? p.feedUrl : null,
      ingestArtifactId: typeof p.ingestArtifactId === "string" ? p.ingestArtifactId : null,
      ingestPipelineRunId: typeof p.ingestPipelineRunId === "string" ? p.ingestPipelineRunId : null,
    },
  };
};
