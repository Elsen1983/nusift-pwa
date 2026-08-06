import { readBody } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

const STALE_BROWSER_SUBSCRIPTION_MS = 90 * 24 * 60 * 60 * 1000;

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  const body = await readBody<{ currentEndpoint?: unknown }>(event);
  const currentEndpoint = typeof body?.currentEndpoint === "string" && body.currentEndpoint.length <= 4096
    ? body.currentEndpoint
    : null;

  if (currentEndpoint) {
    await prisma.pushSubscription.updateMany({
      where: { userId, endpoint: currentEndpoint, isActive: true },
      data: { lastSeenAt: new Date() },
    });
  } else {
    // When this browser reports no subscription, conservatively retire only
    // records that are provably expired or have not checked in for 90 days.
    // Other recent devices remain independent and active.
    await prisma.pushSubscription.updateMany({
      where: {
        userId,
        isActive: true,
        OR: [
          { expirationTime: { lt: BigInt(Date.now()) } },
          { lastSeenAt: { lt: new Date(Date.now() - STALE_BROWSER_SUBSCRIPTION_MS) } },
        ],
      },
      data: { isActive: false, lastSeenAt: new Date() },
    });
  }

  const [activeCount, currentEndpointRecord] = await Promise.all([
    prisma.pushSubscription.count({ where: { userId, isActive: true } }),
    currentEndpoint
      ? prisma.pushSubscription.findFirst({
          where: { userId, endpoint: currentEndpoint },
          select: { isActive: true },
        })
      : Promise.resolve(null),
  ]);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationScheduleSlot: true, allowBreakingNotifications: true },
  });

  return {
    enabled: activeCount > 0,
    activeCount,
    currentEndpointActive: currentEndpointRecord?.isActive === true,
    scheduleSlot: user?.notificationScheduleSlot || "MORNING",
    allowBreakingNotifications: user?.allowBreakingNotifications ?? true,
  };
});
