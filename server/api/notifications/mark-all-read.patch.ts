import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);

  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });

  const unreadCount = await prisma.notification.count({ where: { userId, readAt: null } });

  return { ok: true, updated: result.count, unreadCount };
});
