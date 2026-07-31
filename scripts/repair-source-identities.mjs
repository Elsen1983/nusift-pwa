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
const pool = new pg.Pool({
  connectionString: databaseUrl.toString(),
  max: 1,
  connectionTimeoutMillis: 15_000,
});

const normalizeIdentity = (value) => {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
};

const canonicalStoredUrl = (value) => {
  const url = new URL(value);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
};

const relationScore = (row) =>
  row.userSubmitted * 1_000_000 +
  row.activeSubscriptions * 100_000 +
  row.subscriptions * 10_000 +
  row.productive * 5_000 +
  row.validFeed * 2_000 +
  row.articles * 100 +
  row.categories * 10 +
  row.artifacts;

const groupMappings = (rows, urlField) => {
  const groups = new Map();
  for (const row of rows) {
    let key;
    try {
      key = normalizeIdentity(row[urlField]);
    } catch {
      continue;
    }
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  const mappings = [];
  const winners = new Map();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    group.sort((left, right) =>
      relationScore(right) - relationScore(left) ||
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
      left.id.localeCompare(right.id),
    );
    const winner = group[0];
    winners.set(winner.id, {
      id: winner.id,
      key,
      storedUrl: canonicalStoredUrl(winner[urlField]),
      members: group,
    });
    for (const loser of group.slice(1)) {
      mappings.push({ loserId: loser.id, winnerId: winner.id });
    }
  }
  return { mappings, winners };
};

const sourceRowsSql = `
  SELECT ns.*,
    (ns."feedProvenance" = 'USER_SUBMITTED')::int AS "userSubmitted",
    (ns."currentFeedProductive")::int AS productive,
    (ns."rssFeedUrl" IS NOT NULL)::int AS "validFeed",
    (SELECT count(*)::int FROM "UserSourceSubscription" s WHERE s."sourceId" = ns.id) AS subscriptions,
    (SELECT count(*)::int FROM "UserSourceSubscription" s WHERE s."sourceId" = ns.id AND s."isActive") AS "activeSubscriptions",
    (SELECT count(*)::int FROM "Article" a WHERE a."sourceId" = ns.id) AS articles,
    (SELECT count(*)::int FROM "SourceCategory" c WHERE c."newsSourceId" = ns.id) AS categories,
    (SELECT count(*)::int FROM "PipelineArtifact" p WHERE p."sourceId" = ns.id) AS artifacts
  FROM "NewsSource" ns
`;

const categoryRowsSql = `
  SELECT sc.*,
    (sc."feedProvenance" = 'USER_SUBMITTED')::int AS "userSubmitted",
    (sc."currentFeedProductive")::int AS productive,
    (sc."rssFeedUrl" IS NOT NULL)::int AS "validFeed",
    (SELECT count(*)::int FROM "UserCategorySubscription" s WHERE s."categoryId" = sc.id) AS subscriptions,
    (SELECT count(*)::int FROM "UserCategorySubscription" s WHERE s."categoryId" = sc.id AND s."isActive") AS "activeSubscriptions",
    (SELECT count(*)::int FROM "Article" a WHERE a."categoryId" = sc.id) AS articles,
    0 AS categories,
    (SELECT count(*)::int FROM "PipelineArtifact" p WHERE p."categoryId" = sc.id) AS artifacts
  FROM "SourceCategory" sc
`;

const insertMappings = async (client, table, mappings) => {
  await client.query(`CREATE TEMP TABLE ${table} (loser_id text PRIMARY KEY, winner_id text NOT NULL) ON COMMIT DROP`);
  if (mappings.length === 0) return;
  const values = [];
  const params = [];
  mappings.forEach((mapping, index) => {
    values.push(`($${index * 2 + 1}, $${index * 2 + 2})`);
    params.push(mapping.loserId, mapping.winnerId);
  });
  await client.query(`INSERT INTO ${table} (loser_id, winner_id) VALUES ${values.join(",")}`, params);
};

const recoverSubmittedFeed = (row) => {
  if (row.rssFeedUrl || row.feedProvenance !== "USER_SUBMITTED") return row.rssFeedUrl;
  const evidence = row.discoveryEvidence;
  const candidate = evidence?.outcome?.feedUrl || evidence?.feedUrl;
  return typeof candidate === "string" && candidate ? candidate : null;
};

const mergeMetadata = (members, winner) => {
  const ranked = [...members].sort((a, b) => relationScore(b) - relationScore(a));
  const first = (field) => ranked.find((row) => row[field] != null)?.[field] ?? null;
  const submitted = ranked.find((row) =>
    row.feedProvenance === "USER_SUBMITTED" &&
    (row.rssFeedUrl || row.discoveryEvidence?.outcome?.feedUrl || row.discoveryEvidence?.feedUrl),
  );
  const feedUrl = submitted ? recoverSubmittedFeed(submitted) : first("rssFeedUrl");
  return {
    rssFeedUrl: feedUrl,
    rssStatus: feedUrl ? "ACTIVE" : winner.rssStatus === "ACTIVE" ? "NO_RSS_FOUND" : winner.rssStatus,
    discoveryEvidence: submitted?.discoveryEvidence ?? first("discoveryEvidence"),
    currentFeedProductive: ranked.some((row) => row.currentFeedProductive),
    consecutiveNonProductiveRuns: Math.min(...ranked.map((row) => row.consecutiveNonProductiveRuns ?? 0)),
    lastProductiveFeedUrl: first("lastProductiveFeedUrl"),
    lastProductiveAt: first("lastProductiveAt"),
    feedProvenance: submitted ? "USER_SUBMITTED" : winner.feedProvenance,
    feedSubmittedByUserId: submitted?.feedSubmittedByUserId ?? first("feedSubmittedByUserId"),
    feedSubmittedAt: submitted?.feedSubmittedAt ?? first("feedSubmittedAt"),
  };
};

