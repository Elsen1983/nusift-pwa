import { createError } from "h3";
import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  requireUserId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  await assertRateLimit(event, "fix-rss-status", 3, 10 * 60 * 1000);

  const result = await prisma.newsSource.updateMany({
    where: {
      rssStatus: "ACTIVE",
      OR: [
        { rssFeedUrl: null },
        { rssFeedUrl: "" },
      ],
    },
    data: {
      rssStatus: "NO_RSS_FOUND",
    },
  });

  return {
    ok: true,
    fixedCount: result.count,
  };
});
