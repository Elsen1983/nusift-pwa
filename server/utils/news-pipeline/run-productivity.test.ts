import { describe, expect, it } from "vitest";
import { assessRunProductivity, countConsecutiveUnproductiveRuns } from "./run-productivity";
import type { PipelineStageTimingSummary, StageBatchProductivity, TelemetryStage } from "./stage-telemetry";

const timing = (stage: TelemetryStage, input?: {
  processed?: number;
  succeeded?: number;
  productivity?: StageBatchProductivity;
}) => ({
  stage,
  processed: input?.processed ?? 0,
  succeeded: input?.succeeded ?? 0,
  productivity: input?.productivity ?? {},
} as PipelineStageTimingSummary);

const outcomes = (...stages: TelemetryStage[]) =>
  stages.map((stage) => ({ stage, status: "completed" as const }));

describe("assessRunProductivity", () => {
  it("does not coerce missing telemetry to zero", () => {
    const result = assessRunProductivity({ stageTimings: [], stageOutcomes: outcomes("agent1") });
    expect(result.verdict).toBe("unknown");
    expect(result.productive).toBeNull();
    expect(result.availability.articlesInserted).toBe("metric_unreported");
    expect(result.lostAtBoundary).toBe("evidence_incomplete");
  });

  it("distinguishes a proven run with no executed stage", () => {
    const result = assessRunProductivity({ stageTimings: [], stageOutcomes: [] });
    expect(result.verdict).toBe("unproductive");
    expect(result.lostAtBoundary).toBe("no_stage_executed");
    expect(result.availability.articlesPublishable).toBe("stage_absent");
  });

  it("marks durable insertion as productive", () => {
    const result = assessRunProductivity({
      stageOutcomes: outcomes("agent1"),
      stageTimings: [timing("agent1", {
        processed: 2,
        productivity: { candidateArticlesFound: 3, articlesInserted: 1 },
      })],
    });
    expect(result.verdict).toBe("productive");
    expect(result.deepestProductiveBoundary).toBe("inserted");
  });

  it("marks a publishable-only backlog transition as productive", () => {
    const result = assessRunProductivity({
      stageOutcomes: outcomes("agent3"),
      stageTimings: [timing("agent3", {
        succeeded: 0,
        productivity: { articlesEnriched: 0, articlesPublishable: 2 },
      })],
    });
    expect(result.verdict).toBe("productive");
    expect(result.articlesPublishable).toBe(2);
    expect(result.deepestProductiveBoundary).toBe("publishable");
  });

  it("keeps verdict independent from stage outcome status", () => {
    const stageTimings = [timing("agent3", {
      succeeded: 1,
      productivity: { articlesEnriched: 1, articlesPublishable: 0 },
    })];
    const completed = assessRunProductivity({ stageTimings, stageOutcomes: [{ stage: "agent3", status: "completed" }] });
    const failed = assessRunProductivity({ stageTimings, stageOutcomes: [{ stage: "agent3", status: "failed" }] });
    expect(completed.verdict).toBe(failed.verdict);
  });

  it("requires complete output evidence before declaring unproductive", () => {
    const result = assessRunProductivity({
      stageOutcomes: outcomes("agent3"),
      stageTimings: [timing("agent3", { succeeded: 0, productivity: { articlesEnriched: 0 } })],
    });
    expect(result.verdict).toBe("unknown");
  });
});

describe("countConsecutiveUnproductiveRuns", () => {
  const summary = (verdict: "productive" | "unproductive" | "unknown", complete = true) => ({
    summary: {
      productivity: {
        verdict,
        productive: verdict === "unknown" ? null : verdict === "productive",
        evidenceComplete: complete,
        lostAtBoundary: verdict === "productive" ? "produced_output" : "no_candidates_found",
        articlesInserted: 0,
        articlesEnriched: 0,
        articlesPublishable: 0,
      },
    },
  });

  it("stops at unknown or incomplete evidence", () => {
    expect(countConsecutiveUnproductiveRuns([
      summary("unproductive"),
      summary("unknown", false),
      summary("unproductive"),
    ])).toBe(1);
  });
});
