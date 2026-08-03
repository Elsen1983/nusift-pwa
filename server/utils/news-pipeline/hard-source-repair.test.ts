import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactFindMany: vi.fn(),
  artifactUpdateMany: vi.fn(),
}));

vi.mock("../prisma", () => ({
  prisma: {
    pipelineArtifact: {
      findMany: mocks.artifactFindMany,
      updateMany: mocks.artifactUpdateMany,
    },
  },
}));

import {
  findRuntimeEvidenceOnlyProfiles,
  isRuntimeEvidenceOnlyProfilePayload,
  repairRuntimeEvidenceOnlyProfiles,
} from "./hard-source-repair";

const runtimeProfilePayload = {
  schemaVersion: 1,
  artifactKind: "article_discovery_hard_source_profile",
  sourceId: "src-1",
  categoryId: null,
  targetUrl: "https://example.com/news",
  staticQuality: "failed",
  browserStatus: "BROWSER_RUNTIME_UNAVAILABLE",
  failureCount: 3,
  dominantReasons: ["browser_runtime_unavailable"],
};

const genuineProfilePayload = {
  ...runtimeProfilePayload,
  browserStatus: "BROWSER_NO_CANDIDATES",
};

describe("isRuntimeEvidenceOnlyProfilePayload", () => {
  it("flags runtime-unavailable profiles as invalid evidence", () => {
    expect(isRuntimeEvidenceOnlyProfilePayload(runtimeProfilePayload)).toBe(true);
  });

  it("flags fallback-disabled profiles as invalid evidence", () => {
    expect(isRuntimeEvidenceOnlyProfilePayload({
      ...runtimeProfilePayload,
      browserStatus: "BROWSER_FALLBACK_DISABLED",
    })).toBe(true);
  });

  it("does not flag genuine no-candidates profiles", () => {
    expect(isRuntimeEvidenceOnlyProfilePayload(genuineProfilePayload)).toBe(false);
  });

  it("returns false for malformed payloads", () => {
    expect(isRuntimeEvidenceOnlyProfilePayload(null)).toBe(false);
    expect(isRuntimeEvidenceOnlyProfilePayload("nope")).toBe(false);
    expect(isRuntimeEvidenceOnlyProfilePayload({})).toBe(false);
  });
});

describe("findRuntimeEvidenceOnlyProfiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only profiles created from runtime evidence (bounded scan)", async () => {
    const artifacts = [
      { id: "p-runtime", status: "PROFILE", sourceId: "src-1", categoryId: null, createdAt: new Date("2026-08-01"), updatedAt: new Date("2026-08-01"), payload: runtimeProfilePayload },
      { id: "p-genuine", status: "PROFILE", sourceId: "src-2", categoryId: null, createdAt: new Date("2026-08-01"), updatedAt: new Date("2026-08-01"), payload: genuineProfilePayload },
      { id: "p-resolved", status: "RESOLVED", sourceId: "src-3", categoryId: null, createdAt: new Date("2026-08-01"), updatedAt: new Date("2026-08-01"), payload: runtimeProfilePayload },
    ];
    mocks.artifactFindMany.mockImplementation(async ({ where }: any) => {
      const notIn = where?.status?.notIn ?? [];
      return artifacts.filter((artifact) => !notIn.includes(artifact.status));
    });

    const profiles = await findRuntimeEvidenceOnlyProfiles();
    expect(profiles.map((p) => p.id)).toEqual(["p-runtime"]);
    expect(profiles[0]?.browserStatus).toBe("BROWSER_RUNTIME_UNAVAILABLE");
  });
});

describe("repairRuntimeEvidenceOnlyProfiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("is dry-run by default and performs no writes", async () => {
    mocks.artifactFindMany.mockResolvedValue([
      { id: "p-runtime", sourceId: "src-1", categoryId: null, createdAt: new Date(), updatedAt: new Date(), payload: runtimeProfilePayload },
    ]);

    const result = await repairRuntimeEvidenceOnlyProfiles();

    expect(result.dryRun).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.updated).toBe(0);
    expect(mocks.artifactUpdateMany).not.toHaveBeenCalled();
  });

  it("writes only when explicitly confirmed (dryRun: false)", async () => {
    mocks.artifactFindMany.mockResolvedValue([
      { id: "p-runtime", sourceId: "src-1", categoryId: null, createdAt: new Date(), updatedAt: new Date(), payload: runtimeProfilePayload },
      { id: "p-genuine", sourceId: "src-2", categoryId: null, createdAt: new Date(), updatedAt: new Date(), payload: genuineProfilePayload },
    ]);

    const result = await repairRuntimeEvidenceOnlyProfiles({ dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(result.updated).toBe(1);
    expect(mocks.artifactUpdateMany).toHaveBeenCalledTimes(1);
    const call = mocks.artifactUpdateMany.mock.calls[0]!;
    expect(call[0].where).toEqual({ id: "p-runtime" });
    expect(call[0].data.status).toBe("INVALIDATED_RUNTIME_EVIDENCE");
    expect(call[0].data.payload.lifecycleState).toBe("stale");
    expect(call[0].data.payload.invalidatedReason).toBe("platform_runtime_evidence_only");
    // Original payload preserved.
    expect(call[0].data.payload.artifactKind).toBe("article_discovery_hard_source_profile");
  });

  it("counts failed updates without throwing", async () => {
    mocks.artifactFindMany.mockResolvedValue([
      { id: "p-runtime", sourceId: "src-1", categoryId: null, createdAt: new Date(), updatedAt: new Date(), payload: runtimeProfilePayload },
    ]);
    mocks.artifactUpdateMany.mockRejectedValue(new Error("db down"));

    const result = await repairRuntimeEvidenceOnlyProfiles({ dryRun: false });
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(1);
  });
});
