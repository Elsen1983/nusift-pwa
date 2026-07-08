import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import { readScopedSourceAuditReport } from "../../utils/news-pipeline/scoped-source-audit";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Forbidden in production" });
  }

  await assertRateLimit(event, "scoped-source-prune", 2, 10 * 60 * 1000);

  const body = (await readBody<{ limit?: number }>(event).catch(() => null)) as
    | { limit?: number }
    | null;
  const limit = Math.max(1, Math.min(50, Number(body?.limit) || 25));
  const report = readScopedSourceAuditReport();
  const targetIds = report.items
    .filter((item) => item.action === "candidate_delete_invalid_subpath")
    .slice(0, limit)
    .map((item) => item.sourceId);

  const result = targetIds.length
    ? await prisma.newsSource.deleteMany({
        where: { id: { in: targetIds } },
      })
    : { count: 0 };

  return {
    ok: true,
    requestedLimit: limit,
    attempted: targetIds.length,
    deleted: result.count,
    remaining: Math.max(report.summary.candidateDeleteInvalidSubpath - targetIds.length, 0),
  };
});
