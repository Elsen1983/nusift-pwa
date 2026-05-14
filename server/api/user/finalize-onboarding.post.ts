// server/api/user/finalize-onboarding.post.ts
import jwt from 'jsonwebtoken';
import { prisma } from '../../utils/prisma';

export default defineEventHandler(async (event) => {
  const token = getCookie(event, 'auth_token');
  
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized: Missing token." });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw createError({ statusCode: 500, statusMessage: "Server Configuration Error." });
  }

  let decodedToken: any;
  try {
    decodedToken = jwt.verify(token, secret);
  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized: Invalid or expired token." });
  }

  const currentUserId = decodedToken.userId;

  if (!currentUserId) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized: Invalid token payload." });
  }

  const body = await readBody(event);
  const { region, sources, interests } = body;

  try {
    // 1. Alap adatok frissítése és a User Tier (Csomag) lekérése
    const updatedUser = await prisma.user.update({
      where: { id: currentUserId },
      data: {
        primaryRegion: region,
        topInterests: interests,
        onboardingStep: 3
      },
      select: { id: true, email: true, onboardingStep: true, primaryRegion: true, tier: true }
    });

    // 2. Kvóta (Quota) beállítása a Tier alapján
    const maxActiveLimit = updatedUser.tier === 'PRO' ? 15 : 5;
    let currentlyActiveCount = 0;

    // 3. Források feldolgozása, Deduplikáció és Explicit Kapcsolatok létrehozása
    if (Array.isArray(sources)) {
      for (const rawUrl of sources) {
        try {
          const urlObj = new URL(rawUrl);
          const rootDomain = `${urlObj.protocol}//${urlObj.hostname}`;
          let path = urlObj.pathname === "/" ? "" : urlObj.pathname.replace(/\/$/, "");

          // A globális hírforrás létrehozása vagy frissítése (Deduplikáció)
          const newsSource = await prisma.newsSource.upsert({
            where: { frontPageUrl: rootDomain },
            create: {
              frontPageUrl: rootDomain,
              mediaName: urlObj.hostname.replace(/^www\./, ''),
            },
            update: {}
          });

          // Eldöntjük, hogy belefér-e még az aktív kvótába
          const shouldBeActive = currentlyActiveCount < maxActiveLimit;

          // Ha nincs aloldal (Root domain feliratkozás)
          if (path === "") {
            await prisma.userSourceSubscription.upsert({
              where: {
                userId_sourceId: { userId: currentUserId, sourceId: newsSource.id }
              },
              create: {
                userId: currentUserId,
                sourceId: newsSource.id,
                isActive: shouldBeActive
              },
              update: {} // Ha már létezik, nem írjuk felül az állapotát az onboardingnál
            });
            if (shouldBeActive) currentlyActiveCount++;
            
          } else {
            // Ha aloldal / rovat (Pl. /tech)
            const fullPathUrl = `${rootDomain}${path}`;
            const sourceCategory = await prisma.sourceCategory.upsert({
              where: {
                newsSourceId_pathUrl: { newsSourceId: newsSource.id, pathUrl: fullPathUrl }
              },
              create: {
                newsSourceId: newsSource.id,
                name: path.substring(1).replace(/\//g, ' - '),
                pathUrl: fullPathUrl,
                isUserRequested: true
              },
              update: {}
            });

            await prisma.userCategorySubscription.upsert({
              where: {
                userId_categoryId: { userId: currentUserId, categoryId: sourceCategory.id }
              },
              create: {
                userId: currentUserId,
                categoryId: sourceCategory.id,
                isActive: shouldBeActive
              },
              update: {}
            });
            if (shouldBeActive) currentlyActiveCount++;
          }
        } catch (e) {
          console.error(`Failed to process source URL: ${rawUrl}`, e);
        }
      }
    }

    return { 
      success: true, 
      user: updatedUser
    };

  } catch (error) {
    console.error("Finalize onboarding DB error:", error);
    throw createError({ statusCode: 500, statusMessage: "Failed to finalize onboarding process." });
  }
});