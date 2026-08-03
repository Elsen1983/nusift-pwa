import { describe, expect, it } from "vitest";
import cronConfig from "../../../vercel.json";

describe("vercel.json cron schedule", () => {
  const crons = cronConfig.crons;

  it("stays within Vercel Hobby cron limits", () => {
    expect(crons).toHaveLength(2);
    expect(crons.every((cron) => !cron.schedule.includes(","))).toBe(true);
  });

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

  it("does not add a third notification cron (durable notification workflow instead)", () => {
    expect(crons.some((cron) => cron.path.includes("send-due-notifications"))).toBe(false);
    expect(crons.some((cron) => cron.path.includes("notifications"))).toBe(false);
    // Every configured cron must run no more than once per day (Hobby limit).
    for (const cron of crons) {
      const minute = cron.schedule.split(" ")[0] ?? "";
      expect(minute.includes(",")).toBe(false);
      const hour = cron.schedule.split(" ")[1] ?? "";
      expect(hour.includes(",")).toBe(false);
      expect(hour.includes("/")).toBe(false);
      expect(cron.schedule.split(" ")[2]).toBe("*");
      expect(cron.schedule.split(" ")[3]).toBe("*");
      expect(cron.schedule.split(" ")[4]).toBe("*");
    }
  });
});
