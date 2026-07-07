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

  await assertRateLimit(event, "scoped-source-normalize", 3, 10 * 60 * 1000);

  const body = await readBody<{ limit?: number }>(event).catch(() => ({}));
  const limit = Math.max(1, Math.min(50, Number(body?.limit) || 25));
  const report = readScopedSourceAuditReport();
  const targets = report.items
    .filter((item) => item.action === "normalize_to_https")
    .slice(0, limit);

  let updated = 0;

  for (const target of targets) {
    const result = await prisma.newsSource.updateMany({
      where: { id: target.sourceId, frontPageUrl: target.frontPageUrl },
      data: { frontPageUrl: target.normalizedFrontPageUrl },
    });
    updated += result.count;
  }

  return {
    ok: true,
    requestedLimit: limit,
    attempted: targets.length,
    updated,
    remaining: Math.max(report.summary.normalizeToHttps - targets.length, 0),
  };
});
