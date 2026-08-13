// ─────────────────────────────────────────────────────────────────────────────
// Agent 3 — Rejection diagnostics normalizer
// ─────────────────────────────────────────────────────────────────────────────
//
// Safely extracts compact rejection diagnostic data from PipelineArtifact
// payloads for admin debugging. Tolerates malformed JSON, drops or nulls
// malformed fields, caps arrays and strings, and never throws because one
// artifact is malformed.
// ─────────────────────────────────────────────────────────────────────────────

import type { EnrichmentOutcomeKind, BrowserFallbackSkippedReason } from "./enrichment";
import { repairUtf8Mojibake } from "../../../shared/text-encoding";

/** Rejection kinds shown in the diagnostics panel. */
export const REJECTION_KINDS: ReadonlyArray<EnrichmentOutcomeKind> = [
  "LOW_CONTENT_QUALITY",
  "UNSUPPORTED_STRUCTURE",
  "HTTP_ACCESS_BLOCKED",
  "INTERSTITIAL_OR_CHALLENGE",
  "HEADLESS_REQUIRED",
  "PAYWALL_BLOCKED",
  "RETRYABLE_FAILURE",
  "CANONICAL_MISMATCH",
];

/** Set of artifact types that represent rejection/non-success outcomes. */
const REJECTION_ARTIFACT_TYPES: ReadonlySet<string> = new Set([
  "article_enrichment_rejection",
  "article_headless_queue_candidate",
]);

/** Normalized top candidate entry. */
export interface NormalizedTopCandidate {
  selector: string | null;
  score: number | null;
  paragraphCount: number | null;
  textLength: number | null;
  reasons: string[];
}

/** Normalized rejection diagnostic item. */
export interface NormalizedRejectionDiagnostic {
  id: string;
  createdAt: string;
  pipelineRunId: string | null;
  articleId: number | null;
  title: string | null;
  articleUrl: string | null;
  originalArticleUrl: string | null;
  transportUrl: string | null;
  transportSignals: string[];
  transportAttempts: Array<{
    protocol: "https" | "http";
    url: string | null;
    statusCode: number | null;
    outcome: string;
  }>;
  sourceId: string | null;
  categoryId: string | null;
  kind: string;
  rejectedReason: string | null;
  detail: string | null;
  confidence: number | null;
  extractorVersion: string | null;
  diagnostics: {
    selectedContainerSelector: string | null;
    selectedContainerScore: number | null;
    selectedContainerParagraphCount: number | null;
    selectedContainerTextLength: number | null;
    candidateContainerCount: number | null;
    bodyRejectedReason: string | null;
    scoreReasons: string[];
    bodySource: string | null;
    linkTextRatio: number | null;
    boilerplatePenalty: number | null;
    topCandidates: NormalizedTopCandidate[];
    stoppedAtText: string | null;
    stoppedAtClassOrId: string | null;
    excludedBlockCount: number | null;
  };
  browserFallback: {
    attempted: boolean;
    succeeded: boolean;
    skippedReason: BrowserFallbackSkippedReason | null;
    staticRejectedReason: string | null;
    browserRejectedReason: string | null;
    runtimeUnavailable: boolean;
    rateLimited: boolean;
    statusCode: number | null;
  } | null;
  httpAccessBlocked: boolean;
  retryDisposition: string | null;
  retryAfterAt: string | null;
  retryReasonCode: string | null;
}

/** Raw artifact row from Prisma. */
export interface RawRejectionArtifact {
  id: string;
  createdAt: Date;
  pipelineRunId: string | null;
  sourceId: string | null;
  categoryId: string | null;
  artifactType: string;
  status: string;
  payload: unknown;
  errorLog: string | null;
}

export interface DeferredCooldownGroup {
  hostname: string;
  deferredArticles: number;
  nextRetryAt: string | null;
  reasons: Record<string, number>;
}

/** Aggregate only durable DEFERRED diagnostics in a deterministic bounded view. */
export function summarizeDeferredCooldowns(items: NormalizedRejectionDiagnostic[]): DeferredCooldownGroup[] {
  const groups = new Map<string, DeferredCooldownGroup>();
  for (const item of items) {
    if (item.retryDisposition !== "DEFERRED") continue;
    let hostname = "unknown";
    const diagnosticUrl = item.originalArticleUrl || item.articleUrl;
    if (diagnosticUrl) {
      try { hostname = new URL(diagnosticUrl).hostname; } catch { /* malformed URL */ }
    }
    const group = groups.get(hostname) || { hostname, deferredArticles: 0, nextRetryAt: null, reasons: {} };
    group.deferredArticles++;
    if (item.retryAfterAt && (!group.nextRetryAt || item.retryAfterAt < group.nextRetryAt)) group.nextRetryAt = item.retryAfterAt;
    const reason = item.retryReasonCode || item.rejectedReason || "unknown";
    group.reasons[reason] = (group.reasons[reason] ?? 0) + 1;
    groups.set(hostname, group);
  }
  return [...groups.values()].sort((a, b) => b.deferredArticles - a.deferredArticles || a.hostname.localeCompare(b.hostname));
}

