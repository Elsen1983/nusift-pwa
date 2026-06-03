// server/api/user/sources/add.post.ts
import jwt from "jsonwebtoken";
import { prisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  // 1. Authentication
  const token = getCookie(event, "auth_token");
  if (!token)
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });

  const secret = process.env.JWT_SECRET;
  if (!secret)
    throw createError({
      statusCode: 500,
      statusMessage: "Server Configuration Error",
    });

  let decodedToken: any;
  try {
    decodedToken = jwt.verify(token, secret);
  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token" });
  }

  const userId = decodedToken.userId;
  const { url, name } = await readBody(event);

  if (!url)
    throw createError({ statusCode: 400, statusMessage: "URL is required" });

  try {
    // 2. STORAGE LIMIT (Max 50 total)
    const totalCount =
      (await prisma.userSourceSubscription.count({ where: { userId } })) +
      (await prisma.userCategorySubscription.count({ where: { userId } }));

    if (totalCount >= 50) {
      throw createError({
        statusCode: 403,
        statusMessage: "Tárhely limit elérve (max 50 forrás).",
      });
    }

    // 3. ACTIVATION QUOTA (5 or 15 active)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tier: true },
    });
    const maxActiveLimit = user?.tier === "PRO" ? 15 : 5;

    const activeRoots = await prisma.userSourceSubscription.count({
      where: { userId, isActive: true },
    });
    const activeCats = await prisma.userCategorySubscription.count({
      where: { userId, isActive: true },
    });
    const shouldBeActive = activeRoots + activeCats < maxActiveLimit;

    // 4. NewsSource Normalization & Deduplication (THE FIX)
    const urlObj = new URL(url);
    const cleanIncomingHostname = urlObj.hostname.replace(/^www\./, "");
    const path = urlObj.pathname;

    // [DEBUG] Search for existing domains using broad matching (ignores http/https and www.)
    const potentialMatches = await prisma.newsSource.findMany({
      where: {
        frontPageUrl: { contains: cleanIncomingHostname, mode: "insensitive" },
      },
    });

    // [DEBUG] Strict JavaScript validation to prevent substring collision
    const existingSource = potentialMatches.find((dbSource) => {
      try {
        const dbUrlObj = new URL(dbSource.frontPageUrl);
        return (
          dbUrlObj.hostname.replace(/^www\./, "") === cleanIncomingHostname
        );
      } catch {
        return false;
      }
    });

    let newsSource;
    let needsDiscovery = false;

    if (existingSource) {
      // [DEBUG] Record found! Safely link to the existing ID to prevent duplication
      newsSource = existingSource;
      console.log(
        `[Source-Manager] Linked to existing source: ${newsSource.id}`,
      );
    } else {
      // [DEBUG] No record found. Create cleanly using a fallback root protocol.
      const fallbackRoot = `${urlObj.protocol}//${urlObj.hostname}`;
      newsSource = await prisma.newsSource.create({
        data: {
          frontPageUrl: fallbackRoot,
          mediaName: name || cleanIncomingHostname,
          rssStatus: "PENDING_DISCOVERY", // Explicitly set state to trigger crawler
        },
      });
      needsDiscovery = true;
      console.log(
        `[Source-Manager] Created new source: ${newsSource.frontPageUrl}`,
      );
    }

    // 5. UPSERT (Main Page vs Category/Path)
    if (path === "/" || path === "") {
      // [DEBUG] User added the root domain, link to UserSourceSubscription
      await prisma.userSourceSubscription.upsert({
        where: { userId_sourceId: { userId, sourceId: newsSource.id } },
        create: { userId, sourceId: newsSource.id, isActive: shouldBeActive },
        update: { isActive: shouldBeActive },
      });
    } else {
      // [DEBUG] User added a specific category or sub-path, link to SourceCategory
      const sourceCategory = await prisma.sourceCategory.upsert({
        where: {
          newsSourceId_pathUrl: { newsSourceId: newsSource.id, pathUrl: url },
        },
        create: {
          newsSourceId: newsSource.id,
          name: path.substring(1).replace(/\//g, " - "),
          pathUrl: url,
          isUserRequested: true,
        },
        update: {},
      });

      await prisma.userCategorySubscription.upsert({
        where: { userId_categoryId: { userId, categoryId: sourceCategory.id } },
        create: {
          userId,
          categoryId: sourceCategory.id,
          isActive: shouldBeActive,
        },
        update: { isActive: shouldBeActive },
      });
    }

    // 6. TRIGGER TARGETED DISCOVERY (Only if brand new)
    if (needsDiscovery) {
      console.log(
        `[Source-Manager] Dispatching background agent for new source...`,
      );

      // [DEBUG] Nuxt 4 auto-imports executeTargetedDiscovery from server/utils/discovery.ts
      event.waitUntil(
        executeTargetedDiscovery([newsSource.id]).catch((err) =>
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
    throw createError({ statusCode: 500, statusMessage: error.message });
  }
});
