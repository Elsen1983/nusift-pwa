import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const findManyMock = vi.fn();
const findManySourceMock = vi.fn();
const findManyCategoryMock = vi.fn();

afterEach(() => {
  vi.useRealTimers();
});

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findMany: (...args: any[]) => findManyMock(...args),
    },
    newsSource: {
      findMany: (...args: any[]) => findManySourceMock(...args),
    },
    sourceCategory: {
      findMany: (...args: any[]) => findManyCategoryMock(...args),
    },
  },
}));

// ─── Pure helper tests (no DB) ──────────────────────────────────────────────

describe("hard-source-tracking — pure classification helpers", () => {
  async function loadModule() {
    return await import("./hard-source-tracking");
  }

  describe("isProductiveOrResolved", () => {
    it("returns true for productive static target", async () => {
      const { isProductiveOrResolved } = await loadModule();
      expect(
        isProductiveOrResolved({
          lastStaticQuality: "productive",
          lastBrowserStatus: null,
          lastAcceptedCount: null,
        }),
      ).toBe(true);
    });

    it("returns true when browser resolved (RESOLVED status)", async () => {
      const { isProductiveOrResolved } = await loadModule();
      expect(
        isProductiveOrResolved({
          lastStaticQuality: "failed",
          lastBrowserStatus: "RESOLVED",
          lastAcceptedCount: 3,
        }),
      ).toBe(true);
    });

    it("returns true when browser accepted count > 0", async () => {
      const { isProductiveOrResolved } = await loadModule();
      expect(
        isProductiveOrResolved({
          lastStaticQuality: "blocked",
          lastBrowserStatus: "BROWSER_NO_CANDIDATES",
          lastAcceptedCount: 2,
        }),
      ).toBe(true);
    });

    it("returns false when static failed and browser found no candidates", async () => {
      const { isProductiveOrResolved } = await loadModule();
      expect(
        isProductiveOrResolved({
          lastStaticQuality: "failed",
          lastBrowserStatus: "BROWSER_NO_CANDIDATES",
          lastAcceptedCount: 0,
        }),
      ).toBe(false);
    });

    it("returns false when static failed and browser runtime unavailable", async () => {
      const { isProductiveOrResolved } = await loadModule();
      expect(
        isProductiveOrResolved({
          lastStaticQuality: "blocked",
          lastBrowserStatus: "BROWSER_RUNTIME_UNAVAILABLE",
          lastAcceptedCount: null,
        }),
      ).toBe(false);
    });
  });

  describe("classifyRecommendedNextAction", () => {
    it("returns run_browser when browser runtime unavailable", async () => {
      const { classifyRecommendedNextAction } = await loadModule();
      expect(
        classifyRecommendedNextAction({
          lastStaticQuality: "blocked",
          lastBrowserStatus: "BROWSER_RUNTIME_UNAVAILABLE",
          lastAcceptedCount: null,
          consecutiveFailedDiscoveryAttempts: 1,
        }),
      ).toBe("run_browser");
    });

    it("returns run_browser when browser fallback disabled", async () => {
      const { classifyRecommendedNextAction } = await loadModule();
      expect(
        classifyRecommendedNextAction({
          lastStaticQuality: "failed",
          lastBrowserStatus: "BROWSER_FALLBACK_DISABLED",
          lastAcceptedCount: null,
          consecutiveFailedDiscoveryAttempts: 1,
        }),
      ).toBe("run_browser");
    });

    it("returns run_browser when static failed but browser hasn't run yet", async () => {
      const { classifyRecommendedNextAction } = await loadModule();
      expect(
        classifyRecommendedNextAction({
          lastStaticQuality: "failed",
          lastBrowserStatus: null,
          lastAcceptedCount: null,
          consecutiveFailedDiscoveryAttempts: 1,
        }),
      ).toBe("run_browser");
    });

  it("returns ai_inspection_candidate when static + browser both failed with repeated attempts", async () => {
    const { classifyRecommendedNextAction } = await loadModule();
    expect(
      classifyRecommendedNextAction({
        lastStaticQuality: "failed",
        lastBrowserStatus: "BROWSER_NO_CANDIDATES",
        lastAcceptedCount: 0,
        consecutiveFailedDiscoveryAttempts: 3,
      }),
    ).toBe("ai_inspection_candidate");
  });

  it("returns ai_inspection_candidate when static + browser both failed once (count=2)", async () => {
    // Single static failure + single browser failure = 2 consecutive attempts.
    // Per spec acceptance: "static and browser both fail → AI inspection candidate".
    const { classifyRecommendedNextAction } = await loadModule();
    expect(
      classifyRecommendedNextAction({
        lastStaticQuality: "failed",
        lastBrowserStatus: "BROWSER_NO_CANDIDATES",
        lastAcceptedCount: 0,
        consecutiveFailedDiscoveryAttempts: 2,
      }),
    ).toBe("ai_inspection_candidate");
  });

  it("returns manual_review when browser failed but only 1 total attempt (e.g. browser-only failure)", async () => {
    // A browser failure with no prior static failure (count=1) should NOT
    // immediately become an AI inspection candidate — it may be transient.
    const { classifyRecommendedNextAction } = await loadModule();
    expect(
      classifyRecommendedNextAction({
        lastStaticQuality: null,
        lastBrowserStatus: "BROWSER_NO_CANDIDATES",
        lastAcceptedCount: 0,
        consecutiveFailedDiscoveryAttempts: 1,
      }),
    ).toBe("manual_review");
  });

    it("returns ai_inspection_candidate when browser errored (HEADLESS_PROCESSING_STALE) repeatedly", async () => {
      const { classifyRecommendedNextAction } = await loadModule();
      expect(
        classifyRecommendedNextAction({
          lastStaticQuality: "blocked",
          lastBrowserStatus: "HEADLESS_PROCESSING_STALE",
          lastAcceptedCount: null,
          consecutiveFailedDiscoveryAttempts: 2,
        }),
      ).toBe("ai_inspection_candidate");
    });
  });
});

