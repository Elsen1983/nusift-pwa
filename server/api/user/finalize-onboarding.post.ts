// server/api/user/finalize-onboarding.post.ts
import jwt from "jsonwebtoken";
import { prisma } from "../../utils/prisma";
import { executeTargetedDiscovery } from "../../utils/discovery";

export default defineEventHandler(async (event) => {
  const token = getCookie(event, "auth_token");

  if (!token) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized: Missing token.",
    });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw createError({
      statusCode: 500,
      statusMessage: "Server Configuration Error.",
    });
  }

  let decodedToken: any;
  try {
    decodedToken = jwt.verify(token, secret);
  } catch (error) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized: Invalid or expired token.",
    });
  }

  const currentUserId = decodedToken.userId;

  if (!currentUserId) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized: Invalid token payload.",
    });
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
        onboardingStep: 3,
      },
      select: {
        id: true,
        email: true,
        onboardingStep: true,
        primaryRegion: true,
        tier: true,
      },
    });

    // 2. Kvóta (Quota) beállítása a Tier alapján
    const maxActiveLimit = updatedUser.tier === "PRO" ? 15 : 5;
    let currentlyActiveCount = 0;

    if (Array.isArray(sources)) {
      console.log(
        `[Audit][Onboarding] User ${currentUserId} submitted ${sources.length} sources for onboarding.`,
      );
      if (sources.length > 20) {
        console.warn(
          `[Audit][Onboarding] User exceeded maximum limit. Truncating to 20.`,
        );
        sources.splice(20);
      }
    } else {
      console.warn(
        `[Audit][Onboarding] User ${currentUserId} did not submit a valid sources array.`,
      );
    }

    const targetedSourceIds: string[] = [];

    // 3. Források feldolgozása, Deduplikáció és Relációs Kapcsolatok
    if (Array.isArray(sources)) {
      for (const rawUrl of sources) {
        try {
          // A) URL Normalizálás
          const incomingUrlObj = new URL(rawUrl);
          const cleanIncomingHostname = incomingUrlObj.hostname
            .replace(/^www\./, "")
            .toLowerCase();
          const incomingPath = incomingUrlObj.pathname
            .replace(/^\/|\/$/g, "")
            .toLowerCase();
          const pureRootUrl = `${incomingUrlObj.protocol}//${incomingUrlObj.hostname}`;

          // B) Keresés a meglévő szülő (Root) domainek között
          const potentialRoots = await prisma.newsSource.findMany({
            where: {
              frontPageUrl: {
                contains: cleanIncomingHostname,
                mode: "insensitive",
              },
            },
          });

          const parentRoot = potentialRoots.find((dbSource) => {
            try {
              const dbUrlObj = new URL(dbSource.frontPageUrl);
              return (
                dbUrlObj.hostname.replace(/^www\./, "").toLowerCase() ===
                cleanIncomingHostname
              );
            } catch {
              return false;
            }
          });

          // C) Keresés az exakt Kategória/Rovat között (ha van path)
          let exactCategory = null;
          if (incomingPath !== "") {
            const potentialCats = await prisma.sourceCategory.findMany({
              where: {
                pathUrl: {
                  contains: cleanIncomingHostname,
                  mode: "insensitive",
                },
              },
            });
            exactCategory = potentialCats.find((dbCat) => {
              try {
                const dbUrlObj = new URL(dbCat.pathUrl);
                const dbHostname = dbUrlObj.hostname
                  .replace(/^www\./, "")
                  .toLowerCase();
                const dbPath = dbUrlObj.pathname
                  .replace(/^\/|\/$/g, "")
                  .toLowerCase();
                return (
                  dbHostname === cleanIncomingHostname &&
                  dbPath === incomingPath
                );
              } catch {
                return false;
              }
            });
          }

          const shouldBeActive = currentlyActiveCount < maxActiveLimit;

          // D) Mentési és Relációs Logika (Szétválasztva)
          if (incomingPath === "") {
            // --- FELHASZNÁLÓ FŐOLDALT ADOTT MEG ---
            let rootId = null;
            if (parentRoot) {
              rootId = parentRoot.id;
              console.log(`[Onboarding] Linked to existing ROOT: ${rootId}`);
            } else {
              const newRoot = await prisma.newsSource.create({
                data: {
                  frontPageUrl: pureRootUrl,
                  mediaName: cleanIncomingHostname,
                  rssStatus: "PENDING_DISCOVERY",
                  isSystemImported: false,
                },
              });
              rootId = newRoot.id;
              targetedSourceIds.push(rootId);
              console.log(
                `[Onboarding] Created completely new ROOT: ${pureRootUrl}`,
              );
            }

            await prisma.userSourceSubscription.upsert({
              where: {
                userId_sourceId: { userId: currentUserId, sourceId: rootId },
              },
              create: {
                userId: currentUserId,
                sourceId: rootId,
                isActive: shouldBeActive,
              },
              update: { isActive: shouldBeActive },
            });
          } else {
            // --- FELHASZNÁLÓ KATEGÓRIÁT (ALOLDALT) ADOTT MEG ---
            if (exactCategory) {
              console.log(
                `[Onboarding] Linked to existing CATEGORY: ${exactCategory.id}`,
              );
              await prisma.userCategorySubscription.upsert({
                where: {
                  userId_categoryId: {
                    userId: currentUserId,
                    categoryId: exactCategory.id,
                  },
                },
                create: {
                  userId: currentUserId,
                  categoryId: exactCategory.id,
                  isActive: shouldBeActive,
                },
                update: { isActive: shouldBeActive },
              });
            } else {
              // Nincs még ilyen kategória. Kell új szülőt csinálni?
              let rootIdForCategory = null;
              if (parentRoot) {
                rootIdForCategory = parentRoot.id;
              } else {
                const newRoot = await prisma.newsSource.create({
                  data: {
                    frontPageUrl: pureRootUrl,
                    mediaName: cleanIncomingHostname,
                    rssStatus: "PENDING_DISCOVERY",
                    isSystemImported: false,
                  },
                });
                rootIdForCategory = newRoot.id;
                targetedSourceIds.push(rootIdForCategory); // A szülőn futtatjuk le a discoveryt
                console.log(
                  `[Onboarding] Created new parent ROOT for category: ${pureRootUrl}`,
                );
              }

              // Kategória létrehozása és összekötése
              const newCat = await prisma.sourceCategory.create({
                data: {
                  newsSourceId: rootIdForCategory,
                  name: incomingUrlObj.pathname
                    .substring(1)
                    .replace(/\//g, " - "),
                  pathUrl: rawUrl,
                  isUserRequested: true,
                  rssStatus: "PENDING_DISCOVERY",
                },
              });

              await prisma.userCategorySubscription.upsert({
                where: {
                  userId_categoryId: {
                    userId: currentUserId,
                    categoryId: newCat.id,
                  },
                },
                create: {
                  userId: currentUserId,
                  categoryId: newCat.id,
                  isActive: shouldBeActive,
                },
                update: { isActive: shouldBeActive },
              });
              console.log(
                `[Onboarding] Created and linked new CATEGORY: ${newCat.pathUrl}`,
              );
            }
          }

          // Ha sikeresen létrejött egy aktív kapcsolat, növeljük a számlálót
          if (shouldBeActive) currentlyActiveCount++;
        } catch (error) {
          console.error(
            `[Insertion Error] Failed to process URL ${rawUrl}:`,
            error,
          );
        }
      }
    }

    if (targetedSourceIds.length > 0) {
      console.log(
        `[Orchestrator] Dispatching non-blocking discovery for ${targetedSourceIds.length} sources.`,
      );
      event.waitUntil(
        executeTargetedDiscovery(targetedSourceIds).catch((err) =>
          console.error(
            "[Orchestrator] Background discovery loop crashed:",
            err,
          ),
        ),
      );
    } else {
      console.log("[Orchestrator] No new sources require discovery execution.");
    }

    return {
      success: true,
      user: updatedUser,
    };
  } catch (error) {
    console.error("Finalize onboarding DB error:", error);
    throw createError({
      statusCode: 500,
      statusMessage: "Failed to finalize onboarding process.",
    });
  }
});
