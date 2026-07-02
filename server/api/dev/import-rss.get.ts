// server/api/dev/import-rss.get.ts
import fs from 'fs';
import { prisma } from '../../utils/prisma';
import { RssStatus } from '@prisma/client';
import { getImportRssReportPath, loadImportSources, verifyImportedRssFeed } from '../../utils/news-pipeline/import-rss';
import { logAgentScan } from '../../utils/news-pipeline/log';

export default defineEventHandler(async (event) => {
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
      const verification = await verifyImportedRssFeed(source.rssFeedUrl);
      const verifiedStatus = source.rssFeedUrl ? verification.status : RssStatus.NO_RSS_FOUND;
      const existing = await prisma.newsSource.findUnique({
        where: { frontPageUrl: source.frontPageUrl },
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
      const changed =
        !existing ||
        existing.mediaName !== mergedData.mediaName ||
        existing.mediaType !== mergedData.mediaType ||
        existing.language !== mergedData.language ||
        existing.location !== mergedData.location ||
        existing.countryCode !== mergedData.countryCode ||
        existing.continent !== mergedData.continent ||
        existing.detailPageUrl !== mergedData.detailPageUrl ||
        existing.aboutPageUrl !== mergedData.aboutPageUrl ||
        existing.contactPageUrl !== mergedData.contactPageUrl ||
        existing.contactName !== mergedData.contactName ||
        existing.contactEmail !== mergedData.contactEmail ||
        existing.contactPhone !== mergedData.contactPhone ||
        existing.rssFeedUrl !== mergedData.rssFeedUrl ||
        existing.rssStatus !== mergedData.rssStatus ||
        existing.isSystemImported !== true;

      await prisma.newsSource.upsert({
        where: { frontPageUrl: source.frontPageUrl },
        create: {
          frontPageUrl: source.frontPageUrl,
          ...mergedData,
        },
        update: mergedData,
      });

      if (existing) {
        updated += 1;
        if (changed) metadataPatched += 1;
      } else {
        created += 1;
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
