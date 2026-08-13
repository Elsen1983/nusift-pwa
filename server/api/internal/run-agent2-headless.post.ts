import { createError, getHeader } from "h3";
import { secretsMatch } from "../../utils/secure-secret";
import { runAgent2HeadlessWorkflowBatch } from "../../utils/news-pipeline/agent2-headless-workflow-batch";

const asBoundedInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.trunc(parsed)))
    : fallback;
};

export default defineEventHandler(async (event) => {
  const expectedSecret = process.env.CRON_SECRET || process.env.NUXT_CRON_SECRET;
  const authorization = getHeader(event, "authorization");
  const secretHeader = getHeader(event, "x-cron-secret");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!secretsMatch(secretHeader || bearerToken, expectedSecret)) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }
  const body = await readBody(event).catch(() => ({}));
  const orchestrationRunId = typeof body?.orchestrationRunId === "string"
    ? body.orchestrationRunId.trim().slice(0, 100)
    : "";
  if (!orchestrationRunId) {
    throw createError({ statusCode: 400, statusMessage: "Missing orchestrationRunId." });
  }
  return runAgent2HeadlessWorkflowBatch({
    orchestrationRunId,
    batchSeq: asBoundedInteger(body?.batchSeq, 1, 1, 10_000),
    remainingBefore: body?.remainingBefore == null
      ? null
      : asBoundedInteger(body.remainingBefore, 0, 0, 1_000_000),
    sleepMs: asBoundedInteger(body?.sleepMs, 0, 0, 86_400_000),
  });
});
