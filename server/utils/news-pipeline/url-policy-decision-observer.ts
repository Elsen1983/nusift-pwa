/**
 * URL Policy Decision Observer
 *
 * Lightweight utility that observes URL policy decisions for both the
 * production baseline and candidate shadow policy side-by-side.
 *
 * Uses existing PipelineArtifact infrastructure — no Prisma migration.
 * Logs are persisted with artifactType "url_policy_decision".
 *
 * Side-effect-free observation: the observer never changes existing
 * enforced behavior. Candidate shadow decisions are logged but never
 * acted upon.
 */

import { prisma } from "../prisma";
import {
  evaluateProductionUrlPolicy,
  evaluateCandidateUrlPolicy,
  type UrlPolicyDecisionLog,
  type UrlPolicyEvaluationInput,
  type AgentName,
} from "./url-policy-evaluation";
import type { Prisma } from "@prisma/client";

/**
 * Per-URL persistence is intentionally opt-in until callers use a bounded,
 * request-scoped batch writer. Unbounded fire-and-forget writes can exhaust a
 * serverless instance's database pool during large Agent 1/2 runs.
 */
export function isUrlPolicyDecisionPersistenceEnabled(): boolean {
  return process.env.NUXT_ENABLE_URL_POLICY_DECISION_PERSISTENCE === "true";
}

// ─── Query Parameter Sanitization ───────────────────────────────────────────

/** Sensitive query parameter names that should be stripped from logged URLs. */
const SENSITIVE_QUERY_PARAMS = new Set([
  "token",
  "secret",
  "key",
  "api_key",
  "apikey",
  "password",
  "passwd",
  "auth",
  "session",
  "sid",
  "access_token",
  "refresh_token",
]);

/**
 * Strip sensitive query parameters from a URL string.
 * Returns the URL with sensitive params removed, or the original URL
 * if it has no query string or is unparseable.
 */
export function sanitizeUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    let removedAny = false;
    for (const param of SENSITIVE_QUERY_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.delete(param);
        removedAny = true;
      }
    }
    return removedAny ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/**
 * Strip sensitive query parameters from the `url` and `normalizedUrl` fields
 * of a decision log. Returns a new object — does not mutate the input.
 */
function sanitizeDecisionLog(log: UrlPolicyDecisionLog): UrlPolicyDecisionLog {
  return {
    ...log,
    url: sanitizeUrlForLogging(log.url),
    normalizedUrl: log.normalizedUrl ? sanitizeUrlForLogging(log.normalizedUrl) : undefined,
  };
}

// ─── Decision Observation ──────────────────────────────────────────────────

/**
 * Observe both production and candidate policy decisions for a URL.
 *
 * Pure observation function: evaluates both policies and returns the
 * pair of decisions without any side effects.
 *
 * @param input - The URL evaluation input (url, sourceId, agent, stage, etc.).
 * @returns An object with production and candidate decision logs.
 */
export function observeUrlPolicyDecisions(
  input: UrlPolicyEvaluationInput,
): { production: UrlPolicyDecisionLog; candidate: UrlPolicyDecisionLog } {
  return {
    production: evaluateProductionUrlPolicy(input),
    candidate: evaluateCandidateUrlPolicy(input),
  };
}

// ─── Decision Logging (via PipelineArtifact) ───────────────────────────────

/**
 * Build an idempotency key for deduplicating decision logs.
 */
export function buildDecisionLogIdempotencyKey(
  decision: UrlPolicyDecisionLog,
): string {
  const parts = [
    decision.normalizedUrl || decision.url,
    decision.agent || "unknown",
    decision.stage || "unknown",
    decision.policyVersion,
    decision.enforcementMode,
  ];
  return parts.join("::");
}

/**
 * Create a lightweight PipelineRun for URL policy observations.
 * Used when callers do not already have a pipeline run context.
 */
async function ensureUrlPolicyRun(): Promise<string> {
  const run = await prisma.pipelineRun.create({
    data: { status: "URL_POLICY_OBSERVATION", targetCount: 0 },
    select: { id: true },
  });
  return run.id;
}

/**
 * Persist a single URL policy decision as a PipelineArtifact record.
 *
 * No Prisma migration — uses existing PipelineArtifact model.
 * Payload is compact (never stores full HTML, DOM, or article text).
 *
 * @param pipelineRunId - Required. The pipeline run to associate artifacts with.
 *   Callers without a pipeline context should use `ensureUrlPolicyRun()` once
 *   per batch and reuse the returned ID for all calls in that batch.
 * @returns The created artifact id, or null if logging was skipped (dedup).
 */
