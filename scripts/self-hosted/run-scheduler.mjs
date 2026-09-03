import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const SCHEDULED_JOBS = Object.freeze([
  { name: "daily-pipeline", hour: 3, minute: 0, path: "/api/internal/run-daily-pipeline" },
  { name: "cleanup-maintenance", hour: 5, minute: 30, path: "/api/internal/cleanup-maintenance" },
]);

export function scheduledJobKey(job, now) {
  return `${job.name}:${now.toISOString().slice(0, 16)}`;
}

export function dueScheduledJobs(now) {
  return SCHEDULED_JOBS.filter((job) =>
    now.getUTCMinutes() === job.minute && now.getUTCHours() === job.hour,
  );
}

export async function triggerDueScheduledJobs({ now, completedKeys, fetchImpl, internalBaseUrl, cronSecret }) {
  const due = dueScheduledJobs(now);
  const results = [];

  for (const job of due) {
    const key = scheduledJobKey(job, now);
    if (completedKeys.has(key)) continue;

    try {
      const response = await fetchImpl(new URL(job.path, internalBaseUrl), {
        headers: { "x-cron-secret": cronSecret },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      completedKeys.add(key);
      results.push({ job: job.name, ok: true });
    } catch (error) {
      results.push({ job: job.name, ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return results;
}

function requireSchedulerConfig() {
  const rawBaseUrl = (process.env.NUXT_INTERNAL_BASE_URL || "").trim();
  const cronSecret = (process.env.CRON_SECRET || process.env.NUXT_CRON_SECRET || "").trim();
  if (!rawBaseUrl || !cronSecret) throw new Error("NUXT_INTERNAL_BASE_URL and CRON_SECRET are required.");

  const internalBaseUrl = new URL(rawBaseUrl);
  if (!/^https?:$/.test(internalBaseUrl.protocol)) throw new Error("NUXT_INTERNAL_BASE_URL must use HTTP or HTTPS.");
  return { internalBaseUrl, cronSecret };
}

async function main() {
  const { internalBaseUrl, cronSecret } = requireSchedulerConfig();
  const completedKeys = new Set();
  let ticking = false;

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const results = await triggerDueScheduledJobs({
        now: new Date(),
        completedKeys,
        fetchImpl: fetch,
        internalBaseUrl,
        cronSecret,
      });
      for (const result of results) {
        const level = result.ok ? "info" : "error";
        console[level](`[scheduler] ${result.job}: ${result.ok ? "triggered" : result.reason}`);
      }
    } finally {
      ticking = false;
    }
  };

  console.info("[scheduler] active; UTC schedules: daily pipeline 03:00, maintenance 05:30.");
  await tick();
  const interval = setInterval(() => void tick(), 15_000);
  const shutdown = () => {
    clearInterval(interval);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
