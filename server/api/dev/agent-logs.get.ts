import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "agent-logs", 10, 60 * 1000);

  const logs = await prisma.agentScanLog.findMany({
    select: {
      id: true,
      status: true,
      sourceId: true,
      errorLog: true,
      createdAt: true,
      executionTimeMs: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return { ok: true, logs };
});
