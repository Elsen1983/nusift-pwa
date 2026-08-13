/**
 * Shared bounded stage contract for the production workflow and the local
 * Docker parity runner. Keep behaviour-changing limits here so the two
 * entrypoints cannot silently drift.
 */
export const DAILY_PIPELINE_STAGES = [
  "agent1",
  "agent2-static",
  "agent2-headless",
  "agent3",
] as const;

export type DailyPipelineStage = (typeof DAILY_PIPELINE_STAGES)[number];

export const STAGE_CONCURRENCY_LIMIT: Record<DailyPipelineStage, number> = {
  agent1: 1,
  "agent2-static": 1,
  "agent2-headless": 1,
  agent3: 1,
};

export const STAGE_BATCH_SIZE_LIMIT: Record<DailyPipelineStage, number> = {
  agent1: 5,
  "agent2-static": 5,
  "agent2-headless": 3,
  agent3: 10,
};

export const STAGE_TIME_BUDGET_MS = 240_000;
export const STAGE_MIN_REMAINING_MS = 30_000;

export const AGENT3_WORKFLOW_BROWSER_MAX_ATTEMPTS = 2;
export const AGENT3_WORKFLOW_BROWSER_TIMEOUT_MS = 25_000;
export const AGENT3_WORKFLOW_MAX_ARTICLES_PER_SOURCE = 2;
