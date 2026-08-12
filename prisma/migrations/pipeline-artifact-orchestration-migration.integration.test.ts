import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import pg from "pg";
import { expect, it } from "vitest";

const enabled = process.env.NUSIFT_RUN_PIPELINE_ATTRIBUTION_MIGRATION_INTEGRATION === "1";
const envUrl = process.env.DATABASE_URL ?? (() => {
  try { return dotenv.parse(readFileSync(new URL("../../.env", import.meta.url), "utf8")).DATABASE_URL; }
  catch { return undefined; }
})();

const requireLocalUrl = (value: string | undefined) => {
  if (!value) throw new Error("Local DATABASE_URL is required for the pipeline attribution migration integration test.");
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) || !["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Pipeline attribution migration integration is localhost-only.");
  }
  return value;
};

if (enabled) requireLocalUrl(envUrl);
const run = enabled ? it : it.skip;
const sql = readFileSync(
  new URL("./20260812000000_add_pipeline_artifact_orchestration_attribution/migration.sql", import.meta.url),
  "utf8",
);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

run("executes the orchestration attribution migration in an isolated local schema", async () => {
  const client = new pg.Client({ connectionString: requireLocalUrl(envUrl), connectionTimeoutMillis: 5_000 });
  const schema = `pipeline_attr_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path TO ${quote(schema)}, public`);
    await client.query(`
      CREATE TABLE "PipelineRun" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "PipelineArtifact" (
        "id" TEXT PRIMARY KEY,
        "pipelineRunId" TEXT NOT NULL REFERENCES "PipelineRun"("id") ON DELETE CASCADE,
        "sourceId" TEXT,
        "categoryId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(sql);
    await client.query(`INSERT INTO "PipelineRun" ("id") VALUES ('owner'), ('orchestration')`);
    await client.query(`INSERT INTO "PipelineArtifact" ("id", "pipelineRunId", "orchestrationRunId") VALUES ('a1', 'owner', 'orchestration')`);
    await client.query(`DELETE FROM "PipelineRun" WHERE "id" = 'orchestration'`);

    const row = await client.query(`SELECT "orchestrationRunId" FROM "PipelineArtifact" WHERE "id" = 'a1'`);
    expect(row.rows[0]?.orchestrationRunId).toBeNull();
    const index = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'PipelineArtifact_orchestrationRunId_sourceId_categoryId_createdAt_idx'`,
      [schema],
    );
    expect(index.rowCount).toBe(1);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}, 15_000);
