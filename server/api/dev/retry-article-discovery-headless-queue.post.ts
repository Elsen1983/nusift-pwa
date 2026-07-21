import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";

const RETRIABLE_HEADLESS_STATUSES = new Set([
  "BROWSER_NO_CANDIDATES",
  "BROWSER_RUNTIME_UNAVAILABLE",
  "BROWSER_FALLBACK_DISABLED",
  "HEADLESS_PROCESSING_STALE",
  "SKIPPED_UNIMPLEMENTED",
  "INVALID",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export default defineEventHandler(async (event) => {
  const adminId = await requireAdminId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "headless-queue-retry", 10, 10 * 60 * 1000);

  const body = await readBody(event).catch(() => ({}));
  const artifactId = readString(body?.artifactId);
  const retryReason = readString(body?.reason) || "manual_admin_retry";

  if (!artifactId) {
    throw createError({ statusCode: 400, statusMessage: "artifactId is required." });
  }

  const artifact = await prisma.pipelineArtifact.findUnique({
    where: { id: artifactId },
    select: {
      id: true,
      artifactType: true,
      status: true,
      sourceId: true,
      categoryId: true,
      payload: true,
    },
  });

  if (!artifact || artifact.artifactType !== "article_discovery_headless_required") {
    throw createError({ statusCode: 404, statusMessage: "Headless queue artifact not found." });
  }

  if (!RETRIABLE_HEADLESS_STATUSES.has(artifact.status)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Artifact status ${artifact.status} is not retryable.`,
    });
  }

  const payload = isPlainObject(artifact.payload) ? artifact.payload : {};
  const targetUrl = readString(payload.targetUrl);
  const sourceId = readString(payload.sourceId) || artifact.sourceId;
  const categoryId = readString(payload.categoryId) || artifact.categoryId;

  if (!targetUrl || !sourceId) {
    throw createError({
      statusCode: 400,
      statusMessage: "Cannot retry artifact with missing targetUrl or sourceId.",
    });
  }

  const now = new Date().toISOString();
  const retryPayload = {
    targetUrl,
    sourceId,
    categoryId: categoryId || null,
    quality: readString(payload.quality) || "failed",
    confidence: readString(payload.confidence),
    escalationReasons: readStringArray(payload.escalationReasons),
    outcomeSummary: isPlainObject(payload.outcomeSummary) ? payload.outcomeSummary : null,
    discoverySources: isPlainObject(payload.discoverySources) ? payload.discoverySources : null,
    retryOfArtifactId: artifact.id,
    retryOfStatus: artifact.status,
    retryRequestedAt: now,
    retryRequestedByUserId: adminId,
    retryReason,
  };

  const run = await prisma.pipelineRun.create({
    data: {
      status: "COMPLETED",
      targetCount: 1,
      artifactCount: 1,
      summary: {
        type: "article_discovery_headless_retry",
        retryOfArtifactId: artifact.id,
        targetUrl,
        requestedByUserId: adminId,
        createdAt: now,
      },
    },
    select: { id: true },
  });

  const retryArtifact = await prisma.pipelineArtifact.create({
    data: {
      pipelineRunId: run.id,
      sourceId,
      categoryId: categoryId || null,
      artifactType: "article_discovery_headless_required",
      status: "PENDING_HEADLESS",
      candidateCount: 0,
      payload: retryPayload,
      errorLog: `Manual retry requested for ${artifact.status} artifact ${artifact.id}.`,
    },
    select: {
      id: true,
      status: true,
      sourceId: true,
      categoryId: true,
      payload: true,
    },
  });

  return {
    ok: true,
    retryArtifact,
  };
});
