// server/api/user/sources/add.post.ts
import jwt from "jsonwebtoken";
import { prisma } from "../../../utils/prisma";

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

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw createError({
      statusCode: 500,
      statusMessage: "Server Configuration Error",
      message: "Szerver konfigurációs hiba (JWT_SECRET).",
    });
  }

  let decodedToken: any;
  try {
    decodedToken = jwt.verify(token, secret);
  } catch (error) {
    throw createError({
      statusCode: 401,
      statusMessage: "Invalid token",
      message: "Érvénytelen vagy lejárt munkamenet.",
    });
  }

  const userId = decodedToken.userId;
  const { url, name } = await readBody(event);

  if (!url) {
    throw createError({
      statusCode: 400,
      statusMessage: "Bad Request",
      message: "Az URL megadása kötelező.",
    });
  }

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
      select: { tier: true },
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

    // 4. NewsSource & Category Normalization & Deduplication (Teljeskörű Ellenőrzés)
    const urlObj = new URL(url);
    const cleanIncomingHostname = urlObj.hostname
      .replace(/^www\./, "")
      .toLowerCase();
    const incomingPath = urlObj.pathname.replace(/^\/|\/$/g, "").toLowerCase();

    // 4.A Keresés a Főoldalak (NewsSource) között
    const potentialRootMatches = await prisma.newsSource.findMany({
      where: {
        frontPageUrl: { contains: cleanIncomingHostname, mode: "insensitive" },
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
      include: { newsSource: true }, // Szükségünk van a szülőre is
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
      // ESET 1: A link már létezik a kategóriák között (pl. wexfordpeople)
      console.log(
        `[Source-Manager] Linked to existing CATEGORY: ${existingCategory.id}`,
      );

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
      // ESET 2: A link már létezik a főoldalak között
      console.log(
        `[Source-Manager] Linked to existing ROOT source: ${existingRoot.id}`,
      );

      await prisma.userSourceSubscription.upsert({
        where: { userId_sourceId: { userId, sourceId: existingRoot.id } },
        create: { userId, sourceId: existingRoot.id, isActive: shouldBeActive },
        update: { isActive: shouldBeActive },
      });
    } else {
      // ESET 3: Teljesen ismeretlen link.
      // 1. Megtisztítjuk a szülőt a path-tól
      const pureRootUrl = `${urlObj.protocol}//${urlObj.hostname}`;
      const path = urlObj.pathname;

      // 2. Mindenképp létrehozzuk a tiszta szülőt (Root) a NewsSource táblában
      const newRoot = await prisma.newsSource.create({
        data: {
          frontPageUrl: pureRootUrl,
          mediaName: name || cleanIncomingHostname,
          rssStatus: "PENDING_DISCOVERY",
        },
      });
      console.log(
        `[Source-Manager] Created completely new ROOT: ${newRoot.frontPageUrl}`,
      );

      // 3. Eldöntjük, hogy a user egy tiszta főoldalt, vagy egy kategóriát kért-e
      if (path === "/" || path === "") {
        // Ha csak egy főoldal (pl. telex.hu), akkor magához a Root-hoz kötjük
        await prisma.userSourceSubscription.upsert({
          where: { userId_sourceId: { userId, sourceId: newRoot.id } },
          create: { userId, sourceId: newRoot.id, isActive: shouldBeActive },
          update: { isActive: shouldBeActive },
        });
      } else {
        // Ha van belső útvonal (pl. telex.hu/sport), létrehozzuk a kategóriát a friss szülő alá
        const newCat = await prisma.sourceCategory.create({
          data: {
            newsSourceId: newRoot.id,
            name: path.substring(1).replace(/\//g, " - "),
            pathUrl: url,
            isUserRequested: true,
            rssStatus: "PENDING_DISCOVERY",
          },
        });

        // A usert a friss KATEGÓRIÁHOZ kötjük, nem a szülőhöz!
        await prisma.userCategorySubscription.upsert({
          where: { userId_categoryId: { userId, categoryId: newCat.id } },
          create: { userId, categoryId: newCat.id, isActive: shouldBeActive },
          update: { isActive: shouldBeActive },
        });
        console.log(
          `[Source-Manager] Created completely new CATEGORY: ${newCat.pathUrl}`,
        );
      }

      needsDiscovery = true;

      // 6. TRIGGER TARGETED DISCOVERY (Csak teljesen új forrás esetén indul el!)
      console.log(
        `[Source-Manager] Dispatching background agent for new source...`,
      );
      event.waitUntil(
        // A szkennernek a Root ID-t küldjük, hogy onnan indítsa a feltérképezést
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
