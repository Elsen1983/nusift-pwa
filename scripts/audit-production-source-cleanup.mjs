import crypto from "node:crypto";
import fs from "node:fs";
import dotenv from "dotenv";
import pg from "pg";

const args = new Set(process.argv.slice(2));
const envArg = process.argv.find((arg) => arg.startsWith("--env="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const envFile = envArg?.slice("--env=".length) || ".env";
const outputFile = outputArg?.slice("--output=".length) || null;

if (!args.has("--production-read-only")) {
  throw new Error("Refusing to connect: pass --production-read-only to confirm a read-only production audit.");
}

const parsedEnv = dotenv.parse(fs.readFileSync(envFile));
if (!parsedEnv.DATABASE_URL) throw new Error(`DATABASE_URL is missing from ${envFile}.`);
const databaseUrl = new URL(parsedEnv.DATABASE_URL);
if (["localhost", "127.0.0.1", "::1"].includes(databaseUrl.hostname)) {
  throw new Error("This command is production-audit only; use the existing local repair scripts for localhost.");
}

const pool = new pg.Pool({
  connectionString: databaseUrl.toString(),
  max: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 5_000,
});

const normalizeUrl = (value) => {
  const url = new URL(value);
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
};

const rootUrl = (value) => {
  const url = new URL(value);
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const groupDuplicates = (rows, field) => {
  const groups = new Map();
  for (const row of rows) {
    try {
      const key = normalizeUrl(row[field]);
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    } catch {
      // Malformed URLs are reported separately and never included in a repair plan.
    }
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([normalizedUrl, members]) => ({
      normalizedUrl,
      ids: members.map((row) => row.id).sort(),
      storedUrls: [...new Set(members.map((row) => row[field]))].sort(),
      count: members.length,
    }))
    .sort((a, b) => a.normalizedUrl.localeCompare(b.normalizedUrl));
};

const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query("SET LOCAL lock_timeout = '2s'");

  // One pg client executes one query at a time. Keep these sequential so the
  // audit remains compatible with pg 9 without opening extra connections.
  const sourcesResult = await client.query(`
      SELECT id, "frontPageUrl",
        (SELECT count(*)::int FROM "SourceCategory" c WHERE c."newsSourceId" = ns.id) AS categories,
        (SELECT count(*)::int FROM "Article" a WHERE a."sourceId" = ns.id) AS articles,
        (SELECT count(*)::int FROM "UserSourceSubscription" s WHERE s."sourceId" = ns.id) AS subscriptions,
        (SELECT count(*)::int FROM "PipelineArtifact" p WHERE p."sourceId" = ns.id) AS artifacts
      FROM "NewsSource" ns
      ORDER BY id
    `);
  const categoriesResult = await client.query(`
      SELECT id, "newsSourceId", "pathUrl", "rssFeedUrl", "rssStatus",
        (SELECT count(*)::int FROM "Article" a WHERE a."categoryId" = sc.id) AS articles,
        (SELECT count(*)::int FROM "UserCategorySubscription" s WHERE s."categoryId" = sc.id) AS subscriptions,
        (SELECT count(*)::int FROM "PipelineArtifact" p WHERE p."categoryId" = sc.id) AS artifacts
      FROM "SourceCategory" sc
      ORDER BY id
    `);
  const invalidStateResult = await client.query(`
      SELECT
        (SELECT count(*)::int FROM "NewsSource" WHERE "rssStatus" = 'ACTIVE' AND "rssFeedUrl" IS NULL) AS invalid_active_sources,
        (SELECT count(*)::int FROM "SourceCategory" WHERE "rssStatus" = 'ACTIVE' AND "rssFeedUrl" IS NULL) AS invalid_active_categories
    `);

  const sources = sourcesResult.rows;
  const categories = categoriesResult.rows;
  const categoryByNormalizedUrl = new Map();
  for (const category of categories) {
    try {
      const key = normalizeUrl(category.pathUrl);
      if (!categoryByNormalizedUrl.has(key)) categoryByNormalizedUrl.set(key, []);
      categoryByNormalizedUrl.get(key).push(category);
    } catch { /* reported below */ }
  }

  const hierarchyOverlaps = [];
  for (const source of sources) {
    try {
      const normalized = normalizeUrl(source.frontPageUrl);
      if (new URL(normalized).pathname === "/") continue;
      const matchingCategories = categoryByNormalizedUrl.get(normalized) || [];
      if (matchingCategories.length === 0) continue;
      hierarchyOverlaps.push({
        sourceId: source.id,
        sourceUrl: source.frontPageUrl,
        expectedRootUrl: rootUrl(source.frontPageUrl),
        matchingCategoryIds: matchingCategories.map((category) => category.id).sort(),
        matchingCategorySourceIds: [...new Set(matchingCategories.map((category) => category.newsSourceId))].sort(),
        impact: {
          categories: source.categories,
          articles: source.articles,
          subscriptions: source.subscriptions,
          artifacts: source.artifacts,
        },
      });
    } catch { /* reported below */ }
  }

  const malformedSourceUrls = sources
    .filter((row) => { try { normalizeUrl(row.frontPageUrl); return false; } catch { return true; } })
    .map((row) => ({ id: row.id, value: row.frontPageUrl }));
  const malformedCategoryUrls = categories
    .filter((row) => { try { normalizeUrl(row.pathUrl); return false; } catch { return true; } })
    .map((row) => ({ id: row.id, value: row.pathUrl }));

  const plan = {
    sourceDuplicateGroups: groupDuplicates(sources, "frontPageUrl"),
    categoryDuplicateGroups: groupDuplicates(categories, "pathUrl"),
    hierarchyOverlaps: hierarchyOverlaps.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    invalidRssStates: invalidStateResult.rows[0],
    malformedSourceUrls,
    malformedCategoryUrls,
  };
  const planHash = crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const report = {
    mode: "production-read-only",
    generatedAt: new Date().toISOString(),
    databaseHost: databaseUrl.hostname,
    planHash,
    summary: {
      sourcesScanned: sources.length,
      categoriesScanned: categories.length,
      sourceDuplicateGroups: plan.sourceDuplicateGroups.length,
      categoryDuplicateGroups: plan.categoryDuplicateGroups.length,
      hierarchyOverlaps: plan.hierarchyOverlaps.length,
      invalidActiveSources: plan.invalidRssStates.invalid_active_sources,
      invalidActiveCategories: plan.invalidRssStates.invalid_active_categories,
      malformedSourceUrls: malformedSourceUrls.length,
      malformedCategoryUrls: malformedCategoryUrls.length,
    },
    plan,
  };

  await client.query("ROLLBACK");
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outputFile) fs.writeFileSync(outputFile, output, { flag: "wx" });
  else process.stdout.write(output);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
