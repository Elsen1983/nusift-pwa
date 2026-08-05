import crypto from "node:crypto";
import fs from "node:fs";
import dotenv from "dotenv";
import pg from "pg";

const CONFIRM_TOKEN = "APPLY_PRODUCTION_SOURCE_HIERARCHY_REPAIR";
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const envArg = process.argv.find((arg) => arg.startsWith("--env="));
const hashArg = process.argv.find((arg) => arg.startsWith("--plan-hash="));
const confirmArg = process.argv.find((arg) => arg.startsWith("--confirm="));
const envFile = envArg?.slice("--env=".length) || ".env";
const expectedHash = hashArg?.slice("--plan-hash=".length) || null;
const confirmation = confirmArg?.slice("--confirm=".length) || null;

if (!args.has("--production")) throw new Error("Pass --production to acknowledge the remote target.");
const parsedEnv = dotenv.parse(fs.readFileSync(envFile));
if (!parsedEnv.DATABASE_URL) throw new Error(`DATABASE_URL is missing from ${envFile}.`);
const databaseUrl = new URL(parsedEnv.DATABASE_URL);
if (["localhost", "127.0.0.1", "::1"].includes(databaseUrl.hostname)) {
  throw new Error("This utility is production-only; use the existing local repair scripts for localhost.");
}
if (apply && (confirmation !== CONFIRM_TOKEN || !expectedHash)) {
  throw new Error(`Apply requires --confirm=${CONFIRM_TOKEN} and --plan-hash=<fresh dry-run hash>.`);
}

const pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 10_000 });
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
const normalizeFeedIdentity = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return normalizeUrl(value); } catch { return `invalid:${value.trim().toLowerCase()}`; }
};

