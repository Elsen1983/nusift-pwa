import fs from "fs";
import { createError } from "h3";
import { requireUserId } from "../../utils/require-user";
import { getHttpSourceMergeAuditReportPath } from "../../utils/news-pipeline/http-source-merge-audit";

export default defineEventHandler(async (event) => {
  requireUserId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Forbidden in production" });
  }

  const reportPath = getHttpSourceMergeAuditReportPath();
  if (!fs.existsSync(reportPath)) {
    return {
      ok: true,
      report: null,
    };
  }

  return {
    ok: true,
    report: JSON.parse(fs.readFileSync(reportPath, "utf-8")),
  };
});
