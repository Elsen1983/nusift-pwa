import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { stableTargetKey } from "./text";

export const ACTIVE_HEADLESS_QUEUE_STATUSES = [
  "PENDING_HEADLESS",
  "HEADLESS_PROCESSING",
  "HEADLESS_PROCESSING_STALE",
] as const;

type CreateHeadlessQueueArtifactInput = {
  pipelineRunId: string;
  orchestrationRunId?: string | null;
  sourceId: string;
  categoryId: string | null;
  targetUrl: string;
  payload: Prisma.InputJsonObject;
  errorLog?: string | null;
};

type HeadlessQueueArtifactResult = {
  artifact: Awaited<ReturnType<typeof prisma.pipelineArtifact.create>>;
  created: boolean;
  /** True only when a PENDING_HEADLESS static evidence CAS update succeeded. */
  evidenceRefreshed: boolean;
  /** True when a PENDING_HEADLESS refresh lost its status CAS race. */
  evidenceRefreshConflict: boolean;
};

const readRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const MAX_STATIC_EVIDENCE_STRING = 512;
const boundedString = (value: unknown, max = MAX_STATIC_EVIDENCE_STRING): string | null =>
  typeof value === "string" ? value.slice(0, max) : null;
const boundedNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const boundedBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const compactRateLimitEvidence = (value: unknown): Prisma.InputJsonValue[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).map((item) => {
    const evidence = readRecord(item);
    return {
      phase: boundedString(evidence.phase, 32),
      url: boundedString(evidence.url),
      status: evidence.status === 429 ? 429 : null,
      retryAfterAt: boundedString(evidence.retryAfterAt, 64),
      retryAfterSource: boundedString(evidence.retryAfterSource, 32),
    };
  });
};

const compactSkippedWork = (value: unknown): Prisma.InputJsonValue[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    const skipped = readRecord(item);
    return {
      phase: boundedString(skipped.phase, 32),
      url: boundedString(skipped.url),
      reason: boundedString(skipped.reason, 128),
    };
  });
};

/**
 * Keep static retry evidence separate from browser claim/recovery fields. The
 * projection is deliberately compact and bounded before it is persisted so a
 * malformed or unexpectedly large discovery payload cannot expand the queue
 * marker without limit.
 */
const buildStaticDiscoveryEvidence = (
  input: CreateHeadlessQueueArtifactInput,
  targetKey: string,
): Prisma.InputJsonObject => {
  const payload = readRecord(input.payload);
  const requestBudget = readRecord(payload.requestBudget);
  return {
    targetUrl: boundedString(input.targetUrl),
    targetKey: boundedString(targetKey),
    stopReason: boundedString(payload.stopReason, 64),
    rateLimitPhase: boundedString(payload.rateLimitPhase, 32),
    retryAfterAt: boundedString(payload.retryAfterAt, 64),
    retryAfterSource: boundedString(payload.retryAfterSource, 32),
    rateLimitEvidence: compactRateLimitEvidence(payload.rateLimitEvidence),
    requestBudget: {
      limit: boundedNumber(requestBudget.limit),
      used: boundedNumber(requestBudget.used),
      remaining: boundedNumber(requestBudget.remaining),
      exhausted: boundedBoolean(requestBudget.exhausted),
      skippedWork: compactSkippedWork(requestBudget.skippedWork),
    },
    discoveryComplete: boundedBoolean(payload.discoveryComplete),
    retryable: boundedBoolean(payload.retryable),
    acceptedCount: boundedNumber(payload.acceptedCount),
    evaluatedCount: boundedNumber(payload.evaluatedCount),
    updatedAt: new Date().toISOString(),
  };
};

const compactStringArray = (value: unknown, itemMax = 128, maxItems = 8): string[] =>
  Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === "string")
      .slice(0, maxItems)
      .map((item) => item.slice(0, itemMax))
    : [];

