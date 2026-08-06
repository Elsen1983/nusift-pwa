import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_INSPECTION_MAX_DATE_RANGE_DAYS, ADMIN_INSPECTION_MAX_LIMIT, classifyInspectionArticleState,
  deriveInspectionFlags, getInspectionPipelineStage, normalizeBodyPreview, normalizeInspectionDateRange,
  safeInspectionUrl, clampInspectionLimit, validateInspectionDateRange, resolveInspectionActivity, deriveInspectionActivityEvidence,
  adaptInspectionLifecycleEvidence, loadBodyReadinessEvidence,
} from "./admin-inspection";

describe("admin inspection helpers", () => {
  it("redacts query credentials and bounds pagination/date windows", () => {
    expect(safeInspectionUrl("https://user:secret@example.com/a?token=hidden#x")).toBe("https://example.com/a");
    expect(clampInspectionLimit("999")).toBe(ADMIN_INSPECTION_MAX_LIMIT);
    const range = normalizeInspectionDateRange({ dateFrom: "2020-01-01T00:00:00.000Z", dateTo: "2026-08-06T00:00:00.000Z", now: new Date("2026-08-06T00:00:00.000Z") });
    expect(range.days).toBe(ADMIN_INSPECTION_MAX_DATE_RANGE_DAYS);
  });

  it("never treats omitted or short body text as published", () => {
    const base = { title: "A", canonicalUrl: "https://example.com/a", publicationStatus: "PUBLISHED", publicationStage: "agent3", publicationReadyAt: new Date(), enrichmentStatus: "ENRICHED" };
    expect(classifyInspectionArticleState(base)).not.toBe("PUBLISHED");
    expect(classifyInspectionArticleState({ ...base, bodyText: "x".repeat(499) })).not.toBe("PUBLISHED");
    expect(classifyInspectionArticleState({ ...base, bodyText: "x".repeat(500) })).toBe("PUBLISHED");
    expect(classifyInspectionArticleState({ ...base, publicationStatus: "REJECTED" })).toBe("REJECTED");
  });

  it("rejects unsafe custom ranges without silently clamping them", () => {
    const now = new Date("2026-08-06T00:00:00.000Z");
    expect(validateInspectionDateRange({ dateFrom: "2026-08-07", dateTo: "2026-08-06", now })).toContain("after");
    expect(validateInspectionDateRange({ dateFrom: "2026-01-01", dateTo: "2026-08-06", now })).toContain("90 days");
    expect(validateInspectionDateRange({ dateFrom: "2026-08-01", dateTo: "2026-08-07", now })).toContain("future");
    expect(validateInspectionDateRange({ dateFrom: "2026-08-01", dateTo: "2026-08-06", now })).toBeNull();
  });

  it("derives canonical active reasons instead of treating non-terminal RSS as active", () => {
    expect(deriveInspectionActivityEvidence({ rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, activeSubscriberCount: 0, isSystemImported: false, lifecycle: "static_pending" })).toEqual({ active: false, activeReason: "NONE" });
    expect(deriveInspectionActivityEvidence({ rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, activeSubscriberCount: 1, isSystemImported: false, lifecycle: "static_pending" })).toEqual({ active: true, activeReason: "ACTIVE_SUBSCRIBER" });
    expect(deriveInspectionActivityEvidence({ rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, activeSubscriberCount: 0, isSystemImported: true, lifecycle: "static_pending" })).toEqual({ active: true, activeReason: "SYSTEM_TARGET" });
    expect(deriveInspectionActivityEvidence({ rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, activeSubscriberCount: 0, isSystemImported: false, nextRetryAt: new Date(Date.now() + 60_000), lifecycle: "static_failed" })).toEqual({ active: true, activeReason: "DEFERRED_RETRY" });
    expect(deriveInspectionActivityEvidence({ rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, activeSubscriberCount: 0, isSystemImported: false, lifecycle: "static_failed" })).toEqual({ active: true, activeReason: "ACTIVE_RECOVERY" });
    expect(deriveInspectionActivityEvidence({ rssStatus: "FAILED", currentFeedProductive: false, activeSubscriberCount: 1, isSystemImported: true, lifecycle: "resolved" })).toEqual({ active: false, activeReason: "NONE" });
  });

  it("normalizes bounded body projection scalar types and deduplicates IDs", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { id: "7", bodyPresent: "true", bodyLength: "500", bodyPrefix: "A".repeat(20) },
      { id: 8n, bodyPresent: false, bodyLength: 0n, bodyPrefix: null },
    ]);
    const result = await loadBodyReadinessEvidence({ $queryRaw: queryRaw }, [7, 7, 8]);
    expect(result.get(7)).toMatchObject({ id: 7, bodyPresent: true, bodyLength: 500 });
    expect(result.get(8)).toMatchObject({ id: 8, bodyPresent: false, bodyLength: 0 });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("adapts newest lifecycle evidence and preserves canonical classifier parity", () => {
    const result = adaptInspectionLifecycleEvidence([
      { id: "old", createdAt: "2026-08-01T00:00:00Z", artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "failed", lifecycleState: "open" } },
      { id: "new", createdAt: "2026-08-02T00:00:00Z", artifactType: "article_discovery_candidates", status: "CAPTURED", payload: { quality: "productive", lifecycleState: "applied" } },
    ], { rssStatus: "NO_RSS_FOUND", currentFeedProductive: false });
    expect(result.lifecycle).toBe("static_productive");
    expect(result.evidenceCoverage).toBe("COMPLETE");
  });

  it("keeps deferred targets active and distinguishes browser-required lifecycle", () => {
    expect(resolveInspectionActivity({ rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, active: true, nextRetryAt: new Date(Date.now() + 60_000), lifecycle: "static_failed" })).toBe("ACTIVE_DEFERRED");
    expect(resolveInspectionActivity({ rssStatus: "NO_RSS_FOUND", currentFeedProductive: false, active: true, lifecycle: "browser_failed_retryable" })).toBe("ACTIVE_BROWSER_REQUIRED");
    expect(resolveInspectionActivity({ rssStatus: "DOMAIN_DEAD", currentFeedProductive: false, active: true })).toBe("DOMAIN_DEAD");
  });

  it("maps durable evidence to canonical stages and bounds previews", () => {
    expect(getInspectionPipelineStage({ processingStage: "INGESTED", processingStatus: "SUCCESS" }, [])).toBe("AGENT1");
    expect(getInspectionPipelineStage({ processingStage: "INGESTED", processingStatus: "SUCCESS" }, ["article_discovery_candidates"])).toBe("AGENT2");
    expect(getInspectionPipelineStage({ enrichmentStatus: "ENRICHING" }, [])).toBe("AGENT3");
    expect(getInspectionPipelineStage({ publicationStatus: "PUBLISHED", publicationStage: "agent3" }, [])).toBe("TERMINAL");
    const preview = normalizeBodyPreview(`<p>  ${"A".repeat(500)} </p>`);
    expect(preview).toHaveLength(320);
    expect(normalizeBodyPreview(" \u0000\t ")).toBeNull();
  });

  it("derives deterministic source diagnostics centrally", () => {
    const flags = deriveInspectionFlags({
      totalArticlesInWindow: 0, publishedArticlesInWindow: 0, pendingArticlesInWindow: 0, deferredArticlesInWindow: 1,
      rejectedArticlesInWindow: 0, permanentFailuresInWindow: 0, retryableFailuresInWindow: 0, agent1ProductivityCount: 0,
      agent2DiscoveredCount: 1, agent3ProcessedCount: 0, agent3EnrichedCount: 0, agent3PublishedCount: 0, agent3RejectedCount: 0,
      deferredCount: 1, retryableFailureCount: 0, permanentFailureCount: 0, browserFallbackUsageCount: 1,
      latestArticleCreatedAt: null, latestPublishedArticleAt: null, latestFailureReason: null, diagnosticsTruncated: false,
      metricsApproximate: false, metricAccuracy: "EXACT", approximateMetrics: [], artifactOnlyEvents: 0, scannedArticles: 0, scannedArtifacts: 0, rssStatus: "ACTIVE", currentFeedProductive: false, lastSuccessfulPipelineAt: null,
    });
    expect(flags).toEqual(expect.arrayContaining(["NO_ARTICLES_GENERATED", "DISCOVERED_NOT_ENRICHED", "RETRY_BACKLOG", "RSS_UNPRODUCTIVE", "BROWSER_FALLBACK_REQUIRED"]));
  });
});
