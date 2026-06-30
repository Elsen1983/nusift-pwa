import { createError, getQuery } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  const { q } = getQuery(event);
  const query = typeof q === "string" ? q.trim() : "";

  if (query.length < 2) {
    throw createError({ statusCode: 400, statusMessage: "Search query is required." });
  }

  const isEmail = query.includes("@");

  const userId = await requireUserId(event);

  const users = await prisma.user.findMany({
    where: {
      NOT: { id: userId },
      ...(isEmail
        ? { email: { contains: query, mode: "insensitive" } }
        : {
            profile: {
              nickname: { contains: query, mode: "insensitive" },
            },
          }),
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

  // Fetch existing connections (in either direction) for the matched users
  const userIds = users.map((u) => u.id);
  const connections = await prisma.usersConnection.findMany({
    where: {
      OR: [
        { requesterId: userId, addresseeId: { in: userIds } },
        { requesterId: { in: userIds }, addresseeId: userId },
      ],
    },
    select: {
      requesterId: true,
      addresseeId: true,
      status: true,
    },
  });

  // Build a map from other-user-id → connection status
  const statusMap = new Map<string, string>();
  for (const conn of connections) {
    const otherId = conn.requesterId === userId ? conn.addresseeId : conn.requesterId;
    // Prefer non-DECLINED statuses so that ACCEPTED/BLOCKED/PENDING are not
    // overwritten by an older DECLINED record.
    if (!statusMap.has(otherId) || conn.status !== "DECLINED") {
      statusMap.set(otherId, conn.status);
    }
  }

  return {
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      nickname: user.profile?.nickname || null,
      firstName: user.profile?.firstName || null,
      lastName: user.profile?.lastName || null,
      avatarUrl: user.profile?.avatarUrl || null,
      connectionStatus: statusMap.get(user.id) || null,
    })),
  };
});
