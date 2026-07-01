// server/api/user/sources/toggle.put.ts
import { prisma } from '../../../utils/prisma';
import { requireUserId } from '../../../utils/require-user';

export default defineEventHandler(async (event) => {
  // Authentication (session-guard validates tokenVersion)
  const userId = requireUserId(event);
  const { sourceId, isActive } = await readBody(event); 

  if (!sourceId || typeof isActive !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: "Bad Request", message: "Hiányzó adatok a kérésből." });
  }

  try {
    // 1. QUOTA GUARD: Only allow activation if there is available space
    if (isActive) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { tier: true } });
      const maxLimit = user?.tier === 'PRO' ? 15 : 5;
      
      // We must calculate the active count using the exact same inheritance logic as the GET endpoint.
      const rootSubscriptions = await prisma.userSourceSubscription.findMany({
        where: { userId, isActive: true },
        include: { newsSource: { select: { rssStatus: true } } }
      });

      const categorySubscriptions = await prisma.userCategorySubscription.findMany({
        where: { userId, isActive: true },
        include: {
          category: {
            select: { 
              rssStatus: true,
              newsSource: { select: { rssStatus: true } } 
            }
          }
        }
      });

      // Calculate Root active count
      const activeRoots = rootSubscriptions.filter(sub => 
        sub.newsSource.rssStatus !== 'FAILED' && 
        sub.newsSource.rssStatus !== 'DOMAIN_DEAD'
      ).length;

      // Calculate Category active count using hierarchical logic
      const activeCats = categorySubscriptions.filter(sub => {
        let finalStatus = sub.category.rssStatus;
        const parentStatus = sub.category.newsSource.rssStatus;

        if (finalStatus === 'ACTIVE') {
          // Keep as is
        } else if (parentStatus === 'ACTIVE' || parentStatus === 'NO_RSS_FOUND') {
          finalStatus = 'NO_RSS_FOUND' as any;
        } else if (parentStatus === 'FAILED' || parentStatus === 'DOMAIN_DEAD') {
          finalStatus = parentStatus;
        }

        return finalStatus !== 'FAILED' && finalStatus !== 'DOMAIN_DEAD';
      }).length;
      
      // If we hit the limit with true active sources, block the activation
      if (activeRoots + activeCats >= maxLimit) {
        throw createError({ 
          statusCode: 403, 
          statusMessage: "Forbidden", 
          message: "Kvóta limit elérve. Előbb függessz fel egy másik forrást." 
        });
      }
    }

    // 2. Update: Find the subscription and update the isActive status
    // Search for Root source
    const rootSub = await prisma.userSourceSubscription.findUnique({ where: { id: sourceId } });
    
    if (rootSub && rootSub.userId === userId) {
      await prisma.userSourceSubscription.update({
        where: { id: sourceId },
        data: { isActive }
      });
      return { success: true, message: isActive ? "Forrás aktiválva." : "Forrás felfüggesztve." };
    }

    // Search for Category source
    const catSub = await prisma.userCategorySubscription.findUnique({ where: { id: sourceId } });
    
    if (catSub && catSub.userId === userId) {
      await prisma.userCategorySubscription.update({
        where: { id: sourceId },
        data: { isActive }
      });
      return { success: true, message: isActive ? "Rovat aktiválva." : "Rovat felfüggesztve." };
    }

    throw createError({ statusCode: 404, statusMessage: "Not Found", message: "Feliratkozás nem található a rendszerben." });

  } catch (error: any) {
    throw createError({ 
      statusCode: error.statusCode || 500, 
      statusMessage: error.statusCode ? "Error" : "Internal Server Error", 
      message: error.message 
    });
  }
});
