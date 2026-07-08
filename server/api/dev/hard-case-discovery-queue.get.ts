import { defineEventHandler, getQuery } from "h3";
import { prisma } from "../../utils/prisma";
import { requireAdminId } from "../../utils/require-admin";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  const query = getQuery(event);
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 25));

  const items = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: "hard_case_discovery_candidate",
      status: "PENDING_HEADLESS",
    },
    orderBy: {
      createdAt: "desc",
    },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      sourceId: true,
      categoryId: true,
      pipelineRunId: true,
      errorLog: true,
      payload: true,
    },
  });

  return {
    total: items.length,
    items,
  };
});
