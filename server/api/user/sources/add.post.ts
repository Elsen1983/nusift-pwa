// server/api/user/sources/add.post.ts
import { prisma } from "../../../utils/prisma";
import { verifySessionToken } from "../../../utils/auth";

export default defineEventHandler(async (event) => {
  // 1. Authentication
  const token = getCookie(event, "auth_token");
  if (!token) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized",
      message: "Nincs jogosultságod a művelethez.",
    });
  }
  const userId = verifySessionToken(token).userId;
  // ÚJ: A frontendnek küldenie kell a check-source által visszaadott 'detectedLanguage'-t (itt 'language'-ként fogadjuk)
  const { url, name, language: sourceLanguage } = await readBody(event);

  if (!url) {
    throw createError({
      statusCode: 400,
      statusMessage: "Bad Request",
      message: "Az URL megadása kötelező.",
    });
  }

  // A forrás nyelve, ha nem jött a frontendről, akkor alapértelmezetten 'en'
  const finalLanguage = sourceLanguage || 'en';

  try {
    // 2. STORAGE LIMIT (Max 50 total)
    const totalCount =
      (await prisma.userSourceSubscription.count({ where: { userId } })) +
      (await prisma.userCategorySubscription.count({ where: { userId } }));

    if (totalCount >= 50) {
      throw createError({
        statusCode: 403,
        statusMessage: "Forbidden",
        message: "Tárhely limit elérve (max 50 forrás).",
      });
    }

    // 3. ACTIVATION QUOTA (5 or 15 active - Hierarchical Filter Sync)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tier: true }, // CORRECTED: Removed preferredLanguage
    });

    const maxActiveLimit = user?.tier === "PRO" ? 15 : 5;

    const rootSubscriptions = await prisma.userSourceSubscription.findMany({
      where: { userId, isActive: true },
      include: { newsSource: { select: { rssStatus: true } } },
    });

    const categorySubscriptions =
      await prisma.userCategorySubscription.findMany({
        where: { userId, isActive: true },
        include: {
          category: {
            select: {
              rssStatus: true,
              newsSource: { select: { rssStatus: true } },
            },
          },
        },
      });

    const activeRoots = rootSubscriptions.filter(
      (sub) =>
        sub.newsSource.rssStatus !== "FAILED" &&
        sub.newsSource.rssStatus !== "DOMAIN_DEAD",
    ).length;

    const activeCats = categorySubscriptions.filter((sub) => {
      let finalStatus = sub.category.rssStatus;
      const parentStatus = sub.category.newsSource.rssStatus;

      if (finalStatus === "ACTIVE") {
        // Keep as is
      } else if (parentStatus === "ACTIVE" || parentStatus === "NO_RSS_FOUND") {
        finalStatus = "NO_RSS_FOUND" as any;
      } else if (parentStatus === "FAILED" || parentStatus === "DOMAIN_DEAD") {
        finalStatus = parentStatus;
      }

      return finalStatus !== "FAILED" && finalStatus !== "DOMAIN_DEAD";
    }).length;

    const shouldBeActive = activeRoots + activeCats < maxActiveLimit;

    // 4. NewsSource & Category Normalization & Deduplication
    const urlObj = new URL(url);
    const cleanIncomingHostname = urlObj.hostname
      .replace(/^www\./, "")
      .toLowerCase();
    const incomingPath = urlObj.pathname.replace(/^\/|\/$/g, "").toLowerCase();

    // 4.A Keresés a Főoldalak (NewsSource) között
    const potentialRootMatches = await prisma.newsSource.findMany({
      where: {
        frontPageUrl: { contains: cleanIncomingHostname, mode: "insensitive" }
        // CORRECTED: Removed language filtering entirely to allow deduplication
      },
    });

    const existingRoot = potentialRootMatches.find((dbSource) => {
      try {
        const dbUrlObj = new URL(dbSource.frontPageUrl);
        const dbHostname = dbUrlObj.hostname
          .replace(/^www\./, "")
          .toLowerCase();
        const dbPath = dbUrlObj.pathname.replace(/^\/|\/$/g, "").toLowerCase();
        return dbHostname === cleanIncomingHostname && dbPath === incomingPath;
      } catch {
        return false;
      }
    });

    // 4.B Keresés a Rovatok/Aloldalak (SourceCategory) között
    const potentialCategoryMatches = await prisma.sourceCategory.findMany({
      where: {
        pathUrl: { contains: cleanIncomingHostname, mode: "insensitive" },
      },
      include: { newsSource: true }, 
    });

    const existingCategory = potentialCategoryMatches.find((dbCat) => {
      try {
        const dbUrlObj = new URL(dbCat.pathUrl);
        const dbHostname = dbUrlObj.hostname
          .replace(/^www\./, "")
          .toLowerCase();
        const dbPath = dbUrlObj.pathname.replace(/^\/|\/$/g, "").toLowerCase();
        return dbHostname === cleanIncomingHostname && dbPath === incomingPath;
      } catch {
        return false;
      }
    });

    let needsDiscovery = false;

    // 5. UPSERT (Összekötés a megfelelő entitással)
    if (existingCategory) {
      console.log(`[Source-Manager] Linked to existing CATEGORY: ${existingCategory.id}`);

      await prisma.userCategorySubscription.upsert({
        where: {
          userId_categoryId: { userId, categoryId: existingCategory.id },
        },
        create: {
          userId,
          categoryId: existingCategory.id,
          isActive: shouldBeActive,
        },
        update: { isActive: shouldBeActive },
      });
    } else if (existingRoot) {
      console.log(`[Source-Manager] Linked to existing ROOT source: ${existingRoot.id}`);

      await prisma.userSourceSubscription.upsert({
        where: { userId_sourceId: { userId, sourceId: existingRoot.id } },
        create: { userId, sourceId: existingRoot.id, isActive: shouldBeActive },
        update: { isActive: shouldBeActive },
      });
    } else {
      // ESET 3: Teljesen ismeretlen link.
      const pureRootUrl = `${urlObj.protocol}//${urlObj.hostname}`;
      const path = urlObj.pathname;

      // CORRECTED: Switched from .create to .upsert to prevent 500 crashes
      const newRoot = await prisma.newsSource.upsert({
        where: { frontPageUrl: pureRootUrl },
        create: {
          frontPageUrl: pureRootUrl,
          mediaName: name || cleanIncomingHostname,
          rssStatus: "PENDING_DISCOVERY",
          language: finalLanguage, // CORRECTED: Uses the true detected language
        },
        update: {} 
      });
      console.log(`[Source-Manager] Created completely new ROOT: ${newRoot.frontPageUrl}`);

      if (path === "/" || path === "") {
        await prisma.userSourceSubscription.upsert({
          where: { userId_sourceId: { userId, sourceId: newRoot.id } },
          create: { userId, sourceId: newRoot.id, isActive: shouldBeActive },
          update: { isActive: shouldBeActive },
        });
      } else {
        const newCat = await prisma.sourceCategory.create({
          data: {
            newsSourceId: newRoot.id,
            name: path.substring(1).replace(/\//g, " - "),
            pathUrl: url,
            isUserRequested: true,
            rssStatus: "PENDING_DISCOVERY",
          },
        });

        await prisma.userCategorySubscription.upsert({
          where: { userId_categoryId: { userId, categoryId: newCat.id } },
          create: { userId, categoryId: newCat.id, isActive: shouldBeActive },
          update: { isActive: shouldBeActive },
        });
        console.log(`[Source-Manager] Created completely new CATEGORY: ${newCat.pathUrl}`);
      }

      needsDiscovery = true;

      console.log(`[Source-Manager] Dispatching background agent for new source...`);
      event.waitUntil(
        executeTargetedDiscovery([newRoot.id]).catch((err) =>
          console.error("[Source-Manager] Discovery failed:", err),
        ),
      );
    }

    return {
      success: true,
      activated: shouldBeActive,
      message: shouldBeActive
        ? "Forrás hozzáadva és aktiválva."
        : "Kvóta elérve: Felfüggesztett zónába került.",
    };
  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusCode ? "Error" : "Internal Server Error",
      message: error.message,
    });
  }
});