const compactOutcomeSummary = (value: unknown): Prisma.InputJsonObject | null => {
  const summary = readRecord(value);
  if (Object.keys(summary).length === 0) return null;
  const byStatus = readRecord(summary.byStatus);
  const bySourceKind = readRecord(summary.bySourceKind);
  return {
    totalEvaluated: boundedNumber(summary.totalEvaluated),
    accepted: boundedNumber(summary.accepted),
    rejected: boundedNumber(summary.rejected),
    byStatus: Object.fromEntries(
      Object.entries(byStatus).slice(0, 20).map(([key, count]) => [key.slice(0, 64), boundedNumber(count)]),
    ),
    bySourceKind: Object.fromEntries(
      Object.entries(bySourceKind).slice(0, 10).map(([key, count]) => [key.slice(0, 64), boundedNumber(count)]),
    ),
  };
};

const compactDiscoverySources = (value: unknown): Prisma.InputJsonObject | null => {
  const sources = readRecord(value);
  if (Object.keys(sources).length === 0) return null;
  return {
    listingPages: boundedNumber(sources.listingPages),
    sitemapUrls: boundedNumber(sources.sitemapUrls),
    jsonldUrls: boundedNumber(sources.jsonldUrls),
  };
};

/**
 * New markers use an allowlist rather than spreading the full discovery
 * artifact. The full static artifact remains the authoritative audit record;
 * the queue marker carries only the compact fields needed by the consumer and
 * the namespaced retry evidence.
 */
const mergeCreatedPayload = (
  input: CreateHeadlessQueueArtifactInput,
  targetKey: string,
): Prisma.InputJsonObject => {
  const payload = readRecord(input.payload);
  const staticDiscovery = buildStaticDiscoveryEvidence(input, targetKey);
  return {
    schemaVersion: 2,
    artifactKind: "headless_escalation_marker",
    sourceId: boundedString(payload.sourceId, 128),
    categoryId: boundedString(payload.categoryId, 128),
    targetUrl: boundedString(input.targetUrl),
    targetKey,
    quality: boundedString(payload.quality, 32),
    confidence: boundedString(payload.confidence, 32),
    escalationReasons: compactStringArray(payload.escalationReasons, 64),
    explanation: boundedString(payload.explanation, 512),
    outcomeSummary: compactOutcomeSummary(payload.outcomeSummary),
    discoverySources: compactDiscoverySources(payload.discoverySources),
    retryOfArtifactId: boundedString(payload.retryOfArtifactId, 128),
    retryOfStatus: boundedString(payload.retryOfStatus, 64),
    retryRequestedAt: boundedString(payload.retryRequestedAt, 64),
    retryRequestedByUserId: boundedString(payload.retryRequestedByUserId, 128),
    retryReason: boundedString(payload.retryReason, 128),
    // Keep compact top-level aliases for existing queue/audit readers while
    // making staticDiscovery the authoritative namespaced evidence for refresh.
    stopReason: staticDiscovery.stopReason,
    rateLimitPhase: staticDiscovery.rateLimitPhase,
    retryAfterAt: staticDiscovery.retryAfterAt,
    retryAfterSource: staticDiscovery.retryAfterSource,
    rateLimitEvidence: staticDiscovery.rateLimitEvidence,
    requestBudget: staticDiscovery.requestBudget,
    discoveryComplete: staticDiscovery.discoveryComplete,
    retryable: staticDiscovery.retryable,
    acceptedCount: staticDiscovery.acceptedCount,
    evaluatedCount: staticDiscovery.evaluatedCount,
    staticDiscovery,
  };
};

