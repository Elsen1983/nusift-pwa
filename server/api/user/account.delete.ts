import { createError } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);

  try {
    const existingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!existingUser) {
      throw createError({ statusCode: 404, statusMessage: "User not found." });
    }

    await prisma.$transaction([
      prisma.notification.deleteMany({
        where: { userId },
      }),
      prisma.pushSubscription.deleteMany({
        where: { userId },
      }),
      prisma.userReadActivity.deleteMany({
        where: { userId },
      }),
      prisma.bookmark.deleteMany({
        where: { userId },
      }),
      prisma.articleRating.deleteMany({
        where: { userId },
      }),
      prisma.usersConnection.deleteMany({
        where: {
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
      }),
      prisma.userSourceSubscription.deleteMany({
        where: { userId },
      }),
      prisma.userCategorySubscription.deleteMany({
        where: { userId },
      }),
      prisma.userProfile.deleteMany({
        where: { userId },
      }),
      prisma.user.delete({
        where: { id: userId },
      }),
    ]);

    const deletedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (deletedUser) {
      throw createError({
        statusCode: 500,
        statusMessage: "Account deletion verification failed.",
      });
    }

    deleteCookie(event, "auth_token", {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });

    deleteCookie(event, "session_status", {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });

    return {
      success: true,
      message: "Account deleted permanently.",
    };
  } catch (error: any) {
    console.error("Failed to delete account:", error);
    throw createError({
      statusCode: error?.statusCode || 500,
      statusMessage: error?.statusMessage || error?.message || "Failed to delete account.",
    });
  }
});
