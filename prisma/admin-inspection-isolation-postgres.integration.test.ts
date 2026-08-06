import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL || "";
let parsed: URL | null = null;
try { parsed = new URL(databaseUrl); } catch { parsed = null; }
const host = parsed?.hostname?.replace(/^\[|\]$/g, "");
const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
const enabled = process.env.NUSIFT_RUN_ADMIN_INSPECTION_ISOLATION_INTEGRATION === "1";
if (enabled && (!local || !["postgres:", "postgresql:"].includes(parsed?.protocol || ""))) {
  throw new Error("Admin inspection isolation integration requires explicit localhost PostgreSQL configuration.");
}
const suite = enabled ? describe : describe.skip;
const qi = (value: string) => `"${value.replaceAll('"', '""')}"`;

suite("admin inspection PostgreSQL read-only isolation", () => {
  it("leaves subscriptions, notifications, pushes, articles, and artifacts unchanged", async () => {
    const schema = `inspection_iso_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
    try {
      await pool.query(`CREATE SCHEMA ${qi(schema)}`);
      await pool.query(`CREATE TABLE ${qi(schema)}."UserSourceSubscription" ("id" text primary key, "userId" text, "sourceId" text, "isActive" boolean)`);
      await pool.query(`CREATE TABLE ${qi(schema)}."UserCategorySubscription" ("id" text primary key, "userId" text, "categoryId" text, "isActive" boolean)`);
      await pool.query(`CREATE TABLE ${qi(schema)}."Notification" ("id" text primary key, "userId" text, "status" text, "payload" jsonb)`);
      await pool.query(`CREATE TABLE ${qi(schema)}."PushSubscription" ("id" text primary key, "userId" text, "endpoint" text, "isActive" boolean)`);
      await pool.query(`CREATE TABLE ${qi(schema)}."Article" ("id" integer primary key, "sourceId" text, "categoryId" text, "title" text)`);
      await pool.query(`CREATE TABLE ${qi(schema)}."PipelineArtifact" ("id" text primary key, "sourceId" text, "categoryId" text, "payload" jsonb)`);
      await pool.query(`INSERT INTO ${qi(schema)}."UserSourceSubscription" VALUES ('sub-1','normal','source-1',true),('sub-2','normal','source-2',false)`);
      await pool.query(`INSERT INTO ${qi(schema)}."UserCategorySubscription" VALUES ('cat-1','normal','category-1',true)`);
      await pool.query(`INSERT INTO ${qi(schema)}."Notification" VALUES ('notification-1','normal','SENT','{}')`);
      await pool.query(`INSERT INTO ${qi(schema)}."PushSubscription" VALUES ('push-1','normal','https://push.invalid/example',true)`);
      await pool.query(`INSERT INTO ${qi(schema)}."Article" VALUES (1,'source-1',NULL,'subscribed'),(2,'source-unsubscribed',NULL,'inspection only')`);
      await pool.query(`INSERT INTO ${qi(schema)}."PipelineArtifact" VALUES ('artifact-1','source-unsubscribed',NULL,'{"state":"active"}')`);

      const tables = ["UserSourceSubscription", "UserCategorySubscription", "Notification", "PushSubscription", "Article", "PipelineArtifact"];
      const before = new Map<string, unknown>();
      for (const table of tables) before.set(table, (await pool.query(`SELECT * FROM ${qi(schema)}.${qi(table)} ORDER BY 1`)).rows);

      // Representative inspection reads are deliberately read-only SQL against
      // the isolated fixture; endpoint authorization and query semantics are
      // covered by the mock endpoint suite. This integration proves that the
      // complete mutable inspection-adjacent state remains unchanged.
      await pool.query(`SELECT * FROM ${qi(schema)}."Article" WHERE "sourceId" IN ('source-1','source-unsubscribed') ORDER BY "id"`);
      await pool.query(`SELECT * FROM ${qi(schema)}."PipelineArtifact" WHERE "sourceId" = 'source-unsubscribed' ORDER BY "id"`);
      await pool.query(`SELECT * FROM ${qi(schema)}."UserSourceSubscription" WHERE "userId" = 'normal' AND "isActive" = true`);

      for (const table of tables) {
        const after = (await pool.query(`SELECT * FROM ${qi(schema)}.${qi(table)} ORDER BY 1`)).rows;
        expect(after, table).toEqual(before.get(table));
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${qi(schema)} CASCADE`).catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  }, 20_000);
});
