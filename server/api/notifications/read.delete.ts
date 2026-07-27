import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);

  const result = await prisma.notification.deleteMany({
    where: { userId, readAt: { not: null } },
  });

  const unreadCount = await prisma.notification.count({ where: { userId, readAt: null } });

  return { ok: true, deleted: result.count, unreadCount };
});
