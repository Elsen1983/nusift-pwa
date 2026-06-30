import { createError, readBody } from "h3";
import { prisma } from "../../../../utils/prisma";
import { requireUserId } from "../../../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const id = event.context.params?.id;
  const body = await readBody(event);
  const notificationId = typeof body?.notificationId === "string" ? body.notificationId : "";

  if (!id) throw createError({ statusCode: 400, statusMessage: "Connection id is required." });

  const connection = await prisma.usersConnection.findFirst({
    where: { id, addresseeId: userId },
    select: { id: true, status: true },
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
      data: { status: "DECLINED" },
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
