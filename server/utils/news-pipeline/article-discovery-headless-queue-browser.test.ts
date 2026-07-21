import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const findManyMock = vi.fn();
const updateManyMock = vi.fn();
const logAgentScanMock = vi.fn();
const isBrowserFallbackEnabledMock = vi.fn();
const discoverArticleLinksWithBrowserMock = vi.fn();
const evaluateArticleLinkCandidateMock = vi.fn();
const persistCandidatesMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findMany: (...args: any[]) => findManyMock(...args),
      updateMany: (...args: any[]) => updateManyMock(...args),
    },
  },
}));

vi.mock("./log", () => ({
  logAgentScan: (...args: any[]) => logAgentScanMock(...args),
}));

vi.mock("./article-discovery-browser", () => ({
  isBrowserFallbackEnabled: (...args: any[]) => isBrowserFallbackEnabledMock(...args),
  discoverArticleLinksWithBrowser: (...args: any[]) => discoverArticleLinksWithBrowserMock(...args),
}));

vi.mock("./article-discovery-helpers", () => ({
  evaluateArticleLinkCandidate: (...args: any[]) => evaluateArticleLinkCandidateMock(...args),
  ArticleDiscoveryOutcomeTracker: class {
    private accepted: any[] = [];
    private rejected: any[] = [];
    private byStatus: Record<string, number> = {};
    private bySourceKind: Record<string, number> = {};
    record(o: any) {
      if (o.status === "accepted") this.accepted.push(o);
      else if (this.rejected.length < 100) this.rejected.push(o);
      this.byStatus[o.status] = (this.byStatus[o.status] || 0) + 1;
      this.bySourceKind[o.sourceKind] = (this.bySourceKind[o.sourceKind] || 0) + 1;
    }
    getSummary() {
      const rejectionCounts: Record<string, number> = {};
      for (const o of this.rejected) {
        const r = o.reason || o.status;
        rejectionCounts[r] = (rejectionCounts[r] || 0) + 1;
      }
      return {
        totalEvaluated: Object.values(this.byStatus).reduce((a, b) => a + b, 0),
        accepted: this.accepted.length,
        rejected: Object.entries(this.byStatus).filter(([s]) => s !== "accepted").reduce((a, [, v]) => a + v, 0),
        byStatus: { ...this.byStatus },
        bySourceKind: { ...this.bySourceKind },
        topRejectionReasons: Object.entries(rejectionCounts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5),
      };
    }
    getAccepted() { return [...this.accepted]; }
    getRejected() { return [...this.rejected]; }
  },
  assessArticleDiscoveryQuality: (input: any) => {
    if (input.acceptedCount > 0) {
      return { quality: "productive", shouldEscalateToHeadless: false, escalationReasons: [], confidence: "high", explanation: "productive" };
    }
    return { quality: "failed", shouldEscalateToHeadless: true, escalationReasons: ["no_candidates"], confidence: "high", explanation: "failed" };
  },
}));

vi.mock("./ingest", () => ({
  persistCandidates: (...args: any[]) => persistCandidatesMock(...args),
}));

