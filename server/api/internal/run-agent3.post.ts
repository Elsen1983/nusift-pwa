import { createError, getHeader } from "h3";
import { secretsMatch } from "../../utils/secure-secret";
import { getAgent3Progress } from "../../utils/news-pipeline/enrichment-runtime";
import { computeAgent3CompletionSummaryForRun } from "../../utils/news-pipeline/agent3-completion";
import { runAgent3WorkflowBatch } from "../../utils/news-pipeline/agent3-workflow-batch";

const authenticate = (event: Parameters<typeof getHeader>[0]) => {
  const expected = process.env.CRON_SECRET || process.env.NUXT_CRON_SECRET;
  const authorization = getHeader(event, "authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const provided = getHeader(event, "x-cron-secret") || bearer;
  if (!secretsMatch(provided, expected)) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }
};

const boundedInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.trunc(parsed)))
    : fallback;
};

export default defineEventHandler(async (event) => {
  authenticate(event);
  const body = await readBody(event).catch(() => ({}));
  const orchestrationRunId = typeof body?.orchestrationRunId === "string"
    ? body.orchestrationRunId.trim().slice(0, 100)
    : "";
  if (!orchestrationRunId) {
    throw createError({ statusCode: 400, statusMessage: "Missing orchestrationRunId." });
  }

  if (body?.action === "completion") {
    const { summary } = await computeAgent3CompletionSummaryForRun(getAgent3Progress, {
      currentRunOptions: { includeEnriched: false, forceReprocess: false, pipelineRunId: orchestrationRunId },
      futureRunOptions: { includeEnriched: false, forceReprocess: false },
    });
    return { action: "completion" as const, summary };
  }

  return runAgent3WorkflowBatch({
    orchestrationRunId,
    batchSeq: boundedInteger(body?.batchSeq, 1, 1, 10_000),
    remainingBefore: body?.remainingBefore == null
      ? null
      : boundedInteger(body.remainingBefore, 0, 0, 1_000_000),
    sleepMs: boundedInteger(body?.sleepMs, 0, 0, 86_400_000),
  });
});
