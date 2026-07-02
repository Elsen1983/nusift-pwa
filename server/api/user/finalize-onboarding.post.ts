// server/api/user/finalize-onboarding.post.ts
import { prisma } from "../../utils/prisma";
import { executeTargetedDiscovery } from "../../utils/discovery";
import { runNewsPipeline } from "../../utils/news-pipeline/orchestrator";
import { requireUserId } from "../../utils/require-user";
import { validateHostname, SSRFError } from "../../utils/ssrf-guard";
import { ISO_LANG_CODES } from "../../utils/langCodes"; // ÚJ: Importáljuk a nyelv-Set-et (Ellenőrizd az elérési utat!)

const MAX_SUBMITTED_SOURCES = 20;

type OnboardingBody = {
  region?: string | null;
  sources?: unknown;
  interests?: string[] | null;
};

function normalizeRssStatus(
  status: "PENDING_DISCOVERY" | "NO_RSS_FOUND" | "ACTIVE",
  rssFeedUrl?: string | null,
) {
  if (status === "ACTIVE" && !rssFeedUrl) {
    return "NO_RSS_FOUND" as const;
  }

  return status;
}

// 1. FALLBACK HEURISTIC: Used only if the frontend payload loses the language
const guessLanguageFromUrl = (urlString: string): string => {
  try {
    const url = new URL(urlString);
    const hostParts = url.hostname.split(".");
    const pathParts = url.pathname.split("/").filter(Boolean);

    const subdomain = hostParts[0];
    if (hostParts.length > 2 && subdomain && ISO_LANG_CODES.has(subdomain))
      return subdomain;

    const tld = hostParts[hostParts.length - 1];
    if (tld && ISO_LANG_CODES.has(tld)) return tld;

    const firstPath = pathParts[0];
    if (pathParts.length > 0 && firstPath && ISO_LANG_CODES.has(firstPath))
      return firstPath;

    return "en"; // Biztonságos alapértelmezett fallback
  } catch {
    return "en";
  }
};


function normalizeUrl(raw: string) {
  const incomingUrlObj = new URL(raw);
  if (!/^https?:$/.test(incomingUrlObj.protocol))
    throw new Error("Unsupported URL protocol");

  const cleanIncomingHostname = incomingUrlObj.hostname
    .replace(/^www\./, "")
    .toLowerCase();
  const incomingPath = incomingUrlObj.pathname
    .replace(/(^\/|\/$)/g, "")
    .toLowerCase();
  const pureRootUrl = `${incomingUrlObj.protocol}//${incomingUrlObj.hostname}`;
  return { incomingUrlObj, cleanIncomingHostname, incomingPath, pureRootUrl };
}

