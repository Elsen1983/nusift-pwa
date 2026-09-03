import assert from "node:assert/strict";
import test from "node:test";
import { dueScheduledJobs, scheduledJobKey, triggerDueScheduledJobs } from "./run-scheduler.mjs";

test("only triggers the two production-equivalent UTC schedules", () => {
  assert.deepEqual(dueScheduledJobs(new Date("2026-09-03T03:00:00.000Z")).map((job) => job.name), ["daily-pipeline"]);
  assert.deepEqual(dueScheduledJobs(new Date("2026-09-03T05:30:00.000Z")).map((job) => job.name), ["cleanup-maintenance"]);
  assert.deepEqual(dueScheduledJobs(new Date("2026-09-03T03:01:00.000Z")), []);
});

test("records only accepted triggers so a transient failure is retried within its minute", async () => {
  const now = new Date("2026-09-03T03:00:00.000Z");
  const completedKeys = new Set();
  let attempts = 0;
  const fetchImpl = async () => ({ ok: ++attempts === 2, status: 503 });
  const input = {
    now,
    completedKeys,
    fetchImpl,
    internalBaseUrl: new URL("http://app:3000"),
    cronSecret: "test-secret",
  };

  assert.deepEqual(await triggerDueScheduledJobs(input), [{ job: "daily-pipeline", ok: false, reason: "HTTP 503" }]);
  assert.deepEqual(await triggerDueScheduledJobs(input), [{ job: "daily-pipeline", ok: true }]);
  assert.equal(completedKeys.has(scheduledJobKey(dueScheduledJobs(now)[0], now)), true);
});
