import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const findManyMock = vi.fn();
const updateManyMock = vi.fn();
const logAgentScanMock = vi.fn();
const isBrowserFallbackEnabledMock = vi.fn();
const discoverArticleLinksWithBrowserMock = vi.fn();
const evaluateArticleLinkCandidateMock = vi.fn();
const evaluateArticleLinkCandidateWithBrowserMock = vi.fn();
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
  evaluateArticleLinkCandidateWithBrowser: (...args: any[]) =>
    evaluateArticleLinkCandidateWithBrowserMock(...args),
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

const makeBrowserLink = (url: string, text = "Article", rawSignals: Record<string, unknown> = {}) => ({
  url,
  text,
  sourcePageUrl: `browser:https://example.com/news`,
  sourceKind: "browser" as const,
  rawSignals: { anchorText: text, score: 50, scoreReasons: [], ...rawSignals },
});

const makeBrowserResultOk = (links: any[], overrides: Record<string, any> = {}) => ({
  ok: true as const,
  renderedUrl: "https://example.com/news",
  links,
  rawLinkCount: links.length + 10,
  shortlistedLinkCount: links.length,
  topRejectedLinks: [] as any[],
  shortlistedLinkSamples: links.map((l: any) => ({
    url: l.url,
    normalizedUrl: l.url,
    anchorText: l.text,
    score: 50,
    rejected: false,
    reason: null,
    scoreReasons: [] as string[],
    sameDomain: true,
    utilityPath: false,
    categoryScoped: null,
  })),
  topRejectionReasons: [] as any[],
  diagnostics: {
    pageTitle: "News",
    linkCount: links.length + 10,
    articleLikeLinkCount: links.length,
    browserRuntimeAvailable: true,
    elapsedMs: 1500,
  },
  ...overrides,
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
    evaluateArticleLinkCandidateWithBrowserMock.mockReset();
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

  it("does not over-fetch when runBrowser=true but browser fallback is disabled", async () => {
    // When env flag is off, the queue should fetch only `limit` items, not
    // limit * 3. There are no cooldown checks to scan past.
    isBrowserFallbackEnabledMock.mockReturnValue(false);

    const artifacts = Array.from({ length: 6 }, (_, i) =>
      makeArtifact({ id: `art-${i}`, payload: { targetUrl: `https://example.com/news/${i}`, sourceId: `src-${i}` } }),
    );
    // Return all 6 artifacts — but the query should have used take: limit (2),
    // not take: 6. We verify this indirectly: only 2 should be marked
    // BROWSER_FALLBACK_DISABLED.
    findManyMock.mockResolvedValue(artifacts.slice(0, 2));
    updateManyMock.mockResolvedValue({ count: 1 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true, limit: 2 });

    // Verify the query used take: 2 (the limit), not take: 6 (limit*3)
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      take: 2,
    }));

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserSkippedDisabled).toBe(2);
      expect(result.browserResolved).toBe(0);
    }
    expect(discoverArticleLinksWithBrowserMock).not.toHaveBeenCalled();
    // Exactly 2 artifacts marked BROWSER_FALLBACK_DISABLED
    expect(updateManyMock).toHaveBeenCalledTimes(2);
    for (const call of updateManyMock.mock.calls) {
      expect(call[0].data.status).toBe("BROWSER_FALLBACK_DISABLED");
    }
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
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(link1), makeBrowserLink(link2)], {
        diagnostics: { pageTitle: "News", linkCount: 10, articleLikeLinkCount: 2, browserRuntimeAvailable: true, elapsedMs: 3000 },
      }),
    );
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
    // browserRawLinks comes from browserResult.rawLinkCount (makeBrowserResultOk default: links.length + 10 = 12)
    expect(finalCall.data.payload.browserRawLinks).toBe(12);
    expect(finalCall.data.payload.browserShortlistedLinks).toBe(2);
    expect(finalCall.data.payload.browserEvaluated).toBe(2);
    expect(finalCall.data.payload.browserQualityAssessment.quality).toBe("productive");
  });

  it("passes listing context date fallback into browser detail evaluation", async () => {
    const articleUrl = "https://example.com/news/278416836/arizona-heat-warning";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([
        makeBrowserLink(articleUrl, "Arizona heat warning remains in effect", {
          listingDateText: "10 July 2026",
        }),
      ]),
    );
    evaluateArticleLinkCandidateMock.mockResolvedValueOnce(makeAcceptedEvaluation(articleUrl));
    persistCandidatesMock.mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });

    const fn = await loadFn();
    await fn({ dryRun: false, runBrowser: true });

    expect(evaluateArticleLinkCandidateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        articleUrl,
        listingDateFallbackRaw: "10 July 2026",
      }),
    );
  });

  // ── browser returns only utility links → no candidates ────────────────

  it("marks as BROWSER_NO_CANDIDATES when browser returns only utility links", async () => {
    const utilityLink = "https://example.com/about";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(utilityLink)], {
        diagnostics: { pageTitle: "News", linkCount: 5, articleLikeLinkCount: 1, browserRuntimeAvailable: true, elapsedMs: 2000 },
      }),
    );
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
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(articleUrl)]),
    );
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
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(link1), makeBrowserLink(link2)], {
        diagnostics: { pageTitle: "News", linkCount: 4, articleLikeLinkCount: 2, browserRuntimeAvailable: true, elapsedMs: 1000 },
      }),
    );
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
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(dupUrl), makeBrowserLink(dupUrl)], {
        diagnostics: { pageTitle: "News", linkCount: 2, articleLikeLinkCount: 2, browserRuntimeAvailable: true, elapsedMs: 1000 },
      }),
    );
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
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(articleUrl)], {
        diagnostics: { pageTitle: "News Page", linkCount: 15, articleLikeLinkCount: 1, browserRuntimeAvailable: true, elapsedMs: 2500 },
      }),
    );
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
    // browserRawLinks comes from browserResult.rawLinkCount (makeBrowserResultOk default: links.length + 10 = 11)
    expect(payload.browserRawLinks).toBe(11);
    expect(payload.browserShortlistedLinks).toBe(1);
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

  // ── browser detail recovery ─────────────────────────────────────────────

  it("attempts browser detail recovery when static evaluation fails with fetch_failed", async () => {
    const articleUrl = "https://example.com/news/2026/07/20/recovered";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(articleUrl)]),
    );

    evaluateArticleLinkCandidateMock.mockResolvedValueOnce(
      makeRejectedEvaluation(articleUrl, "fetch_failed", "HTTP 403"),
    );
    evaluateArticleLinkCandidateWithBrowserMock.mockResolvedValueOnce(
      makeAcceptedEvaluation(articleUrl),
    );
    persistCandidatesMock.mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserResolved).toBe(1);
      expect(result.browserCandidatesFound).toBe(1);
    }

    expect(evaluateArticleLinkCandidateWithBrowserMock).toHaveBeenCalledTimes(1);
    expect(evaluateArticleLinkCandidateWithBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({ articleUrl }),
    );

    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("RESOLVED");
    expect(finalCall.data.payload.browserDetailEvaluated).toBe(1);
    expect(finalCall.data.payload.browserDetailAccepted).toBe(1);
    expect(finalCall.data.payload.browserDetailFetchRecovered).toBe(1);
    expect(finalCall.data.payload.browserDetailRecoveryReasons).toEqual(["fetch_failed"]);
  });

  it("does not attempt browser detail recovery for normal quality rejections", async () => {
    const articleUrl = "https://example.com/news/2026/07/20/stale";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(articleUrl)]),
    );

    evaluateArticleLinkCandidateMock.mockResolvedValueOnce(
      makeRejectedEvaluation(articleUrl, "rejected_stale", "stale"),
    );

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    expect(evaluateArticleLinkCandidateWithBrowserMock).not.toHaveBeenCalled();

    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("BROWSER_NO_CANDIDATES");
    expect(finalCall.data.payload.browserDetailEvaluated).toBe(0);
    expect(finalCall.data.payload.browserDetailAccepted).toBe(0);
  });

  it("enforces the max detail evaluation limit of 10", async () => {
    const links = Array.from({ length: 15 }, (_, i) =>
      makeBrowserLink(`https://example.com/news/2026/07/2${i}/story`),
    );
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk(links),
    );

    // All static evaluations fail with HTTP 403.
    for (const link of links) {
      evaluateArticleLinkCandidateMock.mockResolvedValueOnce(
        makeRejectedEvaluation(link.url, "fetch_failed", "HTTP 403"),
      );
      evaluateArticleLinkCandidateWithBrowserMock.mockResolvedValueOnce(
        makeRejectedEvaluation(link.url, "rejected_stale", "stale"),
      );
    }

    const fn = await loadFn();
    await fn({ dryRun: false, runBrowser: true });

    // totalDetailEvaluations limits to 10 (static + recovery combined)
    // Each link uses 2 evaluations (static + browser recovery), so 5 links = 10 evaluations
    expect(evaluateArticleLinkCandidateMock).toHaveBeenCalledTimes(5);
    expect(evaluateArticleLinkCandidateWithBrowserMock).toHaveBeenCalledTimes(5);

    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.payload.browserDetailEvaluated).toBe(5);
    expect(finalCall.data.payload.browserDetailAccepted).toBe(0);
    expect(finalCall.data.payload.browserDetailRejected).toBe(5);
  });

  it("keeps browser detail recovery failure non-fatal and records audit counters", async () => {
    const articleUrl = "https://example.com/news/2026/07/20/failure";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(articleUrl)]),
    );

    evaluateArticleLinkCandidateMock.mockResolvedValueOnce(
      makeRejectedEvaluation(articleUrl, "fetch_failed", "HTTP 403"),
    );
    evaluateArticleLinkCandidateWithBrowserMock.mockResolvedValueOnce(
      makeRejectedEvaluation(articleUrl, "detail_validation_failed", "navigation failed"),
    );

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserNoCandidates).toBe(1);
    }

    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("BROWSER_NO_CANDIDATES");
    expect(finalCall.data.payload.browserDetailEvaluated).toBe(1);
    expect(finalCall.data.payload.browserDetailRejected).toBe(1);
  });

  // ── Browser link audit fields are persisted ────────────────────────────

  it("persists browserTopRejectedLinks, browserShortlistedLinkSamples, and browserTopLinkRejectionReasons", async () => {
    const articleUrl = "https://example.com/news/2026/07/20/audit-test";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk(
        [makeBrowserLink(articleUrl)],
        {
          rawLinkCount: 663,
          shortlistedLinkCount: 1,
          topRejectedLinks: [
            { url: "https://example.com/about", normalizedUrl: null, anchorText: "About", score: 0, rejected: true, reason: "utility_path", scoreReasons: [], sameDomain: true, utilityPath: true, categoryScoped: null },
          ],
          shortlistedLinkSamples: [
            { url: articleUrl, normalizedUrl: articleUrl, anchorText: "Article", score: 50, rejected: false, reason: null, scoreReasons: [], sameDomain: true, utilityPath: false, categoryScoped: null },
          ],
          topRejectionReasons: [{ reason: "utility_path", count: 300 }, { reason: "different_domain", count: 200 }],
        },
      ),
    );
    evaluateArticleLinkCandidateMock.mockResolvedValueOnce(makeAcceptedEvaluation(articleUrl));
    persistCandidatesMock.mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });

    const fn = await loadFn();
    await fn({ dryRun: false, runBrowser: true });

    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.payload.browserRawLinks).toBe(663);
    expect(finalCall.data.payload.browserShortlistedLinks).toBe(1);
    expect(finalCall.data.payload.browserTopRejectedLinks).toHaveLength(1);
    expect(finalCall.data.payload.browserTopRejectedLinks[0].reason).toBe("utility_path");
    expect(finalCall.data.payload.browserShortlistedLinkSamples).toHaveLength(1);
    expect(finalCall.data.payload.browserTopLinkRejectionReasons).toHaveLength(2);
    expect(finalCall.data.payload.browserTopLinkRejectionReasons[0]).toEqual({ reason: "utility_path", count: 300 });
  });

  // ── Multiple detail evaluation: first rejected, second accepted ───────

  it("evaluates multiple shortlisted links and resolves if second is accepted", async () => {
    const link1 = "https://example.com/news/2026/07/20/first-rejected";
    const link2 = "https://example.com/news/2026/07/20/second-accepted";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(link1), makeBrowserLink(link2)]),
    );

    evaluateArticleLinkCandidateMock
      .mockResolvedValueOnce(makeRejectedEvaluation(link1, "rejected_stale", "stale"))
      .mockResolvedValueOnce(makeAcceptedEvaluation(link2));
    persistCandidatesMock.mockResolvedValue({ inserted: 1, skipped: 0, failed: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserResolved).toBe(1);
      expect(result.browserCandidatesFound).toBe(1);
    }
    expect(evaluateArticleLinkCandidateMock).toHaveBeenCalledTimes(2);

    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("RESOLVED");
    expect(finalCall.data.payload.browserAccepted).toBe(1);
    expect(finalCall.data.payload.browserRejected).toBe(1);
  });

  // ── All candidates missing date: BROWSER_NO_CANDIDATES with audit ──────

  it("marks BROWSER_NO_CANDIDATES with useful audit when all candidates missing date", async () => {
    const link1 = "https://example.com/news/2026/07/20/no-date-1";
    const link2 = "https://example.com/news/2026/07/20/no-date-2";
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk(
        [makeBrowserLink(link1), makeBrowserLink(link2)],
        {
          rawLinkCount: 500,
          shortlistedLinkCount: 2,
          topRejectedLinks: [],
          shortlistedLinkSamples: [
            { url: link1, normalizedUrl: link1, anchorText: "Story 1", score: 50, rejected: false, reason: null, scoreReasons: [], sameDomain: true, utilityPath: false, categoryScoped: null },
            { url: link2, normalizedUrl: link2, anchorText: "Story 2", score: 45, rejected: false, reason: null, scoreReasons: [], sameDomain: true, utilityPath: false, categoryScoped: null },
          ],
          topRejectionReasons: [],
        },
      ),
    );

    // Both rejected for missing date but with title (wouldAcceptWithWeakDate)
    evaluateArticleLinkCandidateMock
      .mockResolvedValueOnce({
        accepted: false,
        candidate: null,
        outcome: { url: link1, sourceKind: "browser", status: "rejected_stale", staleReason: "missing_published_at", title: "A Valid Article Title Here", reason: "missing publishedAt" },
      })
      .mockResolvedValueOnce({
        accepted: false,
        candidate: null,
        outcome: { url: link2, sourceKind: "browser", status: "rejected_stale", staleReason: "missing_published_at", title: "Another Valid Title Text", reason: "missing publishedAt" },
      });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserNoCandidates).toBe(1);
    }

    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("BROWSER_NO_CANDIDATES");
    expect(finalCall.data.payload.browserShortlistedLinks).toBe(2);
    expect(finalCall.data.payload.browserShortlistedLinkSamples).toHaveLength(2);
    // The reason should include the wouldAcceptWithWeakDate diagnostic flag
    const rejectedOutcomes = finalCall.data.payload.browserRejectedOutcomes;
    for (const outcome of rejectedOutcomes) {
      if (outcome.staleReason === "missing_published_at") {
        expect(outcome.reason).toContain("wouldAcceptWithWeakDate");
      }
    }
  });

  // ── MAX_BROWSER_ACCEPTED_CANDIDATES stops early ────────────────────────

  it("short-circuits browser detail evaluation after repeated HTTP 429 responses", async () => {
    const links = Array.from({ length: 5 }, (_, i) =>
      makeBrowserLink(`https://example.com/news/2026/07/2${i}/rate-limited-story`),
    );
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(makeBrowserResultOk(links));

    evaluateArticleLinkCandidateMock
      .mockResolvedValueOnce(makeRejectedEvaluation(links[0]!.url, "fetch_failed", "HTTP 429"))
      .mockResolvedValueOnce(makeRejectedEvaluation(links[1]!.url, "fetch_failed", "HTTP 429"))
      .mockResolvedValueOnce(makeAcceptedEvaluation(links[2]!.url));
    evaluateArticleLinkCandidateWithBrowserMock
      .mockResolvedValueOnce(makeRejectedEvaluation(links[0]!.url, "fetch_failed", "HTTP 429"))
      .mockResolvedValueOnce(makeRejectedEvaluation(links[1]!.url, "fetch_failed", "HTTP 429"));

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserNoCandidates).toBe(1);
      expect(result.browserResolved).toBe(0);
    }
    expect(evaluateArticleLinkCandidateMock).toHaveBeenCalledTimes(2);
    expect(evaluateArticleLinkCandidateWithBrowserMock).toHaveBeenCalledTimes(2);
    expect(persistCandidatesMock).not.toHaveBeenCalled();

    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.status).toBe("BROWSER_NO_CANDIDATES");
    expect(finalCall.data.payload.browserBlockedReason).toBe("http_429");
    expect(finalCall.data.payload.browserRateLimited).toBe(true);
    expect(finalCall.data.payload.browserRateLimitReason).toBe("http_429");
    expect(finalCall.data.payload.browserDetailEvaluationStoppedReason).toBe("rate_limited");
    expect(finalCall.data.payload.browserRateLimitedAt).toEqual(expect.any(String));
    expect(finalCall.data.payload.browserRetryAfterAt).toEqual(expect.any(String));
    expect(finalCall.data.payload.browserRateLimitedCount).toBe(2);
    expect(finalCall.data.payload.browserError).toContain("rate-limited");
    expect(finalCall.data.payload.browserEvaluated).toBe(2);
  });

  // ── Browser cooldown (Approach A) ───────────────────────────────────

  it("skips browser work when cooldown is active and keeps artifact as PENDING_HEADLESS", async () => {
    const targetUrl = "https://example.com/news";
    const now = new Date();
    const futureRetryAfter = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

    // First findMany = queue fetch (returns PENDING_HEADLESS artifacts)
    // Second findMany = cooldown check (returns rate-limited artifact for same target)
    findManyMock
      .mockResolvedValueOnce([makeArtifact({ payload: { targetUrl, sourceId: "src-1" } })])
      .mockResolvedValueOnce([{
        id: "art-rate-limited",
        payload: {
          targetUrl,
          browserRateLimited: true,
          browserRetryAfterAt: futureRetryAfter,
        },
      }]);
    updateManyMock.mockResolvedValue({ count: 1 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserCooldownSkipped).toBe(1);
      expect(result.browserProcessed).toBe(0);
      expect(result.browserResolved).toBe(0);
    }
    // Should NOT have launched browser work
    expect(discoverArticleLinksWithBrowserMock).not.toHaveBeenCalled();
    // Should update payload with cooldown metadata but keep PENDING_HEADLESS
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "PENDING_HEADLESS" }),
      data: expect.objectContaining({
        payload: expect.objectContaining({
          skippedDueToBrowserCooldown: true,
          browserCooldownUntil: futureRetryAfter,
          lastBrowserCooldownSkipAt: expect.any(String),
        }),
      }),
    }));
    // Should NOT change status away from PENDING_HEADLESS
    expect(updateManyMock).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "BROWSER_COOLDOWN_DEFERRED" }),
    }));
  });

  it("does NOT trigger cooldown for same sourceId/categoryId but different targetUrl", async () => {
    const differentTarget = "https://example.com/different-section";
    const now = new Date();
    const futureRetryAfter = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

    // First findMany = queue fetch, second = cooldown check with different targetUrl
    findManyMock
      .mockResolvedValueOnce([makeArtifact()])
      .mockResolvedValueOnce([{
        id: "art-other-target",
        payload: {
          targetUrl: differentTarget,
          browserRateLimited: true,
          browserRetryAfterAt: futureRetryAfter,
        },
      }]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: false,
      reason: "browser_runtime_unavailable",
      links: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: "not installed",
        browserRuntimeAvailable: false,
        elapsedMs: 5,
      },
    });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserCooldownSkipped).toBe(0);
      // Should have proceeded to browser work (and failed because runtime unavailable)
      expect(result.browserSkippedUnavailable).toBe(1);
    }
    expect(discoverArticleLinksWithBrowserMock).toHaveBeenCalled();
  });

  it("allows retry when cooldown has expired (browserRetryAfterAt in the past)", async () => {
    const targetUrl = "https://example.com/news";
    const pastRetryAfter = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    // First = queue fetch, second = cooldown check with expired cooldown
    findManyMock
      .mockResolvedValueOnce([makeArtifact({ payload: { targetUrl, sourceId: "src-1" } })])
      .mockResolvedValueOnce([{
        id: "art-expired-cooldown",
        payload: {
          targetUrl,
          browserRateLimited: true,
          browserRetryAfterAt: pastRetryAfter,
        },
      }]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: false,
      reason: "browser_runtime_unavailable",
      links: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: "not installed",
        browserRuntimeAvailable: false,
        elapsedMs: 5,
      },
    });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserCooldownSkipped).toBe(0);
      // Should have proceeded to browser work
      expect(result.browserSkippedUnavailable).toBe(1);
    }
    expect(discoverArticleLinksWithBrowserMock).toHaveBeenCalled();
  });

  it("ignores artifacts with missing/malformed payload targetUrl in cooldown check", async () => {
    const now = new Date();
    const futureRetryAfter = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

    // First = queue fetch, second = cooldown check with missing targetUrl
    findManyMock
      .mockResolvedValueOnce([makeArtifact()])
      .mockResolvedValueOnce([{
        id: "art-no-target",
        payload: {
          browserRateLimited: true,
          browserRetryAfterAt: futureRetryAfter,
          // targetUrl is missing
        },
      }]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: false,
      reason: "browser_runtime_unavailable",
      links: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: "not installed",
        browserRuntimeAvailable: false,
        elapsedMs: 5,
      },
    });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserCooldownSkipped).toBe(0);
      // Should have proceeded (malformed targetUrl in cooldown artifact is ignored)
      expect(result.browserSkippedUnavailable).toBe(1);
    }
    expect(discoverArticleLinksWithBrowserMock).toHaveBeenCalled();
  });

  it("cooldown item does not block later queue items from processing", async () => {
    const cooldownUrl = "https://example.com/news";
    const laterUrl = "https://example.com/tech";
    const now = new Date();
    const futureRetryAfter = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

    // First = queue fetch (both artifacts), second = cooldown check for art-1
    // Third = cooldown check for art-2 (different target, no cooldown)
    findManyMock
      .mockResolvedValueOnce([
        makeArtifact({ id: "art-1", payload: { targetUrl: cooldownUrl, sourceId: "src-1" } }),
        makeArtifact({ id: "art-2", payload: { targetUrl: laterUrl, sourceId: "src-1" } }),
      ])
      .mockResolvedValueOnce([{
        id: "art-cooldown",
        payload: { targetUrl: cooldownUrl, browserRateLimited: true, browserRetryAfterAt: futureRetryAfter },
      }])
      .mockResolvedValueOnce([]); // art-2 has different targetUrl, no cooldown match

    // First updateMany = cooldown payload update (art-1)
    // Second updateMany = claim (art-2)
    // Third updateMany = final status (art-2)
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue({
      ok: false,
      reason: "browser_runtime_unavailable",
      links: [],
      diagnostics: {
        pageTitle: null,
        linkCount: 0,
        articleLikeLinkCount: 0,
        blockedReason: "not installed",
        browserRuntimeAvailable: false,
        elapsedMs: 5,
      },
    });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserCooldownSkipped).toBe(1);
      // Second artifact should have been processed (runtime unavailable)
      expect(result.browserSkippedUnavailable).toBe(1);
    }
    // Browser work should have been attempted for the second artifact
    expect(discoverArticleLinksWithBrowserMock).toHaveBeenCalledTimes(1);
  });

  // ── Browser work cap enforcement ────────────────────────────────────

  it("caps real browser work to limit even when fetchLimit returns more items", async () => {
    // limit=2, findMany returns 6 valid non-cooldown artifacts
    // Only 2 should get browser claims/work; the rest are skipped by the cap.
    const links = Array.from({ length: 6 }, (_, i) =>
      makeBrowserLink(`https://example.com/news/2026/07/2${i}/story`),
    );
    const artifacts = links.map((l, i) =>
      makeArtifact({ id: `art-${i}`, payload: { targetUrl: l.url, sourceId: "src-1" } }),
    );

    // Each artifact needs a cooldown check (findMany) before the cap is evaluated.
    // Items 0 and 1: cooldown check (no match) → claim → browser work
    // Item 2: cooldown check (no match) → cap hit (browserAttemptedTargets >= limit) → break
    findManyMock
      .mockResolvedValueOnce(artifacts)  // queue fetch
      .mockResolvedValueOnce([])         // cooldown check art-0
      .mockResolvedValueOnce([])         // cooldown check art-1
      .mockResolvedValueOnce([]);        // cooldown check art-2 (cap hit, break)

    updateManyMock.mockResolvedValue({ count: 1 });
    // Use a successful-but-empty browser result so browserProcessed increments.
    // (browser_runtime_unavailable goes to the failure path which doesn't
    // increment browserProcessed — that counter is for completed browser runs.)
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([], {
        diagnostics: { pageTitle: "Empty", linkCount: 0, articleLikeLinkCount: 0, browserRuntimeAvailable: true, elapsedMs: 50 },
      }),
    );
    persistCandidatesMock.mockResolvedValue({ inserted: 0, skipped: 0, failed: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true, limit: 2 });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      // Only 2 browser targets should have been attempted (the limit)
      expect(result.browserAttemptedTargets).toBe(2);
      expect(result.browserProcessed).toBe(2);
      expect(result.browserNoCandidates).toBe(2);
    }
    // Browser work should have been called exactly twice
    expect(discoverArticleLinksWithBrowserMock).toHaveBeenCalledTimes(2);
  });

  it("cooldown-skipped items do not consume the browser work cap", async () => {
    // limit=2. First 2 items are cooldown-skipped, next 2 are valid.
    // All 4 are fetched (fetchLimit >= 4), but only 2 valid ones run browser work.
    const cooldownUrl = "https://example.com/news";
    const validUrl1 = "https://example.com/tech";
    const validUrl2 = "https://example.com/sports";
    const now = new Date();
    const futureRetryAfter = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

    const artifacts = [
      makeArtifact({ id: "art-cool-1", payload: { targetUrl: cooldownUrl, sourceId: "src-1" } }),
      makeArtifact({ id: "art-cool-2", payload: { targetUrl: cooldownUrl, sourceId: "src-1" } }),
      makeArtifact({ id: "art-valid-1", payload: { targetUrl: validUrl1, sourceId: "src-1" } }),
      makeArtifact({ id: "art-valid-2", payload: { targetUrl: validUrl2, sourceId: "src-1" } }),
    ];

    const cooldownArtifact = {
      id: "art-rate-limited",
      payload: { targetUrl: cooldownUrl, browserRateLimited: true, browserRetryAfterAt: futureRetryAfter },
    };

    // Each artifact needs a cooldown check (findMany) before the cap is evaluated.
    // art-cool-1: cooldown match → skip (no cap consumed)
    // art-cool-2: cooldown match → skip (no cap consumed)
    // art-valid-1: no cooldown → claim → browser work (attempted=1)
    // art-valid-2: no cooldown → claim → browser work (attempted=2)
    findManyMock
      .mockResolvedValueOnce(artifacts)          // queue fetch
      .mockResolvedValueOnce([cooldownArtifact]) // cooldown check art-cool-1
      .mockResolvedValueOnce([cooldownArtifact]) // cooldown check art-cool-2
      .mockResolvedValueOnce([])                 // cooldown check art-valid-1
      .mockResolvedValueOnce([]);                // cooldown check art-valid-2

    updateManyMock.mockResolvedValue({ count: 1 });
    // Use a successful-but-empty browser result so browserProcessed increments.
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([], {
        diagnostics: { pageTitle: "Empty", linkCount: 0, articleLikeLinkCount: 0, browserRuntimeAvailable: true, elapsedMs: 50 },
      }),
    );
    persistCandidatesMock.mockResolvedValue({ inserted: 0, skipped: 0, failed: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true, limit: 2 });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserCooldownSkipped).toBe(2);
      // The 2 valid items should have run browser work despite 2 cooldown skips
      expect(result.browserAttemptedTargets).toBe(2);
      expect(result.browserProcessed).toBe(2);
    }
    expect(discoverArticleLinksWithBrowserMock).toHaveBeenCalledTimes(2);
  });

  it("counts cooldown updateMany count=0 as race-skipped, not cooldown-skipped", async () => {
    const targetUrl = "https://example.com/news";
    const now = new Date();
    const futureRetryAfter = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

    findManyMock
      .mockResolvedValueOnce([makeArtifact({ payload: { targetUrl, sourceId: "src-1" } })])
      .mockResolvedValueOnce([{
        id: "art-rate-limited",
        payload: { targetUrl, browserRateLimited: true, browserRetryAfterAt: futureRetryAfter },
      }]);

    // Cooldown updateMany returns count=0 (another worker claimed it)
    updateManyMock.mockResolvedValueOnce({ count: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });

    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      // Should be counted as race-skipped, NOT cooldown-skipped
      expect(result.browserCooldownSkipped).toBe(0);
      expect(result.skippedAlreadyClaimed).toBe(1);
      expect(result.browserAttemptedTargets).toBe(0);
    }
    expect(discoverArticleLinksWithBrowserMock).not.toHaveBeenCalled();
  });

  it("clears cooldown metadata on successful browser run", async () => {
    const articleUrl = "https://example.com/news/2026/07/20/after-cooldown";
    // First = queue fetch, second = cooldown check (no active cooldown)
    findManyMock
      .mockResolvedValueOnce([makeArtifact({
        payload: {
          targetUrl: "https://example.com/news",
          sourceId: "src-1",
          skippedDueToBrowserCooldown: true,
          browserCooldownUntil: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      })])
      .mockResolvedValueOnce([]); // no cooldown artifacts
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk([makeBrowserLink(articleUrl)]),
    );
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
    // Cooldown metadata should be cleared on success
    expect(finalCall.data.payload.skippedDueToBrowserCooldown).toBe(false);
    expect(finalCall.data.payload.browserCooldownUntil).toBeNull();
  });

  it("stops evaluating after MAX_BROWSER_ACCEPTED_CANDIDATES accepted", async () => {
    const links = Array.from({ length: 15 }, (_, i) =>
      makeBrowserLink(`https://example.com/news/2026/07/2${i}/story`),
    );
    findManyMock.mockResolvedValue([makeArtifact()]);
    updateManyMock.mockResolvedValue({ count: 1 });
    discoverArticleLinksWithBrowserMock.mockResolvedValue(
      makeBrowserResultOk(links),
    );

    // First 10 accept, rest would accept too
    for (const link of links) {
      evaluateArticleLinkCandidateMock.mockResolvedValueOnce(makeAcceptedEvaluation(link.url));
    }
    persistCandidatesMock.mockResolvedValue({ inserted: 10, skipped: 0, failed: 0 });

    const fn = await loadFn();
    await fn({ dryRun: false, runBrowser: true });

    // Should only evaluate 10 before stopping
    expect(evaluateArticleLinkCandidateMock).toHaveBeenCalledTimes(10);

    const finalCall = updateManyMock.mock.calls[1]![0];
    expect(finalCall.data.payload.browserAccepted).toBe(10);
  });
});
