import { createError, getHeader } from "h3";
import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import {
  runDailyNewsPipelineWorkflow,
} from "../../workflows/daily-news-pipeline";

export default defineEventHandler(async (event) => {
  const expectedSecret = process.env.CRON_SECRET || process.env.NUXT_CRON_SECRET;
  if (!expectedSecret) {
    throw createError({ statusCode: 500, statusMessage: "Cron endpoint not configured." });
  }

  const authorization = getHeader(event, "authorization");
  const secretHeader = getHeader(event, "x-cron-secret");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const providedSecret = secretHeader || bearerToken;
  if (!providedSecret || providedSecret !== expectedSecret) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }

  const input = {
    orchestrationId: randomUUID(),
    triggeredAt: new Date().toISOString(),
  };
  const run = await start(runDailyNewsPipelineWorkflow, [input]);

  return {
    ok: true,
    workflowRunId: run.runId,
    orchestrationId: input.orchestrationId,
    triggeredAt: input.triggeredAt,
  };
});
