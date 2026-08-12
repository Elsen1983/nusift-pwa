import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import pg from "pg";
import { expect, it } from "vitest";

const enabled = process.env.NUSIFT_RUN_ARTICLE_IDENTITY_MIGRATION_INTEGRATION === "1";
const envUrl = process.env.DATABASE_URL ?? (() => {
  try { return dotenv.parse(readFileSync(new URL("../../.env", import.meta.url), "utf8")).DATABASE_URL; }
  catch { return undefined; }
})();

const requireLocalUrl = (value: string | undefined) => {
  if (!value) throw new Error("Local DATABASE_URL is required for the Article identity migration integration test.");
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!(url.protocol === "postgres:" || url.protocol === "postgresql:") || !["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Article identity migration integration is localhost-only.");
  }
  return value;
};

if (enabled) requireLocalUrl(envUrl);
const run = enabled ? it : it.skip;
const sql = readFileSync(new URL("./20260812160000_define_article_identity_contract/migration.sql", import.meta.url), "utf8");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

run("executes the Article identity migration without merging rows or orphaning relations", async () => {
  const client = new pg.Client({ connectionString: requireLocalUrl(envUrl), connectionTimeoutMillis: 5_000 });
  const contender = new pg.Client({ connectionString: requireLocalUrl(envUrl), connectionTimeoutMillis: 5_000 });
  const schema = `article_identity_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.connect();
    await contender.connect();
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path TO ${quote(schema)}, public`);
    await contender.query(`SET search_path TO ${quote(schema)}, public`);
    await client.query(`
      CREATE TABLE "Article" (
        "id" SERIAL PRIMARY KEY,
        "sourceId" TEXT NOT NULL,
        "canonicalUrl" TEXT,
        "rssGuid" TEXT,
        "contentHash" TEXT
      );
      CREATE UNIQUE INDEX "Article_canonicalUrl_key" ON "Article"("canonicalUrl");
      CREATE UNIQUE INDEX "Article_rssGuid_key" ON "Article"("rssGuid");
      CREATE UNIQUE INDEX "Article_contentHash_key" ON "Article"("contentHash");
      CREATE TABLE "Bookmark" ("id" TEXT PRIMARY KEY, "articleId" INTEGER NOT NULL REFERENCES "Article"("id") ON DELETE CASCADE);
      CREATE TABLE "ArticleRating" ("id" TEXT PRIMARY KEY, "articleId" INTEGER NOT NULL REFERENCES "Article"("id") ON DELETE CASCADE);
      CREATE TABLE "UserReadActivity" ("id" TEXT PRIMARY KEY, "articleId" INTEGER NOT NULL REFERENCES "Article"("id") ON DELETE CASCADE);
      INSERT INTO "Article" ("sourceId", "canonicalUrl", "rssGuid", "contentHash") VALUES
        ('source-a', 'http://example.test/story', 'guid-a', 'hash-a'),
        ('source-b', 'https://example.test/story', 'guid-b', 'hash-b'),
        ('source-c', 'https://other.test/story', 'guid-c', 'hash-c');
      INSERT INTO "Bookmark" VALUES ('bookmark', 1);
      INSERT INTO "ArticleRating" VALUES ('rating', 1);
      INSERT INTO "UserReadActivity" VALUES ('read', 1);
    `);

    await client.query(sql);

    const identities = await client.query(`SELECT "id", "canonicalIdentity" FROM "Article" ORDER BY "id"`);
    expect(identities.rows).toEqual([
      { id: 1, canonicalIdentity: null },
      { id: 2, canonicalIdentity: null },
      { id: 3, canonicalIdentity: "https://other.test/story" },
    ]);
    await client.query(`INSERT INTO "Article" ("sourceId", "canonicalUrl", "canonicalIdentity", "rssGuid", "contentHash") VALUES
      ('source-a', 'https://publisher-a.test/wire', 'https://publisher-a.test/wire', 'reused-guid', 'same-hash'),
      ('source-b', 'https://publisher-b.test/wire', 'https://publisher-b.test/wire', 'reused-guid', 'same-hash')`);
    await expect(client.query(`INSERT INTO "Article" ("sourceId", "canonicalUrl", "canonicalIdentity") VALUES
      ('source-z', 'http://publisher-a.test/wire', 'https://publisher-a.test/wire')`)).rejects.toMatchObject({ code: "23505" });

    const concurrent = await Promise.allSettled([
      client.query(`INSERT INTO "Article" ("sourceId", "canonicalUrl", "canonicalIdentity") VALUES ('race-a', 'http://race.test/story', 'https://race.test/story')`),
      contender.query(`INSERT INTO "Article" ("sourceId", "canonicalUrl", "canonicalIdentity") VALUES ('race-b', 'https://race.test/story', 'https://race.test/story')`),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);

    for (const table of ["Bookmark", "ArticleRating", "UserReadActivity"]) {
      expect((await client.query(`SELECT count(*)::int count FROM ${quote(table)}`)).rows[0]?.count).toBe(1);
    }
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
    await contender.end().catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}, 15_000);