const updateWinnerMetadata = async (client, table, urlField, plans) => {
  for (const plan of plans.values()) {
    const winner = plan.members.find((row) => row.id === plan.id);
    const merged = mergeMetadata(plan.members, winner);
    await client.query(
      `UPDATE "${table}" SET
        "${urlField}" = $2,
        "rssFeedUrl" = $3,
        "rssStatus" = $4,
        "discoveryEvidence" = $5::jsonb,
        "currentFeedProductive" = $6,
        "consecutiveNonProductiveRuns" = $7,
        "lastProductiveFeedUrl" = $8,
        "lastProductiveAt" = $9,
        "feedProvenance" = $10,
        "feedSubmittedByUserId" = $11,
        "feedSubmittedAt" = $12
      WHERE id = $1`,
      [
        plan.id,
        plan.storedUrl,
        merged.rssFeedUrl,
        merged.rssStatus,
        merged.discoveryEvidence ? JSON.stringify(merged.discoveryEvidence) : null,
        merged.currentFeedProductive,
        merged.consecutiveNonProductiveRuns,
        merged.lastProductiveFeedUrl,
        merged.lastProductiveAt,
        merged.feedProvenance,
        merged.feedSubmittedByUserId,
        merged.feedSubmittedAt,
      ],
    );
  }
};