// ─── Integration tests (mocked DB) ──────────────────────────────────────────

describe("hard-source-tracking — buildHardSourceReport", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    findManySourceMock.mockReset();
    findManyCategoryMock.mockReset();
    findManySourceMock.mockResolvedValue([]);
    findManyCategoryMock.mockResolvedValue([]);
  });

  async function loadFn() {
    const mod = await import("./hard-source-tracking");
    return mod.buildHardSourceReport;
  }

  function makeStaticArtifact(overrides: {
    sourceId: string;
    targetUrl: string;
    quality: string;
    categoryId?: string | null;
    createdAt?: Date;
    escalated?: boolean;
  }) {
    return {
      id: `static-${overrides.sourceId}-${overrides.targetUrl}`,
      artifactType: "article_discovery_candidates",
      status: overrides.quality === "productive" ? "CAPTURED" : "FAILED",
      sourceId: overrides.sourceId,
      categoryId: overrides.categoryId ?? null,
      candidateCount: overrides.quality === "productive" ? 3 : 0,
      createdAt: overrides.createdAt ?? new Date("2026-07-15T10:00:00Z"),
      payload: {
        targetUrl: overrides.targetUrl,
        sourceId: overrides.sourceId,
        qualityAssessment: {
          quality: overrides.quality,
          confidence: "high",
          shouldEscalateToHeadless: overrides.escalated ?? (overrides.quality === "failed" || overrides.quality === "blocked"),
        },
      },
    };
  }

  function makeBrowserArtifact(overrides: {
    sourceId: string;
    targetUrl: string;
    status: string;
    accepted?: number;
    inserted?: number;
    categoryId?: string | null;
    createdAt?: Date;
    browserRateLimited?: boolean;
    browserRetryAfterAt?: string | null;
  }) {
    return {
      id: `browser-${overrides.sourceId}-${overrides.targetUrl}`,
      artifactType: "article_discovery_headless_required",
      status: overrides.status,
      sourceId: overrides.sourceId,
      categoryId: overrides.categoryId ?? null,
      candidateCount: overrides.accepted ?? 0,
      createdAt: overrides.createdAt ?? new Date("2026-07-16T10:00:00Z"),
      payload: {
        targetUrl: overrides.targetUrl,
        sourceId: overrides.sourceId,
        browserFallbackRan: true,
        browserAccepted: overrides.accepted ?? 0,
        browserInserted: overrides.inserted ?? 0,
        browserRateLimited: overrides.browserRateLimited ?? false,
        browserRateLimitReason: overrides.browserRateLimited ? "http_429" : null,
        browserRetryAfterAt: overrides.browserRetryAfterAt ?? null,
      },
    };
  }

  it("productive static target is NOT a hard source", async () => {
    findManyMock.mockResolvedValue([
      makeStaticArtifact({
        sourceId: "src-good",
        targetUrl: "https://good.com/news",
        quality: "productive",
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.total).toBe(0);
    expect(report.hardSources).toEqual([]);
  });

  it("static failed + browser no candidates → AI inspection candidate (single static + single browser failure)", async () => {
    // Spec acceptance: "If static and browser both fail, it should be clearly
    // visible as an AI-inspection candidate." A single static failure (+1)
    // followed by a single browser BROWSER_NO_CANDIDATES (+1) = 2 consecutive
    // failed discovery attempts, which triggers ai_inspection_candidate.
    // Desc ordering: browser (2026-07-16) comes before static (2026-07-15).
    findManyMock.mockResolvedValue([
      makeBrowserArtifact({
        sourceId: "src-hard",
        targetUrl: "https://hard.com/news",
        status: "BROWSER_NO_CANDIDATES",
        accepted: 0,
      }),
      makeStaticArtifact({
        sourceId: "src-hard",
        targetUrl: "https://hard.com/news",
        quality: "failed",
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.total).toBe(1);
    expect(report.hardSources[0]?.targetUrl).toBe("https://hard.com/news");
    expect(report.hardSources[0]?.lastStaticQuality).toBe("failed");
    expect(report.hardSources[0]?.lastBrowserStatus).toBe("BROWSER_NO_CANDIDATES");
    expect(report.hardSources[0]?.consecutiveFailedDiscoveryAttempts).toBe(2);
    expect(report.hardSources[0]?.recommendedNextAction).toBe("ai_inspection_candidate");
  });

  it("browser resolved → NOT a hard source", async () => {
    // Desc ordering: browser (newer) comes before static (older).
    findManyMock.mockResolvedValue([
      makeBrowserArtifact({
        sourceId: "src-resolved",
        targetUrl: "https://resolved.com/news",
        status: "RESOLVED",
        accepted: 5,
        inserted: 5,
      }),
      makeStaticArtifact({
        sourceId: "src-resolved",
        targetUrl: "https://resolved.com/news",
        quality: "failed",
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.total).toBe(0);
  });

  it("excludes an active 429 from hard sources and counts it once as cooldown-only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    findManyMock.mockResolvedValue([
      makeStaticArtifact({
        sourceId: "src-cooldown",
        targetUrl: "https://cooldown.com/news",
        quality: "failed",
        createdAt: new Date("2026-07-30T11:55:00.000Z"),
      }),
      makeBrowserArtifact({
        sourceId: "src-cooldown",
        targetUrl: "https://cooldown.com/news",
        status: "BROWSER_NO_CANDIDATES",
        browserRateLimited: true,
        browserRetryAfterAt: "2026-07-30T13:00:00.000Z",
        createdAt: new Date("2026-07-30T11:50:00.000Z"),
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.hardSources).toEqual([]);
    expect(report.cooldownOnlyCount).toBe(1);
    expect(report.qualifyingHardSourceCount).toBe(0);
    expect(report.evidenceTargetCount).toBe(1);
    vi.useRealTimers();
  });

  it("newer static evidence does not erase active browser cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    findManyMock.mockResolvedValue([
      makeStaticArtifact({
        sourceId: "src-mixed",
        targetUrl: "https://mixed.com/news",
        quality: "failed",
        createdAt: new Date("2026-07-30T11:59:00.000Z"),
      }),
      makeBrowserArtifact({
        sourceId: "src-mixed",
        targetUrl: "https://mixed.com/news",
        status: "BROWSER_NO_CANDIDATES",
        browserRateLimited: true,
        browserRetryAfterAt: "2026-07-30T13:00:00.000Z",
        createdAt: new Date("2026-07-30T11:58:00.000Z"),
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.cooldownOnlyCount).toBe(1);
    expect(report.hardSources).toHaveLength(0);
    vi.useRealTimers();
  });

  it("expired 429 can qualify as a hard source again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T14:00:00.000Z"));
    findManyMock.mockResolvedValue([
      makeBrowserArtifact({
        sourceId: "src-expired",
        targetUrl: "https://expired.com/news",
        status: "BROWSER_NO_CANDIDATES",
        browserRateLimited: true,
        browserRetryAfterAt: "2026-07-30T13:00:00.000Z",
      }),
      makeStaticArtifact({
        sourceId: "src-expired",
        targetUrl: "https://expired.com/news",
        quality: "failed",
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.cooldownOnlyCount).toBe(0);
    expect(report.hardSources).toHaveLength(1);
    vi.useRealTimers();
  });

  it("active scoped RSS resolution hides stale Agent 2 hard-source markers", async () => {
    // Desc ordering: browser (newer) comes before static (older).
    findManyMock.mockResolvedValue([
      makeBrowserArtifact({
        sourceId: "src-rss",
        targetUrl: "https://example.com/category",
        status: "BROWSER_NO_CANDIDATES",
        categoryId: "cat-rss",
      }),
      makeStaticArtifact({
        sourceId: "src-rss",
        targetUrl: "https://example.com/category",
        quality: "failed",
        categoryId: "cat-rss",
      }),
    ]);
    findManySourceMock.mockResolvedValue([]);
    findManyCategoryMock.mockResolvedValue([
      {
        newsSourceId: "src-rss",
        id: "cat-rss",
        rssFeedUrl: "https://example.com/rss",
        rssStatus: "ACTIVE",
      },
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.total).toBe(0);
    expect(report.hardSources).toEqual([]);
  });

  it("runtime unavailable → recommended action is run_browser, not AI inspection", async () => {
    // Desc ordering: browser (newer) comes before static (older).
    findManyMock.mockResolvedValue([
      makeBrowserArtifact({
        sourceId: "src-unavail",
        targetUrl: "https://unavail.com/news",
        status: "BROWSER_RUNTIME_UNAVAILABLE",
        accepted: 0,
      }),
      makeStaticArtifact({
        sourceId: "src-unavail",
        targetUrl: "https://unavail.com/news",
        quality: "blocked",
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.total).toBe(1);
    expect(report.hardSources[0]?.recommendedNextAction).toBe("run_browser");
    expect(report.hardSources[0]?.recommendedNextAction).not.toBe("ai_inspection_candidate");
  });

  it("weak static WITHOUT escalation is NOT a hard source (spec: 'weak with escalation')", async () => {
    findManyMock.mockResolvedValue([
      makeStaticArtifact({
        sourceId: "src-weak-stable",
        targetUrl: "https://weak-stable.com/news",
        quality: "weak",
        escalated: false,
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    // Weak-but-stable (no escalation) must NOT be flagged as a hard source.
    expect(report.total).toBe(0);
    expect(report.hardSources).toEqual([]);
  });

  it("weak static WITH escalation + browser failure IS a hard source → AI inspection (single + single = 2 attempts)", async () => {
    // Desc ordering: newest artifact must come first in mock array.
    // Browser artifact (2026-07-16) is newer than static (2026-07-15).
    findManyMock.mockResolvedValue([
      makeBrowserArtifact({
        sourceId: "src-weak-esc",
        targetUrl: "https://weak-esc.com/news",
        status: "BROWSER_NO_CANDIDATES",
        accepted: 0,
      }),
      makeStaticArtifact({
        sourceId: "src-weak-esc",
        targetUrl: "https://weak-esc.com/news",
        quality: "weak",
        escalated: true,
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.total).toBe(1);
    expect(report.hardSources[0]?.lastStaticQuality).toBe("weak");
    // weak-escalated (+1) + browser no-candidates (+1) = 2 → AI inspection
    expect(report.hardSources[0]?.consecutiveFailedDiscoveryAttempts).toBe(2);
    expect(report.hardSources[0]?.recommendedNextAction).toBe("ai_inspection_candidate");
  });

  it("failed static (always escalated) without browser run → run_browser", async () => {
    findManyMock.mockResolvedValue([
      makeStaticArtifact({
        sourceId: "src-failed",
        targetUrl: "https://failed.com/news",
        quality: "failed",
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.total).toBe(1);
    expect(report.hardSources[0]?.lastStaticQuality).toBe("failed");
    expect(report.hardSources[0]?.recommendedNextAction).toBe("run_browser");
  });

  it("preserves sourceId, categoryId, targetUrl in the entry", async () => {
    // Desc ordering: browser (newer) comes before static (older).
    findManyMock.mockResolvedValue([
      makeBrowserArtifact({
        sourceId: "src-cat",
        targetUrl: "https://cat.com/sports",
        status: "BROWSER_NO_CANDIDATES",
        categoryId: "cat-1",
      }),
      makeStaticArtifact({
        sourceId: "src-cat",
        targetUrl: "https://cat.com/sports",
        quality: "failed",
        categoryId: "cat-1",
      }),
    ]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.hardSources[0]?.sourceId).toBe("src-cat");
    expect(report.hardSources[0]?.categoryId).toBe("cat-1");
    expect(report.hardSources[0]?.targetUrl).toBe("https://cat.com/sports");
    expect(report.hardSources[0]?.key).toBe("src-cat|cat-1|https://cat.com/sports");
  });

  it("handles empty artifact set", async () => {
    findManyMock.mockResolvedValue([]);

    const fn = await loadFn();
    const report = await fn();

    expect(report.total).toBe(0);
    expect(report.hardSources).toEqual([]);
    expect(report.scannedArtifacts).toBe(0);
  });

  it("clamps scanLimit between 10 and 500", async () => {
    findManyMock.mockResolvedValue([]);

    const fn = await loadFn();
    await fn({ scanLimit: 1 });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));

    findManyMock.mockResolvedValue([]);
    await fn({ scanLimit: 99999 });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
  });
});
