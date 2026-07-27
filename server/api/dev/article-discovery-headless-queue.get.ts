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

  const items = artifacts.map(normalizeHeadlessQueueArtifact);
  const summary = buildHeadlessQueueSummary(items);

  return {
    ok: true,
    items,
    summary,
    view: requestedView,
    browserFallbackEnabled: isBrowserFallbackEnabled(),
  };
});
