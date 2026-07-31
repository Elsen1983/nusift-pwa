import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import pg from "pg";
import { describe, expect, it } from "vitest";

export function readDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
  dotenvContents?: string,
): string | undefined {
  if (environment.DATABASE_URL !== undefined) return environment.DATABASE_URL;
  if (dotenvContents === undefined) return undefined;
  return dotenv.parse(dotenvContents).DATABASE_URL;
}

export function validateLocalDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new Error(
      "Publication-gate PostgreSQL integration was explicitly enabled, but DATABASE_URL is missing.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(
      "Publication-gate PostgreSQL integration was explicitly enabled, but DATABASE_URL is invalid.",
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      "Publication-gate PostgreSQL integration requires a postgresql:// or postgres:// DATABASE_URL.",
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(
      `Publication-gate PostgreSQL integration requires a local DATABASE_URL host; received ${parsed.hostname}.`,
    );
  }
  return databaseUrl;
}

const integrationEnabled = process.env.NUSIFT_RUN_PUBLICATION_GATE_MIGRATION_INTEGRATION === "1";
const dotenvContents = (() => {
  try {
    return readFileSync(new URL("../../.env", import.meta.url), "utf8");
  } catch {
    return undefined;
  }
})();
const databaseUrl = readDatabaseUrl(process.env, dotenvContents);
if (integrationEnabled) validateLocalDatabaseUrl(databaseUrl);

// Without opt-in the destructive test body is skipped. With opt-in, invalid
// configuration fails above rather than being silently reported as skipped.
const runIfDatabaseAvailable = integrationEnabled ? it : it.skip;

const initialMigration = readFileSync(
  new URL("./20260731134500_add_article_publication_gate/migration.sql", import.meta.url),
  "utf8",
);
const correctiveMigration = readFileSync(
  new URL("./20260731134600_correct_article_publication_gate/migration.sql", import.meta.url),
  "utf8",
);

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

const baseTableSql = `
  CREATE TABLE "Article" (
    "id" INTEGER PRIMARY KEY,
    "title" TEXT,
    "canonicalUrl" TEXT,
    "bodyText" TEXT,
    "enrichmentStatus" TEXT NOT NULL,
    "enrichmentFinishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

const publicationTableSql = `
  CREATE TYPE "PublicationStatus" AS ENUM ('CANDIDATE', 'PROCESSING', 'PUBLISHED', 'REJECTED');
  CREATE TABLE "Article" (
    "id" INTEGER PRIMARY KEY,
    "title" TEXT,
    "canonicalUrl" TEXT,
    "bodyText" TEXT,
    "enrichmentStatus" TEXT NOT NULL,
    "enrichmentFinishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publicationStatus" "PublicationStatus" NOT NULL DEFAULT 'CANDIDATE',
    "publicationStage" TEXT,
    "publicationReadyAt" TIMESTAMP(3)
  );
`;

const rows = [
  { id: 1, title: "Valid", canonicalUrl: "https://example.com/valid", bodyText: "A".repeat(500), status: "ENRICHED" },
  { id: 2, title: null, canonicalUrl: "https://example.com/null-title", bodyText: "A".repeat(500), status: "ENRICHED" },
  { id: 3, title: " \t\n ", canonicalUrl: "https://example.com/blank-title", bodyText: "A".repeat(500), status: "ENRICHED" },
  { id: 4, title: "Valid", canonicalUrl: null, bodyText: "A".repeat(500), status: "ENRICHED" },
  { id: 5, title: "Valid", canonicalUrl: " \t\n ", bodyText: "A".repeat(500), status: "ENRICHED" },
  { id: 6, title: "Valid", canonicalUrl: "https://example.com/null-body", bodyText: null, status: "ENRICHED" },
  { id: 7, title: "Valid", canonicalUrl: "https://example.com/short", bodyText: `\n${"A".repeat(499)}\t`, status: "ENRICHED" },
  { id: 8, title: "Valid", canonicalUrl: "https://example.com/edge", bodyText: `\t${"A".repeat(500)}\n`, status: "ENRICHED" },
  { id: 9, title: "Valid", canonicalUrl: "https://example.com/not-enriched", bodyText: "A".repeat(500), status: "INGESTED" },
  { id: 10, title: "Valid", canonicalUrl: "https://example.com/previously-invalid", bodyText: "A".repeat(499), status: "ENRICHED" },
];

async function seedBase(client: pg.Client, previouslyPublished = false) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO "Article" ("id", "title", "canonicalUrl", "bodyText", "enrichmentStatus") VALUES ($1, $2, $3, $4, $5)`,
      [row.id, row.title, row.canonicalUrl, row.bodyText, row.status],
    );
  }
  if (previouslyPublished) {
    await client.query(
      `UPDATE "Article" SET "publicationStatus" = 'PUBLISHED', "publicationStage" = 'agent3', "publicationReadyAt" = CURRENT_TIMESTAMP`,
    );
  }
}

