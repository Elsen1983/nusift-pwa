import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import {
  buildScopedSourceAuditReport,
  getScopedSourceAuditReportPath,
  writeScopedSourceAuditReport,
} from "../../utils/news-pipeline/scoped-source-audit";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Forbidden in production" });
  }

  await assertRateLimit(event, "scoped-source-audit", 3, 10 * 60 * 1000);

  const sources = await prisma.newsSource.findMany({
    select: {
      id: true,
      frontPageUrl: true,
      mediaName: true,
      rssFeedUrl: true,
      rssStatus: true,
    },
  });

  const report = buildScopedSourceAuditReport(sources);
  writeScopedSourceAuditReport(report);

  return {
    ok: true,
    reportPath: getScopedSourceAuditReportPath(),
    summary: report.summary,
  };
});