/** Cap a string to a maximum length, returning null for non-strings. */
function capString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = repairUtf8Mojibake(value);
  return normalized.length > maxLen ? normalized.slice(0, maxLen) : normalized;
}

/** Normalize a number, returning null for non-numbers. */
function safeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** Normalize a string array, capping to maxLen entries. */
function capStringArray(value: unknown, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .slice(0, maxLen);
}

/** Check if a value is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a single top candidate from the diagnostics payload.
 * Returns null if the entry is not a valid object.
 */
function normalizeTopCandidate(value: unknown): NormalizedTopCandidate | null {
  if (!isPlainObject(value)) return null;
  return {
    selector: capString(value.selector, 200),
    score: safeNumber(value.score),
    paragraphCount: safeNumber(value.paragraphCount),
    textLength: safeNumber(value.textLength),
    reasons: capStringArray(value.reasons ?? value.scoreReasons, 10),
  };
}

/**
 * Normalize rejection diagnostics from an artifact payload.
 *
 * - Tolerates malformed payloads: returns null on fatal structural issues.
 * - Caps arrays (topCandidates max 5, scoreReasons max 10).
 * - Caps strings (stoppedAtText 120, stoppedAtClassOrId 160, detail 300, title 180).
 * - Never throws.
 */
export function normalizeRejectionDiagnostic(
  artifact: RawRejectionArtifact,
): NormalizedRejectionDiagnostic | null {
  try {
    const payload = artifact.payload;
    if (!isPlainObject(payload)) return null;

    // Extract kind from the payload
    const kind = typeof payload.kind === "string" ? payload.kind : null;
    if (!kind) return null;

    // Skip SUCCESS and SKIPPED outcomes
    if (kind === "SUCCESS" || kind === "SKIPPED") return null;

    // Extract article metadata from payload
    const articleId = typeof payload.articleId === "number" ? payload.articleId : null;
    const articleUrl = capString(payload.articleUrl, 2000);

    // Extract provenance
    const provenance = isPlainObject(payload.provenance) ? payload.provenance : {};
    const sourceId = typeof provenance.sourceId === "string" ? provenance.sourceId : (artifact.sourceId ?? null);
    const categoryId = typeof provenance.categoryId === "string" ? provenance.categoryId : (artifact.categoryId ?? null);

    // Extract rejection info
    const rejection = isPlainObject(payload.rejection) ? payload.rejection : {};
    const rejectedReason = capString(rejection.code, 100);
    const detail = capString(rejection.detail, 300);

    // Extract quality
    const quality = isPlainObject(payload.quality) ? payload.quality : {};
    const confidence = safeNumber(quality.confidence);

    // Extract extractor version
    const extractorVersion = capString(payload.extractorVersion, 100);
    const method = isPlainObject(payload.method) ? payload.method : {};
    const originalArticleUrl = capString(method.originalArticleUrl ?? provenance.originalArticleUrl ?? payload.articleUrl, 2000);
    const transportUrl = capString(method.transportUrl, 2000);
    const transportSignals = capStringArray(isPlainObject(payload.quality) ? payload.quality.signals : [], 20)
      .filter((signal) => signal === "https_first" || signal === "https_first_failed" || signal === "http_fallback_used");
    const transportAttempts = Array.isArray(method.transportAttempts)
      ? method.transportAttempts.flatMap((attempt) => {
          if (!isPlainObject(attempt)) return [];
          if (attempt.protocol !== "https" && attempt.protocol !== "http") return [];
          return [{
            protocol: attempt.protocol as "https" | "http",
            url: capString(attempt.url, 2000),
            statusCode: safeNumber(attempt.statusCode),
            outcome: capString(attempt.outcome, 40) || "unknown",
          }];
        }).slice(0, 3)
      : [];
    const retryDiagnostics = isPlainObject(payload.retryDiagnostics) ? payload.retryDiagnostics : {};

    // Extract rejection diagnostics (the new compact field)
    const diag = isPlainObject(payload.rejectionDiagnostics) ? payload.rejectionDiagnostics : null;

    // Extract title from rejectionDiagnostics (stored during extraction)
    const title = diag ? capString(diag.title, 180) : capString(payload.title, 180);

    const diagnostics = diag
      ? {
          selectedContainerSelector: capString(diag.selectedContainerSelector, 200),
          selectedContainerScore: safeNumber(diag.selectedContainerScore),
          selectedContainerParagraphCount: safeNumber(diag.selectedContainerParagraphCount),
          selectedContainerTextLength: safeNumber(diag.selectedContainerTextLength),
          candidateContainerCount: safeNumber(diag.candidateContainerCount),
          bodyRejectedReason: capString(diag.bodyRejectedReason, 200),
          scoreReasons: capStringArray(diag.scoreReasons, 10),
          bodySource: capString(diag.bodySource, 50),
          linkTextRatio: safeNumber(diag.linkTextRatio),
          boilerplatePenalty: safeNumber(diag.boilerplatePenalty),
          topCandidates: Array.isArray(diag.topCandidates)
            ? diag.topCandidates.map(normalizeTopCandidate).filter((c): c is NormalizedTopCandidate => c !== null).slice(0, 5)
            : [],
          stoppedAtText: capString(diag.stoppedAtText, 120),
          stoppedAtClassOrId: capString(diag.stoppedAtClassOrId, 160),
          excludedBlockCount: safeNumber(diag.excludedBlockCount),
        }
      : {
          selectedContainerSelector: null,
          selectedContainerScore: null,
          selectedContainerParagraphCount: null,
          selectedContainerTextLength: null,
          candidateContainerCount: null,
          bodyRejectedReason: null,
          scoreReasons: [],
          bodySource: null,
          linkTextRatio: null,
          boilerplatePenalty: null,
          topCandidates: [],
          stoppedAtText: null,
          stoppedAtClassOrId: null,
          excludedBlockCount: null,
        };

    // Extract browser fallback metadata
    const bf = isPlainObject(payload.browserFallback) ? payload.browserFallback : null;
    const validSkippedReasons: ReadonlySet<string> = new Set([
      "not_eligible", "browser_disabled", "max_attempts_exhausted",
      "source_cooldown", "runtime_unavailable_global_stop",
      "rate_limited_source", "recently_blocked", "static_429_host",
    ]);
    const browserFallback = bf
      ? {
          attempted: bf.attempted === true,
          succeeded: bf.succeeded === true,
          skippedReason: (typeof bf.browserFallbackSkippedReason === "string" && validSkippedReasons.has(bf.browserFallbackSkippedReason)
            ? bf.browserFallbackSkippedReason
            : null) as BrowserFallbackSkippedReason | null,
          staticRejectedReason: capString(bf.staticRejectedReason, 100),
          browserRejectedReason: capString(bf.browserRejectedReason, 100),
          runtimeUnavailable: bf.runtimeUnavailable === true,
          rateLimited: bf.rateLimited === true,
          statusCode: safeNumber(bf.statusCode),
        }
      : null;
    const httpAccessBlocked = browserFallback?.statusCode === 403
      || browserFallback?.statusCode === 429
      || (typeof detail === "string" && detail.includes("[http_error]")
        && (detail.includes("403") || detail.includes("429")));

    return {
      id: artifact.id,
      createdAt: artifact.createdAt instanceof Date ? artifact.createdAt.toISOString() : String(artifact.createdAt),
      pipelineRunId: artifact.pipelineRunId,
      articleId,
      title,
      articleUrl,
      originalArticleUrl,
      transportUrl,
      transportSignals,
      transportAttempts,
      sourceId,
      categoryId,
      kind,
      rejectedReason,
      detail,
      confidence,
      extractorVersion,
      diagnostics,
      browserFallback,
      httpAccessBlocked,
      retryDisposition: capString(retryDiagnostics.disposition, 40),
      retryAfterAt: capString(retryDiagnostics.retryAfter ?? rejection.retryAfterAt, 80),
      retryReasonCode: capString(retryDiagnostics.reasonCode, 100),
    };
  } catch {
    // Malformed artifact — skip silently
    return null;
  }
}

/**
 * Check whether an artifact represents a rejection (non-SUCCESS, non-SKIPPED).
 * Used to filter artifacts before normalization.
 */
export function isRejectionArtifact(artifact: RawRejectionArtifact): boolean {
  // Quick check: artifact type must be a rejection type
  if (!REJECTION_ARTIFACT_TYPES.has(artifact.artifactType)) return false;
  // Status must be FAILED or PENDING_HEADLESS
  if (artifact.status !== "FAILED" && artifact.status !== "PENDING_HEADLESS") return false;
  return true;
}
