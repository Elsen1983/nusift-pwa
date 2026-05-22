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
  const { url, name } = await readBody(event); // A validált, tiszta URL érkezik

  if (!url) throw createError({ statusCode: 400, statusMessage: "URL is required" });

  try {
    // 2. TÁRHELY LIMIT (50 összesen)
    const totalCount = await prisma.userSourceSubscription.count({ where: { userId } }) +
                       await prisma.userCategorySubscription.count({ where: { userId } });
    
    if (totalCount >= 50) {
      throw createError({ statusCode: 403, statusMessage: "Tárhely limit elérve (max 50 forrás)." });
    }

    // 3. AKTIVÁCIÓS KVÓTA (5 vagy 15 aktív)
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { tier: true } });
    const maxActiveLimit = user?.tier === 'PRO' ? 15 : 5;
    
    const activeRoots = await prisma.userSourceSubscription.count({ where: { userId, isActive: true } });
    const activeCats = await prisma.userCategorySubscription.count({ where: { userId, isActive: true } });
    const shouldBeActive = (activeRoots + activeCats) < maxActiveLimit;

    // 4. NewsSource keresése/létrehozása
    const urlObj = new URL(url);
    const rootDomain = `${urlObj.protocol}//${urlObj.hostname}`;
    
    let newsSource = await prisma.newsSource.findUnique({ where: { frontPageUrl: rootDomain } });
    if (!newsSource) {
      newsSource = await prisma.newsSource.create({
        data: { frontPageUrl: rootDomain, mediaName: name || urlObj.hostname }
      });
    }

    // 5. UPSERT (Főoldal vs Rovat)
    const path = urlObj.pathname;

    if (path === "/" || path === "") {
      await prisma.userSourceSubscription.upsert({
        where: { userId_sourceId: { userId, sourceId: newsSource.id } },
        create: { userId, sourceId: newsSource.id, isActive: shouldBeActive },
        update: { isActive: shouldBeActive } // Újraaktiválás lehetősége
      });
    } else {
      const sourceCategory = await prisma.sourceCategory.upsert({
        where: { newsSourceId_pathUrl: { newsSourceId: newsSource.id, pathUrl: url } },
        create: { 
          newsSourceId: newsSource.id, 
          name: path.substring(1).replace(/\//g, ' - '), 
          pathUrl: url, 
          isUserRequested: true 
        },
        update: {}
      });

      await prisma.userCategorySubscription.upsert({
        where: { userId_categoryId: { userId, categoryId: sourceCategory.id } },
        create: { userId, categoryId: sourceCategory.id, isActive: shouldBeActive },
        update: { isActive: shouldBeActive }
      });
    }

    return { 
      success: true, 
      activated: shouldBeActive, 
      message: shouldBeActive ? 'Forrás hozzáadva és aktiválva.' : 'Kvóta elérve: Felfüggesztett zónába került.' 
    };

  } catch (error: any) {
    throw createError({ statusCode: 500, statusMessage: error.message });
  }
});