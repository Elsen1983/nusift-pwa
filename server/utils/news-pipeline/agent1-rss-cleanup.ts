/**
 * Agent 1 RSS cleanup: resolve stale Agent 2 headless markers and
 * hard-source profiles when Agent 1 discovers a scoped RSS feed.
 *
 * Extracted from ingest.ts for direct testability.
 *
 * Matching rules:
 * - Strict match on sourceId + categoryId + targetUrl (category-level).
 * - Matches all active headless artifact statuses.
 * - Sets status to RESOLVED_BY_AGENT1_RSS and preserves existing payload
 *   with appended resolution metadata.
 * - Also marks matching hard-source profile artifacts as resolved
 *   (without deleting them).
 *
 * Non-fatal: failure does not affect Agent 1 ingest result.
 */

import { prisma } from "../prisma";
import { logAgentScan } from "./log";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ResolveAgent1RssCleanupInput = {
  sourceId: string;
  categoryId: string;
  targetUrl: string;
  rssFeedUrl: string;
  pipelineRunId?: string | null;
};

export type ResolveAgent1RssCleanupResult = {
  resolvedMarkerCount: number;
  resolvedProfileCount: number;
};

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Statuses that indicate an Agent 2 headless queue artifact is still active
 * and should be resolved when Agent 1 successfully discovers a scoped RSS feed.
 * Includes both primary and legacy status values.
 */
export const AGENT1_RSS_RESOLVABLE_STATUSES = [
  "PENDING_HEADLESS",
  "BROWSER_NO_CANDIDATES",
  "BROWSER_RUNTIME_UNAVAILABLE",
  "BROWSER_FALLBACK_DISABLED",
  "BROWSER_COOLDOWN_DEFERRED",
  "HEADLESS_PROCESSING",
  "HEADLESS_PROCESSING_STALE",
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * When Agent 1 discovers and saves a scoped RSS feed for a category,
 * resolve any stale Agent 2 headless queue artifacts AND matching
 * hard-source profile artifacts for that exact target.
 *
 * @returns Counts of resolved markers and profiles. Returns zero counts
 *   on any top-level error (non-fatal).
 */
export async function resolveHeadlessMarkersByAgent1Rss(
  input: ResolveAgent1RssCleanupInput,
): Promise<ResolveAgent1RssCleanupResult> {
  try {
    // ── Step 1: Resolve headless queue markers ────────────────────────
    const markers = await prisma.pipelineArtifact.findMany({
      where: {
        artifactType: "article_discovery_headless_required",
        sourceId: input.sourceId,
        categoryId: input.categoryId,
        status: { in: AGENT1_RSS_RESOLVABLE_STATUSES },
      },
      select: { id: true, payload: true, status: true },
      orderBy: { createdAt: "desc" },
    });

    // Filter to exact targetUrl match via payload inspection
    // (Prisma JSON queries don't support normalized URL comparison).
    const matchingMarkers = markers.filter((marker) => {
      const payload = isPlainObject(marker.payload) ? marker.payload : {};
      const markerTargetUrl = readString(payload.targetUrl);
      return markerTargetUrl === input.targetUrl;
    });

    const resolvedAt = new Date().toISOString();
    let resolvedMarkerCount = 0;

    for (const marker of matchingMarkers) {
      try {
        const existingPayload = isPlainObject(marker.payload) ? marker.payload : {};
        await prisma.pipelineArtifact.update({
          where: { id: marker.id },
          data: {
            status: "RESOLVED_BY_AGENT1_RSS",
            payload: {
              ...existingPayload,
              resolvedBy: "agent1_scoped_rss",
              resolvedAt,
              resolvedRssFeedUrl: input.rssFeedUrl,
              resolvedSourceUrl: input.targetUrl,
              resolvedPipelineRunId: input.pipelineRunId || null,
              previousStatus: marker.status,
            },
          },
        });
        resolvedMarkerCount += 1;
      } catch {
        // Individual marker update failure is non-fatal.
      }
    }

    // ── Step 2: Mark matching hard-source profiles as resolved ────────
    let resolvedProfileCount = 0;

    try {
      const profiles = await prisma.pipelineArtifact.findMany({
        where: {
          artifactType: "article_discovery_hard_source_profile",
          sourceId: input.sourceId,
          categoryId: input.categoryId,
        },
        select: { id: true, payload: true, status: true },
        orderBy: { createdAt: "desc" },
      });

      const matchingProfiles = profiles.filter((profile) => {
        if (profile.status === "RESOLVED_BY_AGENT1_RSS") return false;
        const payload = isPlainObject(profile.payload) ? profile.payload : {};
        const profileTargetUrl = readString(payload.targetUrl);
        return profileTargetUrl === input.targetUrl;
      });

      for (const profile of matchingProfiles) {
        try {
          const existingPayload = isPlainObject(profile.payload) ? profile.payload : {};
          await prisma.pipelineArtifact.update({
            where: { id: profile.id },
            data: {
              status: "RESOLVED_BY_AGENT1_RSS",
              payload: {
                ...existingPayload,
                resolvedBy: "agent1_scoped_rss",
                resolvedAt,
                resolvedRssFeedUrl: input.rssFeedUrl,
                resolvedSourceUrl: input.targetUrl,
                resolvedPipelineRunId: input.pipelineRunId || null,
                previousStatus: profile.status,
                previousSuggestedNextAction: readString(existingPayload.suggestedNextAction),
              },
            },
          });
          resolvedProfileCount += 1;
        } catch {
          // Individual profile update failure is non-fatal.
        }
      }
    } catch {
      // Profile resolution failure is non-fatal.
    }

    // ── Step 3: Log results ───────────────────────────────────────────
    const totalResolved = resolvedMarkerCount + resolvedProfileCount;
    if (totalResolved > 0) {
      await logAgentScan({
        sourceId: input.sourceId,
        categoryId: input.categoryId,
        status: "A1_CATEGORY_HEADLESS_MARKERS_RESOLVED_BY_RSS",
        executionTimeMs: 0,
        errorLog:
          `Resolved ${resolvedMarkerCount} headless marker(s) and ${resolvedProfileCount} hard-source profile(s) ` +
          `for ${input.targetUrl} after Agent 1 scoped RSS discovery. ` +
          `rssFeedUrl=${input.rssFeedUrl}, resolvedAt=${resolvedAt}.`,
      });
    }

    return { resolvedMarkerCount, resolvedProfileCount };
  } catch (error: any) {
    await logAgentScan({
      sourceId: input.sourceId,
      categoryId: input.categoryId,
      status: "A1_CATEGORY_HEADLESS_MARKERS_RESOLVE_FAILED",
      executionTimeMs: 0,
      errorLog: `Failed to resolve stale headless markers for ${input.targetUrl}: ${error?.message || String(error)}`,
    }).catch(() => {});
    return { resolvedMarkerCount: 0, resolvedProfileCount: 0 };
  }
}
