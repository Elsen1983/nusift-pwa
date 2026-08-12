import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { recoverStaleArticleDiscoveryHeadlessProcessing } from "./article-discovery-headless-recovery";

const databaseUrl = process.env.DATABASE_URL || "";
let parsed: URL | null = null;
try { parsed = new URL(databaseUrl); } catch { parsed = null; }
const hostname = parsed?.hostname?.replace(/^\[|\]$/g, "");
const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
const isPostgres = parsed?.protocol === "postgres:" || parsed?.protocol === "postgresql:";
const enabled = process.env.NUSIFT_RUN_HEADLESS_CLAIM_RECOVERY_INTEGRATION === "1";
if (enabled && (!databaseUrl || !isLocal || !isPostgres)) {
  throw new Error("Headless claim recovery integration requires explicit localhost PostgreSQL DATABASE_URL.");
}
const suite = enabled ? describe : describe.skip;
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

suite("headless claim recovery PostgreSQL concurrency", () => {
  it("applies the forward migration and allows one recovery winner", async () => {
    const schema = `headless_claim_${randomUUID().replaceAll("-", "")}`;
    const adminPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
    const poolA = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
    const poolB = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
    const clientA = new PrismaClient({ adapter: new PrismaPg(poolA, { schema }) });
    const clientB = new PrismaClient({ adapter: new PrismaPg(poolB, { schema }) });
    try {
      await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await adminPool.query(`
        CREATE TABLE ${quoteIdentifier(schema)}."PipelineArtifact" (
          "id" TEXT PRIMARY KEY,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "artifactType" TEXT NOT NULL,
          "status" TEXT NOT NULL,
          "payload" JSONB NOT NULL,
          "errorLog" TEXT
        )
      `);
      const migrationPath = resolve(
        process.cwd(),
        "prisma/migrations/20260812120000_add_headless_artifact_claim_lease/migration.sql",
      );
      const migrationSql = readFileSync(migrationPath, "utf8")
        .replaceAll('"PipelineArtifact"', `${quoteIdentifier(schema)}."PipelineArtifact"`);
      await adminPool.query(migrationSql);

      const columns = await adminPool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'PipelineArtifact'",
        [schema],
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
        "headlessClaimToken",
        "headlessClaimExpiresAt",
      ]));
      const indexes = await adminPool.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'PipelineArtifact'",
        [schema],
      );
      expect(indexes.rows.map((row) => row.indexname)).toContain(
        "PipelineArtifact_artifactType_status_headlessClaimExpiresAt_idx",
      );

      const now = new Date("2026-08-12T12:00:00.000Z");
      await adminPool.query(
        `INSERT INTO ${quoteIdentifier(schema)}."PipelineArtifact"
          ("id", "artifactType", "status", "payload", "headlessClaimToken", "headlessClaimExpiresAt")
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          "expired-artifact",
          "article_discovery_headless_required",
          "HEADLESS_PROCESSING",
          JSON.stringify({ targetUrl: "https://example.com/news" }),
          "expired-token",
          new Date(now.getTime() - 1_000),
        ],
      );
      const noLog = async () => undefined;
      const [first, second] = await Promise.all([
        recoverStaleArticleDiscoveryHeadlessProcessing({
          mode: "retry", now, limit: 10, db: clientA as any, log: noLog as any,
        }),
        recoverStaleArticleDiscoveryHeadlessProcessing({
          mode: "retry", now, limit: 10, db: clientB as any, log: noLog as any,
        }),
      ]);

      expect(first.recovered + second.recovered).toBe(1);
      expect(first.skippedAlreadyChanged + second.skippedAlreadyChanged).toBe(1);
      const recovered = await clientA.pipelineArtifact.findUnique({
        where: { id: "expired-artifact" },
        select: { status: true, headlessClaimToken: true, headlessClaimExpiresAt: true },
      });
      expect(recovered).toMatchObject({
        status: "PENDING_HEADLESS",
        headlessClaimToken: null,
        headlessClaimExpiresAt: null,
      });
    } finally {
      await clientA.$disconnect().catch(() => undefined);
      await clientB.$disconnect().catch(() => undefined);
      await poolA.end().catch(() => undefined);
      await poolB.end().catch(() => undefined);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined);
      await adminPool.end().catch(() => undefined);
    }
  }, 120_000);
});
