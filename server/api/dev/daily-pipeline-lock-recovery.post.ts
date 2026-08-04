import { createError, readBody } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";

const LOCK_STATUS = "DAILY_PIPELINE_WORKFLOW_RUNNING";
const STALE_STATUS = "DAILY_PIPELINE_WORKFLOW_STALE";
const CONFIRMATION = "RELEASE_STALE_DAILY_PIPELINE_LOCK";
const MIN_HEARTBEAT_AGE_MS = 45 * 60 * 1000;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export default defineEventHandler(async (event) => {
  const adminId = await requireAdminId(event);
  await assertRateLimit(event, "daily-pipeline-lock-recovery", 3, 10 * 60 * 1000);

  const body = await readBody(event).catch(() => null);
  const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
  if (!runId || runId.length > 100 || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid pipeline run ID." });
  }
  if (body?.confirmation !== CONFIRMATION) {
    throw createError({ statusCode: 400, statusMessage: "Exact stale-lock confirmation is required." });
  }

  const run = await prisma.pipelineRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true, updatedAt: true, summary: true },
  });
  if (!run || run.status !== LOCK_STATUS) {
    return { ok: true, changed: false, reason: "not_running" as const };
  }

  const heartbeatAgeMs = Math.max(0, Date.now() - run.updatedAt.getTime());
  if (heartbeatAgeMs < MIN_HEARTBEAT_AGE_MS) {
    throw createError({ statusCode: 409, statusMessage: "Pipeline heartbeat is too recent for recovery." });
  }

  const now = new Date();
  const summary = asRecord(run.summary);
  const changed = await prisma.pipelineRun.updateMany({
    // updatedAt is part of the CAS: a concurrent workflow heartbeat makes this
    // update lose rather than releasing a live lock.
    where: { id: run.id, status: LOCK_STATUS, updatedAt: run.updatedAt },
    data: {
      status: STALE_STATUS,
      finishedAt: now,
      summary: {
        ...summary,
        lockRecovery: {
          recoveredAt: now.toISOString(),
          recoveredByAdminId: adminId,
          previousHeartbeatAt: run.updatedAt.toISOString(),
          heartbeatAgeMs,
          confirmation: CONFIRMATION,
        },
      },
    },
  });

  return {
    ok: true,
    changed: changed.count === 1,
    reason: changed.count === 1 ? "released" as const : "concurrent_heartbeat" as const,
    runId: run.id,
    heartbeatAgeMs,
  };
});
