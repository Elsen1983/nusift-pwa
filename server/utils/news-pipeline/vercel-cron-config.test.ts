import { describe, expect, it } from "vitest";
import cronConfig from "../../../vercel.json";

describe("vercel.json cron schedule", () => {
  const crons = cronConfig.crons;

  // Cron format: "minute hour day month weekday"
  const parseMinuteOfDay = (schedule: string) => {
    const parts = schedule.split(" ");
    const minute = parseInt(parts[0]!, 10);
    const hour = parseInt(parts[1]!, 10);
    return hour * 60 + minute;
  };

  it("has Agent 1 slots before Agent 2 slots", () => {
    const a1Slots = crons.filter((c) => c.path.includes("run-agent1"));
    const a2Slots = crons.filter((c) => c.path.includes("run-agent2"));

    expect(a1Slots.length).toBeGreaterThanOrEqual(4);
    expect(a2Slots.length).toBeGreaterThanOrEqual(2);

    // All Agent 1 slots should be scheduled before all Agent 2 slots
    const lastA1 = Math.max(...a1Slots.map((c) => parseMinuteOfDay(c.schedule)));
    const firstA2 = Math.min(...a2Slots.map((c) => parseMinuteOfDay(c.schedule)));
    expect(lastA1).toBeLessThan(firstA2);
  });

  it("has hard-case and cleanup after Agent 2", () => {
    const a2Slots = crons.filter((c) => c.path.includes("run-agent2"));
    const hardCase = crons.find((c) => c.path.includes("hard-case"));
    const cleanup = crons.find((c) => c.path.includes("cleanup-maintenance"));

    expect(hardCase).toBeDefined();
    expect(cleanup).toBeDefined();

    const lastA2 = Math.max(...a2Slots.map((c) => parseMinuteOfDay(c.schedule)));
    const hardCaseTime = parseMinuteOfDay(hardCase!.schedule);
    const cleanupTime = parseMinuteOfDay(cleanup!.schedule);

    expect(hardCaseTime).toBeGreaterThanOrEqual(lastA2);
    expect(cleanupTime).toBeGreaterThanOrEqual(hardCaseTime);
  });

  it("has enough buffer between last discovery job and cleanup", () => {
    const a2Slots = crons.filter((c) => c.path.includes("run-agent2"));
    const hardCase = crons.find((c) => c.path.includes("hard-case"));
    const cleanup = crons.find((c) => c.path.includes("cleanup-maintenance"));

    expect(hardCase).toBeDefined();
    expect(cleanup).toBeDefined();

    const lastDiscovery = Math.max(
      ...a2Slots.map((c) => parseMinuteOfDay(c.schedule)),
      parseMinuteOfDay(hardCase!.schedule),
    );
    const cleanupTime = parseMinuteOfDay(cleanup!.schedule);

    // Cleanup must run at least 60 min after the last discovery job.
    // This prevents Vercel Hobby flexible cron windows from causing
    // cleanup-before-reimport loops. Intentional design: cleanup runs
    // last in the daily cron schedule so all A1/A2/hard-case slots
    // have finished before any articles are eligible for deletion.
    expect(cleanupTime - lastDiscovery).toBeGreaterThanOrEqual(60);
  });

  it("uses bounded params for Agent 1 cron slots", () => {
    const a1Slots = crons.filter((c) => c.path.includes("run-agent1"));
    for (const slot of a1Slots) {
      expect(slot.path).toContain("maxTargets=");
      expect(slot.path).toContain("timeBudgetMs=");
      expect(slot.path).toContain("minRemainingMs=");
    }
  });
});
