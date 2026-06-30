import { describe, expect, it } from "vitest";
import type { UserRankingContext } from "./context";
import { scoreArticleHeuristic } from "./heuristic";

function baseContext(overrides: Partial<UserRankingContext> = {}): UserRankingContext {
  return {
    userId: "user-1",
    primaryRegion: "ie",
    interests: [
      { id: "technology", name: "Technology", weight: 90, prompt: "AI startups", chips: ["chips"] },
    ],
    subscribedSourceIds: new Set(["source-a"]),
    subscribedCategoryIds: new Set(),
    sourceRatingAvg: new Map([["source-a", 4.5]]),
    recentSourceReads: new Map(),
    ...overrides,
  };
}

const now = new Date("2026-06-30T12:00:00Z");

describe("scoreArticleHeuristic", () => {
  it("boosts fresh articles that match weighted interests", () => {
    const result = scoreArticleHeuristic(
      {
        id: 1,
        title: "AI startup raises funding in Dublin",
        summary: "Technology sector growth continues",
        tags: ["technology"],
        date: new Date("2026-06-30T10:00:00Z"),
        sourceId: "source-a",
        categoryId: null,
        sourceCountryCode: "IE",
        sourceContinent: "Europe",
        categoryName: null,
      },
      baseContext(),
      now,
    );

    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.signals.some((signal) => signal.startsWith("Interest:"))).toBe(true);
    expect(result.reasoning).toContain("interests");
  });

  it("applies fatigue penalty for over-read sources", () => {
    const fresh = scoreArticleHeuristic(
      {
        id: 2,
        title: "Market update",
        summary: null,
        tags: [],
        date: new Date("2026-06-30T11:00:00Z"),
        sourceId: "source-a",
        categoryId: null,
        sourceCountryCode: null,
        sourceContinent: null,
        categoryName: null,
      },
      baseContext({ interests: [], recentSourceReads: new Map([["source-a", 2]]) }),
      now,
    );

    const fatigued = scoreArticleHeuristic(
      {
        id: 3,
        title: "Market update",
        summary: null,
        tags: [],
        date: new Date("2026-06-30T11:00:00Z"),
        sourceId: "source-a",
        categoryId: null,
        sourceCountryCode: null,
        sourceContinent: null,
        categoryName: null,
      },
      baseContext({ interests: [], recentSourceReads: new Map([["source-a", 20]]) }),
      now,
    );

    expect(fatigued.score).toBeLessThan(fresh.score);
    expect(fatigued.signals).toContain("Recent source fatigue");
  });
});