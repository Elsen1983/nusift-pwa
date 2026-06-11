// server/api/user/analytics.ts
import { prisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const userId = event.context.user?.id;
  
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const query = getQuery(event);
  const currentYear = parseInt(query.year as string) || new Date().getFullYear();

  try {
    // 1. Fetch Source & Category Subscriptions
    const sourceSubs = await prisma.userSourceSubscription.findMany({
      where: { userId: userId, isActive: true },
      include: {
        newsSource: { select: { id: true, mediaName: true, countryCode: true } }
      }
    });

    const categorySubs = await prisma.userCategorySubscription.findMany({
      where: { userId: userId, isActive: true },
      include: {
        category: { 
          select: { 
            id: true, 
            newsSourceId: true,
            newsSource: { select: { id: true, mediaName: true, countryCode: true } } 
          } 
        }
      }
    });

    const activeSourceIds = sourceSubs.map(sub => sub.sourceId);
    const activeCategoryIds = categorySubs.map(sub => sub.categoryId);

    // --- NEW: FETCH USER ACTIVITY METRICS CONCURRENTLY ---
    // Using Promise.all ensures these queries run simultaneously, avoiding latency bottlenecks
    const [readCount, rejectedCount, sharedCount, savedCount] = await Promise.all([
      prisma.userReadActivity.count({ 
        where: { userId: userId, actionType: { in: ['READ_FULL', 'CLICKED'] } } 
      }),
      prisma.userReadActivity.count({ 
        where: { userId: userId, actionType: 'DISMISSED' } 
      }),
      prisma.userReadActivity.count({ 
        where: { userId: userId, actionType: 'SHARED' } 
      }),
      prisma.bookmark.count({ 
        where: { userId: userId } 
      })
    ]);

    if (activeSourceIds.length === 0 && activeCategoryIds.length === 0) {
      return { 
        success: true, 
        data: [],
        metrics: { read: readCount, rejected: rejectedCount, shared: sharedCount, saved: savedCount }
      };
    }

    // 3. Prepare Chart Data (Main Domains Only)
    const chartDataMap = new Map();

    sourceSubs.forEach(sub => {
      if (!chartDataMap.has(sub.sourceId)) {
        chartDataMap.set(sub.sourceId, {
          sourceName: sub.newsSource.mediaName,
          countryCode: sub.newsSource.countryCode || 'N/A',
          data: new Array(12).fill(0)
        });
      }
    });

    categorySubs.forEach(sub => {
      const parentSource = sub.category.newsSource;
      if (parentSource && !chartDataMap.has(parentSource.id)) {
        chartDataMap.set(parentSource.id, {
          sourceName: parentSource.mediaName,
          countryCode: parentSource.countryCode || 'N/A',
          data: new Array(12).fill(0)
        });
      }
    });

    // 4. Fetch Articles
    const articles = await prisma.article.findMany({
      where: {
        OR: [
          { sourceId: { in: activeSourceIds } },
          { categoryId: { in: activeCategoryIds } }
        ],
        date: {
          gte: new Date(`${currentYear}-01-01T00:00:00.000Z`),
          lt: new Date(`${currentYear + 1}-01-01T00:00:00.000Z`),
        }
      },
      select: {
        sourceId: true, 
        date: true
      }
    });

    // 5. Aggregate Buckets for Chart
    articles.forEach(article => {
      const monthIndex = article.date.getMonth();
      const entry = chartDataMap.get(article.sourceId);
      
      if (entry) {
        entry.data[monthIndex]++;
      }
    });

    // Return combined payload
    return { 
      success: true, 
      data: Array.from(chartDataMap.values()),
      metrics: {
        read: readCount,
        rejected: rejectedCount,
        shared: sharedCount,
        saved: savedCount
      }
    };

  } catch (error) {
    console.error("Analytics Aggregation Error:", error);
    throw createError({ statusCode: 500, statusMessage: 'Internal Server Error' });
  }
});