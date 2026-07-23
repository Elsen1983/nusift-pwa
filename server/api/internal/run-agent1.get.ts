import { createError, getHeader } from "h3";
import { runNewsPipeline } from "../../utils/news-pipeline/orchestrator";
import { resolveAgent2Targets } from "../../utils/news-pipeline/article-discovery";

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

  // Agent 1 only — does NOT trigger Agent 2
  const startedAt = Date.now();
  const result = await runNewsPipeline();
  const durationMs = Date.now() - startedAt;

  // Compute Agent 2 eligible count after A1 run.
  let agent2EligibleAfterRun: number | null = null;
  let agent2EligibleAfterRunError: string | null = null;
  try {
    const { targets: a2Targets } = await resolveAgent2Targets();
    agent2EligibleAfterRun = a2Targets.length;
  } catch (err: any) {
    agent2EligibleAfterRunError = String(err?.message || err).slice(0, 200);
  }

  return {
    ok: true,
    agent: "A1",
    durationMs,
    result,
    agent2EligibleAfterRun,
    agent2EligibleAfterRunError,
  };
});
