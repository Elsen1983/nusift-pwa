import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "prisma/migrations/20260812000000_add_pipeline_artifact_orchestration_attribution/migration.sql"),
  "utf8",
);

describe("PipelineArtifact orchestration attribution migration", () => {
  it("is forward-only, nullable, indexed, and preserves artifacts on orchestration deletion", () => {
    expect(migration).toContain('ADD COLUMN "orchestrationRunId" TEXT');
    expect(migration).toContain('CREATE INDEX "PipelineArtifact_orchestrationRunId_sourceId_categoryId_createdAt_idx"');
    expect(migration).toContain("ON DELETE SET NULL");
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(migration).not.toMatch(/NOT\s+NULL/i);
  });
});
