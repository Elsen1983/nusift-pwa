import { createError, readBody } from "h3";
import { prisma } from "../../../../utils/prisma";
import { requireUserId } from "../../../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  const id = event.context.params?.id;
  const body = await readBody(event);
  const notificationId = typeof body?.notificationId === "string" ? body.notificationId : "";

  if (!id) throw createError({ statusCode: 400, statusMessage: "Connection id is required." });

  const connection = await prisma.usersConnection.findFirst({
    where: { id, addresseeId: userId },
    include: { requester: { select: { email: true, profile: { select: { nickname: true } } } } },
  });

  if (!connection) {
    throw createError({ statusCode: 404, statusMessage: "Friend request not found." });
  }

  if (connection.status !== "PENDING") {
    throw createError({ statusCode: 409, statusMessage: "Friend request is no longer pending." });
  }

  await prisma.$transaction([
    prisma.usersConnection.update({
      where: { id },
      data: { status: "ACCEPTED" },
    }),
    prisma.notification.create({
      data: {
        userId: connection.requesterId,
        type: "FRIEND_REQUEST_ACCEPTED",
        title: "Friend request accepted",
        body:
          (connection.requester.profile?.nickname
            ? `@${connection.requester.profile.nickname}`
            : connection.requester.email) + " accepted your friend request.",
        url: "/notifications",
        payload: { connectionId: connection.id, responderId: userId },
        status: "SENT",
        sentAt: new Date(),
      },
    }),
    ...(notificationId
      ? [
          prisma.notification.deleteMany({
            where: { id: notificationId, userId, type: "FRIEND_REQUEST" },
          }),
        ]
      : []),
  ]);

  return { ok: true };
});