export async function persistUrlPolicyDecision(
  decision: UrlPolicyDecisionLog,
  pipelineRunId: string,
  options?: {
    deduplicate?: boolean;
    idempotencyKey?: string;
  },
): Promise<string | null> {
  const sanitized = sanitizeDecisionLog(decision);
  const deduplicate = options?.deduplicate !== false;

  if (deduplicate) {
    const key = options?.idempotencyKey || buildDecisionLogIdempotencyKey(sanitized);
    const existing = await prisma.pipelineArtifact.findFirst({
      where: {
        artifactType: "url_policy_decision",
        sourceId: sanitized.sourceId,
        errorLog: key,
      },
      select: { id: true },
    });
    if (existing) return null;
  }

  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    artifactKind: "url_policy_decision",
    url: sanitized.url,
    normalizedUrl: sanitized.normalizedUrl || null,
    sourceId: sanitized.sourceId || null,
    categoryId: sanitized.categoryId || null,
    agent: sanitized.agent || null,
    stage: sanitized.stage || null,
    discoveryMethod: sanitized.discoveryMethod || null,
    policyVersion: sanitized.policyVersion,
    ruleVersion: sanitized.ruleVersion || null,
    enforcementMode: sanitized.enforcementMode,
    decision: sanitized.decision,
    reasonCode: sanitized.reasonCode,
    evidence: sanitized.evidence || null,
    evaluationDatasetVersion: sanitized.evaluationDatasetVersion || null,
    createdAt: sanitized.createdAt,
  };

  const idempotencyKey = options?.idempotencyKey || buildDecisionLogIdempotencyKey(sanitized);

  const artifact = await prisma.pipelineArtifact.create({
    data: {
      pipelineRunId,
      sourceId: sanitized.sourceId,
      categoryId: sanitized.categoryId,
      artifactType: "url_policy_decision",
      status: "CAPTURED",
      candidateCount: 0,
      payload: payload as unknown as Prisma.InputJsonValue,
      errorLog: idempotencyKey,
    },
    select: { id: true },
  });

  return artifact.id;
}

/**
 * Convenience: observe and persist both production and candidate decisions.
 *
 * Creates a shared PipelineRun when none is provided, so both persist calls
 * share the same run ID (avoids creating two PipelineRun rows per URL).
 */
export async function observeAndLogUrlPolicyDecisions(
  input: UrlPolicyEvaluationInput,
  options?: {
    pipelineRunId?: string;
    deduplicate?: boolean;
  },
): Promise<{
  production: UrlPolicyDecisionLog;
  candidate: UrlPolicyDecisionLog;
  productionArtifactId: string | null;
  candidateArtifactId: string | null;
}> {
  const decisions = observeUrlPolicyDecisions(input);

  if (!isUrlPolicyDecisionPersistenceEnabled()) {
    return {
      production: decisions.production,
      candidate: decisions.candidate,
      productionArtifactId: null,
      candidateArtifactId: null,
    };
  }

  // Resolve or create a shared PipelineRun for this observation batch
  const pipelineRunId = options?.pipelineRunId ?? (await ensureUrlPolicyRun());

  const productionArtifactId = await persistUrlPolicyDecision(
    decisions.production,
    pipelineRunId,
    { deduplicate: options?.deduplicate },
  );
  const candidateArtifactId = await persistUrlPolicyDecision(
    decisions.candidate,
    pipelineRunId,
    { deduplicate: options?.deduplicate },
  );

  return {
    production: decisions.production,
    candidate: decisions.candidate,
    productionArtifactId,
    candidateArtifactId,
  };
}

// ─── Recent Decision Queries ──────────────────────────────────────────────

/**
 * Fetch recent URL policy decision artifacts.
 *
 * Read-only. Bounded result size (default 100).
 * Filters by top-level Prisma columns only (artifactType, sourceId).
 * Decision/enforcementMode filters use payload JSON path traversal.
 */
export async function getRecentUrlPolicyDecisions(options?: {
  limit?: number;
  sourceId?: string;
}): Promise<UrlPolicyDecisionLog[]> {
  const where: Record<string, unknown> = {
    artifactType: "url_policy_decision",
  };
  if (options?.sourceId) where.sourceId = options.sourceId;

  const artifacts = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: "url_policy_decision",
      ...(options?.sourceId ? { sourceId: options.sourceId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: options?.limit ?? 100,
    select: {
      payload: true,
      createdAt: true,
    },
  });

  return artifacts.map((a) => {
    const p = (a.payload as Record<string, unknown>) || {};
    return {
      url: String(p.url || ""),
      normalizedUrl: p.normalizedUrl ? String(p.normalizedUrl) : undefined,
      sourceId: p.sourceId ? String(p.sourceId) : undefined,
      categoryId: p.categoryId ? String(p.categoryId) : undefined,
      agent: p.agent ? (p.agent as AgentName) : undefined,
      stage: p.stage ? String(p.stage) : undefined,
      discoveryMethod: p.discoveryMethod ? String(p.discoveryMethod) : undefined,
      policyVersion: String(p.policyVersion || ""),
      ruleVersion: p.ruleVersion ? String(p.ruleVersion) : undefined,
      enforcementMode: p.enforcementMode as "ENFORCED" | "SHADOW",
      decision: p.decision as UrlPolicyDecisionLog["decision"],
      reasonCode: String(p.reasonCode || ""),
      evidence: p.evidence ? (p.evidence as Record<string, unknown>) : undefined,
      evaluationDatasetVersion: p.evaluationDatasetVersion
        ? String(p.evaluationDatasetVersion)
        : undefined,
      createdAt: a.createdAt.toISOString(),
    };
  });
}
