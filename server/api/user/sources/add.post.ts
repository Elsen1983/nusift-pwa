// server/api/user/sources/add.post.ts
import jwt from 'jsonwebtoken';
import { prisma } from '../../../utils/prisma';

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
  const body = await readBody(event);
  const rawUrl = body.url;

  if (!rawUrl) {
    throw createError({ statusCode: 400, statusMessage: "URL is required" });
  }

  try {
    // 2. Kvóta kiszámítása
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tier: true }
    });

    if (!user) throw createError({ statusCode: 404, statusMessage: "User not found" });

    const maxActiveLimit = user.tier === 'PRO' ? 15 : 5;

    // Aktív források összeszámlálása (Főoldalak + Rovatok)
    const activeRoots = await prisma.userSourceSubscription.count({
      where: { userId, isActive: true }
    });
    const activeCategories = await prisma.userCategorySubscription.count({
      where: { userId, isActive: true }
    });
    
    const currentlyActiveCount = activeRoots + activeCategories;
    const shouldBeActive = currentlyActiveCount < maxActiveLimit;

    // 3. URL Normalizáció
    const urlObj = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    const rootDomain = `${urlObj.protocol}//${urlObj.hostname}`;
    let path = urlObj.pathname === "/" ? "" : urlObj.pathname.replace(/\/$/, "");

    // 4. Globális forrás létrehozása/frissítése (Deduplikáció)
    const newsSource = await prisma.newsSource.upsert({
      where: { frontPageUrl: rootDomain },
      create: {
        frontPageUrl: rootDomain,
        mediaName: urlObj.hostname.replace(/^www\./, ''),
      },
      update: {}
    });

    let newSubscription;

    // 5. Kapcsolat létrehozása (Főoldal vs Rovat)
    if (path === "") {
      newSubscription = await prisma.userSourceSubscription.upsert({
        where: { userId_sourceId: { userId, sourceId: newsSource.id } },
        create: { userId, sourceId: newsSource.id, isActive: shouldBeActive },
        update: {} // Ha már fel van iratkozva, nem írjuk felül a státuszát itt
      });
    } else {
      const fullPathUrl = `${rootDomain}${path}`;
      const sourceCategory = await prisma.sourceCategory.upsert({
        where: { newsSourceId_pathUrl: { newsSourceId: newsSource.id, pathUrl: fullPathUrl } },
        create: {
          newsSourceId: newsSource.id,
          name: path.substring(1).replace(/\//g, ' - '),
          pathUrl: fullPathUrl,
          isUserRequested: true
        },
        update: {}
      });

      newSubscription = await prisma.userCategorySubscription.upsert({
        where: { userId_categoryId: { userId, categoryId: sourceCategory.id } },
        create: { userId, categoryId: sourceCategory.id, isActive: shouldBeActive },
        update: {}
      });
    }

    return {
      success: true,
      activated: shouldBeActive,
      message: shouldBeActive ? 'Source added and activated.' : 'Added to Suspended Zone (Quota Full).'
    };

  } catch (error: any) {
    console.error("Add Source Error:", error);
    throw createError({ statusCode: 500, statusMessage: "Failed to process source." });
  }
});