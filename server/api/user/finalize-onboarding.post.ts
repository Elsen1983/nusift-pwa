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
          `[Audit][Onboarding] User ${currentUserId} exceeded maximum source limit (Submitted: ${sources.length}). Truncating to 20.`,
        );
        sources.splice(20); // Csak az első 20 forrást engedjük át
      }
    } else {
      console.warn(
        `[Audit][Onboarding] User ${currentUserId} did not submit a valid sources array.`,
      );
    }

    // 3. Források feldolgozása, Deduplikáció és Explicit Kapcsolatok létrehozása
    const targetedSourceIds: string[] = [];
    if (Array.isArray(sources)) {
      for (const rawUrl of sources) {
        try {
          // 1. Normalize the incoming URL
          const incomingUrlObj = new URL(rawUrl);
          const cleanIncomingHostname = incomingUrlObj.hostname.replace(
            /^www\./,
            "",
          ); // e.g., "delmagyar.hu"

          // 2. Search for existing domains using a broad LIKE query first (for performance)
          const potentialMatches = await prisma.newsSource.findMany({
            where: {
              frontPageUrl: {
                contains: cleanIncomingHostname,
                mode: "insensitive",
              },
            },
          });

          // 3. Strict JavaScript validation to prevent substring collision (e.g., 'subdelmagyar.hu')
          const existingSource = potentialMatches.find((dbSource) => {
            try {
              const dbUrlObj = new URL(dbSource.frontPageUrl);
              return (
                dbUrlObj.hostname.replace(/^www\./, "") ===
                cleanIncomingHostname
              );
            } catch {
              return false;
            }
          });

          let finalSourceId = null;

          if (existingSource) {
            // 4a. RECORD EXISTS: Do NOT create a duplicate.
            // Grab the existing ID so we can link the user to it.
            console.log(
              `[Deduplication] Prevented duplicate for ${rawUrl}. Using existing ID: ${existingSource.id}`,
            );
            finalSourceId = existingSource.id;

            // Optional: If the existing source is pending, we can still queue it for discovery
            if (existingSource.rssStatus === "PENDING_DISCOVERY") {
              targetedSourceIds.push(finalSourceId);
            }
          } else {
            // 4b. TRULY NEW RECORD: Safe to create.
            const newSource = await prisma.newsSource.create({
              data: {
                frontPageUrl: rawUrl,
                mediaName: cleanIncomingHostname,
                rssStatus: "PENDING_DISCOVERY",
                isSystemImported: false,
              },
            });
            console.log(
              `[Deduplication] Created new source: ${newSource.frontPageUrl}`,
            );
            finalSourceId = newSource.id;
            targetedSourceIds.push(finalSourceId); // Queue for discovery
          }

          // 5. Link the finalSourceId to the User via UserSourceSubscription
          if (finalSourceId) {
            const incomingUrlObj = new URL(rawUrl);
            const path = incomingUrlObj.pathname;
            const shouldBeActive = currentlyActiveCount < maxActiveLimit;

            if (path === "/" || path === "") {
              // ROUTE A: Root Domain Subscription (e.g., https://444.hu/)
              await prisma.userSourceSubscription.upsert({
                where: {
                  userId_sourceId: {
                    userId: currentUserId,
                    sourceId: finalSourceId,
                  },
                },
                create: {
                  userId: currentUserId,
                  sourceId: finalSourceId,
                  isActive: shouldBeActive,
                },
                update: {
                  isActive: shouldBeActive,
                },
              });
              console.log(
                `[Onboarding] Linked ROOT source ${finalSourceId} to user (Active: ${shouldBeActive})`,
              );
            } else {
              // ROUTE B: Category / Sub-path Subscription (e.g., https://telex.hu/rovat/kulfold)
              const sourceCategory = await prisma.sourceCategory.upsert({
                where: {
                  newsSourceId_pathUrl: {
                    newsSourceId: finalSourceId,
                    pathUrl: rawUrl,
                  },
                },
                create: {
                  newsSourceId: finalSourceId,
                  name: path.substring(1).replace(/\//g, " - "),
                  pathUrl: rawUrl,
                  isUserRequested: true,
                },
                update: {}, // Categories are static once created
              });

              await prisma.userCategorySubscription.upsert({
                where: {
                  userId_categoryId: {
                    userId: currentUserId,
                    categoryId: sourceCategory.id,
                  },
                },
                create: {
                  userId: currentUserId,
                  categoryId: sourceCategory.id,
                  isActive: shouldBeActive,
                },
                update: {
                  isActive: shouldBeActive,
                },
              });
              console.log(
                `[Onboarding] Linked CATEGORY ${sourceCategory.id} (${rawUrl}) to user (Active: ${shouldBeActive})`,
              );
            }

            // Increment active count regardless of whether it was a root or a category
            if (shouldBeActive) {
              currentlyActiveCount++;
            }

            console.log(
              `[Onboarding] Successfully linked source ${finalSourceId} to user ${currentUserId} (Active: ${shouldBeActive})`,
            );
          }
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
