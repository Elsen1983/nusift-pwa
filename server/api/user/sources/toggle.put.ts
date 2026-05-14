// server/api/user/sources/toggle.put.ts
import jwt from 'jsonwebtoken';
import { prisma } from '../../../utils/prisma';

export default defineEventHandler(async (event) => {
  const token = getCookie(event, 'auth_token');
  if (!token) throw createError({ statusCode: 401, statusMessage: "Unauthorized" });

  const secret = process.env.JWT_SECRET;
  if (!secret) throw createError({ statusCode: 500, statusMessage: "Server Config Error" });

  let decodedToken: any;
  try {
    decodedToken = jwt.verify(token, secret);
  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token" });
  }

  const userId = decodedToken.userId;
  const body = await readBody(event);
  const { sourceId, isActive } = body; // Ez a subscription UUID-ja

  if (!sourceId || typeof isActive !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: "Missing required fields" });
  }

  try {
    // Ha AKTIVÁLNI akar, le kell ellenőrizni a kvótát
    if (isActive) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { tier: true }
      });
      const maxLimit = user?.tier === 'PRO' ? 15 : 5;
      
      const activeRoots = await prisma.userSourceSubscription.count({ where: { userId, isActive: true } });
      const activeCats = await prisma.userCategorySubscription.count({ where: { userId, isActive: true } });
      
      if (activeRoots + activeCats >= maxLimit) {
        throw createError({ statusCode: 403, statusMessage: "Quota limit reached. Suspend another source first." });
      }
    }

    // Megpróbáljuk frissíteni a Főoldali feliratkozást
    const rootSub = await prisma.userSourceSubscription.findUnique({
      where: { id: sourceId }
    });

    if (rootSub && rootSub.userId === userId) {
      await prisma.userSourceSubscription.update({
        where: { id: sourceId },
        data: { isActive }
      });
      return { success: true };
    }

    // Ha nem Főoldal, megpróbáljuk frissíteni a Rovat feliratkozást
    const catSub = await prisma.userCategorySubscription.findUnique({
      where: { id: sourceId }
    });

    if (catSub && catSub.userId === userId) {
      await prisma.userCategorySubscription.update({
        where: { id: sourceId },
        data: { isActive }
      });
      return { success: true };
    }

    throw createError({ statusCode: 404, statusMessage: "Subscription not found" });

  } catch (error: any) {
    console.error("Toggle Source Error:", error);
    throw createError({ 
      statusCode: error.statusCode || 500, 
      statusMessage: error.statusMessage || "Failed to toggle source state." 
    });
  }
});