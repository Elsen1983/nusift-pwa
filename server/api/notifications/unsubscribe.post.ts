import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";
import { createError, readBody } from "h3";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const body = await readBody(event);

  if (!body?.endpoint) {
    throw createError({ statusCode: 400, statusMessage: "endpoint is required." });
  }

  await prisma.pushSubscription.updateMany({
    where: { userId, endpoint: body.endpoint },
    data: { isActive: false, lastSeenAt: new Date() },
  });

  return { ok: true };
});
