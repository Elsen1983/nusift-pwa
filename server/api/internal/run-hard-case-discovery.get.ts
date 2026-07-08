import { createError, getHeader, getQuery } from "h3";
import { processHardCaseDiscoveryQueue } from "../../utils/news-pipeline/hard-case-consumer";

export default defineEventHandler(async (event) => {
  const expectedSecret = process.env.CRON_SECRET || process.env.NUXT_CRON_SECRET;
  if (!expectedSecret) {
    throw createError({ statusCode: 500, statusMessage: "Cron endpoint not configured." });
  }

  const authHeader = getHeader(event, "authorization");
  const secretHeader = getHeader(event, "x-cron-secret");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const providedSecret = secretHeader || bearerToken;

  if (!providedSecret || providedSecret !== expectedSecret) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }

  const query = getQuery(event);
  const limit = Math.max(1, Math.min(50, Number(query.limit) || 10));
  const result = await processHardCaseDiscoveryQueue(limit);

  return {
    ok: true,
    scheduled: true,
    result,
  };
});
