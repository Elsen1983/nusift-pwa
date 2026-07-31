import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  agent1: vi.fn(),
  agent2: vi.fn(),
  headless: vi.fn(),
  browserEnabled: vi.fn(),
  agent3: vi.fn(),
  agent3Progress: vi.fn(),
}));

vi.mock("../utils/prisma", () => ({
  prisma: { pipelineRun: { updateMany: mocks.updateMany } },
}));
vi.mock("../utils/news-pipeline/orchestrator", () => ({ runAgent1Batch: mocks.agent1 }));
vi.mock("../utils/news-pipeline/article-discovery", () => ({ runArticleDiscoveryBatch: mocks.agent2 }));
vi.mock("../utils/news-pipeline/article-discovery-headless-queue", () => ({
  processArticleDiscoveryHeadlessQueue: mocks.headless,
}));
vi.mock("../utils/news-pipeline/article-discovery-browser", () => ({
  isBrowserFallbackEnabled: mocks.browserEnabled,
}));
vi.mock("../utils/news-pipeline/enrichment-runtime", () => ({
  runEnrichmentBatch: mocks.agent3,
  getAgent3Progress: mocks.agent3Progress,
}));
vi.mock("../utils/notification-sender", () => ({ sendDueDailyNotifications: vi.fn() }));

import { DAILY_PIPELINE_STAGES, runDailyPipelineStageBatch } from "./daily-news-pipeline";

describe("daily news pipeline stage batches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.browserEnabled.mockReturnValue(true);
  });

  it("uses the extensible ordered stage registry", () => {
    expect(DAILY_PIPELINE_STAGES).toEqual([
      "agent1",
      "agent2-static",
      "agent2-headless",
      "agent3",
    ]);
  });

  it("runs Agent 1 with the production bounded batch contract", async () => {
    mocks.agent1.mockResolvedValue({ processed: 5, remainingEligible: 2 });
    await expect(runDailyPipelineStageBatch("orchestration-1", "agent1")).resolves.toMatchObject({
      processed: 5,
      remaining: 2,
      complete: false,
    });
    expect(mocks.agent1).toHaveBeenCalledWith({
      maxTargets: 5,
      timeBudgetMs: 240_000,
      minRemainingMs: 30_000,
    });
  });

  it("runs Agent 2 static discovery with the production bounded batch contract", async () => {
    mocks.agent2.mockResolvedValue({ processed: 4, remainingEligible: 0 });
    await expect(runDailyPipelineStageBatch("orchestration-1", "agent2-static")).resolves.toMatchObject({
      processed: 4,
      remaining: 0,
      complete: true,
    });
    expect(mocks.agent2).toHaveBeenCalledWith({
      maxTargets: 5,
      timeBudgetMs: 240_000,
      minRemainingMs: 30_000,
    });
  });

  it("runs the real Agent 2 browser queue in write mode", async () => {
    mocks.headless.mockResolvedValue({
      dryRun: false,
      processed: 3,
      claimed: 3,
      browserAttemptedTargets: 3,
    });
    await expect(runDailyPipelineStageBatch("orchestration-1", "agent2-headless")).resolves.toMatchObject({
      processed: 3,
      complete: false,
    });
    expect(mocks.headless).toHaveBeenCalledWith({ limit: 3, dryRun: false, runBrowser: true });
  });

  it("runs Agent 3 without browser fallback, reprocessing, or a daily article cap", async () => {
    mocks.agent3.mockResolvedValue({ articleCount: 10 });
    mocks.agent3Progress.mockResolvedValue({ retryableNow: 7 });
    await expect(runDailyPipelineStageBatch("orchestration-1", "agent3")).resolves.toMatchObject({
      processed: 10,
      remaining: 7,
      complete: false,
    });
    expect(mocks.agent3).toHaveBeenCalledWith({
      maxArticles: 10,
      includeEnriched: false,
      forceReprocess: false,
      browserFallback: false,
    });
  });
});
