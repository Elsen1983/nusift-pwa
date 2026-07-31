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
  sourceId: string;
  categoryId: string | null;
  targetUrl: string;
  payload: Prisma.InputJsonObject;
  errorLog?: string | null;
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
): Promise<{ artifact: Awaited<ReturnType<typeof prisma.pipelineArtifact.create>>; created: boolean }> {
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
    if (existing) return { artifact: existing, created: false };

    const artifact = await tx.pipelineArtifact.create({
      data: {
        pipelineRunId: input.pipelineRunId,
        sourceId: input.sourceId,
        categoryId: input.categoryId,
        artifactType: "article_discovery_headless_required",
        status: "PENDING_HEADLESS",
        candidateCount: 0,
        payload: {
          ...input.payload,
          targetUrl: input.targetUrl,
          targetKey,
        },
        errorLog: input.errorLog ?? null,
      },
    });
    return { artifact, created: true };
  });
}
