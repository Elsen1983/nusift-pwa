import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);

  const acceptedConnections = await prisma.usersConnection.findMany({
    where: {
      status: "ACCEPTED",
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
    include: {
      requester: { select: { id: true, email: true, profile: { select: { nickname: true, avatarUrl: true } } } },
      addressee: { select: { id: true, email: true, profile: { select: { nickname: true, avatarUrl: true } } } },
    },
    orderBy: { updatedAt: "desc" },
  });

  const pendingConnections = await prisma.usersConnection.findMany({
    where: {
      status: "PENDING",
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
    include: {
      requester: { select: { id: true, email: true, profile: { select: { nickname: true, avatarUrl: true } } } },
      addressee: { select: { id: true, email: true, profile: { select: { nickname: true, avatarUrl: true } } } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return {
    friends: acceptedConnections.map((connection) => {
      const friend = connection.requesterId === userId ? connection.addressee : connection.requester;
      return {
        connectionId: connection.id,
        id: friend.id,
        email: friend.email,
        nickname: friend.profile?.nickname || null,
        avatarUrl: friend.profile?.avatarUrl || null,
      };
    }),
    pending: pendingConnections.map((connection) => {
      const otherUser = connection.requesterId === userId ? connection.addressee : connection.requester;
      return {
        connectionId: connection.id,
        id: otherUser.id,
        email: otherUser.email,
        nickname: otherUser.profile?.nickname || null,
        avatarUrl: otherUser.profile?.avatarUrl || null,
        direction: connection.requesterId === userId ? "SENT" : "RECEIVED",
      };
    }),
  };
});
