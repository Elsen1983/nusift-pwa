import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import type { IngestCandidate, IngestRejectedItem, IngestResult, IngestSkipSummary, PipelineResult } from "./types";

const serializeCandidate = (candidate: IngestCandidate) => ({
  sourceId: candidate.sourceId,
  categoryId: candidate.categoryId || null,
  sourceUrl: candidate.sourceUrl,
  canonicalUrl: candidate.canonicalUrl,
  rssGuid: candidate.rssGuid || null,
  rawTitle: candidate.rawTitle || null,
  title: candidate.title,
  publishedAt: candidate.publishedAt ? candidate.publishedAt.toISOString() : null,
  rawBodyText: candidate.rawBodyText || null,
  bodyText: candidate.bodyText || null,
  contentHash: candidate.contentHash,
  isPaywall: candidate.isPaywall,
  rawTags: candidate.rawTags,
  rawSignals: candidate.rawSignals,
  reasoning: candidate.reasoning,
  provenance: candidate.provenance,
  normalizationFlags: candidate.normalizationFlags || [],
});

export async function createPipelineRun(targetCount: number) {
  return prisma.pipelineRun.create({
    data: {
      status: "RUNNING",
      targetCount,
    },
    select: {
      id: true,
    },
  });
}

export async function persistPipelineArtifact(input: {
  pipelineRunId: string;
  result: IngestResult;
}) {
  const payload = {
    sourceId: input.result.sourceId,
    categoryId: input.result.categoryId || null,
    capturedAt: new Date().toISOString(),
    candidateCount: input.result.candidates.length,
    failed: input.result.failed,
    feedUrl: input.result.feedUrl || null,
    feedFormat: input.result.feedFormat || null,
    skipSummary: input.result.skipSummary satisfies IngestSkipSummary,
    rejectedItems: input.result.rejectedItems satisfies IngestRejectedItem[],
    candidates: input.result.candidates.map(serializeCandidate),
  } satisfies Prisma.InputJsonValue;

  return prisma.pipelineArtifact.create({
    data: {
      pipelineRunId: input.pipelineRunId,
      sourceId: input.result.sourceId,
      categoryId: input.result.categoryId || null,
      artifactType: "rss_candidates",
      status: input.result.failed > 0 && input.result.candidates.length === 0 ? "FAILED" : "CAPTURED",
      candidateCount: input.result.candidates.length,
      payload,
      errorLog:
        input.result.failed > 0 && input.result.candidates.length === 0
          ? "No candidates captured for target."
          : null,
    },
  });
}

export async function finalizePipelineRun(input: {
  pipelineRunId: string;
  result: PipelineResult;
}) {
  return prisma.pipelineRun.update({
    where: { id: input.pipelineRunId },
    data: {
      status: input.result.failed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
      finishedAt: new Date(),
      candidatesFound: input.result.candidatesFound,
      inserted: input.result.inserted,
      skipped: input.result.skipped,
      failed: input.result.failed,
      artifactCount: input.result.artifactCount || 0,
      summary: {
        sourcesScanned: input.result.sourcesScanned,
        candidatesFound: input.result.candidatesFound,
        inserted: input.result.inserted,
        skipped: input.result.skipped,
        failed: input.result.failed,
        artifactCount: input.result.artifactCount || 0,
      } satisfies Prisma.InputJsonValue,
    },
  });
}
