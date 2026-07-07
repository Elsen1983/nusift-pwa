import { createError } from "h3";
import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";
import {
  buildHttpSourceMergeAuditReport,
  getHttpSourceMergeAuditReportPath,
} from "../../utils/news-pipeline/http-source-merge-audit";

export default defineEventHandler(async (event) => {
  requireUserId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Forbidden in production" });
  }

  await assertRateLimit(event, "http-source-merge-audit", 3, 10 * 60 * 1000);

  const report = await buildHttpSourceMergeAuditReport();

  return {
    ok: true,
    reportPath: getHttpSourceMergeAuditReportPath(),
    summary: report.summary,
  };
});
