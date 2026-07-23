import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";

const readPayload = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};

const readNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const readBoolean = (value: unknown) => value === true;

const readString = (value: unknown) =>
  typeof value === "string" ? value : null;

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "agent1-run-summary", 10, 60 * 1000);

  const latestArtifact = await prisma.pipelineArtifact.findFirst({
    where: { artifactType: "agent1_target_outcome" },
    select: { pipelineRunId: true },
    orderBy: { createdAt: "desc" },
  });

  if (!latestArtifact) {
    return {
      ok: true,
      run: null,
      items: [],
    };
  }

  const [run, artifacts] = await Promise.all([
    prisma.pipelineRun.findUnique({
      where: { id: latestArtifact.pipelineRunId },
      select: {
        id: true,
        startedAt: true,
        finishedAt: true,
        targetCount: true,
        candidatesFound: true,
        inserted: true,
        skipped: true,
        failed: true,
        artifactCount: true,
      },
    }),
    prisma.pipelineArtifact.findMany({
      where: {
        pipelineRunId: latestArtifact.pipelineRunId,
        artifactType: "agent1_target_outcome",
      },
      select: {
        id: true,
        createdAt: true,
        sourceId: true,
        categoryId: true,
        status: true,
        candidateCount: true,
        payload: true,
        errorLog: true,
      },
      orderBy: { createdAt: "asc" },
      take: 250,
    }),
  ]);

  return {
    ok: true,
    run,
    items: artifacts.map((artifact) => {
      const payload = readPayload(artifact.payload);
      return {
        id: artifact.id,
        createdAt: artifact.createdAt,
        sourceId: artifact.sourceId,
        categoryId: artifact.categoryId,
        status: artifact.status,
        passed: readBoolean(payload.passed),
        handedToAgent2: readBoolean(payload.handedToAgent2),
        sourceUrl: readString(payload.sourceUrl),
        candidates: readNumber(payload.candidates),
        inserted: readNumber(payload.inserted),
        skipped: readNumber(payload.skipped),
        failed: readNumber(payload.failed),
        enriched: readNumber(payload.enriched),
        feedUrl: readString(payload.feedUrl),
        feedFormat: readString(payload.feedFormat),
        failureReason: readString(payload.failureReason) || artifact.errorLog,
      };
    }),
  };
});
