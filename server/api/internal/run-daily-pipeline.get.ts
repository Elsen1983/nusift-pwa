import { createError, getHeader } from "h3";
import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import {
  runDailyNewsPipelineWorkflow,
} from "../../workflows/daily-news-pipeline";

type NotificationTriggerResult = {
  started: boolean;
  workflowRunId: string | null;
  markerRunId: string | null;
  dateKey: string;
  reason: string;
};

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

  const triggeredAt = new Date();
  const input = {
    orchestrationId: randomUUID(),
    triggeredAt: triggeredAt.toISOString(),
  };
  const run = await start(runDailyNewsPipelineWorkflow, [input]);

  // Digest delivery runs in its own durable workflow, started once per UTC
  // calendar day without waiting for it. It holds no pipeline lock and its
  // durable sleeps never delay the main pipeline's lock release. Duplicate
  // daily executions are idempotent (one marker per dateKey).
  let notification: NotificationTriggerResult = {
    started: false,
    workflowRunId: null,
    markerRunId: null,
    dateKey: "",
    reason: "skipped",
  };
  try {
    const { ensureDailyNotificationsWorkflow } =
      await import("../../utils/news-pipeline/notification-workflow-schedule");
    notification = await ensureDailyNotificationsWorkflow(triggeredAt);
  } catch (error: any) {
    notification = {
      started: false,
      workflowRunId: null,
      markerRunId: null,
      dateKey: "",
      reason: "start_error",
    };
  }

  return {
    ok: true,
    workflowRunId: run.runId,
    orchestrationId: input.orchestrationId,
    triggeredAt: input.triggeredAt,
    notificationWorkflow: notification,
  };
});
