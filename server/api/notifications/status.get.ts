import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);

  const [subscriptionCount, activeCount, user] = await Promise.all([
    prisma.pushSubscription.count({ where: { userId } }),
    prisma.pushSubscription.count({ where: { userId, isActive: true } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { notificationScheduleSlot: true, allowBreakingNotifications: true },
    }),
  ]);

  return {
    enabled: activeCount > 0,
    subscriptionCount,
    activeCount,
    scheduleSlot: user?.notificationScheduleSlot || "MORNING",
    allowBreakingNotifications: user?.allowBreakingNotifications ?? true,
  };
});
