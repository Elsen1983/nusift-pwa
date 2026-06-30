import { createError } from "h3";
import { prisma } from "../../../../utils/prisma";
import { requireUserId } from "../../../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const id = event.context.params?.id;

  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "Connection id is required." });
  }

  const connection = await prisma.usersConnection.findFirst({
    where: {
      id,
      status: "ACCEPTED",
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
    select: { id: true },
  });

  if (!connection) {
    throw createError({ statusCode: 404, statusMessage: "Friend connection not found." });
  }

  await prisma.usersConnection.delete({
    where: { id },
  });

  return { ok: true };
});
