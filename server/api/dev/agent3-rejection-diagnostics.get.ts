import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import {
  normalizeRejectionDiagnostic,
  isRejectionArtifact,
  type RawRejectionArtifact,
  type NormalizedRejectionDiagnostic,
  summarizeDeferredCooldowns,
} from "../../utils/news-pipeline/rejection-diagnostics-normalizer";

/**
 * Dev endpoint for Agent 3 rejection diagnostics.
 *
 * Returns recent rejected article extraction outcomes from Agent 3,
 * grouped by rejection kind. Read-only, admin-only, rate-limited.
 *
 * Query params:
 *  - kind: filter by enrichment outcome kind (e.g. LOW_CONTENT_QUALITY)
 *  - sourceId: filter by source ID
 *  - articleId: filter by article ID
 *  - runId / pipelineRunId: filter by pipeline run ID
 *  - limit: max items to return (default 25, max 100)
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "agent3-rejection-diagnostics", 10, 60 * 1000);

  const query = getQuery(event);

  const kind = typeof query.kind === "string" && query.kind.length > 0 ? query.kind : undefined;
  const sourceId = typeof query.sourceId === "string" && query.sourceId.length > 0 ? query.sourceId : undefined;
  const articleId = typeof query.articleId === "string" ? parseInt(query.articleId, 10) : undefined;
  const pipelineRunId = typeof query.runId === "string" && query.runId.length > 0
    ? query.runId
    : typeof query.pipelineRunId === "string" && query.pipelineRunId.length > 0
      ? query.pipelineRunId
      : undefined;

  const rawLimit = typeof query.limit === "string" ? parseInt(query.limit, 10) : 25;
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 25 : rawLimit), 100);

  // Build where clause for rejection artifacts
  const where: Record<string, unknown> = {
    artifactType: { in: ["article_enrichment_rejection", "article_headless_queue_candidate"] },
    status: { in: ["FAILED", "PENDING_HEADLESS"] },
  };

  if (sourceId) where.sourceId = sourceId;
  if (pipelineRunId) where.pipelineRunId = pipelineRunId;

  const includeDuplicates = query.includeDuplicates === "true";

  // Fetch artifacts newest first.
  // Over-fetch enough rows to collapse repeated failures for the same article
  // into a latest-only diagnostics view.
  const artifacts = await prisma.pipelineArtifact.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(limit * 8, 500),
    select: {
      id: true,
      createdAt: true,
      pipelineRunId: true,
      sourceId: true,
      categoryId: true,
      artifactType: true,
      status: true,
      payload: true,
      errorLog: true,
    },
  });

  // Normalize and filter
  const items: NormalizedRejectionDiagnostic[] = [];
  const seenArticleIds = new Set<number>();
  for (const artifact of artifacts) {
    if (items.length >= limit) break;

    const raw = artifact as unknown as RawRejectionArtifact;
    if (!isRejectionArtifact(raw)) continue;

    const normalized = normalizeRejectionDiagnostic(raw);
    if (!normalized) continue;

    // Apply post-normalization filters
    if (kind && normalized.kind !== kind) continue;
    if (articleId && normalized.articleId !== articleId) continue;
    if (!includeDuplicates && normalized.articleId !== null) {
      if (seenArticleIds.has(normalized.articleId)) continue;
      seenArticleIds.add(normalized.articleId);
    }

    items.push(normalized);
  }

  // Compute summary counts by kind
  const byKind: Record<string, number> = {};
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  }

  // Compute summary counts by hostname for domain-level debugging
  const byHostname: Record<string, number> = {};
  let httpAccessBlocked = 0;
  for (const item of items) {
    let hostname = "unknown";
    if (item.articleUrl) {
      try {
        hostname = new URL(item.articleUrl).hostname;
      } catch { /* malformed URL */ }
    }
    byHostname[hostname] = (byHostname[hostname] ?? 0) + 1;
    if (item.httpAccessBlocked) httpAccessBlocked++;
  }

  const cooldownsByHostname = summarizeDeferredCooldowns(items);

  return {
    ok: true,
    summary: {
      totalReturned: items.length,
      byKind,
      byHostname,
      httpAccessBlocked,
      latestOnly: !includeDuplicates,
      cooldownsByHostname,
      cooldownAggregationBounded: artifacts.length === Math.min(limit * 8, 500),
    },
    items,
  };
});
