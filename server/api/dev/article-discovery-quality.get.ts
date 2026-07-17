import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import { normalizeDiscoveryQualityArtifact } from "../../utils/news-pipeline/discovery-quality-normalize";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "article-discovery-quality", 10, 60 * 1000);

  const artifacts = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: {
        in: ["article_discovery_candidates", "article_discovery_headless_required"],
      },
    },
    select: {
      id: true,
      createdAt: true,
      sourceId: true,
      categoryId: true,
      artifactType: true,
      status: true,
      candidateCount: true,
      payload: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return { ok: true, items: artifacts.map(normalizeDiscoveryQualityArtifact) };
});
