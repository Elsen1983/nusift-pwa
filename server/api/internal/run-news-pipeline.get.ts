import { createError, getHeader } from "h3";
import { runNewsPipeline } from "../../utils/news-pipeline/orchestrator";

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

  const result = await runNewsPipeline();

  return {
    ok: true,
    scheduled: true,
    agents: ["A1", "A2"],
    result,
  };
});
