import fs from "node:fs";
import dotenv from "dotenv";
import pg from "pg";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const envArg = process.argv.find((arg) => arg.startsWith("--env="));
const envFile = envArg?.slice("--env=".length) || ".env";
const env = dotenv.parse(fs.readFileSync(envFile));
const databaseUrl = new URL(env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "::1"].includes(databaseUrl.hostname)) {
  throw new Error("This repair utility is local-only and refuses non-local database hosts.");
}

const pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 1 });

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

const isSubpath = (value) => new URL(normalizeUrl(value)).pathname !== "/";

const loadPlan = async (client) => {
  const [sourceResult, categoryResult] = await Promise.all([
    client.query(`SELECT id, "frontPageUrl" FROM "NewsSource"`),
    client.query(`SELECT id, "newsSourceId", "pathUrl" FROM "SourceCategory"`),
  ]);
  const sourcesByRoot = new Map();
  for (const source of sourceResult.rows) {
    const key = rootUrl(source.frontPageUrl);
    const values = sourcesByRoot.get(key) || [];
    values.push(source);
    sourcesByRoot.set(key, values);
  }
  const categoryByUrl = new Map();
  for (const category of categoryResult.rows) {
    const key = normalizeUrl(category.pathUrl);
    if (!categoryByUrl.has(key)) categoryByUrl.set(key, category);
  }

  const mergeMappings = [];
  const rootifyMappings = [];
  for (const source of sourceResult.rows) {
    if (!isSubpath(source.frontPageUrl)) continue;
    const category = categoryByUrl.get(normalizeUrl(source.frontPageUrl));
    if (!category) continue;
    if (category.newsSourceId !== source.id) {
      mergeMappings.push({
        loserSourceId: source.id,
        winnerSourceId: category.newsSourceId,
        categoryId: category.id,
        sourceUrl: source.frontPageUrl,
      });
      continue;
    }

    const targetRootUrl = rootUrl(source.frontPageUrl);
    const otherRoot = (sourcesByRoot.get(targetRootUrl) || []).find((candidate) =>
      candidate.id !== source.id && normalizeUrl(candidate.frontPageUrl) === targetRootUrl,
    );
    if (otherRoot) {
      mergeMappings.push({
        loserSourceId: source.id,
        winnerSourceId: otherRoot.id,
        categoryId: category.id,
        sourceUrl: source.frontPageUrl,
      });
    } else {
      rootifyMappings.push({ sourceId: source.id, rootUrl: targetRootUrl, sourceUrl: source.frontPageUrl });
    }
  }
  return { mergeMappings, rootifyMappings };
};

const insertMergeMappings = async (client, mappings) => {
  await client.query(`CREATE TEMP TABLE source_hierarchy_map (
    loser_source_id text PRIMARY KEY,
    winner_source_id text NOT NULL,
    category_id text NOT NULL
  ) ON COMMIT DROP`);
  for (const mapping of mappings) {
    await client.query(
      `INSERT INTO source_hierarchy_map VALUES ($1, $2, $3)`,
      [mapping.loserSourceId, mapping.winnerSourceId, mapping.categoryId],
    );
  }
};

const applyPlan = async (client, plan) => {
  await client.query("BEGIN");
  try {
    await insertMergeMappings(client, plan.mergeMappings);
    const childCategoryResult = await client.query(`
      SELECT count(*)::int AS count
      FROM "SourceCategory" child
      JOIN source_hierarchy_map m ON m.loser_source_id = child."newsSourceId"
      WHERE child.id <> m.category_id
    `);
    if (childCategoryResult.rows[0].count > 0) {
      throw new Error("Refusing migration: a loser source owns additional categories that require an explicit category merge plan.");
    }

    await client.query(`
      INSERT INTO "UserCategorySubscription" ("userId", "categoryId", "isActive", "customAlias")
      SELECT sub."userId", m.category_id, sub."isActive", sub."customAlias"
      FROM "UserSourceSubscription" sub
      JOIN source_hierarchy_map m ON m.loser_source_id = sub."sourceId"
      ON CONFLICT ("userId", "categoryId") DO UPDATE SET
        "isActive" = "UserCategorySubscription"."isActive" OR EXCLUDED."isActive",
        "customAlias" = COALESCE("UserCategorySubscription"."customAlias", EXCLUDED."customAlias"),
        "updatedAt" = now()
    `);
    await client.query(`DELETE FROM "UserSourceSubscription" sub USING source_hierarchy_map m WHERE sub."sourceId" = m.loser_source_id`);
    await client.query(`
      UPDATE "Article" row SET "sourceId" = m.winner_source_id, "categoryId" = m.category_id
      FROM source_hierarchy_map m WHERE row."sourceId" = m.loser_source_id
    `);
    await client.query(`
      UPDATE "PipelineArtifact" row SET
        "sourceId" = m.winner_source_id,
        "categoryId" = m.category_id,
        payload = CASE WHEN jsonb_typeof(row.payload) = 'object' THEN
          jsonb_set(jsonb_set(row.payload, '{sourceId}', to_jsonb(m.winner_source_id)), '{categoryId}', to_jsonb(m.category_id))
          ELSE row.payload END
      FROM source_hierarchy_map m WHERE row."sourceId" = m.loser_source_id
    `);
    await client.query(`
      UPDATE "FeedReviewRequest" row SET "sourceId" = m.winner_source_id, "categoryId" = m.category_id
      FROM source_hierarchy_map m WHERE row."sourceId" = m.loser_source_id
    `);
    await client.query(`
      UPDATE "AgentScanLog" row SET "sourceId" = m.winner_source_id, "categoryId" = m.category_id
      FROM source_hierarchy_map m WHERE row."sourceId" = m.loser_source_id
    `);
    await client.query(`DELETE FROM "NewsSource" row USING source_hierarchy_map m WHERE row.id = m.loser_source_id`);

    for (const mapping of plan.rootifyMappings) {
      await client.query(`UPDATE "NewsSource" SET "frontPageUrl" = $2 WHERE id = $1`, [mapping.sourceId, mapping.rootUrl]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

const main = async () => {
  const client = await pool.connect();
  try {
    const plan = await loadPlan(client);
    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      mergeCount: plan.mergeMappings.length,
      rootifyCount: plan.rootifyMappings.length,
      affectedOrigins: new Set([
        ...plan.mergeMappings.map((entry) => rootUrl(entry.sourceUrl)),
        ...plan.rootifyMappings.map((entry) => rootUrl(entry.sourceUrl)),
      ]).size,
      bigNewsMergeCount: plan.mergeMappings.filter((entry) => entry.sourceUrl.includes("bignewsnetwork.com")).length,
      rootifyMappings: plan.rootifyMappings,
    }, null, 2));
    if (apply) {
      await applyPlan(client, plan);
      const remaining = await loadPlan(client);
      if (remaining.mergeMappings.length || remaining.rootifyMappings.length) {
        throw new Error(`Postcondition failed: ${remaining.mergeMappings.length + remaining.rootifyMappings.length} overlaps remain.`);
      }
      console.log("Source hierarchy repair completed; zero overlaps remain.");
    }
  } finally {
    client.release();
    await pool.end();
  }
};

await main();
