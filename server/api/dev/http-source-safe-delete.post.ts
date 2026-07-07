import fs from "fs";
import { createError } from "h3";
import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import {
  getHttpSourceMergeAuditReportPath,
  type HttpSourceMergeAuditReport,
} from "../../utils/news-pipeline/http-source-merge-audit";

export default defineEventHandler(async (event) => {
  requireUserId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Forbidden in production" });
  }

  await assertRateLimit(event, "http-source-safe-delete", 3, 10 * 60 * 1000);

  const report = JSON.parse(
    fs.readFileSync(getHttpSourceMergeAuditReportPath(), "utf-8"),
  ) as HttpSourceMergeAuditReport;
  const targets = report.items.filter(
    (item) => item.recommendedAction === "safe_delete_http_source",
  );

  let deleted = 0;

  for (const target of targets) {
    const result = await prisma.newsSource.deleteMany({
      where: {
        id: target.httpSourceId,
      },
    });
    deleted += result.count;
  }

  return {
    ok: true,
    attempted: targets.length,
    deleted,
  };
});