vi.mock("./types", () => ({}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const makeArtifact = (overrides: Record<string, unknown> = {}) => ({
  id: (overrides.id as string) ?? "art-1",
  sourceId: (overrides.sourceId as string | null) ?? "src-1",
  categoryId: (overrides.categoryId as string | null) ?? null,
  createdAt: (overrides.createdAt as Date) ?? new Date("2026-07-16T10:00:00Z"),
  payload: (overrides.payload as Record<string, unknown>) ?? {
    targetUrl: "https://example.com/news",
    sourceId: "src-1",
    quality: "failed",
    escalationReasons: ["no_candidates"],
  },
});

const makeBrowserLink = (url: string, text = "Article") => ({
  url,
  text,
  sourcePageUrl: `browser:https://example.com/news`,
  sourceKind: "browser" as const,
  rawSignals: { anchorText: text, score: 50, scoreReasons: [] },
});

const makeAcceptedCandidate = (url: string) => ({
  sourceId: "src-1",
  categoryId: null,
  sourceUrl: url,
  canonicalUrl: url,
  rssGuid: null,
  rawTitle: null,
  title: "Test Article",
  publishedAt: new Date(),
  rawBodyText: null,
  bodyText: null,
  contentHash: "hash-" + url,
  isPaywall: false,
  rawTags: [],
  rawSignals: [],
  reasoning: "browser fallback",
  provenance: { origin: "web_discovery", fetchedAt: new Date().toISOString() },
});

const makeAcceptedEvaluation = (url: string) => ({
  accepted: true,
  candidate: makeAcceptedCandidate(url),
  outcome: { url, sourceKind: "browser", status: "accepted", canonicalUrl: url, title: "Test Article" },
});

const makeRejectedEvaluation = (url: string, status: string, reason: string) => ({
  accepted: false,
  candidate: null,
  outcome: { url, sourceKind: "browser", status, reason },
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("processArticleDiscoveryHeadlessQueue — browser fallback lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyMock.mockReset();
    updateManyMock.mockReset();
    logAgentScanMock.mockReset();
    isBrowserFallbackEnabledMock.mockReset();
    discoverArticleLinksWithBrowserMock.mockReset();
    evaluateArticleLinkCandidateMock.mockReset();
    persistCandidatesMock.mockReset();
    logAgentScanMock.mockResolvedValue(undefined);
    isBrowserFallbackEnabledMock.mockReturnValue(true);
    persistCandidatesMock.mockResolvedValue({ inserted: 0, skipped: 0, failed: 0 });
  });

  async function loadFn() {
    const mod = await import("./article-discovery-headless-queue");
    return mod.processArticleDiscoveryHeadlessQueue;
  }

  // ── env disabled → no browser run, BROWSER_FALLBACK_DISABLED ───────────

  it("marks artifact as BROWSER_FALLBACK_DISABLED when env flag is off", async () => {
    isBrowserFallbackEnabledMock.mockReturnValue(false);
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserSkippedDisabled).toBe(1);
      expect(result.browserResolved).toBe(0);
    }
    expect(discoverArticleLinksWithBrowserMock).not.toHaveBeenCalled();
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "BROWSER_FALLBACK_DISABLED" }),
    }));
  });

  // ── runtime unavailable → BROWSER_RUNTIME_UNAVAILABLE ─────────────────

  it("marks artifact as BROWSER_RUNTIME_UNAVAILABLE when browser runtime cannot launch", async () => {
    findManyMock.mockResolvedValue([makeArtifact()]);
    // First updateMany = claim (count 1), second = final status
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: false,
      reason: "browser_runtime_unavailable",
      links: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: "Playwright not installed",
        browserRuntimeAvailable: false,
        elapsedMs: 5,
      },
    });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserSkippedUnavailable).toBe(1);
      expect(result.browserResolved).toBe(0);
    }
    // Verify the final status update includes compact browser metadata
    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("BROWSER_RUNTIME_UNAVAILABLE");
    expect(finalCall.data.payload.browserFallbackRan).toBe(true);
    expect(finalCall.data.payload.browserError).toContain("browser_runtime_unavailable");
  });

  // ── browser returns links → candidates evaluated and persisted ────────

  it("evaluates browser links and persists accepted candidates", async () => {
    const link1 = "https://example.com/news/2026/07/20/story-1";
    const link2 = "https://example.com/news/2026/07/19/story-2";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: true,
      renderedUrl: "https://example.com/news",
      links: [makeBrowserLink(link1), makeBrowserLink(link2)],
      diagnostics: {
        pageTitle: "News",
        linkCount: 10,
        articleLikeLinkCount: 2,
        browserRuntimeAvailable: true,
        elapsedMs: 3000,
      },
    });
    evaluateArticleLinkCandidateMock
      .mockResolvedValueOnce(makeAcceptedEvaluation(link1))
      .mockResolvedValueOnce(makeAcceptedEvaluation(link2));
    persistCandidatesMock.mockResolvedValue({ inserted: 2, skipped: 0, failed: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserResolved).toBe(1);
      expect(result.browserCandidatesFound).toBe(2);
      expect(result.browserCandidatesPersisted?.inserted).toBe(2);
    }
    expect(evaluateArticleLinkCandidateMock).toHaveBeenCalledTimes(2);
    expect(persistCandidatesMock).toHaveBeenCalledTimes(1);

    // Verify final status is RESOLVED with compact browser metadata
    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("RESOLVED");
    expect(finalCall.data.payload.browserFallbackRan).toBe(true);
    expect(finalCall.data.payload.browserAccepted).toBe(2);
    expect(finalCall.data.payload.browserInserted).toBe(2);
    expect(finalCall.data.payload.browserRawLinks).toBe(10);
    expect(finalCall.data.payload.browserEvaluated).toBe(2);
    expect(finalCall.data.payload.browserQualityAssessment.quality).toBe("productive");
  });

  // ── browser returns only utility links → no candidates ────────────────

  it("marks as BROWSER_NO_CANDIDATES when browser returns only utility links", async () => {
    const utilityLink = "https://example.com/about";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: true,
      renderedUrl: "https://example.com/news",
      links: [makeBrowserLink(utilityLink)],
      diagnostics: {
        pageTitle: "News",
        linkCount: 5,
        articleLikeLinkCount: 1,
        browserRuntimeAvailable: true,
        elapsedMs: 2000,
      },
    });
    evaluateArticleLinkCandidateMock.mockResolvedValueOnce(
      makeRejectedEvaluation(utilityLink, "rejected_utility_path", "utility_path"),
    );

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserNoCandidates).toBe(1);
      expect(result.browserResolved).toBe(0);
    }
    expect(persistCandidatesMock).not.toHaveBeenCalled();

    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("BROWSER_NO_CANDIDATES");
    expect(finalCall.data.payload.browserAccepted).toBe(0);
    expect(finalCall.data.payload.browserRejected).toBe(1);
  });

  // ── accepted candidates → marker resolves to RESOLVED ──────────────────

  it("resolves marker to RESOLVED when accepted candidates are found", async () => {
    const articleUrl = "https://example.com/news/2026/07/20/breaking";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: true,
      renderedUrl: "https://example.com/news",
      links: [makeBrowserLink(articleUrl)],
      diagnostics: {
        pageTitle: "News",
        linkCount: 8,
        articleLikeLinkCount: 1,
        browserRuntimeAvailable: true,
        elapsedMs: 1500,
      },
    });
    evaluateArticleLinkCandidateMock.mockResolvedValueOnce(makeAcceptedEvaluation(articleUrl));
    persistCandidatesMock.mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserResolved).toBe(1);
    }
    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("RESOLVED");
    expect(finalCall.data.candidateCount).toBe(1);
  });

  // ── no accepted candidates → BROWSER_NO_CANDIDATES status ──────────────

  it("marks as BROWSER_NO_CANDIDATES when all links are rejected", async () => {
    const link1 = "https://example.com/news/old-story";
    const link2 = "https://example.com/news/another-old";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: true,
      renderedUrl: "https://example.com/news",
      links: [makeBrowserLink(link1), makeBrowserLink(link2)],
      diagnostics: {
        pageTitle: "News",
        linkCount: 4,
        articleLikeLinkCount: 2,
        browserRuntimeAvailable: true,
        elapsedMs: 1000,
      },
    });
    evaluateArticleLinkCandidateMock
      .mockResolvedValueOnce(makeRejectedEvaluation(link1, "rejected_stale", "stale"))
      .mockResolvedValueOnce(makeRejectedEvaluation(link2, "rejected_stale", "stale"));

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserNoCandidates).toBe(1);
      expect(result.browserResolved).toBe(0);
    }
    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("BROWSER_NO_CANDIDATES");
    expect(finalCall.data.payload.browserAccepted).toBe(0);
    expect(finalCall.data.payload.browserRejected).toBe(2);
  });

  // ── already-claimed artifact → no browser work ─────────────────────────

  it("skips browser work when claim returns count 0 (already claimed)", async () => {
    findManyMock.mockResolvedValue([makeArtifact()]);
    // Claim fails — another worker already claimed it
    updateManyMock.mockResolvedValue({ count: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.claimed).toBe(0);
      expect(result.skippedAlreadyClaimed).toBe(1);
    }
    // Only the claim attempt — no browser launch, no final status update
    expect(discoverArticleLinksWithBrowserMock).not.toHaveBeenCalled();
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  // ── invalid artifact → INVALID status ──────────────────────────────────

  it("marks invalid artifact as INVALID (missing targetUrl)", async () => {
    findManyMock.mockResolvedValue([
      makeArtifact({ payload: { sourceId: "src-1", quality: "weak" } }),
    ]);
    updateManyMock.mockResolvedValue({ count: 1 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.skippedInvalid).toBe(1);
    }
    expect(discoverArticleLinksWithBrowserMock).not.toHaveBeenCalled();
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "INVALID" }),
    }));
  });

  // ── dedupe: duplicate canonical URLs are skipped ───────────────────────

  it("deduplicates candidates by canonical URL", async () => {
    const dupUrl = "https://example.com/news/2026/07/20/duplicate-story";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: true,
      renderedUrl: "https://example.com/news",
      links: [makeBrowserLink(dupUrl), makeBrowserLink(dupUrl)],
      diagnostics: {
        pageTitle: "News",
        linkCount: 2,
        articleLikeLinkCount: 2,
        browserRuntimeAvailable: true,
        elapsedMs: 1000,
      },
    });
    // Both links evaluate to accepted with the same canonical URL
    evaluateArticleLinkCandidateMock
      .mockResolvedValueOnce(makeAcceptedEvaluation(dupUrl))
      .mockResolvedValueOnce(makeAcceptedEvaluation(dupUrl));
    persistCandidatesMock.mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserCandidatesFound).toBe(1); // deduped
      expect(result.browserResolved).toBe(1);
    }
    // Only 1 candidate should be persisted (the duplicate was skipped)
    expect(persistCandidatesMock).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ canonicalUrl: dupUrl })]),
    );
    const persistedArg = persistCandidatesMock.mock.calls[0]![0];
    expect(persistedArg).toHaveLength(1);
  });

  // ── compact browser metadata fields are present in the payload ────────

  it("includes all required compact browser metadata fields in the payload", async () => {
    const articleUrl = "https://example.com/news/2026/07/20/metadata-test";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: true,
      renderedUrl: "https://example.com/news",
      links: [makeBrowserLink(articleUrl)],
      diagnostics: {
        pageTitle: "News Page",
        linkCount: 15,
        articleLikeLinkCount: 1,
        browserRuntimeAvailable: true,
        elapsedMs: 2500,
      },
    });
    evaluateArticleLinkCandidateMock.mockResolvedValueOnce(makeAcceptedEvaluation(articleUrl));
    persistCandidatesMock.mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });

    const fn = await loadFn();
    await fn({ dryRun: false, runBrowser: true });

    const finalCall = updateManyMock.mock.calls[1]![0];
    const payload = finalCall.data.payload;
    // All required compact browser metadata fields
    expect(payload.browserFallbackRan).toBe(true);
    expect(payload.browserFallbackStartedAt).toBeDefined();
    expect(payload.browserFallbackFinishedAt).toBeDefined();
    expect(payload.browserRawLinks).toBe(15);
    expect(payload.browserEvaluated).toBe(1);
    expect(payload.browserAccepted).toBe(1);
    expect(payload.browserRejected).toBe(0);
    expect(payload.browserInserted).toBe(1);
    expect(payload.browserSkipped).toBeDefined();
    expect(payload.browserFailed).toBe(0);
    expect(payload.browserTopRejectionReasons).toEqual(expect.any(Array));
    expect(payload.browserError).toBeNull();
    expect(payload.browserOutcomeSummary).toBeDefined();
    expect(payload.browserOutcomeSummary.totalEvaluated).toBe(1);
    expect(payload.browserQualityAssessment).toBeDefined();
    expect(payload.browserQualityAssessment.quality).toBe("productive");
    expect(payload.renderedUrl).toBe("https://example.com/news");
    // No raw HTML, screenshots, or DOM dumps
    expect(payload).not.toHaveProperty("rawHtml");
    expect(payload).not.toHaveProperty("screenshot");
    expect(payload).not.toHaveProperty("domDump");
  });
});
