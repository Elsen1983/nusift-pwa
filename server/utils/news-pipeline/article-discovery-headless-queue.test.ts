import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.fn();
const updateMock = vi.fn();
const logAgentScanMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findMany: (...args: any[]) => findManyMock(...args),
      update: (...args: any[]) => updateMock(...args),
      updateMany: (...args: any[]) => updateMock(...args),
    },
  },
}));

vi.mock("./log", () => ({
  logAgentScan: (...args: any[]) => logAgentScanMock(...args),
}));

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
    explanation: "No candidates found.",
  },
});

describe("processArticleDiscoveryHeadlessQueue", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    updateMock.mockReset();
    logAgentScanMock.mockReset();
    logAgentScanMock.mockResolvedValue(undefined);
  });

  async function loadFn() {
    const mod = await import("./article-discovery-headless-queue");
    return mod.processArticleDiscoveryHeadlessQueue;
  }

  it("defaults to dry-run mode when no input provided", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadFn();
    const result = await fn();
    expect(result.dryRun).toBe(true);
    expect(findManyMock).toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("defaults to dry-run mode when dryRun is not explicitly false", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadFn();
    const result = await fn({ limit: 5 });
    expect(result.dryRun).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("reports inspected, wouldProcess, and skippedInvalid in dry-run", async () => {
    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a", sourceId: "src-1", quality: "blocked" } }),
      makeArtifact({ id: "art-2", payload: { targetUrl: "https://example.com/b", sourceId: "src-1", quality: "failed" } }),
      makeArtifact({ id: "art-3", payload: { quality: "weak" } }),
    ]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, limit: 10 });
    expect(result.dryRun).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
    if (result.dryRun) {
      expect(result.inspected).toBe(3);
      expect(result.wouldProcess).toBe(2);
      expect(result.skippedInvalid).toBe(1);
      expect(result.artifacts).toHaveLength(3);
      expect(result.artifacts[0]!.valid).toBe(true);
      expect(result.artifacts[1]!.valid).toBe(true);
      expect(result.artifacts[2]!.valid).toBe(false);
      expect(result.artifacts[2]!.invalidReason).toContain("targetUrl");
    }
  });

  it("reports invalid when sourceId is missing", async () => {
    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a" } }),
    ]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true });
    expect(result.dryRun).toBe(true);
    if (result.dryRun) {
      expect(result.artifacts[0]!.valid).toBe(false);
      expect(result.artifacts[0]!.invalidReason).toContain("sourceId");
    }
  });

  it("marks valid artifacts as SKIPPED_UNIMPLEMENTED in non-dry-run", async () => {
    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a", sourceId: "src-1", quality: "blocked" } }),
      makeArtifact({ id: "art-2", payload: { targetUrl: "https://example.com/b", sourceId: "src-1", quality: "failed" } }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });
    const fn = await loadFn();
    const result = await fn({ dryRun: false, limit: 10 });
    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.processed).toBe(2);
      expect(result.skippedInvalid).toBe(0);
      expect(result.skippedAlreadyClaimed).toBe(0);
      expect(result.updatedArtifactIds).toEqual(["art-1", "art-2"]);
    }
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "art-1", status: "PENDING_HEADLESS" }),
      data: expect.objectContaining({ status: "SKIPPED_UNIMPLEMENTED" }),
    }));
  });

  it("marks invalid artifacts as INVALID in non-dry-run", async () => {
    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { quality: "weak" } }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });
    const fn = await loadFn();
    const result = await fn({ dryRun: false, limit: 10 });
    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.processed).toBe(0);
      expect(result.skippedInvalid).toBe(1);
      expect(result.skippedAlreadyClaimed).toBe(0);
      expect(result.updatedArtifactIds).toEqual(["art-1"]);
    }
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "art-1", status: "PENDING_HEADLESS" }),
      data: expect.objectContaining({ status: "INVALID" }),
    }));
  });

  it("does not update DB in dry-run even with invalid artifacts", async () => {
    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { quality: "weak" } }),
    ]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("caps limit at MAX_LIMIT (25)", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadFn();
    await fn({ dryRun: true, limit: 100 });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }));
  });

  it("uses default limit of 5 when not specified", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadFn();
    await fn({ dryRun: true });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
  });

  it("clamps limit to minimum of 1", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadFn();
    await fn({ dryRun: true, limit: 0 });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
  });

  it("increments skippedAlreadyClaimed when valid artifact updateMany returns count 0", async () => {
    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a", sourceId: "src-1", quality: "blocked" } }),
    ]);
    updateMock.mockResolvedValue({ count: 0 });
    const fn = await loadFn();
    const result = await fn({ dryRun: false });
    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.processed).toBe(0);
      expect(result.skippedAlreadyClaimed).toBe(1);
      expect(result.updatedArtifactIds).toEqual([]);
    }
  });

  it("increments skippedAlreadyClaimed when invalid artifact updateMany returns count 0", async () => {
    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { quality: "weak" } }),
    ]);
    updateMock.mockResolvedValue({ count: 0 });
    const fn = await loadFn();
    const result = await fn({ dryRun: false });
    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.skippedInvalid).toBe(0);
      expect(result.skippedAlreadyClaimed).toBe(1);
      expect(result.updatedArtifactIds).toEqual([]);
    }
  });

  it("queries only PENDING_HEADLESS artifacts ordered by createdAt ascending", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadFn();
    await fn({ dryRun: true });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        artifactType: "article_discovery_headless_required",
        status: "PENDING_HEADLESS",
      },
      orderBy: { createdAt: "asc" },
    }));
  });

  it("logs start and finish events", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadFn();
    await fn({ dryRun: true });
    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ARTICLE_DISCOVERY_HEADLESS_QUEUE_STARTED" }),
    );
    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ARTICLE_DISCOVERY_HEADLESS_QUEUE_FINISHED" }),
    );
  });

  it("logs per-artifact SKIPPED events in non-dry-run mode", async () => {
    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a", sourceId: "src-1", quality: "blocked" } }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });
    const fn = await loadFn();
    await fn({ dryRun: false });
    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ARTICLE_DISCOVERY_HEADLESS_SKIPPED" }),
    );
  });

  it("handles empty queue gracefully", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true });
    expect(result.dryRun).toBe(true);
    if (result.dryRun) {
      expect(result.inspected).toBe(0);
      expect(result.wouldProcess).toBe(0);
      expect(result.skippedInvalid).toBe(0);
      expect(result.artifacts).toEqual([]);
    }
  });

  // ── Browser fallback integration tests ──────────────────────────────

  it("marks artifact as BROWSER_FALLBACK_DISABLED when runBrowser=true but env flag is off", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    delete process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;

    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a", sourceId: "src-1", quality: "blocked" } }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });
    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });
    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.browserSkippedDisabled).toBe(1);
      expect(result.processed).toBe(0);
    }
    // Env disabled marks directly from PENDING_HEADLESS (no claim needed)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "art-1", status: "PENDING_HEADLESS" }),
      data: expect.objectContaining({ status: "BROWSER_FALLBACK_DISABLED" }),
    }));

    if (original !== undefined) {
      process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original;
    } else {
      delete process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    }
  });

  it("claims artifact before launching browser work", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    // Mock the browser resolver to return runtime unavailable
    // so we can verify the claim happened before browser launch
    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a", sourceId: "src-1", quality: "blocked" } }),
    ]);
    // First updateMany = claim (PENDING_HEADLESS → HEADLESS_PROCESSING)
    // Second updateMany = final status (HEADLESS_PROCESSING → BROWSER_RUNTIME_UNAVAILABLE)
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });
    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.claimed).toBe(1);
    }
    // First updateMany call should claim from PENDING_HEADLESS → HEADLESS_PROCESSING
    expect(updateMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: "art-1", status: "PENDING_HEADLESS" }),
      data: expect.objectContaining({ status: "HEADLESS_PROCESSING" }),
    }));
    // Second updateMany call should transition from HEADLESS_PROCESSING → final status
    expect(updateMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ id: "art-1", status: "HEADLESS_PROCESSING" }),
    }));

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("skips browser work when claim returns count 0", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a", sourceId: "src-1", quality: "blocked" } }),
    ]);
    // Claim fails — artifact already taken by another worker
    updateMock.mockResolvedValue({ count: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, runBrowser: true });
    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.claimed).toBe(0);
      expect(result.skippedAlreadyClaimed).toBe(1);
      // Only the claim attempt should have been made
      expect(updateMock).toHaveBeenCalledTimes(1);
    }

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("caps limit at 3 when runBrowser=true", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadFn();
    await fn({ dryRun: true, runBrowser: true, limit: 10 });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
  });

  it("does not run browser in dry-run mode even when runBrowser=true", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a", sourceId: "src-1", quality: "blocked" } }),
    ]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, runBrowser: true });
    expect(result.dryRun).toBe(true);
    // Dry-run must not claim or update any artifacts
    expect(updateMock).not.toHaveBeenCalled();

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });

  it("non-dry-run without runBrowser defaults to SKIPPED_UNIMPLEMENTED", async () => {
    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a", sourceId: "src-1", quality: "blocked" } }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });
    const fn = await loadFn();
    const result = await fn({ dryRun: false });
    expect(result.dryRun).toBe(false);
    if (!result.dryRun) {
      expect(result.processed).toBe(1);
      expect(result.browserProcessed).toBeUndefined();
    }
    // Non-browser path uses PENDING_HEADLESS → SKIPPED_UNIMPLEMENTED (no claim)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "art-1", status: "PENDING_HEADLESS" }),
      data: expect.objectContaining({ status: "SKIPPED_UNIMPLEMENTED" }),
    }));
  });

  it("claims include headlessProcessingStartedAt and headlessProcessingMode in payload", async () => {
    const original = process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK;
    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = "true";

    findManyMock.mockResolvedValue([
      makeArtifact({ id: "art-1", payload: { targetUrl: "https://example.com/a", sourceId: "src-1", quality: "blocked" } }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadFn();
    await fn({ dryRun: false, runBrowser: true });

    // Claim payload should include processing metadata for stale recovery
    const claimCall = updateMock.mock.calls[0]![0];
    expect(claimCall.data.payload.headlessProcessingStartedAt).toBeDefined();
    expect(claimCall.data.payload.headlessProcessingMode).toBe("browser");

    process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK = original || "";
  });
});

// ─── Stale HEADLESS_PROCESSING Recovery Tests ──────────────────────────────

describe("recoverStaleArticleDiscoveryHeadlessProcessing", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    updateMock.mockReset();
    logAgentScanMock.mockReset();
    logAgentScanMock.mockResolvedValue(undefined);
  });

  async function loadRecovery() {
    const mod = await import("./article-discovery-headless-queue");
    return mod.recoverStaleArticleDiscoveryHeadlessProcessing;
  }

  function makeProcessingArtifact(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    const startedMinutesAgo = (overrides._startedMinutesAgo as number) ?? 45;
    const startedAt = new Date(now.getTime() - startedMinutesAgo * 60 * 1000);

    return {
      id: (overrides.id as string) ?? "art-stale-1",
      sourceId: (overrides.sourceId as string | null) ?? "src-1",
      categoryId: (overrides.categoryId as string | null) ?? null,
      createdAt: (overrides.createdAt as Date) ?? new Date("2026-07-16T10:00:00Z"),
      payload: {
        targetUrl: "https://example.com/news",
        sourceId: "src-1",
        quality: "failed",
        headlessProcessingStartedAt: startedAt.toISOString(),
        headlessProcessingMode: "browser",
        ...(overrides.payload as Record<string, unknown> || {}),
      },
    };
  }

  it("retries stale HEADLESS_PROCESSING artifact in retry mode", async () => {
    findManyMock.mockResolvedValue([
      makeProcessingArtifact({ id: "art-stale-1", _startedMinutesAgo: 45 }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadRecovery();
    const result = await fn({ mode: "retry" });

    expect(result.inspected).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.failedStale).toBe(0);
    expect(result.skippedAlreadyChanged).toBe(0);
    expect(result.artifactIds).toEqual(["art-stale-1"]);

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "art-stale-1", status: "HEADLESS_PROCESSING" }),
      data: expect.objectContaining({ status: "PENDING_HEADLESS" }),
    }));
  });

  it("marks stale artifact as HEADLESS_PROCESSING_STALE in fail mode", async () => {
    findManyMock.mockResolvedValue([
      makeProcessingArtifact({ id: "art-stale-1", _startedMinutesAgo: 60 }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadRecovery();
    const result = await fn({ mode: "fail" });

    expect(result.inspected).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.failedStale).toBe(1);
    expect(result.artifactIds).toEqual(["art-stale-1"]);

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "art-stale-1", status: "HEADLESS_PROCESSING" }),
      data: expect.objectContaining({ status: "HEADLESS_PROCESSING_STALE" }),
    }));
  });

  it("does not touch non-stale (fresh) artifacts", async () => {
    // Artifact started only 5 minutes ago — within default 30min threshold
    findManyMock.mockResolvedValue([
      makeProcessingArtifact({ id: "art-fresh-1", _startedMinutesAgo: 5 }),
    ]);

    const fn = await loadRecovery();
    const result = await fn({ mode: "retry" });

    expect(result.inspected).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.failedStale).toBe(0);
    expect(result.skippedAlreadyChanged).toBe(0);
    expect(result.artifactIds).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("skips artifacts with missing headlessProcessingStartedAt", async () => {
    // Override headlessProcessingStartedAt to null — the helper always sets
    // a default value, so we must explicitly null it out to simulate missing data.
    findManyMock.mockResolvedValue([
      makeProcessingArtifact({ id: "art-no-ts", payload: { headlessProcessingStartedAt: null } }),
    ]);
    updateMock.mockResolvedValue({ count: 0 });

    const fn = await loadRecovery();
    const result = await fn({ mode: "retry" });

    expect(result.inspected).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.artifactIds).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("emits ARTICLE_DISCOVERY_HEADLESS_RECOVERY_FAILED log when findMany throws", async () => {
    findManyMock.mockRejectedValue(new Error("DB connection lost"));

    const fn = await loadRecovery();
    await expect(fn()).rejects.toThrow("DB connection lost");

    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_FAILED",
        errorLog: expect.stringContaining("DB connection lost"),
      }),
    );
  });

  it("increments headlessRecoveryCount in fail mode", async () => {
    findManyMock.mockResolvedValue([
      makeProcessingArtifact({
        id: "art-stale-1",
        _startedMinutesAgo: 45,
        payload: { headlessRecoveryCount: 1 },
      }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadRecovery();
    await fn({ mode: "fail" });

    const updateCall = updateMock.mock.calls[0]![0];
    expect(updateCall.data.payload.headlessRecoveryCount).toBe(2);
    expect(updateCall.data.payload.lastHeadlessRecoveryAt).toBeDefined();
  });

  it("increments skippedAlreadyChanged when compare-and-set returns count 0", async () => {
    findManyMock.mockResolvedValue([
      makeProcessingArtifact({ id: "art-stale-1", _startedMinutesAgo: 45 }),
    ]);
    updateMock.mockResolvedValue({ count: 0 });

    const fn = await loadRecovery();
    const result = await fn({ mode: "retry" });

    expect(result.inspected).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.skippedAlreadyChanged).toBe(1);
    expect(result.artifactIds).toEqual([]);
  });

  it("increments headlessRecoveryCount on retry", async () => {
    findManyMock.mockResolvedValue([
      makeProcessingArtifact({
        id: "art-stale-1",
        _startedMinutesAgo: 45,
        payload: { headlessRecoveryCount: 2 },
      }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadRecovery();
    await fn({ mode: "retry" });

    const updateCall = updateMock.mock.calls[0]![0];
    expect(updateCall.data.payload.headlessRecoveryCount).toBe(3);
    expect(updateCall.data.payload.lastHeadlessRecoveryAt).toBeDefined();
  });

  it("sets headlessRecoveryCount to 1 on first recovery", async () => {
    findManyMock.mockResolvedValue([
      makeProcessingArtifact({ id: "art-stale-1", _startedMinutesAgo: 45 }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadRecovery();
    await fn({ mode: "retry" });

    const updateCall = updateMock.mock.calls[0]![0];
    expect(updateCall.data.payload.headlessRecoveryCount).toBe(1);
  });

  it("clamps limit between 1 and 50, scanLimit between 50 and 250", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadRecovery();

    // limit=0 → clamped to 1; scanLimit = max(1*5, 50) = 50
    await fn({ limit: 0 });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));

    findManyMock.mockResolvedValue([]);
    // limit=200 → clamped to 50; scanLimit = min(50*5, 250) = 250
    await fn({ limit: 200 });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 250 }));
  });

  it("uses default limit of 10 and scanLimit of 50", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadRecovery();
    await fn();

    // scanLimit = max(limit * 5, 50) = max(50, 50) = 50
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    // Verify the STARTED log mentions both values
    const startedCall = logAgentScanMock.mock.calls.find(
      (c: any[]) => c[0]?.status === "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_STARTED",
    );
    expect(startedCall).toBeDefined();
    expect(startedCall![0].errorLog).toContain("olderThanMinutes=30");
    expect(startedCall![0].errorLog).toContain("scanLimit=50");
  });

  it("scanLimit is larger than recovery limit", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadRecovery();
    await fn({ limit: 5 });

    // scanLimit = max(5 * 5, 50) = 50
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
  });

  it("only recovers stale artifacts when mixed with fresh ones", async () => {
    const fresh = makeProcessingArtifact({ id: "art-fresh-1", _startedMinutesAgo: 5 });
    const stale1 = makeProcessingArtifact({ id: "art-stale-1", _startedMinutesAgo: 45 });
    const stale2 = makeProcessingArtifact({ id: "art-stale-2", _startedMinutesAgo: 60 });
    findManyMock.mockResolvedValue([fresh, stale1, stale2]);
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadRecovery();
    const result = await fn({ mode: "retry" });

    // inspected = 3 (all queried), staleFound = 2, recovered = 2
    expect(result.inspected).toBe(3);
    expect(result.staleFound).toBe(2);
    expect(result.recovered).toBe(2);
    expect(result.artifactIds).toEqual(["art-stale-1", "art-stale-2"]);
    // Only 2 updateMany calls (stale artifacts), not 3
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it("only processes up to limit stale artifacts when staleFound > limit", async () => {
    const stale1 = makeProcessingArtifact({ id: "art-stale-1", _startedMinutesAgo: 45 });
    const stale2 = makeProcessingArtifact({ id: "art-stale-2", _startedMinutesAgo: 50 });
    const stale3 = makeProcessingArtifact({ id: "art-stale-3", _startedMinutesAgo: 60 });
    findManyMock.mockResolvedValue([stale1, stale2, stale3]);
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadRecovery();
    const result = await fn({ limit: 2, mode: "retry" });

    expect(result.staleFound).toBe(3);
    expect(result.recovered).toBe(2);
    expect(result.artifactIds).toEqual(["art-stale-1", "art-stale-2"]);
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it("staleFound reflects all stale in scanned batch even beyond limit", async () => {
    const stale1 = makeProcessingArtifact({ id: "art-stale-1", _startedMinutesAgo: 45 });
    const stale2 = makeProcessingArtifact({ id: "art-stale-2", _startedMinutesAgo: 50 });
    const stale3 = makeProcessingArtifact({ id: "art-stale-3", _startedMinutesAgo: 60 });
    findManyMock.mockResolvedValue([stale1, stale2, stale3]);
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadRecovery();
    const result = await fn({ limit: 1 });

    // staleFound includes all 3 even though only 1 was processed
    expect(result.staleFound).toBe(3);
    expect(result.recovered).toBe(1);
  });

  it("FINISHED log includes staleFound", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadRecovery();
    await fn();

    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_FINISHED",
        errorLog: expect.stringContaining("staleFound=0"),
      }),
    );
  });

  it("logs STARTED and FINISHED events", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadRecovery();
    await fn();

    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_STARTED" }),
    );
    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_FINISHED" }),
    );
  });

  it("uses custom olderThanMinutes threshold", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadRecovery();
    await fn({ olderThanMinutes: 60 });

    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_STARTED",
        errorLog: expect.stringContaining("olderThanMinutes=60"),
      }),
    );
  });

  it("clamps scanLimit between 50 and 250", async () => {
    findManyMock.mockResolvedValue([]);
    const fn = await loadRecovery();

    // limit=1 → scanLimit = max(1*5, 50) = 50
    await fn({ limit: 1 });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));

    findManyMock.mockResolvedValue([]);
    // limit=50 → scanLimit = min(50*5, 250) = 250
    await fn({ limit: 50 });
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 250 }));
  });

  it("defaults to retry mode", async () => {
    findManyMock.mockResolvedValue([
      makeProcessingArtifact({ id: "art-stale-1", _startedMinutesAgo: 45 }),
    ]);
    updateMock.mockResolvedValue({ count: 1 });

    const fn = await loadRecovery();
    const result = await fn();

    expect(result.recovered).toBe(1);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PENDING_HEADLESS" }),
    }));
  });
});
