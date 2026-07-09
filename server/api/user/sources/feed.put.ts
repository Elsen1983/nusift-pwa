import { createError } from "h3";
import { prisma } from "../../../utils/prisma";
import { requireUserId } from "../../../utils/require-user";
import { verifyImportedRssFeed } from "../../../utils/news-pipeline/import-rss";
import { getFeedProductivityResetData } from "../../../utils/news-pipeline/feed-productivity";
import { runNewsPipeline } from "../../../utils/news-pipeline/orchestrator";

const isSameRootDomain = (left: string, right: string) => {
  const leftHost = new URL(left).hostname.replace(/^www\./, "").toLowerCase();
  const rightHost = new URL(right).hostname.replace(/^www\./, "").toLowerCase();
  return (
    leftHost === rightHost ||
    leftHost.endsWith(`.${rightHost}`) ||
    rightHost.endsWith(`.${leftHost}`)
  );
};

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  const body = await readBody(event);

  const subscriptionId = String(body?.subscriptionId || "").trim();
  const feedUrlInput = String(body?.feedUrl || "").trim();

  if (!subscriptionId || !feedUrlInput) {
    throw createError({ statusCode: 400, statusMessage: "Missing subscriptionId or feedUrl." });
  }

  let normalizedFeedUrl: string;
  try {
    normalizedFeedUrl = new URL(feedUrlInput).toString();
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid feed URL." });
  }

  const rootSubscription = await prisma.userSourceSubscription.findFirst({
    where: { id: subscriptionId, userId },
    include: {
      newsSource: {
        select: {
          id: true,
          frontPageUrl: true,
          rssFeedUrl: true,
        },
      },
    },
  });

  const categorySubscription = rootSubscription
    ? null
    : await prisma.userCategorySubscription.findFirst({
        where: { id: subscriptionId, userId },
        include: {
          category: {
            select: {
              id: true,
              pathUrl: true,
              rssFeedUrl: true,
              newsSourceId: true,
            },
          },
        },
      });

  if (!rootSubscription && !categorySubscription) {
    throw createError({ statusCode: 404, statusMessage: "Source subscription not found." });
  }

  const targetUrl = rootSubscription
    ? rootSubscription.newsSource.frontPageUrl
    : categorySubscription!.category.pathUrl;

  if (!isSameRootDomain(normalizedFeedUrl, targetUrl)) {
    throw createError({ statusCode: 400, statusMessage: "Feed URL must belong to the same source domain." });
  }

  const verification = await verifyImportedRssFeed(normalizedFeedUrl);
  if (!verification.verified) {
    throw createError({
      statusCode: 400,
      statusMessage: verification.reason || "Feed URL did not validate as RSS/Atom.",
    });
  }

  const now = new Date();
  const discoveryEvidence = {
    evaluatedAt: now.toISOString(),
    targetUrl,
    feedUrl: normalizedFeedUrl,
    discoveredVia: normalizedFeedUrl,
    detection: "manual-override",
    scopeConfidence: "high",
    scopeMatch: rootSubscription ? "generic" : "exact",
    taxonomyEvidence: null,
    score: 100,
    topCandidates: [
      {
        feedUrl: normalizedFeedUrl,
        detection: "manual-override",
        score: 100,
        contentType: null,
        scopeMatch: rootSubscription ? "generic" : "exact",
      },
    ],
    rejectedCandidates: [],
    lastError: null,
  };

  if (rootSubscription) {
    await prisma.newsSource.update({
      where: { id: rootSubscription.newsSource.id },
      data: {
        rssFeedUrl: normalizedFeedUrl,
        rssStatus: "ACTIVE",
        lastRssCheckAt: now,
        discoveryEvidence,
        ...getFeedProductivityResetData(rootSubscription.newsSource.rssFeedUrl, normalizedFeedUrl),
      },
    });

    if (rootSubscription.isActive) {
      await runNewsPipeline([rootSubscription.newsSource.id]);
    }
    return { ok: true, targetType: "ROOT", feedUrl: normalizedFeedUrl };
  }

  await prisma.sourceCategory.update({
    where: { id: categorySubscription!.category.id },
    data: {
      rssFeedUrl: normalizedFeedUrl,
      rssStatus: "ACTIVE",
      lastRssCheckAt: now,
      discoveryEvidence,
      ...getFeedProductivityResetData(categorySubscription!.category.rssFeedUrl, normalizedFeedUrl),
    },
  });

  if (categorySubscription!.isActive) {
    await runNewsPipeline([categorySubscription!.category.newsSourceId], [categorySubscription!.category.id]);
  }
  return { ok: true, targetType: "CATEGORY", feedUrl: normalizedFeedUrl };
});
