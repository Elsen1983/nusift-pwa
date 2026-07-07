import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import {
  buildHttpSourceNormalizationReport,
  getHttpSourceNormalizationReportPath,
} from "../../utils/news-pipeline/http-source-normalization";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Forbidden in production" });
  }

  await assertRateLimit(event, "http-source-normalization", 3, 10 * 60 * 1000);

  const report = await buildHttpSourceNormalizationReport();
  let updated = 0;
  let rssUpdated = 0;
  let runtimeConflicts = 0;

  for (const item of report.items) {
    if (item.action === "update_to_https") {
      try {
        const result = await prisma.newsSource.updateMany({
          where: {
            id: item.sourceId,
            frontPageUrl: item.currentFrontPageUrl,
          },
          data: {
            frontPageUrl: item.normalizedHttpsUrl,
          },
        });

        updated += result.count;
      } catch (error: any) {
        if (error?.code === "P2002") {
          runtimeConflicts += 1;
        } else {
          throw error;
        }
      }
    }

    if (
      item.currentRssFeedUrl &&
      item.currentRssFeedUrl.startsWith("http://") &&
      item.normalizedHttpsRssFeedUrl
    ) {
      const rssResult = await prisma.newsSource.updateMany({
        where: {
          id: item.sourceId,
          rssFeedUrl: item.currentRssFeedUrl,
        },
        data: {
          rssFeedUrl: item.normalizedHttpsRssFeedUrl,
        },
      });
      rssUpdated += rssResult.count;
    }
  }

  return {
    ok: true,
    updated,
    rssUpdated,
    conflicts: report.summary.conflicts + runtimeConflicts,
    runtimeConflicts,
    invalidUrls: report.summary.invalidUrls,
    reportPath: getHttpSourceNormalizationReportPath(),
  };
});
