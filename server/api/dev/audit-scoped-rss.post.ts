import fs from "fs";
import { RssStatus } from "@prisma/client";
import { createError } from "h3";
import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import { logAgentScan } from "../../utils/news-pipeline/log";
import {
  discoverScopedFeedForSource,
  getScopedRssAuditReportPath,
} from "../../utils/news-pipeline/import-rss";

const hasNonRootPath = (url: string) => {
  try {
    return (new URL(url).pathname.replace(/\/+$/, "") || "/") !== "/";
  } catch {
    return false;
  }
};

export default defineEventHandler(async (event) => {
  requireUserId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Forbidden in production" });
  }

  await assertRateLimit(event, "audit-scoped-rss", 2, 10 * 60 * 1000);

  const startedAt = Date.now();
  const sources = await prisma.newsSource.findMany({
    select: {
      id: true,
      frontPageUrl: true,
      mediaName: true,
      rssFeedUrl: true,
      rssStatus: true,
    },
  });

  const targets = sources.filter((source) => hasNonRootPath(source.frontPageUrl));
  const results: Array<Record<string, any>> = [];
  let scopedRepairs = 0;
  let sharedRootConfirmed = 0;
  let noScopedFeedFound = 0;
  let deletedInvalidSubPaths = 0;
  let alreadyMissing = 0;
  let failed = 0;

  await logAgentScan({
    status: "SCOPED_RSS_AUDIT_STARTED",
    executionTimeMs: 0,
    errorLog: `Scoped RSS audit started for ${targets.length} sub-path source(s).`,
  });

  for (const source of targets) {
    try {
      const discovery = await discoverScopedFeedForSource(source.frontPageUrl, source.rssFeedUrl);
      let resolution = "no_change";
      let nextRssFeedUrl = source.rssFeedUrl;
      let nextRssStatus = source.rssStatus;

      if (discovery.pageValidation.invalidSubPath) {
        const deleteResult = await prisma.newsSource.deleteMany({
          where: { id: source.id },
        });

        if (deleteResult.count > 0) {
          resolution = "deleted_invalid_sub_path";
          deletedInvalidSubPaths += 1;
        } else {
          resolution = "already_missing";
          alreadyMissing += 1;
        }
      } else if (discovery.scopedFeedUrl && discovery.scopedFeedUrl !== source.rssFeedUrl) {
        nextRssFeedUrl = discovery.scopedFeedUrl;
        nextRssStatus = RssStatus.ACTIVE;
        const updateResult = await prisma.newsSource.updateMany({
          where: { id: source.id },
          data: {
            frontPageUrl: discovery.pageValidation.shouldUpdateFrontPageUrl
              ? discovery.pageValidation.normalizedUrl
              : source.frontPageUrl,
            rssFeedUrl: nextRssFeedUrl,
            rssStatus: nextRssStatus,
            lastRssCheckAt: new Date(),
          },
        });

        if (updateResult.count > 0) {
          resolution = "updated_to_scoped_feed";
          scopedRepairs += 1;
        } else {
          resolution = "already_missing";
          alreadyMissing += 1;
        }
      } else if (discovery.sharedRootFeedUrl) {
        resolution = "shared_root_feed_confirmed";
        sharedRootConfirmed += 1;
        if (discovery.pageValidation.shouldUpdateFrontPageUrl) {
          await prisma.newsSource.updateMany({
            where: { id: source.id },
            data: {
              frontPageUrl: discovery.pageValidation.normalizedUrl,
            },
          });
        }
      } else {
        resolution = "no_scoped_feed_found";
        noScopedFeedFound += 1;
        if (discovery.pageValidation.shouldUpdateFrontPageUrl) {
          await prisma.newsSource.updateMany({
            where: { id: source.id },
            data: {
              frontPageUrl: discovery.pageValidation.normalizedUrl,
            },
          });
        }
      }

      results.push({
        sourceId: source.id,
        mediaName: source.mediaName,
        frontPageUrl: source.frontPageUrl,
        previousRssFeedUrl: source.rssFeedUrl,
        previousRssStatus: source.rssStatus,
        pageValidation: discovery.pageValidation,
        scopedFeedUrl: discovery.scopedFeedUrl,
        sharedRootFeedUrl: discovery.sharedRootFeedUrl,
        resolution,
        inspectedCandidates: discovery.inspectedCandidates,
      });
    } catch (error: any) {
      failed += 1;
      results.push({
        sourceId: source.id,
        mediaName: source.mediaName,
        frontPageUrl: source.frontPageUrl,
        previousRssFeedUrl: source.rssFeedUrl,
        previousRssStatus: source.rssStatus,
        resolution: "audit_error",
        error: error?.message || String(error),
      });
    }
  }

  const reportPath = getScopedRssAuditReportPath();
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary: {
          totalSubPathSources: targets.length,
          scopedRepairs,
          sharedRootConfirmed,
          noScopedFeedFound,
          deletedInvalidSubPaths,
          alreadyMissing,
          failed,
          durationMs: Date.now() - startedAt,
        },
        results,
      },
      null,
      2,
    ),
    "utf-8",
  );

  await logAgentScan({
    status: "SCOPED_RSS_AUDIT_FINISHED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Scoped RSS audit finished. total=${targets.length}, repaired=${scopedRepairs}, sharedRoot=${sharedRootConfirmed}, noScoped=${noScopedFeedFound}, deleted=${deletedInvalidSubPaths}, alreadyMissing=${alreadyMissing}, failed=${failed}.`,
  });

  return {
    ok: true,
    totalSubPathSources: targets.length,
    scopedRepairs,
    sharedRootConfirmed,
    noScopedFeedFound,
    deletedInvalidSubPaths,
    alreadyMissing,
    failed,
    reportPath,
  };
});
