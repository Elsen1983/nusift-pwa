import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import {
  normalizeHeadlessQueueArtifact,
  buildHeadlessQueueSummary,
} from "../../utils/news-pipeline/headless-queue-normalize";
import { isBrowserFallbackEnabled } from "../../utils/news-pipeline/article-discovery-browser";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  await assertRateLimit(event, "headless-queue-list", 10, 60 * 1000);

  const query = getQuery(event);
  const requestedStatus =
    typeof query.status === "string" ? query.status : undefined;
  const limit = Math.min(
    Math.max(typeof query.limit === "string" ? Number(query.limit) : 50, 1),
    200,
  );

  const where: Record<string, unknown> = {
    artifactType: "article_discovery_headless_required",
  };

  if (requestedStatus) {
    where.status = requestedStatus;
  } else {
    // By default, exclude resolved markers so the active queue is clean.
    where.status = { notIn: ["RESOLVED_BY_STATIC_DISCOVERY"] };
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
    browserFallbackEnabled: isBrowserFallbackEnabled(),
  };
});
