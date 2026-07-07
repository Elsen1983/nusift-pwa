import fs from "fs";
import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { getScopedSourceAuditReportPath } from "../../utils/news-pipeline/scoped-source-audit";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Forbidden in production" });
  }

  const reportPath = getScopedSourceAuditReportPath();
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