async function findParentRoot(cleanIncomingHostname: string) {
  const potentialRoots = await prisma.newsSource.findMany({
    where: {
      frontPageUrl: { contains: cleanIncomingHostname, mode: "insensitive" },
    },
  });

  return potentialRoots.find((dbSource) => {
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
}

export default defineEventHandler(async (event) => {
  const currentUserId = requireUserId(event);
  const rawBody = await readBody<OnboardingBody>(event);
  const { region, sources: rawSources, interests } = rawBody;

  // Accept arrays regardless of content type, truncate to max limit
  const submittedSources: any[] = Array.isArray(rawSources)
    ? rawSources.slice(0, MAX_SUBMITTED_SOURCES)
    : [];

  try {
    // Fetch current user tier for quota calculation (read-only)
    const currentUser = await prisma.user.findUnique({
      where: { id: currentUserId },
      select: { id: true, tier: true },
    });

    if (!currentUser) {
      throw createError({ statusCode: 404, statusMessage: "User not found." });
    }

    const maxActiveLimit = currentUser.tier === "PRO" ? 15 : 5;
    let currentlyActiveCount = 0;
    const targetedSourceIds = new Set<string>();

    for (const rawSourceItem of submittedSources) {
      try {
        // Decode payload: Works if it is "telex.hu" OR { url: "telex.hu", language: "hu" }
        const rawUrl =
          typeof rawSourceItem === "string"
            ? rawSourceItem
            : rawSourceItem?.url;
        const explicitLanguage =
          typeof rawSourceItem === "string" ? null : rawSourceItem?.language;

        if (!rawUrl) continue;

        const {
          incomingUrlObj,
          cleanIncomingHostname,
          incomingPath,
          pureRootUrl,
        } = normalizeUrl(rawUrl);

        // SSRF guard: reject private/internal/IP-literal hostnames before DB persist
        validateHostname(cleanIncomingHostname);
        const parentRoot = await findParentRoot(cleanIncomingHostname);

        // Final Language assignment: Explicit truth from frontend overrides the URL heuristic guess
        const finalSourceLanguage =
          explicitLanguage || guessLanguageFromUrl(pureRootUrl);

        let exactCategory: any = null;

        if (incomingPath !== "") {
          const potentialCats = await prisma.sourceCategory.findMany({
            where: {
              pathUrl: { contains: cleanIncomingHostname, mode: "insensitive" },
            },
          });
          exactCategory = potentialCats.find((dbCat) => {
            try {
              const dbUrlObj = new URL(dbCat.pathUrl);
              return (
                dbUrlObj.hostname.replace(/^www\./, "").toLowerCase() ===
                  cleanIncomingHostname &&
                dbUrlObj.pathname.replace(/(^\/|\/$)/g, "").toLowerCase() ===
                  incomingPath
              );
            } catch {
              return false;
            }
          });
        }

        const shouldBeActive = currentlyActiveCount < maxActiveLimit;

        if (incomingPath === "") {
          // --- ROOT DOMAIN ---
          let rootId = null;
          if (parentRoot) {
            rootId = parentRoot.id;
            if (shouldBeActive) targetedSourceIds.add(rootId);
          } else {
            // SAFE UPSERT WITH FINAL LANGUAGE
            const newRoot = await prisma.newsSource.upsert({
              where: { frontPageUrl: pureRootUrl },
              create: {
                frontPageUrl: pureRootUrl,
                mediaName: cleanIncomingHostname,
                rssStatus: normalizeRssStatus("PENDING_DISCOVERY", null),
                isSystemImported: false,
                language: finalSourceLanguage,
              },
              update: {},
            });
            rootId = newRoot.id;
            if (shouldBeActive) targetedSourceIds.add(rootId);
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
          // --- KATEGÓRIA ---
          if (exactCategory) {
            if (shouldBeActive) targetedSourceIds.add(exactCategory.newsSourceId);
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
            let rootIdForCategory = null;
            if (parentRoot) {
              rootIdForCategory = parentRoot.id;
              if (shouldBeActive) targetedSourceIds.add(rootIdForCategory);
            } else {
              // SAFE UPSERT FOR PARENT ROOT
              const newRoot = await prisma.newsSource.upsert({
                where: { frontPageUrl: pureRootUrl },
                create: {
                  frontPageUrl: pureRootUrl,
                  mediaName: cleanIncomingHostname,
                  rssStatus: normalizeRssStatus("PENDING_DISCOVERY", null),
                  isSystemImported: false,
                  language: finalSourceLanguage,
                },
                update: {},
              });
              rootIdForCategory = newRoot.id;
              if (shouldBeActive) targetedSourceIds.add(rootIdForCategory);
            }

            const newCat = await prisma.sourceCategory.create({
              data: {
                newsSourceId: rootIdForCategory,
                name: incomingUrlObj.pathname
                  .substring(1)
                  .replace(/\//g, " - "),
                pathUrl: rawUrl,
                isUserRequested: true,
                rssStatus: normalizeRssStatus("PENDING_DISCOVERY", null),
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
          }
        }

        if (shouldBeActive) currentlyActiveCount++;
      } catch (error) {
        // Let SSRF guard violations propagate to abort the entire request
        if (error instanceof SSRFError) throw error;
        console.error(`[Insertion Error] Failed to process URL:`, error);
      }
    }

    if (targetedSourceIds.size > 0) {
      const sourceIds = [...targetedSourceIds];
      event.waitUntil(
        executeTargetedDiscovery(sourceIds).catch((err) =>
          console.error(
            "[Orchestrator] Background discovery loop crashed:",
            err,
          ),
        ),
      );
      event.waitUntil(
        runNewsPipeline(sourceIds).catch((err) =>
          console.error("[Orchestrator] Background ingest pipeline crashed:", err),
        ),
      );
    }

    // Persist user profile changes AFTER all sources validated & processed
    const updatedUser = await prisma.user.update({
      where: { id: currentUserId },
      data: {
        primaryRegion: region ?? null,
        topInterests: interests ?? undefined,
        onboardingStep: 3,
      },
      select: { id: true, tier: true },
    });

    return { success: true, user: updatedUser };
  } catch (error) {
    // SSRF guard rejection → 400 (don't persist anything)
    if (error instanceof SSRFError) {
      console.warn(`[Onboarding] SSRF blocked: ${error.detail}`);
      throw createError({
        statusCode: 400,
        statusMessage: "Blocked",
        message: "One or more source URLs failed security validation.",
      });
    }

    throw createError({
      statusCode: 500,
      statusMessage: "Failed to finalize onboarding process.",
    });
  }
});
