// server/api/user/sources/[id].delete.ts
import { prisma } from '../../../utils/prisma';
import { requireUserId } from "../../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  // Kinyerjük az ID-t az URL-ből (pl. /api/user/sources/1234-uuid-5678)
  const subscriptionId = getRouterParam(event, 'id');

  if (!subscriptionId) {
    throw createError({ statusCode: 400, statusMessage: "Subscription ID is required" });
  }

  try {
    // Megkeressük, melyik táblában van és megbizonyosodunk róla, hogy a useré
    const rootSub = await prisma.userSourceSubscription.findUnique({
      where: { id: subscriptionId }
    });

    if (rootSub) {
      if (rootSub.userId !== userId) throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      
      await prisma.userSourceSubscription.delete({
        where: { id: subscriptionId }
      });
      return { success: true, message: "Source removed" };
    }

    const catSub = await prisma.userCategorySubscription.findUnique({
      where: { id: subscriptionId }
    });

    if (catSub) {
      if (catSub.userId !== userId) throw createError({ statusCode: 403, statusMessage: "Forbidden" });

      await prisma.userCategorySubscription.delete({
        where: { id: subscriptionId }
      });
      return { success: true, message: "Category removed" };
    }

    throw createError({ statusCode: 404, statusMessage: "Subscription not found" });

  } catch (error: any) {
    console.error("Delete Source Error:", error);
    throw createError({ 
      statusCode: error.statusCode || 500, 
      statusMessage: error.statusMessage || "Failed to delete source." 
    });
  }
});