const loadPlan = async (client) => {
  const sources = (await client.query(`
    SELECT ns.id, ns."frontPageUrl", ns."rssFeedUrl", ns."rssStatus", ns."feedProvenance",
      ns."currentFeedProductive", ns."discoveryEvidence", ns."consecutiveNonProductiveRuns",
      ns."feedSubmittedByUserId", ns."feedSubmittedAt", ns."lastProductiveFeedUrl", ns."lastProductiveAt",
      (SELECT count(*)::int FROM "SourceCategory" c WHERE c."newsSourceId" = ns.id) AS categories,
      (SELECT count(*)::int FROM "Article" a WHERE a."sourceId" = ns.id) AS articles,
      (SELECT count(*)::int FROM "UserSourceSubscription" s WHERE s."sourceId" = ns.id) AS subscriptions,
      (SELECT count(*)::int FROM "PipelineArtifact" p WHERE p."sourceId" = ns.id) AS artifacts,
      (SELECT count(*)::int FROM "FeedReviewRequest" f WHERE f."sourceId" = ns.id) AS reviews,
      (SELECT count(*)::int FROM "AgentScanLog" l WHERE l."sourceId" = ns.id::text) AS logs
    FROM "NewsSource" ns ORDER BY ns.id
  `)).rows;
  const categories = (await client.query(`
    SELECT id, "newsSourceId", "pathUrl", "rssFeedUrl", "rssStatus",
      "feedProvenance", "currentFeedProductive", "discoveryEvidence",
      "feedSubmittedByUserId", "feedSubmittedAt", "lastProductiveFeedUrl", "lastProductiveAt"
    FROM "SourceCategory" ORDER BY id
  `)).rows;
  const sourcesById = new Map(sources.map((row) => [row.id, row]));
  const rootSources = new Map();
  for (const source of sources) {
    try {
      if (normalizeUrl(source.frontPageUrl) !== rootUrl(source.frontPageUrl)) continue;
      const key = rootUrl(source.frontPageUrl);
      const values = rootSources.get(key) || [];
      values.push(source);
      rootSources.set(key, values);
    } catch { /* malformed rows are never planned */ }
  }
  const categoriesByUrl = new Map();
  for (const category of categories) {
    try {
      const key = normalizeUrl(category.pathUrl);
      const values = categoriesByUrl.get(key) || [];
      values.push(category);
      categoriesByUrl.set(key, values);
    } catch { /* malformed rows are never planned */ }
  }

  const actions = [];
  const blocked = [];
  for (const source of sources) {
    let normalized;
    try { normalized = normalizeUrl(source.frontPageUrl); } catch { continue; }
    if (normalized === rootUrl(source.frontPageUrl)) continue;
    const matches = categoriesByUrl.get(normalized) || [];
    if (matches.length !== 1) continue;
    const category = matches[0];
    const expectedRootUrl = rootUrl(source.frontPageUrl);
    const owner = sourcesById.get(category.newsSourceId);
    if (!owner || rootUrl(owner.frontPageUrl) !== expectedRootUrl) {
      blocked.push({ sourceId: source.id, reason: "category_owner_is_not_expected_root", categoryId: category.id });
      continue;
    }
    if (category.newsSourceId !== source.id && normalizeUrl(owner.frontPageUrl) !== expectedRootUrl) {
      blocked.push({ sourceId: source.id, reason: "category_owner_is_not_a_root_source", categoryId: category.id, ownerSourceId: owner.id });
      continue;
    }

    const dependencyCounts = {
      categories: Number(source.categories), articles: Number(source.articles),
      subscriptions: Number(source.subscriptions), artifacts: Number(source.artifacts),
      reviews: Number(source.reviews), logs: Number(source.logs),
    };
    const valuableFeedState = Boolean(source.rssFeedUrl)
      || source.feedProvenance === "USER_SUBMITTED"
      || source.currentFeedProductive === true;

    if (category.newsSourceId !== source.id) {
      const dependencies = Object.values(dependencyCounts).reduce((sum, value) => sum + value, 0);
      if (dependencies !== 0) {
        blocked.push({
          sourceId: source.id,
          reason: "redundant_source_has_dependencies",
          categoryId: category.id,
          dependencyCounts,
          valuableFeedState,
          sourceFeedState: {
            hasFeedUrl: Boolean(source.rssFeedUrl),
            feedUrlMatchesCategory: Boolean(
              source.rssFeedUrl && category.rssFeedUrl
              && normalizeFeedIdentity(source.rssFeedUrl) === normalizeFeedIdentity(category.rssFeedUrl),
            ),
            provenance: source.feedProvenance,
            productive: source.currentFeedProductive,
          },
          categoryFeedState: {
            hasFeedUrl: Boolean(category.rssFeedUrl),
            provenance: category.feedProvenance,
            productive: category.currentFeedProductive,
          },
        });
        continue;
      }
      const sourceFeedIdentity = normalizeFeedIdentity(source.rssFeedUrl);
      const categoryFeedIdentity = normalizeFeedIdentity(category.rssFeedUrl);
      if (!valuableFeedState) {
        actions.push({ type: "delete_redundant_source", sourceId: source.id, categoryId: category.id, winnerSourceId: owner.id, sourceUrl: source.frontPageUrl, expectedRootUrl });
      } else if (sourceFeedIdentity && sourceFeedIdentity === categoryFeedIdentity) {
        actions.push({ type: "merge_feed_state_and_delete", sourceId: source.id, categoryId: category.id, winnerSourceId: owner.id, sourceUrl: source.frontPageUrl, expectedRootUrl });
      } else if (sourceFeedIdentity && !categoryFeedIdentity) {
        actions.push({ type: "transfer_feed_state_and_delete", sourceId: source.id, categoryId: category.id, winnerSourceId: owner.id, sourceUrl: source.frontPageUrl, expectedRootUrl });
      } else {
        blocked.push({
          sourceId: source.id,
          reason: "conflicting_or_unmergeable_feed_state",
          categoryId: category.id,
          dependencyCounts,
          sourceFeedState: { hasFeedUrl: Boolean(source.rssFeedUrl), provenance: source.feedProvenance, productive: source.currentFeedProductive },
          categoryFeedState: { hasFeedUrl: Boolean(category.rssFeedUrl), provenance: category.feedProvenance, productive: category.currentFeedProductive },
        });
      }
      continue;
    }

    if (dependencyCounts.categories !== 1 || dependencyCounts.articles || dependencyCounts.subscriptions || dependencyCounts.artifacts || dependencyCounts.reviews || dependencyCounts.logs) {
      blocked.push({ sourceId: source.id, reason: "self_owned_source_has_unexpected_dependencies", categoryId: category.id, dependencyCounts });
      continue;
    }
    const otherRoots = (rootSources.get(expectedRootUrl) || []).filter((candidate) => candidate.id !== source.id);
    if (otherRoots.length > 1) {
      blocked.push({ sourceId: source.id, reason: "multiple_root_winners", categoryId: category.id, rootIds: otherRoots.map((row) => row.id) });
    } else if (otherRoots.length === 1) {
      if (valuableFeedState) {
        blocked.push({ sourceId: source.id, reason: "self_owned_merge_has_feed_state", categoryId: category.id, valuableFeedState });
      } else {
        actions.push({ type: "move_category_and_delete_source", sourceId: source.id, categoryId: category.id, winnerSourceId: otherRoots[0].id, sourceUrl: source.frontPageUrl, expectedRootUrl });
      }
    } else {
      actions.push({ type: "rootify_source", sourceId: source.id, categoryId: category.id, winnerSourceId: source.id, sourceUrl: source.frontPageUrl, expectedRootUrl });
    }
  }

  actions.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  blocked.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const hashPayload = { actions, blocked };
  const planHash = crypto.createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex");
  return { planHash, actions, blocked };
};

