import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Dev endpoints disabled in production." });
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
