// server/api/user/sources.get.ts
import jwt from 'jsonwebtoken';
import { prisma } from '../../utils/prisma';

export default defineEventHandler(async (event) => {
  // 1. Autentikáció
  const token = getCookie(event, 'auth_token');
  if (!token) throw createError({ statusCode: 401, statusMessage: "Unauthorized" });

  const secret = process.env.JWT_SECRET;
  if (!secret) throw createError({ statusCode: 500, statusMessage: "Server Configuration Error" });

  let decodedToken: any;
  try {
    decodedToken = jwt.verify(token, secret);
  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token" });
  }

  const userId = decodedToken.userId;

  try {
    // 2. Felhasználói kvóta (Tier) lekérése
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tier: true }
    });

    if (!user) throw createError({ statusCode: 404, statusMessage: "User not found" });

    const quotaLimit = user.tier === 'PRO' ? 15 : 5;

    // 3. Főoldali feliratkozások lekérése (Include-olva a NewsSource adatokat)
    const rootSubscriptions = await prisma.userSourceSubscription.findMany({
      where: { userId: userId },
      include: {
        newsSource: {
          select: { frontPageUrl: true, mediaName: true, rssStatus: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // 4. Rovat feliratkozások lekérése (Include-olva a Kategória ÉS a Szülő Főoldal adatait)
    const categorySubscriptions = await prisma.userCategorySubscription.findMany({
      where: { userId: userId },
      include: {
        category: {
          select: { 
            pathUrl: true, 
            name: true, 
            rssStatus: true,
            newsSource: { select: { mediaName: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // 5. Adatok egységesítése a Frontend számára
    const formattedSources = [
      ...rootSubscriptions.map(sub => ({
        id: sub.id,
        type: 'ROOT',
        url: sub.newsSource.frontPageUrl,
        name: sub.customAlias || sub.newsSource.mediaName,
        isActive: sub.isActive,
        validationStatus: sub.newsSource.rssStatus,
        createdAt: sub.createdAt
      })),
      ...categorySubscriptions.map(sub => ({
        id: sub.id,
        type: 'CATEGORY',
        url: sub.category.pathUrl,
        name: sub.customAlias || `${sub.category.newsSource.mediaName} - ${sub.category.name}`,
        isActive: sub.isActive,
        validationStatus: sub.category.rssStatus,
        createdAt: sub.createdAt
      }))
    ];

    // Aktív források száma
    const activeCount = formattedSources.filter(s => s.isActive).length;

    return {
      success: true,
      quota: {
        tier: user.tier,
        limit: quotaLimit,
        activeCount: activeCount,
        availableSlots: Math.max(0, quotaLimit - activeCount)
      },
      sources: formattedSources
    };

  } catch (error) {
    console.error("Fetch sources error:", error);
    throw createError({ statusCode: 500, statusMessage: "Failed to fetch sources." });
  }
});