const client = await pool.connect();
try {
  if (!apply) {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");
    const plan = await loadPlan(client);
    await client.query("ROLLBACK");
    console.log(JSON.stringify({
      mode: "production-repair-dry-run",
      databaseHost: databaseUrl.hostname,
      ...plan,
      summary: {
        actions: plan.actions.length,
        deleteRedundant: plan.actions.filter((action) => action.type === "delete_redundant_source").length,
        mergeFeedAndDelete: plan.actions.filter((action) => action.type === "merge_feed_state_and_delete").length,
        transferFeedAndDelete: plan.actions.filter((action) => action.type === "transfer_feed_state_and_delete").length,
        moveAndDelete: plan.actions.filter((action) => action.type === "move_category_and_delete_source").length,
        rootify: plan.actions.filter((action) => action.type === "rootify_source").length,
        blocked: plan.blocked.length,
      },
    }, null, 2));
  } else {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('nusift:production-source-hierarchy-repair', 0))");
    const plan = await loadPlan(client);
    if (plan.planHash !== expectedHash) throw new Error(`Plan hash changed. Expected ${expectedHash}, received ${plan.planHash}.`);
    for (const action of plan.actions) {
      if (action.type === "delete_redundant_source") {
        const result = await client.query(`DELETE FROM "NewsSource" WHERE id = $1`, [action.sourceId]);
        if (result.rowCount !== 1) throw new Error(`Delete precondition failed for ${action.sourceId}.`);
      } else if (action.type === "merge_feed_state_and_delete" || action.type === "transfer_feed_state_and_delete") {
        const merged = await client.query(`
          UPDATE "SourceCategory" c SET
            "rssFeedUrl" = COALESCE(c."rssFeedUrl", s."rssFeedUrl"),
            "rssStatus" = CASE WHEN COALESCE(c."rssFeedUrl", s."rssFeedUrl") IS NOT NULL THEN 'ACTIVE' ELSE c."rssStatus" END,
            "discoveryEvidence" = COALESCE(c."discoveryEvidence", s."discoveryEvidence"),
            "currentFeedProductive" = c."currentFeedProductive" OR s."currentFeedProductive",
            "consecutiveNonProductiveRuns" = LEAST(c."consecutiveNonProductiveRuns", s."consecutiveNonProductiveRuns"),
            "lastProductiveFeedUrl" = COALESCE(c."lastProductiveFeedUrl", s."lastProductiveFeedUrl"),
            "lastProductiveAt" = COALESCE(c."lastProductiveAt", s."lastProductiveAt"),
            "feedProvenance" = CASE
              WHEN c."feedProvenance" = 'USER_SUBMITTED' THEN c."feedProvenance"
              WHEN s."feedProvenance" = 'USER_SUBMITTED' THEN s."feedProvenance"
              ELSE COALESCE(c."feedProvenance", s."feedProvenance") END,
            "feedSubmittedByUserId" = COALESCE(c."feedSubmittedByUserId", s."feedSubmittedByUserId"),
            "feedSubmittedAt" = COALESCE(c."feedSubmittedAt", s."feedSubmittedAt")
          FROM "NewsSource" s
          WHERE c.id = $1 AND s.id = $2
        `, [action.categoryId, action.sourceId]);
        if (merged.rowCount !== 1) throw new Error(`Feed-state merge failed for ${action.sourceId}.`);
        const deleted = await client.query(`DELETE FROM "NewsSource" WHERE id = $1`, [action.sourceId]);
        if (deleted.rowCount !== 1) throw new Error(`Merged source delete failed for ${action.sourceId}.`);
      } else if (action.type === "move_category_and_delete_source") {
        const moved = await client.query(`UPDATE "SourceCategory" SET "newsSourceId" = $2 WHERE id = $1 AND "newsSourceId" = $3`, [action.categoryId, action.winnerSourceId, action.sourceId]);
        if (moved.rowCount !== 1) throw new Error(`Category move precondition failed for ${action.categoryId}.`);
        const deleted = await client.query(`DELETE FROM "NewsSource" WHERE id = $1`, [action.sourceId]);
        if (deleted.rowCount !== 1) throw new Error(`Merged source delete failed for ${action.sourceId}.`);
      } else {
        const result = await client.query(`UPDATE "NewsSource" SET "frontPageUrl" = $2 WHERE id = $1 AND "frontPageUrl" = $3`, [action.sourceId, action.expectedRootUrl, action.sourceUrl]);
        if (result.rowCount !== 1) throw new Error(`Rootify precondition failed for ${action.sourceId}.`);
      }
    }
    const remaining = await loadPlan(client);
    if (remaining.actions.length) throw new Error(`Postcondition failed: ${remaining.actions.length} safe actions remain.`);
    await client.query("COMMIT");
    console.log(JSON.stringify({ mode: "production-repair-applied", planHash: expectedHash, applied: plan.actions.length, remainingBlocked: remaining.blocked.length, postcondition: "zero_safe_actions" }, null, 2));
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
