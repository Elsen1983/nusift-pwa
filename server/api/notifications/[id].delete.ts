import { createError } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const id = event.context.params?.id;

  if (!id) throw createError({ statusCode: 400, statusMessage: "Notification id is required." });

  const match = await prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
  if (!match) throw createError({ statusCode: 404, statusMessage: "Notification not found." });

  await prisma.notification.delete({ where: { id } });
  return { ok: true };
});
