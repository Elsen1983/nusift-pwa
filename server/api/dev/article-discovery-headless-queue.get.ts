import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import {
  normalizeHeadlessQueueArtifact,
  buildHeadlessQueueSummary,
  buildHeadlessQueueViewFilter,
  type HeadlessQueueView,
} from "../../utils/news-pipeline/headless-queue-normalize";
import { isBrowserFallbackEnabled } from "../../utils/news-pipeline/article-discovery-browser";
import { readBoundedNumber } from "../../utils/news-pipeline/parse-bounded-number";

const VALID_VIEWS = new Set<HeadlessQueueView>(["active", "history", "all"]);
const RESOLVED_TARGET_STATUSES = [
  "RESOLVED",
  "RESOLVED_BY_STATIC_DISCOVERY",
  "RESOLVED_BY_AGENT1_RSS",
];

type HeadlessQueueArtifact = Parameters<typeof normalizeHeadlessQueueArtifact>[0];

function buildTargetKey(item: {
  sourceId: string | null;
  categoryId: string | null;
  targetUrl: string | null;
}): string | null {
  if (!item.sourceId || !item.targetUrl) return null;
  return [item.sourceId, item.categoryId ?? "", item.targetUrl].join("\u0001");
}

async function filterItemsResolvedByNewerArtifact(
  artifacts: HeadlessQueueArtifact[],
): Promise<HeadlessQueueArtifact[]> {
  const activeTargetKeys = new Set<string>();
  const sourceIds = new Set<string>();

  for (const artifact of artifacts) {
    const item = normalizeHeadlessQueueArtifact(artifact);
    const key = buildTargetKey(item);
    if (!key || RESOLVED_TARGET_STATUSES.includes(item.status)) continue;
    activeTargetKeys.add(key);
    if (item.sourceId) sourceIds.add(item.sourceId);
  }

  if (activeTargetKeys.size === 0 || sourceIds.size === 0) return artifacts;

  const resolvedArtifacts = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: "article_discovery_headless_required",
      status: { in: RESOLVED_TARGET_STATUSES },
      sourceId: { in: [...sourceIds] },
    },
    select: {
      id: true,
      status: true,
      artifactType: true,
      sourceId: true,
      categoryId: true,
      createdAt: true,
      updatedAt: true,
      candidateCount: true,
      payload: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });

  const newestResolvedByTarget = new Map<string, number>();
  for (const artifact of resolvedArtifacts) {
    const item = normalizeHeadlessQueueArtifact(artifact);
    const key = buildTargetKey(item);
    if (!key || !activeTargetKeys.has(key)) continue;

    const updatedAtMs = new Date(item.updatedAt).getTime();
    const previous = newestResolvedByTarget.get(key) ?? 0;
    if (updatedAtMs > previous) newestResolvedByTarget.set(key, updatedAtMs);
  }

  if (newestResolvedByTarget.size === 0) return artifacts;

  return artifacts.filter((artifact) => {
    const item = normalizeHeadlessQueueArtifact(artifact);
    const key = buildTargetKey(item);
    if (!key || RESOLVED_TARGET_STATUSES.includes(item.status)) return true;

    const resolvedAtMs = newestResolvedByTarget.get(key);
    if (!resolvedAtMs) return true;

    return resolvedAtMs <= new Date(item.updatedAt).getTime();
  });
}

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  await assertRateLimit(event, "headless-queue-list", 10, 60 * 1000);

  const query = getQuery(event);
  const requestedStatus =
    typeof query.status === "string" ? query.status : undefined;
  const requestedView =
    typeof query.view === "string" && VALID_VIEWS.has(query.view as HeadlessQueueView)
      ? (query.view as HeadlessQueueView)
      : "active";
  const limit = readBoundedNumber(query.limit, 50, 1, 200);

  const where: Record<string, unknown> = {
    artifactType: "article_discovery_headless_required",
  };

  if (requestedStatus) {
    // Explicit status filter overrides view filtering.
    where.status = requestedStatus;
  } else {
    // Apply view-based filtering.
    const viewFilter = buildHeadlessQueueViewFilter(requestedView);
    if (viewFilter) {
      // Merge: exclude RESOLVED_BY_STATIC_DISCOVERY always, plus view filter.
      Object.assign(where, viewFilter);
    } else {
      // view=all: only exclude RESOLVED_BY_STATIC_DISCOVERY.
      where.status = { notIn: ["RESOLVED_BY_STATIC_DISCOVERY"] };
    }
  }

  const artifacts = await prisma.pipelineArtifact.findMany({
    where,
    select: {
      id: true,
      status: true,
      artifactType: true,
      sourceId: true,
      categoryId: true,
      createdAt: true,
      updatedAt: true,
      candidateCount: true,
      payload: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const visibleArtifacts =
    !requestedStatus && requestedView === "active" && artifacts.length > 0
      ? await filterItemsResolvedByNewerArtifact(artifacts)
      : artifacts;

  const items = visibleArtifacts.map(normalizeHeadlessQueueArtifact);
  const summary = buildHeadlessQueueSummary(items);

  return {
    ok: true,
    items,
    summary,
    view: requestedView,
    browserFallbackEnabled: isBrowserFallbackEnabled(),
  };
});
