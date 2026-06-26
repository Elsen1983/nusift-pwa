import { createError, getQuery } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  requireUserId(event);

  const { q } = getQuery(event);
  const query = typeof q === "string" ? q.trim() : "";

  if (query.length < 2) {
    throw createError({ statusCode: 400, statusMessage: "Search query is required." });
  }

  const isEmail = query.includes("@");

  const users = await prisma.user.findMany({
    where: isEmail
      ? { email: { contains: query, mode: "insensitive" } }
      : {
          profile: {
            nickname: { contains: query, mode: "insensitive" },
          },
        },
    take: 10,
    select: {
      id: true,
      email: true,
      profile: {
        select: {
          nickname: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
    },
  });

  return {
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      nickname: user.profile?.nickname || null,
      firstName: user.profile?.firstName || null,
      lastName: user.profile?.lastName || null,
      avatarUrl: user.profile?.avatarUrl || null,
    })),
  };
});
