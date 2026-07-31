import { describe, expect, it } from "vitest";
import cronConfig from "../../../vercel.json";

describe("vercel.json cron schedule", () => {
  const crons = cronConfig.crons;

  it("starts exactly one durable daily news pipeline", () => {
    const pipelineSlots = crons.filter((cron) => cron.path.includes("run-daily-pipeline"));
    expect(pipelineSlots).toEqual([{
      path: "/api/internal/run-daily-pipeline",
      schedule: "0 3 * * *",
    }]);
  });

  it("does not retain independent Agent 1, Agent 2, or hard-case cron slots", () => {
    expect(crons.some((cron) => cron.path.includes("run-agent1"))).toBe(false);
    expect(crons.some((cron) => cron.path.includes("run-agent2"))).toBe(false);
    expect(crons.some((cron) => cron.path.includes("hard-case"))).toBe(false);
  });

  it("keeps maintenance cleanup separate from pipeline orchestration", () => {
    expect(crons.find((cron) => cron.path.includes("cleanup-maintenance"))).toEqual({
      path: "/api/internal/cleanup-maintenance",
      schedule: "30 5 * * *",
    });
  });
});
