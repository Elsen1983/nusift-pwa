import fs from "fs";
import path from "path";
import { prisma } from "./prisma";

const TIMELINE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const timelineMemoryCache = new Map<string, { generatedAt: string; data: TimelineEntry[] }>();

type TimelineEntry = {
  sourceName: string;
  countryCode: string;
  data: number[];
};

type ActiveAnalyticsTargets = {
  activeSourceIds: string[];
  activeCategoryIds: string[];
};

const getTimelineCachePath = (userId: string, year: number) =>
  path.join(process.cwd(), "data", `user-analytics-timeline-${userId}-${year}.json`);

const getTimelineCacheKey = (userId: string, year: number) => `${userId}:${year}`;

const canUseFileTimelineCache = () => !process.env.VERCEL;

export async function getUserAnalyticsMetrics(userId: string) {
  const [readCount, rejectedCount, sharedCount, savedCount] = await Promise.all([
    prisma.userReadActivity.count({
      where: { userId, actionType: { in: ["READ_FULL", "CLICKED"] } },
    }),
    prisma.userReadActivity.count({
      where: { userId, actionType: "DISMISSED" },
    }),
    prisma.userReadActivity.count({
      where: { userId, actionType: "SHARED" },
    }),
    prisma.bookmark.count({
      where: { userId },
    }),
  ]);

  return {
    read: readCount,
    rejected: rejectedCount,
    shared: sharedCount,
    saved: savedCount,
  };
}

async function buildTimelineData(userId: string, currentYear: number) {
  const [sourceSubs, categorySubs] = await Promise.all([
    prisma.userSourceSubscription.findMany({
      where: { userId, isActive: true },
      include: {
        newsSource: { select: { id: true, mediaName: true, countryCode: true } },
      },
    }),
    prisma.userCategorySubscription.findMany({
      where: { userId, isActive: true },
      include: {
        category: {
          select: {
            id: true,
            newsSourceId: true,
            newsSource: { select: { id: true, mediaName: true, countryCode: true } },
          },
        },
      },
    }),
  ]);

  const activeSourceIds = sourceSubs.map((sub) => sub.sourceId);
  const activeCategoryIds = categorySubs.map((sub) => sub.categoryId);

  if (activeSourceIds.length === 0 && activeCategoryIds.length === 0) {
    return [] as TimelineEntry[];
  }

  const chartDataMap = new Map<string, TimelineEntry>();

  sourceSubs.forEach((sub) => {
    if (!chartDataMap.has(sub.sourceId)) {
      chartDataMap.set(sub.sourceId, {
        sourceName: sub.newsSource.mediaName,
        countryCode: sub.newsSource.countryCode || "N/A",
        data: new Array(12).fill(0),
      });
    }
  });

  categorySubs.forEach((sub) => {
    const parentSource = sub.category.newsSource;
    if (parentSource && !chartDataMap.has(parentSource.id)) {
      chartDataMap.set(parentSource.id, {
        sourceName: parentSource.mediaName,
        countryCode: parentSource.countryCode || "N/A",
        data: new Array(12).fill(0),
      });
    }
  });

  const articles = await prisma.article.findMany({
    where: {
      OR: [
        { sourceId: { in: activeSourceIds } },
        { categoryId: { in: activeCategoryIds } },
      ],
      date: {
        gte: new Date(`${currentYear}-01-01T00:00:00.000Z`),
        lt: new Date(`${currentYear + 1}-01-01T00:00:00.000Z`),
      },
    },
    select: {
      sourceId: true,
      date: true,
    },
  });

  articles.forEach((article) => {
    const monthIndex = article.date.getMonth();
    const entry = chartDataMap.get(article.sourceId);
    if (entry) {
      entry.data[monthIndex] = (entry.data[monthIndex] || 0) + 1;
    }
  });

  return Array.from(chartDataMap.values());
}

async function getActiveAnalyticsTargets(userId: string): Promise<ActiveAnalyticsTargets> {
  const [sourceSubs, categorySubs] = await Promise.all([
    prisma.userSourceSubscription.findMany({
      where: { userId, isActive: true },
      select: { sourceId: true },
    }),
    prisma.userCategorySubscription.findMany({
      where: { userId, isActive: true },
      select: { categoryId: true },
    }),
  ]);

  return {
    activeSourceIds: sourceSubs.map((sub) => sub.sourceId),
    activeCategoryIds: categorySubs.map((sub) => sub.categoryId),
  };
}

async function hasTimelineCacheExpired(
  userId: string,
  currentYear: number,
  generatedAtMs: number,
) {
  if (Date.now() - generatedAtMs >= TIMELINE_CACHE_TTL_MS) {
    return true;
  }

  const { activeSourceIds, activeCategoryIds } = await getActiveAnalyticsTargets(userId);
  if (activeSourceIds.length === 0 && activeCategoryIds.length === 0) {
    return false;
  }

  const latestArticle = await prisma.article.findFirst({
    where: {
      OR: [
        { sourceId: { in: activeSourceIds } },
        { categoryId: { in: activeCategoryIds } },
      ],
      date: {
        gte: new Date(`${currentYear}-01-01T00:00:00.000Z`),
        lt: new Date(`${currentYear + 1}-01-01T00:00:00.000Z`),
      },
    },
    select: {
      updatedAt: true,
      createdAt: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  if (!latestArticle) {
    return false;
  }

  const latestKnownChangeMs = Math.max(
    latestArticle.updatedAt.getTime(),
    latestArticle.createdAt.getTime(),
  );

  return latestKnownChangeMs > generatedAtMs;
}

export async function getUserAnalyticsTimeline(userId: string, currentYear: number) {
  const cachePath = getTimelineCachePath(userId, currentYear);
  const cacheKey = getTimelineCacheKey(userId, currentYear);

  const memoryCached = timelineMemoryCache.get(cacheKey);
  if (memoryCached) {
    try {
      const generatedAt = new Date(memoryCached.generatedAt).getTime();
      if (
        !Number.isNaN(generatedAt) &&
        !(await hasTimelineCacheExpired(userId, currentYear, generatedAt))
      ) {
        return { data: memoryCached.data, cached: true };
      }
    } catch {}
  }

  if (canUseFileTimelineCache() && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as {
        generatedAt: string;
        data: TimelineEntry[];
      };
      const generatedAt = new Date(cached.generatedAt).getTime();
      if (
        !Number.isNaN(generatedAt) &&
        !(await hasTimelineCacheExpired(userId, currentYear, generatedAt))
      ) {
        return { data: cached.data, cached: true };
      }
    } catch {}
  }

  const data = await buildTimelineData(userId, currentYear);
  const payload = {
    generatedAt: new Date().toISOString(),
    data,
  };

  timelineMemoryCache.set(cacheKey, payload);

  if (canUseFileTimelineCache()) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch {}
  }

  return { data, cached: false };
}
