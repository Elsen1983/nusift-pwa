import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), upsert: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() }));
vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findMany: mocks.findMany,
      upsert: mocks.upsert,
      createMany: mocks.createMany,
      updateMany: mocks.updateMany,
    },
  },
}));

import { chooseFunnelTerminalReason, finalizeOrchestrationFunnels, getRunFunnelPage } from "./run-funnel";

const state = (overrides: Record<string, unknown> = {}) => ({
  sourceId: "source-1",
  categoryId: null,
  manifest: true,
  manifestTruncated: false,
  manifestStages: new Set<string>(),
  outcomeStages: new Set<string>(),
  feedItemsParsed: 0,
  candidatesDiscovered: 0,
  candidatesEvaluated: 0,
  candidatesPolicyAccepted: 0,
  candidatesPersisted: 0,
  duplicates: 0,
  persistenceFailed: 0,
  enriched: 0,
  enrichmentFailed: 0,
  publishable: 0,
  articlesSelected: 0,
  deferred: false,
  quarantined: false,
  reasons: new Set<string>(),
  ...overrides,
});

describe("chooseFunnelTerminalReason", () => {
  it("gives durable productive evidence precedence", () => {
    expect(chooseFunnelTerminalReason(state({ publishable: 1, deferred: true }))).toBe("produced_publishable_articles");
  });

  it("distinguishes duplicates from no candidates", () => {
    expect(chooseFunnelTerminalReason(state({ duplicates: 3 }))).toBe("all_duplicates");
    expect(chooseFunnelTerminalReason(state())).toBe("no_candidates_found");
  });

  it("does not guess when the target lacks manifest evidence", () => {
    expect(chooseFunnelTerminalReason(state({ manifest: false }))).toBe("evidence_incomplete");
  });

  it("maps feed-first and enrichment evidence deterministically", () => {
    expect(chooseFunnelTerminalReason(state({ reasons: new Set(["rss_owned_productive"]) })))
      .toBe("feed_first_waiting_evidence");
    expect(chooseFunnelTerminalReason(state({ enrichmentFailed: 1 }))).toBe("enrichment_failed");
  });
});

describe("run funnel persistence", () => {
  beforeEach(() => vi.resetAllMocks());

  it("writes one deterministic funnel from attributed durable evidence", async () => {
    mocks.findMany.mockResolvedValueOnce([{ pipelineRunId: "batch-1" }]).mockResolvedValueOnce([
      {
        id: "m1", artifactType: "orchestration_target_manifest", status: "SELECTED",
        sourceId: "source-1", categoryId: null, candidateCount: 0,
        payload: { stage: "agent1", manifestTruncated: false },
      },
      {
        id: "o1", artifactType: "agent1_target_outcome", status: "PASS",
        sourceId: "source-1", categoryId: null, candidateCount: 2,
        payload: { candidates: 2, inserted: 1, skipped: 1, failed: 0 },
      },
    ]);
    mocks.upsert.mockResolvedValue({ id: "funnel" });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const result = await finalizeOrchestrationFunnels({ orchestrationRunId: "run-1" });

    expect(result).toEqual({ targets: 1, truncated: false, incomplete: 0 });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0]![0].create.payload).toEqual(expect.objectContaining({
      terminalReason: "produced_unpublished_articles",
      evidenceComplete: true,
    }));
  });

  it("uses bounded cursor pagination", async () => {
    mocks.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const result = await getRunFunnelPage({ orchestrationRunId: "run-1", limit: 2 });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe("b");
    expect(result.truncated).toBe(true);
  });
});
