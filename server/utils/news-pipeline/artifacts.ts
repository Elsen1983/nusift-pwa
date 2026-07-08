import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import type {
  HardCaseDiscoveryCandidate,
  IngestCandidate,
  IngestRejectedItem,
  IngestResult,
  IngestSkipSummary,
  PipelineResult,
  ScopeMatch,
} from "./types";

const serializeCandidateProvenance = (
  provenance: IngestCandidate["provenance"],
): Prisma.InputJsonObject => ({
  origin: provenance.origin,
  feedUrl: provenance.feedUrl || null,
  feedFormat: provenance.feedFormat || null,
  discoveredFromCategoryFeed: provenance.discoveredFromCategoryFeed || false,
  sourcePageUrl: provenance.sourcePageUrl || null,
  fetchedAt: provenance.fetchedAt,
});

const serializeCandidate = (candidate: IngestCandidate): Prisma.InputJsonObject => ({
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
  provenance: serializeCandidateProvenance(candidate.provenance),
  normalizationFlags: candidate.normalizationFlags || [],
});

const serializeSkipSummary = (skipSummary: IngestSkipSummary) => ({
  emptyLink: skipSummary.emptyLink,
  outOfScope: skipSummary.outOfScope,
  staleOrMissingPublishedAt: skipSummary.staleOrMissingPublishedAt,
  htmlFallbackNonArticle: skipSummary.htmlFallbackNonArticle,
  htmlFallbackStale: skipSummary.htmlFallbackStale,
});

const serializeRejectedItem = (item: IngestRejectedItem) => ({
  reason: item.reason,
  rawLink: item.rawLink || null,
  canonicalUrl: item.canonicalUrl || null,
  title: item.title || null,
  publishedAt: item.publishedAt || null,
});

const serializeHardCaseDiscoveryCandidate = (
  candidate: HardCaseDiscoveryCandidate,
): Prisma.InputJsonObject => ({
  targetType: candidate.targetType,
  sourceId: candidate.sourceId,
  categoryId: candidate.categoryId || null,
  targetUrl: candidate.targetUrl,
  existingFeedUrl: candidate.existingFeedUrl || null,
  queueReason: candidate.queueReason,
  discovery: {
    feedUrl: candidate.discovery.feedUrl,
    discoveredVia: candidate.discovery.discoveredVia,
    detection: candidate.discovery.detection,
    score: candidate.discovery.score,
    scopeConfidence: candidate.discovery.scopeConfidence,
    scopeMatch: candidate.discovery.scopeMatch || "generic",
    taxonomyEvidence: candidate.discovery.taxonomyEvidence || null,
    topCandidates: candidate.discovery.topCandidates,
    rejectedCandidates: candidate.discovery.rejectedCandidates,
    lastError: candidate.discovery.lastError || null,
  } satisfies Prisma.InputJsonValue,
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
  const payload: Prisma.InputJsonObject = {
    sourceId: input.result.sourceId,
    categoryId: input.result.categoryId || null,
    capturedAt: new Date().toISOString(),
    candidateCount: input.result.candidates.length,
    failed: input.result.failed,
    feedUrl: input.result.feedUrl || null,
    feedFormat: input.result.feedFormat || null,
    skipSummary: serializeSkipSummary(input.result.skipSummary),
    rejectedItems: input.result.rejectedItems.map(serializeRejectedItem),
    candidates: input.result.candidates.map(serializeCandidate) as Prisma.InputJsonArray,
  };

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

export async function persistHardCaseDiscoveryArtifacts(input: {
  pipelineRunId: string;
  result: IngestResult;
}) {
  const queueCandidates = input.result.hardCaseQueueCandidates || [];
  if (queueCandidates.length === 0) {
    return 0;
  }

  await prisma.pipelineArtifact.createMany({
    data: queueCandidates.map((candidate) => ({
      pipelineRunId: input.pipelineRunId,
      sourceId: candidate.sourceId,
      categoryId: candidate.categoryId || null,
      artifactType: "hard_case_discovery_candidate",
      status: "PENDING_HEADLESS",
      candidateCount: 0,
      payload: serializeHardCaseDiscoveryCandidate(candidate),
      errorLog: `Queued ${candidate.targetType} hard-case discovery for ${candidate.targetUrl}. reason=${candidate.queueReason}.`,
    })),
  });

  return queueCandidates.length;
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
