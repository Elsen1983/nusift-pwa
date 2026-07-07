import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Dev endpoints disabled in production." });
  }

  await assertRateLimit(event, "agent-logs-delete", 3, 10 * 60 * 1000);

  const prismaAny = prisma as any;
  const operations = [
    prisma.article.deleteMany({}),
    prisma.agentScanLog.deleteMany({}),
  ];

  if (prismaAny.pipelineArtifact?.deleteMany) {
    operations.push(prismaAny.pipelineArtifact.deleteMany({}));
  }

  if (prismaAny.pipelineRun?.deleteMany) {
    operations.push(prismaAny.pipelineRun.deleteMany({}));
  }

  const results = await prisma.$transaction(operations);
  const articleResult = results[0];
  const logResult = results[1];
  const artifactResult = results[2] || { count: 0 };
  const runResult = results[3] || { count: 0 };

  return {
    ok: true,
    deletedCount: logResult.count,
    articleCount: articleResult.count,
    artifactCount: artifactResult.count,
    runCount: runResult.count,
  };
});
