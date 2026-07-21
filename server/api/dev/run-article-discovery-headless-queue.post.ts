import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { processArticleDiscoveryHeadlessQueue } from "../../utils/news-pipeline/article-discovery-headless-queue";
import { isBrowserFallbackEnabled } from "../../utils/news-pipeline/article-discovery-browser";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production" && process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN !== "true") {
    throw createError({ statusCode: 403, statusMessage: "Manual trigger disabled." });
  }

  const body = await readBody(event).catch(() => ({}));
  const limit = typeof body?.limit === "number" ? body.limit : undefined;
  const dryRun = body?.dryRun !== false; // default to dry-run for safety
  const runBrowser = body?.runBrowser === true;

  if (dryRun) {
    await assertRateLimit(event, "headless-queue-inspect", 20, 60 * 1000);
  } else if (runBrowser) {
    await assertRateLimit(event, "headless-queue-browser", 5, 10 * 60 * 1000);
  } else {
    await assertRateLimit(event, "headless-queue-process", 3, 10 * 60 * 1000);
  }

  // runBrowser must not override the env flag — if requested but disabled,
  // pass it through so the queue returns a clear disabled result.
  const result = await processArticleDiscoveryHeadlessQueue({ limit, dryRun, runBrowser });

  return {
    ok: true,
    result,
    browserFallbackEnabled: isBrowserFallbackEnabled(),
  };
});