async function readState(client: pg.Client) {
  const result = await client.query(
    `SELECT "id", "publicationStatus", "publicationStage", "publicationReadyAt" IS NOT NULL AS "hasReadyAt" FROM "Article" ORDER BY "id"`,
  );
  return result.rows;
}

describe("publication gate migration integration configuration", () => {
  it("parses quoted dotenv URLs and preserves explicit environment precedence", () => {
    expect(readDatabaseUrl({}, 'DATABASE_URL="postgresql://user:secret@localhost:5432/nusift"')).toBe(
      "postgresql://user:secret@localhost:5432/nusift",
    );
    expect(
      readDatabaseUrl(
        { DATABASE_URL: "postgresql://env-user:secret@127.0.0.1:5432/env-db" },
        'DATABASE_URL="postgresql://file-user:secret@localhost:5432/file-db"',
      ),
    ).toBe("postgresql://env-user:secret@127.0.0.1:5432/env-db");
  });

  it("fails explicitly for missing, invalid, and remote opt-in configuration", () => {
    expect(() => validateLocalDatabaseUrl(undefined)).toThrow(/DATABASE_URL is missing/);
    expect(() => validateLocalDatabaseUrl("not a URL")).toThrow(/DATABASE_URL is invalid/);
    expect(() => validateLocalDatabaseUrl("http://localhost/nusift")).toThrow(/postgresql:\/\/ or postgres:\/\//);
    expect(() => validateLocalDatabaseUrl("postgresql://db.example.com/nusift")).toThrow(/local DATABASE_URL host/);
    expect(validateLocalDatabaseUrl("postgresql://[::1]:5432/nusift")).toBe(
      "postgresql://[::1]:5432/nusift",
    );
  });
});

describe("publication gate migration execution", () => {
  runIfDatabaseAvailable("matches fresh and corrective migration safety", async () => {
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
    const freshSchema = `publication_gate_fresh_${randomUUID().replaceAll("-", "")}`;
    const correctiveSchema = `publication_gate_corrective_${randomUUID().replaceAll("-", "")}`;

    try {
      await client.connect();
      for (const schema of [freshSchema, correctiveSchema]) {
        await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      }

      await client.query(`SET search_path TO ${quoteIdentifier(freshSchema)}, public`);
      await client.query(baseTableSql);
      await seedBase(client, false);
      await client.query(initialMigration);
      // Simulate a previously published invalid row arriving before the
      // corrective migration, as can happen on a deployed database.
      await client.query(
        `UPDATE "Article" SET "publicationStatus" = 'PUBLISHED', "publicationStage" = 'agent3', "publicationReadyAt" = CURRENT_TIMESTAMP WHERE "id" = 10`,
      );
      await client.query(correctiveMigration);
      const freshState = await readState(client);

      await client.query(`SET search_path TO ${quoteIdentifier(correctiveSchema)}, public`);
      await client.query(publicationTableSql);
      await seedBase(client, true);
      await client.query(correctiveMigration);
      const correctiveState = await readState(client);

      expect(freshState).toEqual(correctiveState);
      expect(freshState.filter((row) => row.publicationStatus === "PUBLISHED")).toEqual([
        { id: 1, publicationStatus: "PUBLISHED", publicationStage: "agent3", hasReadyAt: true },
        { id: 8, publicationStatus: "PUBLISHED", publicationStage: "agent3", hasReadyAt: true },
      ]);
      for (const row of freshState.filter((value) => value.id !== 1 && value.id !== 8)) {
        expect(row).toMatchObject({
          publicationStatus: "CANDIDATE",
          publicationStage: null,
          hasReadyAt: false,
        });
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(freshSchema)} CASCADE`).catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(correctiveSchema)} CASCADE`).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }, 15_000);

});
