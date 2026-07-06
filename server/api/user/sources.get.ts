import { createError } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        tier: true,
        sourceSubscriptions: {
          include: {
            newsSource: {
              select: {
                frontPageUrl: true,
                mediaName: true,
                rssStatus: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        categorySubscriptions: {
          include: {
            category: {
              select: {
                pathUrl: true,
                name: true,
                rssStatus: true,
                newsSource: {
                  select: {
                    mediaName: true,
                    rssStatus: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!user) {
      throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    const quotaLimit = user.tier === "PRO" ? 15 : 5;

    const formattedSources = [
      ...user.sourceSubscriptions.map((sub) => ({
        id: sub.id,
        type: "ROOT",
        url: sub.newsSource.frontPageUrl,
        name: sub.customAlias || sub.newsSource.mediaName,
        isActive: sub.isActive,
        validationStatus: sub.newsSource.rssStatus,
        createdAt: sub.createdAt,
      })),
      ...user.categorySubscriptions.map((sub) => {
        let finalValidationStatus = sub.category.rssStatus;
        const parentStatus = sub.category.newsSource.rssStatus;

        if (finalValidationStatus !== "ACTIVE") {
          if (parentStatus === "ACTIVE" || parentStatus === "NO_RSS_FOUND") {
            finalValidationStatus = "NO_RSS_FOUND";
          } else if (parentStatus === "FAILED" || parentStatus === "DOMAIN_DEAD") {
            finalValidationStatus = parentStatus;
          }
        }

        return {
          id: sub.id,
          type: "CATEGORY",
          url: sub.category.pathUrl,
          name: sub.customAlias || `${sub.category.newsSource.mediaName} - ${sub.category.name}`,
          isActive: sub.isActive,
          validationStatus: finalValidationStatus,
          createdAt: sub.createdAt,
        };
      }),
    ];

    const activeCount = formattedSources.filter(
      (source) =>
        source.isActive &&
        source.validationStatus !== "FAILED" &&
        source.validationStatus !== "DOMAIN_DEAD",
    ).length;

    return {
      success: true,
      quota: {
        tier: user.tier,
        limit: quotaLimit,
        activeCount,
        availableSlots: Math.max(0, quotaLimit - activeCount),
      },
      sources: formattedSources,
    };
  } catch (error) {
    console.error("Fetch sources error:", error);
    throw createError({ statusCode: 500, statusMessage: "Failed to fetch sources." });
  }
});