const mergeExistingPayload = (
  existingPayload: Prisma.JsonValue,
  input: CreateHeadlessQueueArtifactInput,
  targetKey: string,
): Prisma.InputJsonObject => {
  const staticDiscovery = buildStaticDiscoveryEvidence(input, targetKey);
  return {
    ...readRecord(existingPayload),
    // targetKey is authoritative and must never be replaced by caller payload.
    targetKey,
    // Refresh compact aliases as well as the namespaced object so legacy queue
    // readers cannot observe stale cooldown/completeness counters. Unrelated
    // browser claim/recovery fields remain untouched by the surrounding merge.
    stopReason: staticDiscovery.stopReason,
    rateLimitPhase: staticDiscovery.rateLimitPhase,
    retryAfterAt: staticDiscovery.retryAfterAt,
    retryAfterSource: staticDiscovery.retryAfterSource,
    rateLimitEvidence: staticDiscovery.rateLimitEvidence,
    requestBudget: staticDiscovery.requestBudget,
    discoveryComplete: staticDiscovery.discoveryComplete,
    retryable: staticDiscovery.retryable,
    acceptedCount: staticDiscovery.acceptedCount,
    evaluatedCount: staticDiscovery.evaluatedCount,
    staticDiscovery,
  };
};

function readTargetKey(payload: Prisma.JsonValue): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).targetKey;
  return typeof value === "string" ? value : null;
}

function readTargetUrl(payload: Prisma.JsonValue): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).targetUrl;
  return typeof value === "string" ? value : null;
}

/**
 * Creates at most one active Agent 2 headless artifact per stable target key.
 * The PostgreSQL transaction-scoped advisory lock serializes concurrent
 * creators before the authoritative second check.
 */
export async function createHeadlessQueueArtifactIfAbsent(
  input: CreateHeadlessQueueArtifactInput,
): Promise<HeadlessQueueArtifactResult> {
  const targetKey = stableTargetKey(input.sourceId, input.categoryId, input.targetUrl);
  if (!targetKey) {
    throw new Error(`Cannot create headless queue artifact for invalid target URL: ${input.targetUrl}`);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) IS NULL AS locked",
      `article-discovery-headless:${targetKey}`,
    );

    const active = await tx.pipelineArtifact.findMany({
      where: {
        artifactType: "article_discovery_headless_required",
        status: { in: [...ACTIVE_HEADLESS_QUEUE_STATUSES] },
        sourceId: input.sourceId,
        categoryId: input.categoryId,
      },
      orderBy: { createdAt: "desc" },
    });

    const existing = active.find((artifact) => {
      const payloadKey = readTargetKey(artifact.payload);
      if (payloadKey) return payloadKey === targetKey;
      return stableTargetKey(
        artifact.sourceId,
        artifact.categoryId,
        readTargetUrl(artifact.payload),
      ) === targetKey;
    });
    if (existing) {
      // Only a still-pending marker may receive static operational evidence.
      // The status predicate is the compare-and-set guard: a browser worker
      // can claim the marker between findMany and this update without having
      // its processing payload overwritten.
      if (existing.status !== "PENDING_HEADLESS") {
        return {
          artifact: existing,
          created: false,
          evidenceRefreshed: false,
          evidenceRefreshConflict: false,
        };
      }

      const refreshedPayload = mergeExistingPayload(existing.payload, input, targetKey);
      const refreshed = await tx.pipelineArtifact.updateMany({
        where: {
          id: existing.id,
          status: "PENDING_HEADLESS",
        },
        data: {
          payload: refreshedPayload,
        },
      });
      if (refreshed.count === 1) {
        return {
          artifact: {
            ...existing,
            payload: refreshedPayload as unknown as Prisma.JsonValue,
          },
          created: false,
          evidenceRefreshed: true,
          evidenceRefreshConflict: false,
        };
      }

      return {
        artifact: existing,
        created: false,
        evidenceRefreshed: false,
        evidenceRefreshConflict: true,
      };
    }

    const artifact = await tx.pipelineArtifact.create({
      data: {
        pipelineRunId: input.pipelineRunId,
        orchestrationRunId: input.orchestrationRunId ?? null,
        sourceId: input.sourceId,
        categoryId: input.categoryId,
        artifactType: "article_discovery_headless_required",
        status: "PENDING_HEADLESS",
        candidateCount: 0,
        payload: mergeCreatedPayload(input, targetKey),
        errorLog: input.errorLog ?? null,
      },
    });
    return {
      artifact,
      created: true,
      evidenceRefreshed: false,
      evidenceRefreshConflict: false,
    };
  });
}
