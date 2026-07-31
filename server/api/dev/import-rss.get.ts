// server/api/dev/import-rss.get.ts
import fs from 'fs';
import { createError } from 'h3';
import { requireAdminId } from '../../utils/require-admin';
import { prisma } from '../../utils/prisma';
import { RssStatus } from '@prisma/client';
import { getImportRssReportPath, loadImportSources, verifyImportedRssFeed } from '../../utils/news-pipeline/import-rss';
import { logAgentScan } from '../../utils/news-pipeline/log';
import { resolveSourceUrlIdentity } from '../../utils/source-url-identity';

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === 'production') {
    throw createError({ statusCode: 403, statusMessage: "Forbidden in production" });
  }

  const allSources = loadImportSources();

  if (allSources.length === 0) return { success: false, message: "No data found." };

  try {
    const startedAt = Date.now();
    let created = 0;
    let updated = 0;
    let verifiedActive = 0;
    let verifiedFailed = 0;
    let verifiedNoRss = 0;
    let metadataPatched = 0;
    const now = new Date();
    let processed = 0;
    const concurrency = 6;
    const failedFeeds: Array<{
      frontPageUrl: string;
      mediaName: string;
      rssFeedUrl: string | null;
      status: string;
      reason: string;
    }> = [];
    const noRssFeeds: Array<{
      frontPageUrl: string;
      mediaName: string;
      rssFeedUrl: string | null;
      status: string;
      reason: string;
    }> = [];

    await logAgentScan({
      status: "RSS_REIMPORT_STARTED",
      executionTimeMs: 0,
      errorLog: `Reimport started for ${allSources.length} source(s) with concurrency=${concurrency}.`,
    });
    console.log(`[RSS_REIMPORT] started total=${allSources.length} concurrency=${concurrency}`);

    const processSource = async (source: (typeof allSources)[number]) => {
      const identity = resolveSourceUrlIdentity(source.frontPageUrl);
      const verification = await verifyImportedRssFeed(source.rssFeedUrl || null);
      const verifiedStatus = source.rssFeedUrl ? verification.status : RssStatus.NO_RSS_FOUND;
      if (identity.isRoot) {
        const existing = await prisma.newsSource.findUnique({
          where: { frontPageUrl: identity.rootUrl },
        });
        const mergedData = {
          isSystemImported: true,
          mediaName: source.mediaName,
          mediaType: source.mediaType,
          language: source.language,
          location: source.location,
          countryCode: source.countryCode,
          continent: source.continent,
          detailPageUrl: source.detailPageUrl,
          aboutPageUrl: source.aboutPageUrl,
          contactPageUrl: source.contactPageUrl,
          contactName: source.contactName,
          contactEmail: source.contactEmail,
          contactPhone: source.contactPhone,
          rssFeedUrl: source.rssFeedUrl,
          rssStatus: verifiedStatus,
          lastRssCheckAt: now,
          nextRetryAt: verifiedStatus === RssStatus.ACTIVE ? null : existing?.nextRetryAt || null,
        };
        await prisma.newsSource.upsert({
          where: { frontPageUrl: identity.rootUrl },
          create: { frontPageUrl: identity.rootUrl, ...mergedData },
          update: mergedData,
        });
        if (existing) updated += 1;
        else created += 1;
        if (!existing || Object.entries(mergedData).some(([key, value]) => existing[key as keyof typeof existing] !== value)) {
          metadataPatched += 1;
        }
      } else {
        const rootHostname = new URL(identity.rootUrl).hostname;
        const root = await prisma.newsSource.upsert({
          where: { frontPageUrl: identity.rootUrl },
          create: {
            frontPageUrl: identity.rootUrl,
            mediaName: rootHostname,
            mediaType: source.mediaType,
            language: source.language,
            isSystemImported: true,
            rssStatus: RssStatus.NO_RSS_FOUND,
          },
          update: { isSystemImported: true },
        });
        const existingCategory = await prisma.sourceCategory.findUnique({
          where: {
            newsSourceId_pathUrl: {
              newsSourceId: root.id,
              pathUrl: identity.normalizedUrl,
            },
          },
        });
        const pathName = new URL(identity.normalizedUrl).pathname
          .replace(/^\/+|\/+$/g, "")
          .replace(/[/_-]+/g, " ");
        const categoryData = {
          name: source.mediaName || pathName || rootHostname,
          rssFeedUrl: source.rssFeedUrl,
          rssStatus: verifiedStatus,
          lastRssCheckAt: now,
          nextRetryAt: verifiedStatus === RssStatus.ACTIVE ? null : existingCategory?.nextRetryAt || null,
        };
        await prisma.sourceCategory.upsert({
          where: {
            newsSourceId_pathUrl: {
              newsSourceId: root.id,
              pathUrl: identity.normalizedUrl,
            },
          },
          create: {
            newsSourceId: root.id,
            pathUrl: identity.normalizedUrl,
            isUserRequested: false,
            ...categoryData,
          },
          update: categoryData,
        });
        if (existingCategory) updated += 1;
        else created += 1;
        metadataPatched += 1;
      }

      if (verifiedStatus === RssStatus.ACTIVE) verifiedActive += 1;
      else if (verifiedStatus === RssStatus.NO_RSS_FOUND) {
        verifiedNoRss += 1;
        noRssFeeds.push({
          frontPageUrl: source.frontPageUrl,
          mediaName: source.mediaName,
          rssFeedUrl: source.rssFeedUrl,
          status: verifiedStatus,
          reason: verification.reason,
        });
      } else {
        verifiedFailed += 1;
        failedFeeds.push({
          frontPageUrl: source.frontPageUrl,
          mediaName: source.mediaName,
          rssFeedUrl: source.rssFeedUrl,
          status: verifiedStatus,
          reason: verification.reason,
        });
      }
      processed += 1;

      if (processed % 25 === 0 || processed === allSources.length) {
        const progressMessage = `Processed ${processed}/${allSources.length}. Created=${created}, updated=${updated}, patched=${metadataPatched}, active=${verifiedActive}, failed=${verifiedFailed}, noRss=${verifiedNoRss}.`;
        await logAgentScan({
          status: "RSS_REIMPORT_PROGRESS",
          executionTimeMs: Date.now() - startedAt,
          errorLog: progressMessage,
        });
        console.log(`[RSS_REIMPORT] ${progressMessage}`);
      }
    };

    for (let i = 0; i < allSources.length; i += concurrency) {
      const batch = allSources.slice(i, i + concurrency);
      await Promise.all(batch.map(processSource));
    }

    await logAgentScan({
      status: "RSS_REIMPORT_FINISHED",
      executionTimeMs: Date.now() - startedAt,
      errorLog: `Finished ${allSources.length} source(s). Created=${created}, updated=${updated}, patched=${metadataPatched}, active=${verifiedActive}, failed=${verifiedFailed}, noRss=${verifiedNoRss}.`,
    });
    console.log(`[RSS_REIMPORT] finished total=${allSources.length} created=${created} updated=${updated} patched=${metadataPatched} active=${verifiedActive} failed=${verifiedFailed} noRss=${verifiedNoRss} durationMs=${Date.now() - startedAt}`);

    const reportPath = getImportRssReportPath();
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          summary: {
            total: allSources.length,
            created,
            updated,
            patched: metadataPatched,
            verifiedActive,
            verifiedFailed,
            verifiedNoRss,
            durationMs: Date.now() - startedAt,
          },
          failedFeeds,
          noRssFeeds,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`[RSS_REIMPORT] report written path=${reportPath} failed=${failedFeeds.length} noRss=${noRssFeeds.length}`);

    return {
      success: true,
      message: `Import + enrich + verify complete. Created: ${created}, updated: ${updated}, patched: ${metadataPatched}. Verified active: ${verifiedActive}, failed: ${verifiedFailed}, no RSS: ${verifiedNoRss}.`,
      created,
      updated,
      patched: metadataPatched,
      verifiedActive,
      verifiedFailed,
      verifiedNoRss,
      total: allSources.length,
      reportPath,
    };
  } catch (error: any) {
    console.error("[RSS_REIMPORT] fatal error", error);
    setResponseStatus(event, 500);
    return {
      success: false,
      message: error?.message || "DB Error",
    };
  }
});
