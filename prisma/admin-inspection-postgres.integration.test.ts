import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import {
  loadArticleInspectionEvidence,
  loadBodyReadinessEvidence,
} from "../server/utils/admin-inspection";

const databaseUrl = process.env.DATABASE_URL || "";
let parsed: URL | null = null;
try {
  parsed = new URL(databaseUrl);
} catch {
  parsed = null;
}
const hostname = parsed?.hostname.replace(/^\[|\]$/g, "");
const localHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
const postgresProtocol = parsed?.protocol === "postgres:" || parsed?.protocol === "postgresql:";
const enabled = process.env.NUSIFT_RUN_ADMIN_INSPECTION_POSTGRES_INTEGRATION === "1";
if (enabled && (!localHost || !postgresProtocol)) {
  throw new Error("Admin inspection PostgreSQL integration requires an explicitly opted-in localhost PostgreSQL DATABASE_URL.");
}
const runIntegration = enabled;

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const schemaName = () => `admin_inspection_${randomUUID().replaceAll("-", "")}`;

const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration("admin inspection PostgreSQL projections", () => {
  it("uses real Prisma raw SQL for bounded body evidence and article-specific evidence", async () => {
    const schema = schemaName();
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
    let client: PrismaClient | undefined;
    let clientPool: Pool | undefined;

    try {
      const connection = await admin.connect();
      try {
        await connection.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
        await connection.query(`CREATE TABLE ${quoteIdentifier(schema)}."Article" ("id" INTEGER PRIMARY KEY, "bodyText" TEXT)`);
        await connection.query(`CREATE TABLE ${quoteIdentifier(schema)}."PipelineArtifact" ("id" TEXT PRIMARY KEY, "createdAt" TIMESTAMP(3) NOT NULL, "artifactType" TEXT NOT NULL, "status" TEXT NOT NULL, "sourceId" TEXT, "categoryId" TEXT, "payload" JSONB NOT NULL, "errorLog" TEXT)`);
        await connection.query(`INSERT INTO ${quoteIdentifier(schema)}."Article" ("id", "bodyText") VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8), ($9, $10)`, [
          1, null,
          2, "   \t\n ",
          3, " short ",
          4, "é".repeat(600),
          5, "A".repeat(2_000),
        ]);
        await connection.query(`INSERT INTO ${quoteIdentifier(schema)}."PipelineArtifact" ("id", "createdAt", "artifactType", "status", "sourceId", "categoryId", "payload", "errorLog") VALUES
          ('match-old', '2026-08-01T00:00:00Z', 'article_enrichment_attempt', 'ATTEMPTED', 'source-1', NULL, '{"articleId": 1, "kind": "ATTEMPT"}', NULL),
          ('other-new', '2026-08-03T00:00:00Z', 'article_enrichment_result', 'CAPTURED', 'source-1', NULL, '{"articleId": 2, "kind": "SUCCESS"}', NULL),
          ('match-new', '2026-08-02T00:00:00Z', 'article_enrichment_result', 'CAPTURED', 'source-1', NULL, '{"articleId": 1, "kind": "SUCCESS", "browserFallback": {"attempted": true, "succeeded": false}}', NULL),
          ('string-id', '2026-08-04T00:00:00Z', 'article_enrichment_result', 'CAPTURED', 'source-1', NULL, '{"articleId": "1", "kind": "STRING"}', NULL),
          ('legacy-old', '2026-07-01T00:00:00Z', 'article_enrichment_result', 'CAPTURED', 'source-1', NULL, '{"kind": "LEGACY"}', NULL)`);
        for (let index = 0; index < 125; index += 1) {
          await connection.query(`INSERT INTO ${quoteIdentifier(schema)}."PipelineArtifact" ("id", "createdAt", "artifactType", "status", "sourceId", "categoryId", "payload", "errorLog") VALUES ($1, $2, 'article_enrichment_result', 'CAPTURED', 'source-1', NULL, $3, NULL)`, [
            `unrelated-${index}`,
            new Date(Date.UTC(2026, 7, 5, 0, 0, index)).toISOString(),
            JSON.stringify({ articleId: 999 + index, kind: "UNRELATED" }),
          ]);
        }
      } finally {
        connection.release();
      }

      clientPool = new Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 5_000,
        options: `-c search_path=${quoteIdentifier(schema)}`,
      });
      client = new PrismaClient({ adapter: new PrismaPg(clientPool) });

      const emptyClient = { $queryRaw: async () => { throw new Error("empty ID input must not query PostgreSQL"); } };
      await expect(loadBodyReadinessEvidence(emptyClient, [])).resolves.toEqual(new Map());

      const body = await loadBodyReadinessEvidence(client, [1, 1, 2, 3, 4, 5, 999]);
      expect(body.get(1)).toMatchObject({ id: 1, bodyPresent: false, bodyLength: 0, bodyPrefix: null });
      expect(body.get(2)).toMatchObject({ id: 2, bodyPresent: true, bodyLength: 0 });
      expect(body.get(3)).toMatchObject({ id: 3, bodyPresent: true, bodyLength: 5 });
      expect(body.get(4)).toMatchObject({ id: 4, bodyPresent: true, bodyLength: 600 });
      expect(body.get(4)?.bodyPrefix?.length).toBeLessThanOrEqual(520);
      expect(body.get(5)?.bodyPrefix?.length).toBeLessThanOrEqual(520);
      expect(body.get(999)).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("A".repeat(521));

      const evidence = await loadArticleInspectionEvidence(client, 1, 10);
      expect(evidence.map((row) => row.id)).toEqual(["match-new", "match-old"]);
      expect(evidence).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "other-new" })]));
      expect(evidence).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "string-id" })]));
      expect(evidence).toHaveLength(2);
      expect(evidence[0]?.browserAttempted).toBe("true");
      expect(evidence).toHaveLength(2);
      expect(evidence[0]?.id).not.toBe("unrelated-124");
    } finally {
      await client?.$disconnect().catch(() => undefined);
      await clientPool?.end().catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 20_000);
});
