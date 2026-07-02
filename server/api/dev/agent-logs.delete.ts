import { createError } from "h3";
import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  requireUserId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "agent-logs-delete", 3, 10 * 60 * 1000);

  const [articleResult, logResult] = await prisma.$transaction([
    prisma.article.deleteMany({}),
    prisma.agentScanLog.deleteMany({}),
  ]);

  return { ok: true, deletedCount: logResult.count, articleCount: articleResult.count };
});
