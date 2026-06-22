import { createError, readBody } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  const body = await readBody(event);

  if (!["MORNING", "NOON", "EVENING"].includes(body?.scheduleSlot)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid schedule slot." });
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      notificationScheduleSlot: body.scheduleSlot,
      allowBreakingNotifications: Boolean(body.allowBreakingNotifications),
    },
  });

  return { ok: true };
});
