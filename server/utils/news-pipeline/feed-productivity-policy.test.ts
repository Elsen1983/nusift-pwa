import { describe, expect, it } from "vitest";
import {
  applyFeedProductivityOutcome,
  type FeedProductivityState,
} from "./feed-productivity-policy";
import { FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD } from "./feed-first-policy";

const NOW = new Date("2026-08-13T12:00:00.000Z");

const makeState = (overrides: Partial<FeedProductivityState> = {}): FeedProductivityState => ({
  currentFeedProductive: false,
  consecutiveNonProductiveRuns: 0,
  lastProductiveFeedUrl: null,
  lastProductiveAt: null,
  nextRetryAt: null,
  ...overrides,
});

describe("applyFeedProductivityOutcome", () => {
  it("marks a productive run and resets the nonproductive streak", () => {
    const next = applyFeedProductivityOutcome(
      makeState({ consecutiveNonProductiveRuns: 1 }),
      { kind: "productive", feedUrl: "https://example.com/feed" },
      { now: NOW },
    );
    expect(next).toMatchObject({
      currentFeedProductive: true,
      consecutiveNonProductiveRuns: 0,
      lastProductiveFeedUrl: "https://example.com/feed",
      lastProductiveAt: NOW,
      nextRetryAt: null,
    });
  });

  it("does not erase proven productivity on a single nonproductive run", () => {
    const state = makeState({ currentFeedProductive: true });
    const next = applyFeedProductivityOutcome(state, { kind: "nonproductive" }, { now: NOW });
    expect(next.currentFeedProductive).toBe(true);
    expect(next.consecutiveNonProductiveRuns).toBe(1);
  });

  it("demotes productivity at the exact confirmed-nonproductive threshold", () => {
    let state = makeState({ currentFeedProductive: true });
    for (let i = 0; i < FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD - 1; i += 1) {
      state = applyFeedProductivityOutcome(state, { kind: "nonproductive" }, { now: NOW });
      expect(state.currentFeedProductive).toBe(true);
    }
    state = applyFeedProductivityOutcome(state, { kind: "nonproductive" }, { now: NOW });
    expect(state.currentFeedProductive).toBe(false);
    expect(state.consecutiveNonProductiveRuns).toBe(FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD);
  });

  it("respects a caller-supplied demotion threshold", () => {
    let state = makeState({ currentFeedProductive: true });
    state = applyFeedProductivityOutcome(state, { kind: "nonproductive" }, { now: NOW, demotionThreshold: 1 });
    expect(state.currentFeedProductive).toBe(false);
  });

  it("recovers cleanly after demotion via a later productive run", () => {
    let state = makeState({ currentFeedProductive: true });
    for (let i = 0; i < FEED_NON_PRODUCTIVE_FALLBACK_THRESHOLD; i += 1) {
      state = applyFeedProductivityOutcome(state, { kind: "nonproductive" }, { now: NOW });
    }
    expect(state.currentFeedProductive).toBe(false);
    state = applyFeedProductivityOutcome(state, { kind: "productive", feedUrl: "https://example.com/feed" }, { now: NOW });
    expect(state).toMatchObject({ currentFeedProductive: true, consecutiveNonProductiveRuns: 0 });
  });

  it("demotes immediately on invalid_feed without waiting for the streak threshold", () => {
    const state = makeState({ currentFeedProductive: true, consecutiveNonProductiveRuns: 0 });
    const next = applyFeedProductivityOutcome(state, { kind: "invalid_feed" }, { now: NOW });
    expect(next.currentFeedProductive).toBe(false);
    expect(next.consecutiveNonProductiveRuns).toBe(0);
  });

  it("treats rate_limited, governor_or_robots_defer, and unknown as no-ops", () => {
    const state = makeState({ currentFeedProductive: true, consecutiveNonProductiveRuns: 1 });
    for (const kind of ["rate_limited", "governor_or_robots_defer", "unknown"] as const) {
      const next = applyFeedProductivityOutcome(state, { kind }, { now: NOW });
      expect(next).toEqual(state);
    }
  });

  it("resets productivity state on manual_remap", () => {
    const state = makeState({ currentFeedProductive: true, consecutiveNonProductiveRuns: 3 });
    const next = applyFeedProductivityOutcome(state, { kind: "manual_remap" }, { now: NOW });
    expect(next).toMatchObject({ currentFeedProductive: false, consecutiveNonProductiveRuns: 0 });
  });

  it("keeps source and category state independently scoped", () => {
    const sourceState = makeState({ currentFeedProductive: true });
    const categoryState = makeState({ currentFeedProductive: true });
    const nextSource = applyFeedProductivityOutcome(sourceState, { kind: "invalid_feed" }, { now: NOW });
    expect(nextSource.currentFeedProductive).toBe(false);
    expect(categoryState.currentFeedProductive).toBe(true);
  });
});
