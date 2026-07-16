import { prisma } from "../prisma";
import { canonicalFeedKey, discoverFeedForUrl, verifyFeedCandidate } from "./feed-discovery";
import { logAgentScan } from "./log";
import {
  resolveFeedsWithBrowser,
  shouldAttemptBrowserResolution,
  type BrowserFeedCandidate,
  type BrowserResolveResult,
} from "./browser-feed-resolver";
import { runNewsPipeline } from "./orchestrator";
import { getFeedProductivityResetData } from "./feed-productivity";
import type { DiscoveryOutcome, FeedDiscoveryResult, PipelineResult, PipelineTarget, ResolutionMeta } from "./types";
import { createDiscoveryOutcome, buildErrorDiscoveryOutcome, serializeDiscoveryPayload, serializeDiscoveryPayloadWithMeta } from "./types";

// ─── Payload Types ──────────────────────────────────────────────────────────

type HardCaseArtifactPayload = {
  targetType: "source" | "category";
  sourceId: string;
  categoryId?: string | null;
  targetUrl: string;
  existingFeedUrl?: string | null;
  queueReason?: string;
  discovery?: Record<string, unknown> | null;
};

// FeedDiscoveryResult is imported from ./types

/** Combined return from the browser-augmented discovery flow. */
export type HardCaseResolution = {
  discovery: FeedDiscoveryResult;
  meta: ResolutionMeta;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const BROWSER_DETECTION_MAP: Record<
  BrowserFeedCandidate["source"],
  string
> = {
  "dom-link": "browser-dom-link",
  "inline-script": "browser-inline-script",
  "json-ld": "browser-json-ld",
  "anchor-tag": "browser-anchor-tag",
  "embedded-markup": "browser-embedded-markup",
  "common-path-probe": "browser-common-path-probe",
};

const BROWSER_CANDIDATE_BASE_SCORE: Record<BrowserFeedCandidate["source"], number> = {
  "dom-link": 40,
  "json-ld": 35,
  "inline-script": 30,
  "anchor-tag": 25,
  "embedded-markup": 20,
  "common-path-probe": 28,
};

// ─── Browser-Augmented Discovery ────────────────────────────────────────────

/**
 * Extended feed discovery that attempts browser-based DOM resolution when
 * standard fetch-based discovery fails to find a feed.
 *
 * Flow:
 * 1. Run standard `discoverFeedForUrl` (fetch-based, unchanged)
 * 2. If feed found → return with resolverPath="fetch"
 * 3. If no feed → run browser-based DOM resolution (jsdom, optionally Playwright)
 * 4. Verify browser-discovered candidates
 * 5. Return best verified result with full resolution metadata
 *
 * @param targetIds - sourceId/categoryId for target-aware logging
 */
export async function discoverFeedWithBrowserFallback(
  input: {
    pageUrl: string;
    existingFeedUrl?: string | null;
    preferScopedDirectFeed?: boolean;
  },
  targetIds?: { sourceId?: string; categoryId?: string },
): Promise<HardCaseResolution> {
  const userAgent = "NuSift/1.0 HardCase-Agent";

  // ── Step 1: Standard fetch-based discovery ──────────────────────────────
  const fetchResult = await discoverFeedForUrl({
    pageUrl: input.pageUrl,
    existingFeedUrl: input.existingFeedUrl || null,
    userAgent,
    preferScopedDirectFeed: input.preferScopedDirectFeed,
  });

  // If fetch-based discovery succeeded, return immediately
  if (fetchResult.feedUrl) {
    return {
      discovery: fetchResult,
      meta: {
        resolverPath: "fetch",
        browserAttempted: false,
        browserMethod: "none",
        browserCandidateCount: 0,
        browserCandidates: [],
        browserError: null,
      },
    };
  }

  // ── Step 2: Check if browser resolution is applicable ───────────────────
  if (!shouldAttemptBrowserResolution(input.pageUrl)) {
    return {
      discovery: fetchResult,
      meta: {
        resolverPath: "none",
        browserAttempted: false,
        browserMethod: "none",
        browserCandidateCount: 0,
        browserCandidates: [],
        browserError: null,
      },
    };
  }

  // ── Step 3: Browser-based DOM resolution ────────────────────────────────
  await logAgentScan({
    sourceId: targetIds?.sourceId,
    categoryId: targetIds?.categoryId,
    status: "BROWSER_RESOLUTION_STARTED",
    executionTimeMs: 0,
    errorLog: `Attempting browser-based DOM resolution for ${input.pageUrl}. Fetch-based discovery found ${fetchResult.topCandidates.length} candidate(s) but none verified.`,
  });

  let browserResult: BrowserResolveResult;
  try {
    browserResult = await resolveFeedsWithBrowser({
      pageUrl: input.pageUrl,
      userAgent,
    });
  } catch (error: any) {
    const errorMsg = `Browser resolution failed: ${error?.message || String(error)}`;
    await logAgentScan({
      sourceId: targetIds?.sourceId,
      categoryId: targetIds?.categoryId,
      status: "BROWSER_RESOLUTION_FAILED",
      executionTimeMs: 0,
      errorLog: errorMsg,
    });
    return {
      discovery: fetchResult,
      meta: {
        resolverPath: "none",
        browserAttempted: true,
        browserMethod: "none",
        browserCandidateCount: 0,
        browserCandidates: [],
        browserError: errorMsg,
      },
    };
  }

  const browserCandidateCount = browserResult.candidates.length;

  if (browserCandidateCount === 0) {
    const errorMsg = `Browser resolution (${browserResult.method}) found no candidates. ${browserResult.error || ""}`;
    await logAgentScan({
      sourceId: targetIds?.sourceId,
      categoryId: targetIds?.categoryId,
      status: "BROWSER_RESOLUTION_NO_CANDIDATES",
      executionTimeMs: 0,
      errorLog: errorMsg,
    });
    return {
      discovery: fetchResult,
      meta: {
        resolverPath: "none",
        browserAttempted: true,
        browserMethod: browserResult.method,
        browserCandidateCount: 0,
        browserCandidates: [],
        browserError: browserResult.error || null,
      },
    };
  }

  await logAgentScan({
    sourceId: targetIds?.sourceId,
    categoryId: targetIds?.categoryId,
    status: "BROWSER_RESOLUTION_CANDIDATES_FOUND",
    executionTimeMs: 0,
    errorLog: `Browser resolution (${browserResult.method}) found ${browserCandidateCount} candidate(s): ${browserResult.candidates.map((c) => c.feedUrl).join(", ")}`,
  });

  // ── Step 4: Deduplicate against already-evaluated fetch candidates ──────
  const fetchCandidateUrls = new Set(
    fetchResult.topCandidates.map((c) => c.feedUrl),
  );
  const fetchRejectedUrls = new Set(
    fetchResult.rejectedCandidates.map((c) => c.feedUrl),
  );

  const newBrowserCandidates = browserResult.candidates.filter(
    (c) => !fetchCandidateUrls.has(c.feedUrl) && !fetchRejectedUrls.has(c.feedUrl),
  );

  if (newBrowserCandidates.length === 0) {
    await logAgentScan({
      sourceId: targetIds?.sourceId,
      categoryId: targetIds?.categoryId,
      status: "BROWSER_RESOLUTION_ALL_DUPLICATES",
      executionTimeMs: 0,
      errorLog: `All ${browserCandidateCount} browser candidate(s) were already evaluated by fetch-based discovery.`,
    });
    return {
      discovery: fetchResult,
      meta: {
        resolverPath: "none",
        browserAttempted: true,
        browserMethod: browserResult.method,
        browserCandidateCount,
        browserCandidates: browserResult.candidates.map((c) => ({ feedUrl: c.feedUrl, source: c.source })),
        browserError: null,
      },
    };
  }

  // ── Step 5: Verify browser candidates ───────────────────────────────────
  const browserTopCandidates: FeedDiscoveryResult["topCandidates"] =
    [...fetchResult.topCandidates];
  const browserRejectedCandidates: FeedDiscoveryResult["rejectedCandidates"] =
    [...fetchResult.rejectedCandidates];
  let bestVerified: {
    feedUrl: string;
    discoveredVia: string;
    detection: string;
    contentType: string | null;
    score: number;
  } | null = null;

  for (const candidate of newBrowserCandidates) {
    const baseScore = BROWSER_CANDIDATE_BASE_SCORE[candidate.source] || 20;
    const detection = BROWSER_DETECTION_MAP[candidate.source] || "browser-dom-link";

    try {
      const verified = await verifyFeedCandidate(candidate.feedUrl, { userAgent });
      const score = baseScore;

      browserTopCandidates.push({
        feedUrl: verified.feedUrl,
        detection,
        score,
        contentType: verified.contentType,
        scopeMatch: "generic" as const,
      });

      if (!bestVerified || score > bestVerified.score) {
        bestVerified = {
          feedUrl: verified.feedUrl,
          discoveredVia: input.pageUrl,
          detection,
          contentType: verified.contentType ?? null,
          score,
        };
      }
    } catch (error: any) {
      const reason = error?.message || String(error);
      browserRejectedCandidates.push({
        feedUrl: candidate.feedUrl,
        detection,
        score: baseScore,
        contentType: null,
        scopeMatch: "generic" as const,
        reason: `browser-verify: ${reason}`,
      });
    }
  }

  browserTopCandidates.sort((a, b) => b.score - a.score);

  // ── Step 6: Return result with resolution metadata ──────────────────────
  const browserError = browserResult.error || null;

  if (bestVerified) {
    const scopeConfidence =
      bestVerified.score >= 80 ? "high"
        : bestVerified.score >= 45 ? "medium"
          : "low";

    const resolverPath: ResolutionMeta["resolverPath"] =
      browserResult.method === "playwright" ? "playwright" : "jsdom";

    await logAgentScan({
      sourceId: targetIds?.sourceId,
      categoryId: targetIds?.categoryId,
      status: "BROWSER_RESOLUTION_RESOLVED",
      executionTimeMs: 0,
      errorLog: `Browser resolution resolved feed: ${bestVerified.feedUrl} (resolverPath=${resolverPath}, detection=${bestVerified.detection}, score=${bestVerified.score})`,
    });

    return {
      discovery: {
        feedUrl: bestVerified.feedUrl,
        discoveredVia: bestVerified.discoveredVia,
        detection: bestVerified.detection,
        contentType: bestVerified.contentType,
        score: bestVerified.score,
        scopeConfidence,
        scopeMatch: fetchResult.scopeMatch,
        taxonomyEvidence: fetchResult.taxonomyEvidence,
        topCandidates: browserTopCandidates.slice(0, 5),
        rejectedCandidates: browserRejectedCandidates,
        lastError: undefined,
        canonicalIdentity: bestVerified ? canonicalFeedKey(bestVerified.feedUrl) : null,
      },
      meta: {
        resolverPath,
        browserAttempted: true,
        browserMethod: browserResult.method,
        browserCandidateCount,
        browserCandidates: browserResult.candidates.map((c) => ({ feedUrl: c.feedUrl, source: c.source })),
        browserError,
      },
    };
  }

  await logAgentScan({
    sourceId: targetIds?.sourceId,
    categoryId: targetIds?.categoryId,
    status: "BROWSER_RESOLUTION_VERIFICATION_FAILED",
    executionTimeMs: 0,
    errorLog: `Browser resolution found ${newBrowserCandidates.length} new candidate(s) but none verified. Rejected: ${browserRejectedCandidates.slice(-3).map((r) => `${r.feedUrl} (${r.reason})`).join("; ")}`,
  });    return {
      discovery: {
        feedUrl: null,
        discoveredVia: null,
        detection: "none",
        score: 0,
        scopeConfidence: "low",
        scopeMatch: fetchResult.scopeMatch,
        taxonomyEvidence: fetchResult.taxonomyEvidence,
        topCandidates: browserTopCandidates.slice(0, 5),
        rejectedCandidates: browserRejectedCandidates,
        lastError: `Browser resolution found ${newBrowserCandidates.length} candidate(s) but none verified. ${fetchResult.lastError || ""}`,
        canonicalIdentity: null,
      },
    meta: {
      resolverPath: "none",
      browserAttempted: true,
      browserMethod: browserResult.method,
      browserCandidateCount,
      browserCandidates: browserResult.candidates.map((c) => ({ feedUrl: c.feedUrl, source: c.source })),
      browserError,
    },
  };
}

// ─── Evidence Builders ──────────────────────────────────────────────────────

const buildDiscoveryEvidencePayload = (
  targetUrl: string,
  discovery: FeedDiscoveryResult,
  meta: ResolutionMeta,
) => {
  const outcome = createDiscoveryOutcome(targetUrl, discovery, meta);
  return serializeDiscoveryPayloadWithMeta(outcome, meta);
};

// ─── Artifact Payload Parser ────────────────────────────────────────────────

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

// ─── Queue Consumer ─────────────────────────────────────────────────────────

/**
 * Result of hard-case queue processing, including optional pipeline rerun info.
 */
export type HardCaseQueueResult = {
  processed: number;
  resolved: number;
  failedFinal: number;
  invalid: number;
  /** Whether a follow-up pipeline rerun was triggered for resolved targets. */
  rerunTriggered: boolean;
  /** Number of unique targets fed into the pipeline rerun. */
  rerunTargetCount: number;
  /** Pipeline result if rerun succeeded, null otherwise. */
  rerunResult: PipelineResult | null;
  /** Error message if the pipeline rerun threw, null otherwise. */
  rerunError: string | null;
};

export async function processHardCaseDiscoveryQueue(limit = 10): Promise<HardCaseQueueResult> {
  const take = Math.max(1, Math.min(50, limit));
  const queueItems = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: "hard_case_discovery_candidate",
      status: "PENDING_HEADLESS",
    },
    orderBy: { createdAt: "asc" },
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

  // Collect resolved targets for follow-up pipeline rerun (deduplicated)
  const resolvedTargets: PipelineTarget[] = [];
  const resolvedTargetKeys = new Set<string>();

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
      data: { status: "PROCESSING_HEADLESS" },
    });

    await logAgentScan({
      sourceId: payload.sourceId,
      categoryId: payload.categoryId || undefined,
      status: "HARD_CASE_HEADLESS_STARTED",
      executionTimeMs: 0,
      errorLog: `Processing hard-case discovery for ${payload.targetUrl} (targetType=${payload.targetType}, queueReason=${payload.queueReason || "unknown"}).`,
    });

    try {
      const { discovery, meta } = await discoverFeedWithBrowserFallback(
        {
          pageUrl: payload.targetUrl,
          existingFeedUrl: payload.existingFeedUrl || null,
          preferScopedDirectFeed: payload.targetType === "category",
        },
        { sourceId: payload.sourceId, categoryId: payload.categoryId || undefined },
      );

      const discoveryEvidence = buildDiscoveryEvidencePayload(
        payload.targetUrl,
        discovery,
        meta,
      );

      const outcome = createDiscoveryOutcome(payload.targetUrl, discovery, meta);

      if (payload.targetType === "category" && payload.categoryId) {

        await prisma.sourceCategory.update({
          where: { id: payload.categoryId },
          data: {
            rssFeedUrl: discovery.feedUrl,
            rssStatus: discovery.feedUrl ? "ACTIVE" : "NO_RSS_FOUND",
            lastRssCheckAt: new Date(),
            discoveryEvidence,
            ...getFeedProductivityResetData(payload.existingFeedUrl || null, discovery.feedUrl),
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
            ...getFeedProductivityResetData(payload.existingFeedUrl || null, discovery.feedUrl),
          },
        });
      }

      const finalStatus = discovery.feedUrl ? "RESOLVED" : "FAILED_FINAL";
      if (discovery.feedUrl) {
        resolved += 1;
        // Collect resolved target for follow-up pipeline rerun
        const targetKey = `${payload.sourceId}|${payload.categoryId || ""}`;
        if (!resolvedTargetKeys.has(targetKey)) {
          resolvedTargetKeys.add(targetKey);
          resolvedTargets.push({
            sourceId: payload.sourceId,
            categoryId: payload.categoryId || undefined,
          });
        }
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
            headlessResult: serializeDiscoveryPayloadWithMeta(outcome, meta),
          },
          errorLog: discovery.feedUrl
            ? `Resolved ${payload.targetType} feed via ${meta.resolverPath}: ${discovery.feedUrl}`
            : `Failed ${payload.targetUrl}. resolverPath=${meta.resolverPath}, browser=${meta.browserMethod}, candidates=${meta.browserCandidateCount}. ${discovery.lastError || "No feed found."}`,
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
          ? `Resolved via ${meta.resolverPath}: ${discovery.feedUrl} (detection=${discovery.detection}, browser=${meta.browserMethod}, browserCandidates=${meta.browserCandidateCount})`
          : `Failed for ${payload.targetUrl}. resolverPath=${meta.resolverPath}, browser=${meta.browserMethod}, candidates=${meta.browserCandidateCount}. ${discovery.lastError || ""}`,
      });
    } catch (error: any) {
      failedFinal += 1;
      const errorMessage = error?.message || String(error);

      const errorOutcome = buildErrorDiscoveryOutcome(payload.targetUrl, "none", errorMessage);

      await prisma.pipelineArtifact.update({
        where: { id: item.id },
        data: {
          status: "FAILED_FINAL",
          payload: {
            ...(payload as Record<string, unknown>),
            headlessAttemptedAt: new Date().toISOString(),
            headlessResult: serializeDiscoveryPayload(errorOutcome),
          },
          errorLog: errorMessage,
        },
      });

      await logAgentScan({
        sourceId: payload.sourceId,
        categoryId: payload.categoryId || undefined,
        status: "HARD_CASE_HEADLESS_FAILED_FINAL",
        executionTimeMs: 0,
        errorLog: `Unhandled error for ${payload.targetUrl} (targetType=${payload.targetType}). ${errorMessage}`,
      });
    }
  }

  // ── Step 7: Targeted pipeline rerun for resolved targets ────────────────
  let rerunTriggered = false;
  let rerunTargetCount = 0;
  let rerunResult: PipelineResult | null = null;
  let rerunError: string | null = null;

  if (resolvedTargets.length > 0) {
    rerunTriggered = true;
    rerunTargetCount = resolvedTargets.length;

    // Extract targets: prefer source-level sourceIds only, but fall back to
    // category-parent sourceIds when only category targets were resolved.
    // This prevents hydratePipelineTargets from creating unnecessary
    // source-level targets when only a category feed was discovered.
    const sourceLevelTargets = resolvedTargets.filter((t) => !t.categoryId);
    const categoryTargets = resolvedTargets.filter((t) => t.categoryId);
    const rerunSourceIds = sourceLevelTargets.length > 0
      ? [...new Set(sourceLevelTargets.map((t) => t.sourceId))]
      : [...new Set(categoryTargets.map((t) => t.sourceId))];
    const rerunCategoryIds = categoryTargets.map((t) => t.categoryId as string);

    await logAgentScan({
      status: "HARD_CASE_CHAIN_PIPELINE_STARTED",
      executionTimeMs: 0,
      errorLog: `Hard-case queue resolved ${resolved} target(s). Triggering targeted pipeline rerun for ${rerunTargetCount} unique target(s) (${rerunSourceIds.length} source(s), ${rerunCategoryIds.length} category/categoryies).`,
    });

    try {
      rerunResult = await runNewsPipeline(
        rerunSourceIds,
        rerunCategoryIds.length > 0 ? rerunCategoryIds : undefined,
      );

      await logAgentScan({
        status: "HARD_CASE_CHAIN_PIPELINE_FINISHED",
        executionTimeMs: 0,
        errorLog: `Chain pipeline rerun finished. targets=${rerunTargetCount}, candidates=${rerunResult.candidatesFound}, inserted=${rerunResult.inserted}, skipped=${rerunResult.skipped}, failed=${rerunResult.failed}.`,
      });
    } catch (error: any) {
      rerunError = error?.message || String(error);
      await logAgentScan({
        status: "HARD_CASE_CHAIN_PIPELINE_FINISHED",
        executionTimeMs: 0,
        errorLog: `Chain pipeline rerun failed: ${rerunError}`,
      });
    }
  } else {
    await logAgentScan({
      status: "HARD_CASE_CHAIN_PIPELINE_SKIPPED",
      executionTimeMs: 0,
      errorLog: `No targets resolved in this queue run. Pipeline rerun skipped.`,
    });
  }

  return {
    processed,
    resolved,
    failedFinal,
    invalid,
    rerunTriggered,
    rerunTargetCount,
    rerunResult,
    rerunError,
  };
}
