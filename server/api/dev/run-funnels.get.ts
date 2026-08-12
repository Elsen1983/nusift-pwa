import { getQuery } from "h3";
import { prisma } from "../../utils/prisma";
import { requireAdminId } from "../../utils/require-admin";
import { getRunFunnelPage } from "../../utils/news-pipeline/run-funnel";
import { countConsecutiveUnproductiveRuns, readPersistedRunProductivity } from "../../utils/news-pipeline/run-productivity";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  const query = getQuery(event);
  const orchestrationRunId = typeof query.orchestrationRunId === "string"
    ? query.orchestrationRunId.trim().slice(0, 100)
    : "";
  if (!orchestrationRunId) {
    throw createError({ statusCode: 400, statusMessage: "Missing orchestrationRunId." });
  }
  const cursor = typeof query.cursor === "string" ? query.cursor.slice(0, 100) : null;
  const parsedLimit = Number(query.limit);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 25;

  const [run, page, recentRuns] = await Promise.all([
    prisma.pipelineRun.findUnique({
      where: { id: orchestrationRunId },
      select: { id: true, status: true, createdAt: true, finishedAt: true, summary: true },
    }),
    getRunFunnelPage({ orchestrationRunId, cursor, limit }),
    prisma.pipelineRun.findMany({
      where: { summary: { path: ["kind"], equals: "daily_news_pipeline_workflow" } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { summary: true },
    }),
  ]);

  return {
    orchestrationRunId,
    run: run ? {
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      productivity: readPersistedRunProductivity(run.summary),
    } : null,
    funnels: page,
    consecutiveUnproductiveRuns: countConsecutiveUnproductiveRuns(recentRuns),
  };
});
