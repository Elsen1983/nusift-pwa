import { prisma } from "../prisma";
import { discoverFeedForUrl } from "./feed-discovery";
import { logAgentScan } from "./log";

type HardCaseArtifactPayload = {
  targetType: "source" | "category";
  sourceId: string;
  categoryId?: string | null;
  targetUrl: string;
  existingFeedUrl?: string | null;
  queueReason?: string;
  discovery?: Record<string, unknown> | null;
};

const buildDiscoveryEvidencePayload = (
  targetUrl: string,
  discovery: {
    feedUrl: string | null;
    discoveredVia?: string | null;
    detection: string;
    scopeConfidence?: string;
    score?: number;
    topCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
    }>;
    rejectedCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      reason: string;
    }>;
    lastError?: string;
  },
) => ({
  evaluatedAt: new Date().toISOString(),
  targetUrl,
  feedUrl: discovery.feedUrl,
  discoveredVia: discovery.discoveredVia || null,
  detection: discovery.detection,
  scopeConfidence: discovery.scopeConfidence || "low",
  score: discovery.score ?? 0,
  topCandidates: discovery.topCandidates || [],
  rejectedCandidates: discovery.rejectedCandidates || [],
  lastError: discovery.lastError || null,
});

const parseArtifactPayload = (payload: unknown): HardCaseArtifactPayload | null => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const targetType = candidate.targetType === "category" ? "category" : candidate.targetType === "source" ? "source" : null;
  const sourceId = typeof candidate.sourceId === "string" ? candidate.sourceId : null;
  const targetUrl = typeof candidate.targetUrl === "string" ? candidate.targetUrl : null;

  if (!targetType || !sourceId || !targetUrl) {
    return null;
  }

  return {
    targetType,
    sourceId,
    categoryId: typeof candidate.categoryId === "string" ? candidate.categoryId : null,
    targetUrl,
    existingFeedUrl: typeof candidate.existingFeedUrl === "string" ? candidate.existingFeedUrl : null,
    queueReason: typeof candidate.queueReason === "string" ? candidate.queueReason : undefined,
    discovery:
      candidate.discovery && typeof candidate.discovery === "object"
        ? (candidate.discovery as Record<string, unknown>)
        : null,
  };
};

export async function processHardCaseDiscoveryQueue(limit = 10) {
  const take = Math.max(1, Math.min(50, limit));
  const queueItems = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: "hard_case_discovery_candidate",
      status: "PENDING_HEADLESS",
    },
    orderBy: {
      createdAt: "asc",
    },
    take,
    select: {
      id: true,
      sourceId: true,
      categoryId: true,
      payload: true,
    },
  });

  let processed = 0;
  let resolved = 0;
  let failedFinal = 0;
  let invalid = 0;

  for (const item of queueItems) {
    processed += 1;

    const payload = parseArtifactPayload(item.payload);
    if (!payload) {
      invalid += 1;
      await prisma.pipelineArtifact.update({
        where: { id: item.id },
        data: {
          status: "FAILED_FINAL",
          errorLog: "Invalid hard-case artifact payload.",
        },
      });
      continue;
    }

    await prisma.pipelineArtifact.update({
      where: { id: item.id },
      data: {
        status: "PROCESSING_HEADLESS",
      },
    });

    await logAgentScan({
      sourceId: payload.sourceId,
      categoryId: payload.categoryId || undefined,
      status: "HARD_CASE_HEADLESS_STARTED",
      executionTimeMs: 0,
      errorLog: `Processing hard-case discovery for ${payload.targetUrl}.`,
    });

    try {
      const discovery = await discoverFeedForUrl({
        pageUrl: payload.targetUrl,
        existingFeedUrl: payload.existingFeedUrl || null,
        userAgent: "NuSift/1.0 HardCase-Agent",
        preferScopedDirectFeed: payload.targetType === "category",
      });

      const discoveryEvidence = buildDiscoveryEvidencePayload(
        payload.targetUrl,
        discovery,
      );

      if (payload.targetType === "category" && payload.categoryId) {
        await prisma.sourceCategory.update({
          where: { id: payload.categoryId },
          data: {
            rssFeedUrl: discovery.feedUrl,
            rssStatus: discovery.feedUrl ? "ACTIVE" : "NO_RSS_FOUND",
            lastRssCheckAt: new Date(),
            discoveryEvidence,
          },
        });
      } else {
        await prisma.newsSource.update({
          where: { id: payload.sourceId },
          data: {
            rssFeedUrl: discovery.feedUrl,
            rssStatus: discovery.feedUrl ? "ACTIVE" : "NO_RSS_FOUND",
            lastRssCheckAt: new Date(),
            discoveryEvidence,
          },
        });
      }

      const finalStatus = discovery.feedUrl ? "RESOLVED" : "FAILED_FINAL";
      if (discovery.feedUrl) {
        resolved += 1;
      } else {
        failedFinal += 1;
      }

      await prisma.pipelineArtifact.update({
        where: { id: item.id },
        data: {
          status: finalStatus,
          payload: {
            ...(payload as Record<string, unknown>),
            headlessAttemptedAt: new Date().toISOString(),
            headlessResult: {
              feedUrl: discovery.feedUrl,
              discoveredVia: discovery.discoveredVia || null,
              detection: discovery.detection,
              score: discovery.score ?? 0,
              scopeConfidence: discovery.scopeConfidence || "low",
              topCandidates: discovery.topCandidates || [],
              rejectedCandidates: discovery.rejectedCandidates || [],
              lastError: discovery.lastError || null,
            },
          },
          errorLog: discovery.feedUrl
            ? `Headless queue resolved ${payload.targetType} feed: ${discovery.feedUrl}`
            : `Headless queue failed for ${payload.targetUrl}. ${discovery.lastError || "No feed found."}`,
        },
      });

      await logAgentScan({
        sourceId: payload.sourceId,
        categoryId: payload.categoryId || undefined,
        status: discovery.feedUrl
          ? "HARD_CASE_HEADLESS_RESOLVED"
          : "HARD_CASE_HEADLESS_FAILED_FINAL",
        executionTimeMs: 0,
        errorLog: discovery.feedUrl
          ? `Resolved via hard-case queue: ${discovery.feedUrl}`
          : discovery.lastError || `No feed found for ${payload.targetUrl}.`,
      });
    } catch (error: any) {
      failedFinal += 1;
      const errorMessage = error?.message || String(error);

      await prisma.pipelineArtifact.update({
        where: { id: item.id },
        data: {
          status: "FAILED_FINAL",
          payload: {
            ...(payload as Record<string, unknown>),
            headlessAttemptedAt: new Date().toISOString(),
            headlessResult: {
              feedUrl: null,
              detection: "none",
              score: 0,
              scopeConfidence: "low",
              topCandidates: [],
              rejectedCandidates: [],
              lastError: errorMessage,
            },
          },
          errorLog: errorMessage,
        },
      });

      await logAgentScan({
        sourceId: payload.sourceId,
        categoryId: payload.categoryId || undefined,
        status: "HARD_CASE_HEADLESS_FAILED_FINAL",
        executionTimeMs: 0,
        errorLog: errorMessage,
      });
    }
  }

  return {
    processed,
    resolved,
    failedFinal,
    invalid,
  };
}
