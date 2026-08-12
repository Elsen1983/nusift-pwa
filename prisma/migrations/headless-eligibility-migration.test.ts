import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./20260812000000_add_headless_artifact_eligibility/migration.sql", import.meta.url),
  "utf8",
);

describe("headless artifact eligibility migration", () => {
  it("adds a nullable eligibility timestamp without rewriting existing rows", () => {
    expect(migration).toContain('ADD COLUMN "nextEligibleAt" TIMESTAMP(3)');
    expect(migration).not.toContain('"nextEligibleAt" TIMESTAMP(3) NOT NULL');
    expect(migration).not.toMatch(/UPDATE\s+"PipelineArtifact"/i);
  });

  it("indexes the actionable queue predicate and deterministic ordering fields", () => {
    expect(migration).toContain(
      'ON "PipelineArtifact"("artifactType", "status", "nextEligibleAt", "createdAt")',
    );
  });
});
