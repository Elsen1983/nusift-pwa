import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const artifactFindMany = vi.fn();
const artifactDeleteMany = vi.fn();
const logAgentScanMock = vi.fn();

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findMany: (...args: any[]) => artifactFindMany(...args),
      deleteMany: (...args: any[]) => artifactDeleteMany(...args),
    },
  },
}));

vi.mock("./log", () => ({
  logAgentScan: (...args: any[]) => logAgentScanMock(...args),
}));

// normalizeUrl from ./text — mock to a deterministic transform so tests don't
// depend on URL parsing edge cases beyond what we exercise.
vi.mock("./text", () => ({
  normalizeUrl: (raw: string) => {
    // Mirror the real helper's stable behavior for test inputs.
    const u = new URL(raw);
    u.hash = "";
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  },
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-27T12:00:00Z");
const OLD = new Date("2026-07-01T12:00:00Z"); // 26 days old → past 14d cutoff
const RECENT = new Date("2026-07-25T12:00:00Z"); // 2 days old → within 14d cutoff

function makeArtifact(overrides: Partial<{
  id: string;
  artifactType: string;
  status: string;
  sourceId: string | null;
  categoryId: string | null;
  targetUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  payload: Record<string, unknown>;
}> = {}) {
  return {
    id: overrides.id ?? "art-1",
    artifactType: overrides.artifactType ?? "article_discovery_headless_required",
    status: overrides.status ?? "RESOLVED",
    sourceId: overrides.sourceId ?? "src-1",
    categoryId: overrides.categoryId ?? null,
    createdAt: overrides.createdAt ?? OLD,
    updatedAt: overrides.updatedAt ?? OLD,
    payload: {
      // NOTE: targetUrl may legitimately be null; only fall back to the
      // default when the caller did not specify the key at all.
      targetUrl: overrides.targetUrl === undefined ? "https://example.com/news" : overrides.targetUrl,
      ...(overrides.payload ?? {}),
    },
  };
}

function setupFindMany(artifacts: any[], successfulArtifacts: any[] = []) {
  artifactFindMany.mockImplementation(async (args: any) => {
    // First call: candidate query (where.updatedAt.lt).
    if (args.where?.updatedAt?.lt) {
      return artifacts;
    }
    // Second call: successful terminal artifacts for superseded check.
    return successfulArtifacts;
  });
  artifactDeleteMany.mockResolvedValue({ count: 0 });
}

async function loadFn() {
  const mod = await import("./pipeline-artifact-cleanup");
  return mod.processPipelineArtifactCleanup;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("processPipelineArtifactCleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    logAgentScanMock.mockResolvedValue(undefined);
    artifactDeleteMany.mockResolvedValue({ count: 0 });
  });

  // -- terminal resolved artifact eligibility --------------------------------

  it("marks an old RESOLVED artifact as eligible in dry-run", async () => {
    setupFindMany([makeArtifact({ id: "a1", status: "RESOLVED" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.inspected).toBe(1);
    expect(result.eligibleForDeletion).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.sampleDeletedOrWouldDelete[0]!.reason).toBe("terminal_status_aged");
  });

  it("marks old RESOLVED_BY_STATIC_DISCOVERY and RESOLVED_BY_AGENT1_RSS as eligible", async () => {
    setupFindMany([
      makeArtifact({ id: "a1", status: "RESOLVED_BY_STATIC_DISCOVERY" }),
      makeArtifact({ id: "a2", status: "RESOLVED_BY_AGENT1_RSS" }),
    ]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(2);
  });

  it("marks old BROWSER_FALLBACK_DISABLED (legacy terminal) as eligible", async () => {
    setupFindMany([makeArtifact({ id: "a1", status: "BROWSER_FALLBACK_DISABLED" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
  });

  // -- recent artifact skipped ----------------------------------------------

  it("does not inspect recent artifacts (within retention window)", async () => {
    // Candidate query returns nothing because updatedAt >= cutoff in practice.
    // We simulate the DB filter by returning [].
    setupFindMany([]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.inspected).toBe(0);
    expect(result.eligibleForDeletion).toBe(0);
  });

  // -- active/in-flight statuses always protected ---------------------------

  it("protects HEADLESS_PROCESSING artifacts regardless of age", async () => {
    setupFindMany([makeArtifact({ id: "a1", status: "HEADLESS_PROCESSING" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
    expect(result.protectedReasons.active_inflight_status).toBe(1);
  });

  it("protects HEADLESS_PROCESSING_STALE artifacts (recovery path owns them)", async () => {
    setupFindMany([makeArtifact({ id: "a1", status: "HEADLESS_PROCESSING_STALE" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
  });

  // -- superseded retryable failures ----------------------------------------

  it("marks an old BROWSER_NO_CANDIDATES as eligible when a newer RESOLVED exists for the same target", async () => {
    const target = "https://example.com/news";
    setupFindMany(
      [makeArtifact({
        id: "old-fail",
        status: "BROWSER_NO_CANDIDATES",
        targetUrl: target,
        updatedAt: OLD,
      })],
      [makeArtifact({
        id: "new-success",
        status: "RESOLVED",
        targetUrl: target,
        updatedAt: new Date("2026-07-20T12:00:00Z"), // newer than OLD
      })],
    );
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
    expect(result.sampleDeletedOrWouldDelete[0]!.reason).toBe("superseded_by_newer_success");
  });

  it("protects an old BROWSER_NO_CANDIDATES when no newer success exists for the target", async () => {
    const target = "https://example.com/news";
    setupFindMany(
      [makeArtifact({
        id: "old-fail",
        status: "BROWSER_NO_CANDIDATES",
        targetUrl: target,
        updatedAt: OLD,
      })],
      [], // no successful artifacts
    );
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
    expect(result.protectedReasons.no_newer_success_for_target).toBe(1);
  });

  it("protects an old BROWSER_NO_CANDIDATES when the success is older than the failure", async () => {
    const target = "https://example.com/news";
    setupFindMany(
      [makeArtifact({
        id: "new-fail",
        status: "BROWSER_NO_CANDIDATES",
        targetUrl: target,
        updatedAt: new Date("2026-07-20T12:00:00Z"), // newer
      })],
      [makeArtifact({
        id: "old-success",
        status: "RESOLVED",
        targetUrl: target,
        updatedAt: OLD, // older than the failure
      })],
    );
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
    expect(result.protectedReasons.candidate_newer_than_latest_success).toBe(1);
  });

  it("does not treat a success for a DIFFERENT target as superseding", async () => {
    setupFindMany(
      [makeArtifact({
        id: "fail-A",
        status: "BROWSER_NO_CANDIDATES",
        targetUrl: "https://example.com/news",
        categoryId: "cat-A",
        updatedAt: OLD,
      })],
      [makeArtifact({
        id: "success-B",
        status: "RESOLVED",
        targetUrl: "https://example.com/sports",
        categoryId: "cat-B",
        updatedAt: new Date("2026-07-20T12:00:00Z"),
      })],
    );
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
  });

  it("treats categoryId null vs non-null as different targets", async () => {
    setupFindMany(
      [makeArtifact({
        id: "fail-src",
        status: "BROWSER_NO_CANDIDATES",
        targetUrl: "https://example.com/news",
        categoryId: null,
        updatedAt: OLD,
      })],
      [makeArtifact({
        id: "success-cat",
        status: "RESOLVED",
        targetUrl: "https://example.com/news",
        categoryId: "cat-1",
        updatedAt: new Date("2026-07-20T12:00:00Z"),
      })],
    );
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
  });

  // -- missing / malformed targetUrl does not loose-match -------------------

  it("protects a retryable failure with missing targetUrl (no loose match)", async () => {
    setupFindMany(
      [makeArtifact({
        id: "fail-notarget",
        status: "BROWSER_NO_CANDIDATES",
        targetUrl: null,
        payload: {}, // no targetUrl in payload
        updatedAt: OLD,
      })],
      [makeArtifact({
        id: "success",
        status: "RESOLVED",
        targetUrl: "https://example.com/news",
        updatedAt: new Date("2026-07-20T12:00:00Z"),
      })],
    );
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
    expect(result.protectedReasons.missing_or_malformed_target_url).toBe(1);
  });

  it("protects a retryable failure with a malformed targetUrl", async () => {
    setupFindMany(
      [makeArtifact({
        id: "fail-malformed",
        status: "BROWSER_NO_CANDIDATES",
        targetUrl: "not-a-url",
        updatedAt: OLD,
      })],
      [],
    );
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
    expect(result.protectedReasons.missing_or_malformed_target_url).toBe(1);
  });

  // -- article_discovery_candidates superseded ------------------------------

  it("marks old article_discovery_candidates as eligible when superseded by newer success", async () => {
    const target = "https://example.com/news";
    setupFindMany(
      [makeArtifact({
        id: "cand-old",
        artifactType: "article_discovery_candidates",
        status: "RESOLVED_BY_STATIC_DISCOVERY", // candidates use resolved statuses too
        targetUrl: target,
        updatedAt: OLD,
      })],
      // We only enter superseded branch for candidates regardless of status
      // (the branch keys on artifactType). Provide a newer success.
      [makeArtifact({
        id: "success-new",
        status: "RESOLVED",
        targetUrl: target,
        updatedAt: new Date("2026-07-20T12:00:00Z"),
      })],
    );
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    // Note: RESOLVED_BY_STATIC_DISCOVERY is a terminal status, so it is
    // eligible via terminal_status_aged BEFORE the superseded branch runs.
    // This documents that terminal candidates are eligible by age.
    expect(result.eligibleForDeletion).toBe(1);
  });

  // -- hard-source profiles --------------------------------------------------

  it("protects an unresolved hard-source profile", async () => {
    setupFindMany([
      makeArtifact({
        id: "prof-1",
        artifactType: "article_discovery_hard_source_profile",
        status: "PROFILE",
        targetUrl: "https://example.com/hard",
        payload: { suggestedNextAction: "ai_profile_inspection" },
        updatedAt: OLD,
      }),
    ]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
    expect(result.protectedReasons.hard_source_profile_unresolved).toBe(1);
  });

  it("marks a resolved hard-source profile (RESOLVED_BY_AGENT1_RSS status) older than cutoff as eligible", async () => {
    setupFindMany([
      makeArtifact({
        id: "prof-1",
        artifactType: "article_discovery_hard_source_profile",
        status: "RESOLVED_BY_AGENT1_RSS",
        targetUrl: "https://example.com/hard",
        payload: { resolvedBy: "agent1_scoped_rss", resolvedAt: OLD.toISOString() },
        updatedAt: OLD,
      }),
    ]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
    expect(result.sampleDeletedOrWouldDelete[0]!.reason).toBe("hard_source_profile_resolved");
  });

  it("marks a hard-source profile with resolvedBy+resolvedAt metadata (but PROFILE status) as eligible", async () => {
    setupFindMany([
      makeArtifact({
        id: "prof-1",
        artifactType: "article_discovery_hard_source_profile",
        status: "PROFILE",
        targetUrl: "https://example.com/hard",
        payload: { resolvedBy: "agent1_scoped_rss", resolvedAt: OLD.toISOString() },
        updatedAt: OLD,
      }),
    ]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
  });

  it("protects a hard-source profile with resolvedBy but missing resolvedAt (unclear)", async () => {
    setupFindMany([
      makeArtifact({
        id: "prof-1",
        artifactType: "article_discovery_hard_source_profile",
        status: "PROFILE",
        targetUrl: "https://example.com/hard",
        payload: { resolvedBy: "agent1_scoped_rss" }, // no resolvedAt
        updatedAt: OLD,
      }),
    ]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.protected).toBe(1);
  });

  // -- dry-run does not delete ----------------------------------------------

  it("dryRun=true never calls pipelineArtifact.deleteMany", async () => {
    setupFindMany([makeArtifact({ id: "a1", status: "RESOLVED" })]);
    const fn = await loadFn();
    await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(artifactDeleteMany).not.toHaveBeenCalled();
  });

  // -- dryRun=false deletes only selected ids -------------------------------

  it("dryRun=false deletes only eligible ids via bounded deleteMany", async () => {
    setupFindMany(
      [
        makeArtifact({ id: "a1", status: "RESOLVED", targetUrl: "https://example.com/n1" }),
        makeArtifact({ id: "a2", status: "HEADLESS_PROCESSING", targetUrl: "https://example.com/n2" }),
      ],
      [],
    );
    artifactDeleteMany.mockResolvedValue({ count: 1 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, olderThanDays: 14, now: NOW });

    expect(result.dryRun).toBe(false);
    expect(result.eligibleForDeletion).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.protected).toBe(1);
    expect(artifactDeleteMany).toHaveBeenCalledTimes(1);
    expect(artifactDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["a1"] } } }),
    );
  });

  it("reports deleteCountMismatch when deleteMany count differs from selected", async () => {
    setupFindMany([makeArtifact({ id: "a1", status: "RESOLVED" })]);
    artifactDeleteMany.mockResolvedValue({ count: 0 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.skippedReasons.deleteCountMismatch).toBe(1);
  });

  // -- limit clamping -------------------------------------------------------

  it("clamps limit to max 1000", async () => {
    setupFindMany([]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, limit: 99999, now: NOW });

    expect(result.limit).toBe(1000);
    expect(artifactFindMany.mock.calls[0]![0].take).toBe(1000);
  });

  it("clamps limit to min 1", async () => {
    setupFindMany([]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, limit: 0, now: NOW });

    expect(result.limit).toBe(1);
  });

  it("uses default limit 200 when not provided", async () => {
    setupFindMany([]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.limit).toBe(200);
  });

  // -- result shape / payload safety ----------------------------------------

  it("never exposes raw payload or candidate arrays in the result", async () => {
    setupFindMany([makeArtifact({
      id: "a1",
      status: "RESOLVED",
      payload: { candidates: [{ url: "x" }], html: "<big/>", screenshot: "data:..." },
    })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    const sample = result.sampleDeletedOrWouldDelete[0]!;
    expect(sample).not.toHaveProperty("payload");
    expect(sample).not.toHaveProperty("candidates");
    expect(sample).not.toHaveProperty("html");
    expect(sample).not.toHaveProperty("screenshot");
    expect(Object.keys(sample).sort()).toEqual(
      ["artifactType", "categoryId", "createdAt", "id", "reason", "sourceId", "status", "targetUrl", "updatedAt"].sort(),
    );
  });

  it("caps sampleDeletedOrWouldDelete at 20 entries", async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      makeArtifact({ id: `a${i}`, status: "RESOLVED", targetUrl: `https://example.com/n${i}` }),
    );
    setupFindMany(many);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, limit: 50, now: NOW });

    expect(result.inspected).toBe(50);
    expect(result.eligibleForDeletion).toBe(50);
    expect(result.sampleDeletedOrWouldDelete.length).toBeLessThanOrEqual(20);
  });

  it("aggregates byArtifactType and byStatus", async () => {
    setupFindMany([
      makeArtifact({ id: "a1", artifactType: "article_discovery_headless_required", status: "RESOLVED" }),
      makeArtifact({ id: "a2", artifactType: "article_discovery_hard_source_profile", status: "PROFILE" }),
    ]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.byArtifactType["article_discovery_headless_required"]).toBe(1);
    expect(result.byArtifactType["article_discovery_hard_source_profile"]).toBe(1);
    expect(result.byStatus["RESOLVED"]).toBe(1);
    expect(result.byStatus["PROFILE"]).toBe(1);
  });

  // -- diagnostic artifact types (rss_candidates, hard_case_discovery_candidate) ----

  it("marks old rss_candidates CAPTURED as eligible with reason diagnostic_artifact_aged", async () => {
    setupFindMany([makeArtifact({ id: "rss-1", artifactType: "rss_candidates", status: "CAPTURED" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.inspected).toBe(1);
    expect(result.eligibleForDeletion).toBe(1);
    expect(result.sampleDeletedOrWouldDelete[0]!.reason).toBe("diagnostic_artifact_aged");
    expect(result.sampleDeletedOrWouldDelete[0]!.artifactType).toBe("rss_candidates");
  });

  it("marks old rss_candidates FAILED as eligible", async () => {
    setupFindMany([makeArtifact({ id: "rss-2", artifactType: "rss_candidates", status: "FAILED" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
    expect(result.sampleDeletedOrWouldDelete[0]!.reason).toBe("diagnostic_artifact_aged");
  });

  it("marks old rss_candidates FAILED_FINAL as eligible", async () => {
    setupFindMany([makeArtifact({ id: "rss-3", artifactType: "rss_candidates", status: "FAILED_FINAL" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
    expect(result.sampleDeletedOrWouldDelete[0]!.reason).toBe("diagnostic_artifact_aged");
  });

  it("marks old hard_case_discovery_candidate CAPTURED as eligible", async () => {
    setupFindMany([makeArtifact({ id: "hc-1", artifactType: "hard_case_discovery_candidate", status: "CAPTURED" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
    expect(result.sampleDeletedOrWouldDelete[0]!.reason).toBe("diagnostic_artifact_aged");
  });

  it("marks old hard_case_discovery_candidate FAILED as eligible", async () => {
    setupFindMany([makeArtifact({ id: "hc-2", artifactType: "hard_case_discovery_candidate", status: "FAILED" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
  });

  it("marks old hard_case_discovery_candidate FAILED_FINAL as eligible", async () => {
    setupFindMany([makeArtifact({ id: "hc-3", artifactType: "hard_case_discovery_candidate", status: "FAILED_FINAL" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(1);
  });

  it("does not inspect recent rss_candidates CAPTURED (within cutoff)", async () => {
    // Simulate that the DB query returns nothing because the artifact is within
    // the retention window (updatedAt >= cutoff). The cleanup function never
    // sees it.
    setupFindMany([]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.inspected).toBe(0);
    expect(result.eligibleForDeletion).toBe(0);
  });

  it("conservatively skips unknown artifact type with FAILED status", async () => {
    setupFindMany([makeArtifact({ id: "unk-1", artifactType: "some_other_type", status: "FAILED" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons.unhandled_status_conservative_skip).toBe(1);
  });

  it("conservatively skips known diagnostic artifact type with unknown status", async () => {
    setupFindMany([makeArtifact({ id: "unk-2", artifactType: "rss_candidates", status: "UNKNOWN_STATUS" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons.unhandled_status_conservative_skip).toBe(1);
  });

  it("dryRun=false deletes only selected diagnostic artifact ids", async () => {
    setupFindMany([
      makeArtifact({ id: "rss-old", artifactType: "rss_candidates", status: "CAPTURED" }),
      makeArtifact({ id: "hc-old", artifactType: "hard_case_discovery_candidate", status: "FAILED_FINAL" }),
      makeArtifact({ id: "proc-1", status: "HEADLESS_PROCESSING" }),
    ]);
    artifactDeleteMany.mockResolvedValue({ count: 2 });

    const fn = await loadFn();
    const result = await fn({ dryRun: false, olderThanDays: 14, now: NOW });

    expect(result.dryRun).toBe(false);
    expect(result.eligibleForDeletion).toBe(2);
    expect(result.deleted).toBe(2);
    expect(result.protected).toBe(1);
    expect(artifactDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["rss-old", "hc-old"] } } }),
    );
  });

  // -- unhandled status conservative skip -----------------------------------

  it("conservatively skips unknown statuses (e.g. SKIPPED_UNIMPLEMENTED)", async () => {
    setupFindMany([makeArtifact({ id: "a1", status: "SKIPPED_UNIMPLEMENTED" })]);
    const fn = await loadFn();
    const result = await fn({ dryRun: true, olderThanDays: 14, now: NOW });

    expect(result.eligibleForDeletion).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedReasons.unhandled_status_conservative_skip).toBe(1);
  });

  // -- failure logging ------------------------------------------------------

  it("logs PIPELINE_ARTIFACT_CLEANUP_FAILED and re-throws on DB error", async () => {
    artifactFindMany.mockRejectedValue(new Error("DB connection lost"));
    const fn = await loadFn();
    await expect(fn({ dryRun: false, olderThanDays: 14, now: NOW })).rejects.toThrow(
      "DB connection lost",
    );

    expect(logAgentScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PIPELINE_ARTIFACT_CLEANUP_FAILED" }),
    );
  });
});