const client = await pool.connect();
try {
  const [sourceResult, categoryResult] = await Promise.all([
    client.query(sourceRowsSql),
    client.query(categoryRowsSql),
  ]);
  const sourcePlan = groupMappings(sourceResult.rows, "frontPageUrl");
  const categoryPlan = groupMappings(categoryResult.rows, "pathUrl");
  const validation = await client.query(`
    SELECT
      (SELECT count(*)::int FROM "NewsSource" WHERE "rssStatus" = 'ACTIVE' AND "rssFeedUrl" IS NULL) AS invalid_active_sources,
      (SELECT count(*)::int FROM "SourceCategory" WHERE "rssStatus" = 'ACTIVE' AND "rssFeedUrl" IS NULL) AS invalid_active_categories,
      (SELECT count(*)::int FROM "NewsSource" WHERE lower("frontPageUrl") LIKE '%bignewsnetwork.com%') AS big_news_sources,
      (SELECT count(*)::int FROM "SourceCategory" WHERE lower("pathUrl") = 'https://www.bignewsnetwork.com/category/arizona-news') AS big_news_categories
  `);

  const report = {
    mode: apply ? "apply" : "dry-run",
    sourceGroups: sourcePlan.winners.size,
    sourceLosers: sourcePlan.mappings.length,
    categoryGroups: categoryPlan.winners.size,
    categoryLosers: categoryPlan.mappings.length,
    validation: validation.rows[0],
    bigNewsCategory: categoryResult.rows
      .filter((row) => row.pathUrl.toLowerCase().includes("bignewsnetwork.com/category/arizona-news"))
      .map((row) => ({
        id: row.id,
        sourceId: row.newsSourceId,
        rssFeedUrl: row.rssFeedUrl,
        rssStatus: row.rssStatus,
        feedProvenance: row.feedProvenance,
        currentFeedProductive: row.currentFeedProductive,
        evidenceDetection: row.discoveryEvidence?.outcome?.detection || row.discoveryEvidence?.detection || null,
        evidenceFeedUrl: row.discoveryEvidence?.outcome?.feedUrl || row.discoveryEvidence?.feedUrl || null,
      })),
  };

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 0;
  } else {
    await client.query("BEGIN");
    await insertMappings(client, "source_merge_map", sourcePlan.mappings);
    await insertMappings(client, "category_merge_map", categoryPlan.mappings);

    await client.query(`
      UPDATE "UserCategorySubscription" winner
      SET "isActive" = winner."isActive" OR loser."isActive",
          "customAlias" = COALESCE(winner."customAlias", loser."customAlias")
      FROM "UserCategorySubscription" loser
      JOIN category_merge_map m ON m.loser_id = loser."categoryId"
      WHERE winner."userId" = loser."userId" AND winner."categoryId" = m.winner_id
    `);
    await client.query(`
      DELETE FROM "UserCategorySubscription" loser
      USING category_merge_map m
      WHERE loser."categoryId" = m.loser_id
        AND EXISTS (
          SELECT 1 FROM "UserCategorySubscription" winner
          WHERE winner."userId" = loser."userId" AND winner."categoryId" = m.winner_id
        )
    `);
    await client.query(`UPDATE "UserCategorySubscription" x SET "categoryId" = m.winner_id FROM category_merge_map m WHERE x."categoryId" = m.loser_id`);
    await client.query(`UPDATE "Article" x SET "categoryId" = m.winner_id FROM category_merge_map m WHERE x."categoryId" = m.loser_id`);
    await client.query(`
      UPDATE "PipelineArtifact" x
      SET "categoryId" = m.winner_id,
          payload = CASE
            WHEN x.payload ? 'categoryId'
              THEN jsonb_set(x.payload, '{categoryId}', to_jsonb(m.winner_id::text))
            ELSE x.payload
          END
      FROM category_merge_map m
      WHERE x."categoryId" = m.loser_id
    `);
    await client.query(`UPDATE "FeedReviewRequest" x SET "categoryId" = m.winner_id FROM category_merge_map m WHERE x."categoryId" = m.loser_id`);
    await client.query(`UPDATE "AgentScanLog" x SET "categoryId" = m.winner_id::text FROM category_merge_map m WHERE x."categoryId" = m.loser_id::text`);
    await client.query(`DELETE FROM "SourceCategory" x USING category_merge_map m WHERE x.id = m.loser_id`);

    await client.query(`
      UPDATE "UserSourceSubscription" winner
      SET "isActive" = winner."isActive" OR loser."isActive",
          "customAlias" = COALESCE(winner."customAlias", loser."customAlias")
      FROM "UserSourceSubscription" loser
      JOIN source_merge_map m ON m.loser_id = loser."sourceId"
      WHERE winner."userId" = loser."userId" AND winner."sourceId" = m.winner_id
    `);
    await client.query(`
      DELETE FROM "UserSourceSubscription" loser
      USING source_merge_map m
      WHERE loser."sourceId" = m.loser_id
        AND EXISTS (
          SELECT 1 FROM "UserSourceSubscription" winner
          WHERE winner."userId" = loser."userId" AND winner."sourceId" = m.winner_id
        )
    `);
    await client.query(`UPDATE "UserSourceSubscription" x SET "sourceId" = m.winner_id FROM source_merge_map m WHERE x."sourceId" = m.loser_id`);
    await client.query(`UPDATE "SourceCategory" x SET "newsSourceId" = m.winner_id FROM source_merge_map m WHERE x."newsSourceId" = m.loser_id`);
    await client.query(`UPDATE "Article" x SET "sourceId" = m.winner_id FROM source_merge_map m WHERE x."sourceId" = m.loser_id`);
    await client.query(`
      UPDATE "PipelineArtifact" x
      SET "sourceId" = m.winner_id,
          payload = CASE
            WHEN x.payload ? 'sourceId'
              THEN jsonb_set(x.payload, '{sourceId}', to_jsonb(m.winner_id::text))
            ELSE x.payload
          END
      FROM source_merge_map m
      WHERE x."sourceId" = m.loser_id
    `);
    await client.query(`UPDATE "FeedReviewRequest" x SET "sourceId" = m.winner_id FROM source_merge_map m WHERE x."sourceId" = m.loser_id`);
    await client.query(`UPDATE "AgentScanLog" x SET "sourceId" = m.winner_id::text FROM source_merge_map m WHERE x."sourceId" = m.loser_id::text`);
    await client.query(`DELETE FROM "NewsSource" x USING source_merge_map m WHERE x.id = m.loser_id`);

    await updateWinnerMetadata(client, "SourceCategory", "pathUrl", categoryPlan.winners);
    await updateWinnerMetadata(client, "NewsSource", "frontPageUrl", sourcePlan.winners);
    for (const table of ["NewsSource", "SourceCategory"]) {
      await client.query(`
        UPDATE "${table}"
        SET "rssFeedUrl" = COALESCE(
              "discoveryEvidence" #>> '{outcome,feedUrl}',
              "discoveryEvidence" ->> 'feedUrl'
            ),
            "rssStatus" = 'ACTIVE',
            "feedProvenance" = 'USER_SUBMITTED'
        WHERE "rssFeedUrl" IS NULL
          AND COALESCE(
            "discoveryEvidence" #>> '{outcome,detection}',
            "discoveryEvidence" ->> 'detection'
          ) = 'manual-override'
          AND COALESCE(
            "discoveryEvidence" #>> '{outcome,feedUrl}',
            "discoveryEvidence" ->> 'feedUrl'
          ) IS NOT NULL
      `);
    }
    await client.query(`UPDATE "NewsSource" SET "rssStatus" = 'NO_RSS_FOUND' WHERE "rssStatus" = 'ACTIVE' AND "rssFeedUrl" IS NULL`);
    await client.query(`UPDATE "SourceCategory" SET "rssStatus" = 'NO_RSS_FOUND' WHERE "rssStatus" = 'ACTIVE' AND "rssFeedUrl" IS NULL`);
    await client.query("COMMIT");
    console.log(JSON.stringify({ ...report, committed: true }, null, 2));
  }
} catch (error) {
  if (apply) await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
