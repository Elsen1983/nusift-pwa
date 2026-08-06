import { createError } from "h3";
import {
  ADMIN_INSPECTION_ARTIFACT_SCAN_CAP, ADMIN_INSPECTION_DEFAULT_LIMIT, ADMIN_INSPECTION_MAX_LIMIT,
  ADMIN_INSPECTION_ARTICLE_SCAN_CAP, ADMIN_INSPECTION_MAX_TARGETS, ADMIN_INSPECTION_REASON_LIMIT,
  clampInspectionLimit, classifyInspectionArticleState, deriveInspectionFlags, emptyInspectionStats,
  getInspectionPipelineStage, hostnameFromUrl, loadArticleInspectionEvidence, loadArticleInspectionEvidenceForArticles,
  loadBodyReadinessEvidence, normalizeBodyPreview, normalizeInspectionDateRange, normalizeInspectionSearch,
  parseInspectionDate, validateInspectionDateRange, readArtifactArticleId, readArtifactFailureReason,
  readBrowserFallbackUsed, readInspectionOutcomeSummary, safeInspectionUrl, inspectionStageMatches,
  inspectionStateMatches, type AdminInspectionStats, type AdminInspectionTargetType,
  type InspectionActivityState, type InspectionActiveReason,
} from "../utils/admin-inspection";
import type { Agent2LifecycleState } from "../utils/news-pipeline/agent2-target-lifecycle";
import {
  loadInspectionLifecycleArtifacts, resolveInspectionActiveTargetIds, resolveInspectionActiveTargets,
  type InspectionActiveTarget, type InspectionTargetType,
} from "../utils/inspection-active-targets";
import {
  buildTargetFingerprint, createInspectionSnapshotToken, INSPECTION_SNAPSHOT_MAX_TOKEN_CHARS,
  inspectionSnapshotMeta, inspectionSnapshotSummaryFromClaims, parseInspectionSnapshotToken,
  type InspectionSnapshotValidationError,
} from "../utils/inspection-snapshot";
import { requireInspectionAdminForUser } from "../utils/require-inspection-admin";

/**
 * Framework-independent admin inspection services (Prompt 13H).
 *
 * Every admin-inspection endpoint is a thin `defineEventHandler` wrapper that
 * resolves the session user ID, applies rate limiting, and calls one of these
 * functions with the request-scoped Prisma client and the query/body params.
 * The PostgreSQL application isolation integration test calls the exact same
 * functions with an isolated schema-scoped Prisma client and an authenticated
 * identity, so there is no separate test-only code path and no dependency on
 * Nuxt auto-import globals (`defineEventHandler`, `getQuery`,
 * `getRouterParam`) outside the thin wrappers.
 *
 * Authorization is enforced INSIDE every service function through
 * `requireInspectionAdminForUser`, so production handlers and the integration
 * test share one authorization code path.
 *
 * Snapshot transport (production-safe):
 * - all-active article inspection transports the signed snapshot token in a
 *   bounded JSON POST body (see server/api/dev/admin-article-inspection.post.ts),
 *   never in a GET query parameter. A worst-case token at the maximum
 *   supported target count (500 source IDs + 500 category IDs, UUID-shaped)
 *   stays below the 64 KB body cap and the 64,000-char token cap.
 * - the token is never included in logs, diagnostics, error messages, or
 *   browser history; error messages are generic ("Invalid inspection
 *   snapshot.", "Inspection snapshot has expired.", ...).
 */

export const ADMIN_INSPECTION_POST_BODY_MAX_BYTES = 64 * 1024; // conservative transport cap (64 KB)
export const ADMIN_INSPECTION_SNAPSHOT_MAX_TOKEN_CHARS = INSPECTION_SNAPSHOT_MAX_TOKEN_CHARS;

export type AdminInspectionParams = Record<string, unknown>;

const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * Parse the POST body for all-active article inspection. Enforces the
 * conservative transport size cap (HTTP 413) and JSON validity (HTTP 400)
 * before any application parsing. The returned params object is validated
 * semantically by runAdminArticleInspection, exactly like GET query params.
 */
export function parseAdminArticleInspectionBody(raw: string | undefined): AdminInspectionParams {
  if (typeof raw !== "string" || raw.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "Request body required." });
  }
  if (Buffer.byteLength(raw, "utf8") > ADMIN_INSPECTION_POST_BODY_MAX_BYTES) {
    throw createError({ statusCode: 413, statusMessage: "Request body too large." });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid JSON body." });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid request body." });
  }
  return parsed as AdminInspectionParams;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export async function runAdminInspectionAccess(db: any, userId: string): Promise<{ ok: true; allowed: true }> {
  await requireInspectionAdminForUser(db, userId);
  return { ok: true, allowed: true };
}

// ---------------------------------------------------------------------------
// Source inspection
// ---------------------------------------------------------------------------

export const TARGET_BATCH_SIZE = 100;
export const TARGET_SCAN_CAP = 500;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,800}$/;
const VALID_SOURCE_STATUS = new Set(["ACTIVE", "INACTIVE", "ALL"]);
const VALID_TARGET_TYPES = new Set(["ALL", "SOURCE", "CATEGORY"]);
const VALID_PRODUCTIVITY = new Set([
  "NO_ARTICLES_GENERATED", "DISCOVERED_NOT_ENRICHED", "ENRICHED_NOT_PUBLISHED", "HIGH_REJECTION_RATE",
  "RETRY_BACKLOG", "RSS_UNPRODUCTIVE", "BROWSER_FALLBACK_REQUIRED", "RECENTLY_PRODUCTIVE",
  "ACTIVE_AND_PRODUCTIVE", "ACTIVE_UNPRODUCTIVE", "ACTIVE_DEFERRED", "ACTIVE_BROWSER_REQUIRED", "FAILED", "DOMAIN_DEAD", "INACTIVE",
]);

type StreamCursor = { displayName: string; id: string } | null;
type InspectionCursor = { source: StreamCursor; category: StreamCursor; fingerprint?: string };
type Target = {
  targetType: AdminInspectionTargetType; targetId: string; parentSourceId: string | null; displayName: string;
  frontPageUrl: string | null; pathUrl: string | null; rssFeedUrl: string | null; rssStatus: string;
  parentRssStatus: string | null; parentCurrentFeedProductive: boolean; currentFeedProductive: boolean; lastSuccessfulPipelineAt: Date | null;
  nextRetryAt: Date | null; activeSubscriberCount: number; isSystemImported: boolean; activeReason?: InspectionActiveReason;
};

const encodeCursor = (value: InspectionCursor) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const decodeCursor = (value: unknown): InspectionCursor => {
  if (value == null) return { source: null, category: null };
  if (typeof value !== "string" || !CURSOR_PATTERN.test(value)) throw createError({ statusCode: 400, statusMessage: "Invalid inspection cursor." });
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const read = (item: unknown): StreamCursor => {
      if (item == null) return null;
      const record = asRecord(item);
      if (!record || typeof record.displayName !== "string" || typeof record.id !== "string") throw new Error("invalid cursor");
      return { displayName: record.displayName, id: record.id };
    };
    return { source: read(parsed.source), category: read(parsed.category), fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : undefined };
  } catch { throw createError({ statusCode: 400, statusMessage: "Invalid inspection cursor." }); }
};
const compareTargets = (a: Target, b: Target) => a.displayName.localeCompare(b.displayName) || a.targetType.localeCompare(b.targetType) || a.targetId.localeCompare(b.targetId);
const afterCursorWhere = (cursor: StreamCursor, field: string) => cursor ? { OR: [{ [field]: { gt: cursor.displayName } }, { [field]: cursor.displayName, id: { gt: cursor.id } }] } : {};
const artifactBelongsToTarget = (artifact: { sourceId?: string | null; categoryId?: string | null }, target: Target): boolean =>
  target.targetType === "CATEGORY" ? artifact.categoryId === target.targetId : artifact.sourceId === target.targetId;

const makeStats = (articles: any[], artifacts: any[], target: Target): AdminInspectionStats => {
  const stats = emptyInspectionStats(); const articleIds = new Set<number>(); const latestArtifactByArticle = new Map<number, any>();
  const articleEvidenceTypes = new Map<number, Set<string>>();
  stats.scannedArticles = articles.length; stats.scannedArtifacts = artifacts.length;
  for (const artifact of artifacts) {
    const articleId = readArtifactArticleId(artifact.payload);
    if (articleId === null) continue;
    if (!latestArtifactByArticle.has(articleId)) latestArtifactByArticle.set(articleId, artifact);
    const types = articleEvidenceTypes.get(articleId) ?? new Set<string>();
    types.add(artifact.artifactType); articleEvidenceTypes.set(articleId, types);
  }
  for (const article of articles) {
    if (articleIds.has(article.id)) continue; articleIds.add(article.id); stats.totalArticlesInWindow++;
    // Article rows are the authoritative unique Agent 1 candidate/productivity
    // identity. Agent 2 discovery requires durable discovery evidence; it is not
    // inferred from the mere existence of an Article row.
    if (!stats.latestArticleCreatedAt || article.createdAt > stats.latestArticleCreatedAt) stats.latestArticleCreatedAt = article.createdAt;
    const evidence = latestArtifactByArticle.get(article.id); const payload = asRecord(evidence?.payload); const rejection = asRecord(payload?.rejection);
    const state = classifyInspectionArticleState(article, evidence ? { kind: typeof payload?.kind === "string" ? payload.kind : null, rejectionCode: typeof rejection?.code === "string" ? rejection.code : null, retryAfterAt: typeof payload?.retryAfterAt === "string" ? payload.retryAfterAt : null, browserFallback: asRecord(payload?.browserFallback), retryDiagnostics: asRecord(payload?.retryDiagnostics) } : null);
    if (state === "PUBLISHED") { stats.publishedArticlesInWindow++; stats.agent3PublishedCount++; if (article.publicationReadyAt && (!stats.latestPublishedArticleAt || article.publicationReadyAt > stats.latestPublishedArticleAt)) stats.latestPublishedArticleAt = article.publicationReadyAt; }
    else if (state === "DEFERRED") { stats.deferredArticlesInWindow++; stats.deferredCount++; }
    else if (state === "REJECTED") { stats.rejectedArticlesInWindow++; stats.agent3RejectedCount++; }
    else if (state === "RETRYABLE_FAILURE") { stats.retryableFailuresInWindow++; stats.retryableFailureCount++; }
    else if (state === "PERMANENT_FAILURE") { stats.permanentFailuresInWindow++; stats.permanentFailureCount++; }
    else stats.pendingArticlesInWindow++;
    stats.agent1ProductivityCount++;
    const evidenceTypes = articleEvidenceTypes.get(article.id) ?? new Set<string>();
    if (["article_discovery_candidates", "article_discovery_headless_required", "article_discovery_attempt"].some((type) => evidenceTypes.has(type))) stats.agent2DiscoveredCount++;
    if (article.enrichmentStatus && article.enrichmentStatus !== "INGESTED") stats.agent3ProcessedCount++;
    if (article.enrichmentStatus === "ENRICHED") stats.agent3EnrichedCount++;
    if (readBrowserFallbackUsed(article.enrichmentOutcome) || readBrowserFallbackUsed(evidence?.payload)) stats.browserFallbackUsageCount++;
    if (!stats.latestFailureReason && ["REJECTED", "RETRYABLE_FAILURE", "PERMANENT_FAILURE"].includes(state)) stats.latestFailureReason = readArtifactFailureReason(evidence || {});
  }
  // Artifact rows contribute only when they carry no known Article identity. This prevents retry/history double counting.
  for (const artifact of artifacts) {
    const articleId = readArtifactArticleId(artifact.payload); if (articleId !== null && articleIds.has(articleId)) continue;
    stats.artifactOnlyEvents++;
    // Artifact-only events are intentionally not added to Article lifecycle
    // counters. They remain a separate bounded diagnostic signal; without a
    // durable Article ID they cannot prove a unique article outcome.
    stats.metricsApproximate = true;
    stats.metricAccuracy = "APPROXIMATE";
    if (artifact.artifactType === "agent1_target_outcome") stats.approximateMetrics.push("agent1ProductivityCount");
    if (["article_discovery_candidates", "article_discovery_headless_required", "article_discovery_attempt"].includes(artifact.artifactType)) stats.approximateMetrics.push("agent2DiscoveredCount");
    if (artifact.artifactType === "article_enrichment_rejection") stats.approximateMetrics.push("retryableFailuresInWindow", "permanentFailuresInWindow");
  }
  stats.diagnosticsTruncated = articles.length >= 2_000 || artifacts.length >= ADMIN_INSPECTION_ARTIFACT_SCAN_CAP; stats.metricsApproximate ||= stats.diagnosticsTruncated;
  if (stats.diagnosticsTruncated) { stats.metricAccuracy = "APPROXIMATE"; stats.approximateMetrics.push("allArticleMetrics", "allArtifactMetrics"); }
  stats.approximateMetrics = [...new Set(stats.approximateMetrics)];
  stats.diagnosticFlags = deriveInspectionFlags({ ...stats, rssStatus: target.rssStatus, currentFeedProductive: target.currentFeedProductive, lastSuccessfulPipelineAt: target.lastSuccessfulPipelineAt });
  return stats;
};

const serialize = (target: Target, stats: AdminInspectionStats, activityState: InspectionActivityState, lifecycleState: Agent2LifecycleState, activeReason: InspectionActiveReason, lifecycleEvidenceCoverage: "COMPLETE" | "BOUNDED" | "NONE", lifecycleEvidenceTruncated: boolean) => ({
  targetType: target.targetType, targetId: target.targetId, parentSourceId: target.parentSourceId, displayName: target.displayName,
  frontPageUrl: safeInspectionUrl(target.frontPageUrl), pathUrl: safeInspectionUrl(target.pathUrl), hostname: hostnameFromUrl(target.pathUrl || target.frontPageUrl), rssFeedUrl: safeInspectionUrl(target.rssFeedUrl), rssStatus: target.rssStatus,
  active: !["INACTIVE", "FAILED", "DOMAIN_DEAD"].includes(activityState), activityState, lifecycleState,
  activeReason, lifecycleEvidenceCoverage, lifecycleEvidenceTruncated, activeSubscriberCount: target.activeSubscriberCount, lastSuccessfulPipelineAt: target.lastSuccessfulPipelineAt?.toISOString() ?? null,
  lastArticleCreatedAt: stats.latestArticleCreatedAt?.toISOString() ?? null, lastPublishedArticleAt: stats.latestPublishedArticleAt?.toISOString() ?? null, ...stats,
});

export async function runAdminSourceInspection(db: any, userId: string, query: AdminInspectionParams): Promise<any> {
  await requireInspectionAdminForUser(db, userId);
  const limit = clampInspectionLimit(query.limit); const cursor = decodeCursor(query.cursor);
  const search = normalizeInspectionSearch(query.search); const rssStatus = typeof query.rssStatus === "string" ? query.rssStatus.toUpperCase() : null;
  const targetType = typeof query.targetType === "string" ? query.targetType.toUpperCase() : "ALL";
  if (!VALID_TARGET_TYPES.has(targetType)) throw createError({ statusCode: 400, statusMessage: "Invalid target type." });
  const sourceStatus = typeof query.sourceStatus === "string" ? query.sourceStatus.toUpperCase() : "ALL"; const productivityState = typeof query.productivityState === "string" ? query.productivityState.toUpperCase() : null;
  if (sourceStatus && !VALID_SOURCE_STATUS.has(sourceStatus)) throw createError({ statusCode: 400, statusMessage: "Invalid source status." });
  if (rssStatus && !["ACTIVE", "FAILED", "PENDING_DISCOVERY", "NO_RSS_FOUND", "DOMAIN_DEAD"].includes(rssStatus)) throw createError({ statusCode: 400, statusMessage: "Invalid RSS status." });
  const dateRangeError = validateInspectionDateRange({ dateFrom: query.dateFrom, dateTo: query.dateTo });
  if (dateRangeError) throw createError({ statusCode: 400, statusMessage: dateRangeError });
  if (productivityState && !VALID_PRODUCTIVITY.has(productivityState)) throw createError({ statusCode: 400, statusMessage: "Invalid productivity state." });
  const { dateFrom, dateTo, days } = normalizeInspectionDateRange({ dateFrom: query.dateFrom, dateTo: query.dateTo });
  // Display fingerprint: every display filter that changes which targets a
  // cursor page may contain. It is separate from the snapshot's canonical
  // active-target filter fingerprint.
  const displayFingerprint = JSON.stringify({ search, rssStatus, targetType, sourceStatus, productivityState, dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString() });
  if (cursor.fingerprint && cursor.fingerprint !== displayFingerprint) throw createError({ statusCode: 400, statusMessage: "Inspection cursor does not match the current filters." });
  // Cross-endpoint snapshot: resolved once per request for the signed token.
  // Per-page target resolution below is canonical and independent of this
  // bounded first-N universe, so later cursor pages are never stalled by the
  // snapshot cap.
  const targetTypeBoundary = targetType as InspectionTargetType;
  const targetFingerprint = buildTargetFingerprint(targetTypeBoundary);
  const activeSnapshot = await resolveInspectionActiveTargetIds(db, TARGET_SCAN_CAP, targetTypeBoundary, targetFingerprint);

  let sourceCursor = cursor.source; let categoryCursor = cursor.category; let sourceDone = false; let categoryDone = false; let scanned = 0; let scanTruncated = false; let artifactEvidenceTruncated = false; let sourceScannedTotal = 0; let categoryScannedTotal = 0; let resolutionGaps = 0; const items: any[] = [];
  const nextCursor: InspectionCursor = { source: sourceCursor, category: categoryCursor, fingerprint: displayFingerprint };
  while (items.length < limit && scanned < TARGET_SCAN_CAP && (!sourceDone || !categoryDone)) {
    const sourceFilters: any[] = []; const categoryFilters: any[] = [];
    if (rssStatus) { sourceFilters.push({ rssStatus: rssStatus as any }); categoryFilters.push({ rssStatus: rssStatus as any }); }
    if (targetType === "SOURCE") categoryDone = true;
    if (targetType === "CATEGORY") sourceDone = true;
    if (search) { sourceFilters.push({ OR: [{ mediaName: { contains: search, mode: "insensitive" } }, { frontPageUrl: { contains: search, mode: "insensitive" } }] }); categoryFilters.push({ OR: [{ name: { contains: search, mode: "insensitive" } }, { pathUrl: { contains: search, mode: "insensitive" } }, { newsSource: { mediaName: { contains: search, mode: "insensitive" } } }] }); }
    if (sourceCursor) sourceFilters.push(afterCursorWhere(sourceCursor, "mediaName")); if (categoryCursor) categoryFilters.push(afterCursorWhere(categoryCursor, "name"));
    const [sourceRows, categoryRows] = await Promise.all([
      sourceDone ? Promise.resolve([]) : db.newsSource.findMany({ where: sourceFilters.length ? { AND: sourceFilters } : {}, orderBy: [{ mediaName: "asc" }, { id: "asc" }], take: TARGET_BATCH_SIZE, select: { id: true, mediaName: true, frontPageUrl: true, rssFeedUrl: true, rssStatus: true, currentFeedProductive: true, lastProductiveAt: true, nextRetryAt: true, isSystemImported: true, _count: { select: { subscribers: { where: { isActive: true } } } } } }),
      categoryDone ? Promise.resolve([]) : db.sourceCategory.findMany({ where: categoryFilters.length ? { AND: categoryFilters } : {}, orderBy: [{ name: "asc" }, { id: "asc" }], take: TARGET_BATCH_SIZE, select: { id: true, name: true, pathUrl: true, rssFeedUrl: true, rssStatus: true, currentFeedProductive: true, lastProductiveAt: true, nextRetryAt: true, newsSourceId: true, newsSource: { select: { mediaName: true, frontPageUrl: true, rssStatus: true, currentFeedProductive: true, isSystemImported: true } }, _count: { select: { subscribers: { where: { isActive: true } } } } } }),
    ]);
    if (sourceRows.length === 0 && !sourceDone) sourceDone = true;
    if (categoryRows.length === 0 && !categoryDone) categoryDone = true;
      const sourceTargets: Target[] = sourceRows.map((row: any) => ({ targetType: "SOURCE", targetId: row.id, parentSourceId: null, displayName: row.mediaName, frontPageUrl: row.frontPageUrl, pathUrl: null, rssFeedUrl: row.rssFeedUrl, rssStatus: String(row.rssStatus), parentRssStatus: null, parentCurrentFeedProductive: false, currentFeedProductive: row.currentFeedProductive, lastSuccessfulPipelineAt: row.lastProductiveAt, nextRetryAt: row.nextRetryAt, activeSubscriberCount: row._count.subscribers, isSystemImported: row.isSystemImported }));
    const categoryTargets: Target[] = categoryRows.map((row: any) => ({ targetType: "CATEGORY", targetId: row.id, parentSourceId: row.newsSourceId, displayName: row.name, frontPageUrl: row.newsSource.frontPageUrl, pathUrl: row.pathUrl, rssFeedUrl: row.rssFeedUrl, rssStatus: String(row.rssStatus), parentRssStatus: String(row.newsSource.rssStatus), parentCurrentFeedProductive: Boolean(row.newsSource.currentFeedProductive), currentFeedProductive: row.currentFeedProductive, lastSuccessfulPipelineAt: row.lastProductiveAt, nextRetryAt: row.nextRetryAt, activeSubscriberCount: row._count.subscribers, isSystemImported: row.newsSource.isSystemImported }));
    const merged = [...sourceTargets, ...categoryTargets].sort(compareTargets);
    if (merged.length === 0) break;
    const articles = await db.article.findMany({ where: { OR: [{ sourceId: { in: sourceTargets.map((target) => target.targetId) } }, { categoryId: { in: categoryTargets.map((target) => target.targetId) } }], date: { gte: dateFrom, lte: dateTo } }, orderBy: [{ date: "desc" }, { id: "desc" }], take: 2_001, select: { id: true, title: true, canonicalUrl: true, sourceId: true, categoryId: true, date: true, createdAt: true, publicationStatus: true, publicationStage: true, publicationReadyAt: true, enrichmentStatus: true, enrichmentOutcome: true, processingStage: true, processingStatus: true } });
    const lifecycleInputs = [...sourceTargets, ...categoryTargets].map((target) => ({
      targetType: target.targetType,
      targetId: target.targetId,
      sourceId: target.targetType === "SOURCE" ? target.targetId : target.parentSourceId ?? target.targetId,
      parentSourceId: target.parentSourceId,
      rssStatus: target.rssStatus,
      parentRssStatus: target.parentRssStatus,
      currentFeedProductive: target.currentFeedProductive,
      activeSubscriberCount: target.activeSubscriberCount,
      isSystemImported: target.isSystemImported,
      nextRetryAt: target.nextRetryAt,
      lifecycleArtifacts: [],
    }));
    const lifecycleEvidence = await loadInspectionLifecycleArtifacts(db, lifecycleInputs, 100);
    artifactEvidenceTruncated ||= lifecycleEvidence.truncated;
    const enrichedInputs = lifecycleInputs.map((input) => ({
      ...input,
      lifecycleArtifacts: lifecycleEvidence.byTarget.get(`${input.targetType}:${input.targetId}`) ?? [],
      ...(input.targetType === "CATEGORY" && input.parentSourceId
        ? {
            parentLifecycleArtifacts: lifecycleEvidence.byTarget.get(`SOURCE:${input.parentSourceId}`) ?? [],
            parentCurrentFeedProductive: (input.targetType === "CATEGORY" ? categoryTargets.find((target) => target.targetId === input.targetId)?.parentCurrentFeedProductive : false) ?? false,
          }
        : {}),
    }));
    const resolvedByKey = new Map<string, InspectionActiveTarget>(
      resolveInspectionActiveTargets(enrichedInputs).targets.map((target) => [`${target.targetType}:${target.targetId}`, target]),
    );
    const artifacts = [...lifecycleEvidence.byTarget.entries()].flatMap(([key, rows]) => {
      const target = lifecycleInputs.find((item) => `${item.targetType}:${item.targetId}` === key);
      return rows.map((row) => ({
        ...row,
        sourceId: target?.targetType === "SOURCE" ? target.targetId : typeof row.sourceId === "string" ? row.sourceId : null,
        categoryId: target?.targetType === "CATEGORY" ? target.targetId : typeof row.categoryId === "string" ? row.categoryId : null,
      }));
    });
    const bodyEvidence = await loadBodyReadinessEvidence(db, (articles as any[]).map((article) => article.id));
    let scannedSourceRows = 0; let scannedCategoryRows = 0;
    for (const target of merged) {
      if (items.length >= limit || scanned >= TARGET_SCAN_CAP) break;
      scanned++;
      if (target.targetType === "SOURCE") scannedSourceRows++; else scannedCategoryRows++; const targetArtifacts = (artifacts as any[]).filter((artifact) => artifactBelongsToTarget(artifact, target));
      const resolved = resolvedByKey.get(`${target.targetType}:${target.targetId}`);
      if (!resolved) {
        // A missing resolver result must never cause the same target to be
        // scanned indefinitely: mark the traversal bounded and advance the
        // scan boundary below like any other target.
        scanTruncated = true;
        resolutionGaps++;
      } else {
        const lifecycle = resolved.lifecycleState;
        const activity = resolved.activityState;
        const targetArticles = (articles as any[]).filter((article) => target.targetType === "SOURCE" ? article.sourceId === target.targetId : article.categoryId === target.targetId).map((article) => ({ ...article, ...(bodyEvidence.get(article.id) ?? {}) }));
        const stats = makeStats(targetArticles, targetArtifacts, target);
        const matches = (sourceStatus === "ALL" || (sourceStatus === "ACTIVE" ? activity !== "INACTIVE" && activity !== "FAILED" && activity !== "DOMAIN_DEAD" : activity === "INACTIVE")) && (!productivityState || productivityState === activity || productivityState === lifecycle || stats.diagnosticFlags.includes(productivityState as any));
        if (matches && items.length < limit) items.push(serialize(target, stats, activity, lifecycle, resolved.activeReason, resolved.lifecycleEvidenceCoverage, resolved.evidenceTruncated));
      }
      // The scan boundary ALWAYS advances for every inspected target —
      // resolved or not, filtered out or not, truncated or not.
      if (target.targetType === "SOURCE") { sourceCursor = { displayName: target.displayName, id: target.targetId }; nextCursor.source = sourceCursor; } else { categoryCursor = { displayName: target.displayName, id: target.targetId }; nextCursor.category = categoryCursor; }
    }
    sourceScannedTotal += scannedSourceRows;
    categoryScannedTotal += scannedCategoryRows;
    if (scannedSourceRows === sourceRows.length && sourceRows.length < TARGET_BATCH_SIZE) sourceDone = true;
    if (scannedCategoryRows === categoryRows.length && categoryRows.length < TARGET_BATCH_SIZE) categoryDone = true;
    if (items.length >= limit) break;
  }
  if (scanned >= TARGET_SCAN_CAP && (!sourceDone || !categoryDone)) scanTruncated = true;
  // A full page does not by itself prove more work: both streams may have
  // been exhausted while producing exactly `limit` matches. The cursor is only
  // continued when an unscanned stream remains or the bounded scan cap hit.
  const hasMore = !sourceDone || !categoryDone || scanTruncated;
  const encodedNext = hasMore ? encodeCursor(nextCursor) : null;
  if (hasMore && typeof query.cursor === "string" && encodedNext === query.cursor) {
    // Non-advancing continuation cursors fail explicitly instead of returning
    // an identical cursor that would stall the client forever.
    throw createError({ statusCode: 500, statusMessage: "Inspection pagination cursor did not advance." });
  }
  const summary = { loadedTargets: items.length, productiveTargets: items.filter((item) => item.activityState === "ACTIVE_AND_PRODUCTIVE").length, zeroArticleTargets: items.filter((item) => item.diagnosticFlags.includes("NO_ARTICLES_GENERATED")).length, discoveredNotEnrichedTargets: items.filter((item) => item.diagnosticFlags.includes("DISCOVERED_NOT_ENRICHED")).length, deferredTargets: items.filter((item) => item.activityState === "ACTIVE_DEFERRED").length, browserRequiredTargets: items.filter((item) => item.activityState === "ACTIVE_BROWSER_REQUIRED").length, permanentFailures: items.reduce((sum, item) => sum + item.permanentFailuresInWindow, 0), publishedArticles: items.reduce((sum, item) => sum + item.publishedArticlesInWindow, 0), metricAccuracy: items.some((item) => item.metricAccuracy === "APPROXIMATE") ? "APPROXIMATE" : "EXACT" };
  let snapshotToken: string | null = null;
  try {
    snapshotToken = createInspectionSnapshotToken(activeSnapshot);
  } catch {
    // The snapshot is an add-on: when the server secret is unavailable (local
    // dev) or the token would exceed the bounded transport size, report the
    // snapshot as unavailable instead of failing the whole inspection request.
    snapshotToken = null;
  }
  const snapshot = snapshotToken
    ? inspectionSnapshotSummaryFromClaims(parseInspectionSnapshotToken(snapshotToken, targetTypeBoundary, targetFingerprint))
    : { ...inspectionSnapshotMeta(activeSnapshot), available: false };
  return { ok: true, items, summary, snapshot, snapshotToken, resolutionGaps, pagination: { limit, cursor: typeof query.cursor === "string" ? query.cursor : null, nextCursor: encodedNext, scanTruncated, dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString(), totalWindowDays: days }, bounds: { defaultLimit: ADMIN_INSPECTION_DEFAULT_LIMIT, maxLimit: ADMIN_INSPECTION_MAX_LIMIT, maxTargets: 25, maxDateRangeDays: 90, sourceMetricRule: "SOURCE includes all articles owned by the source, including categorized articles; CATEGORY includes only that category.", metricAccuracy: items.some((item) => item.metricAccuracy === "APPROXIMATE") ? "APPROXIMATE" : "EXACT" } };
}

// ---------------------------------------------------------------------------
// Article inspection (list, all-active snapshot reuse, and detail)
// ---------------------------------------------------------------------------

const VALID_STATES = new Set(["PUBLISHED", "PENDING", "DEFERRED", "RETRYABLE_FAILURE", "PERMANENT_FAILURE", "REJECTED", "ALL"]);
const VALID_STAGES = new Set(["AGENT1", "AGENT2", "AGENT3", "TERMINAL", "UNKNOWN", "ALL"]);
const cursorPattern = /^[A-Za-z0-9_-]{1,400}$/;
const bounded = (value: unknown, max = ADMIN_INSPECTION_REASON_LIMIT): string | null => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null;
const parseIds = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const normalized = values.map((item) => typeof item === "string" ? item.trim() : "");
  if (normalized.some((item) => !/^[A-Za-z0-9_-]{1,120}$/.test(item))) throw createError({ statusCode: 400, statusMessage: "Invalid inspection target id." });
  return [...new Set(normalized)];
};

type ArticleCursor = { date: string; id: number; fingerprint?: string };
const encodeArticleCursor = (cursor: ArticleCursor) => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
const decodeArticleCursor = (value: unknown): ArticleCursor | undefined => {
  if (value == null) return undefined;
  if (typeof value !== "string" || !cursorPattern.test(value)) throw createError({ statusCode: 400, statusMessage: "Invalid article cursor." });
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed.date !== "string" || !Number.isSafeInteger(parsed.id)) throw new Error("invalid");
    const date = new Date(parsed.date); if (!Number.isFinite(date.getTime())) throw new Error("invalid");
    return { date: date.toISOString(), id: parsed.id, fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : undefined };
  } catch { throw createError({ statusCode: 400, statusMessage: "Invalid article cursor." }); }
};

const evidenceSummary = (evidence: any, outcome: ReturnType<typeof readInspectionOutcomeSummary>) => {
  const payload = asRecord(evidence?.payload);
  const rejection = asRecord(payload?.rejection);
  return {
    kind: typeof payload?.kind === "string" ? payload.kind : outcome.kind,
    rejectionCode: typeof rejection?.code === "string" ? rejection.code : outcome.rejectionCode,
    retryAfterAt: typeof rejection?.retryAfterAt === "string" ? rejection.retryAfterAt : outcome.retryAfterAt,
    browserFallback: asRecord(payload?.browserFallback) || outcome.browserFallback,
    retryDiagnostics: asRecord(payload?.retryDiagnostics) || outcome.retryDiagnostics,
  };
};

const mapItem = (article: any, evidence: any, requestedState: string, requestedStage: string) => {
  const outcome = readInspectionOutcomeSummary(article.enrichmentOutcome);
  const summary = evidenceSummary(evidence, outcome);
  const state = classifyInspectionArticleState(article, summary) as AdminArticleState;
  const stage = getInspectionPipelineStage(article, evidence ? [evidence.artifactType] : []) as AdminPipelineStage;
  if (!inspectionStateMatches(state, requestedState) || !inspectionStageMatches(stage, requestedStage)) return null;
  const browserFallback = summary.browserFallback;
  return {
    articleId: article.id,
    title: bounded(article.title, 240),
    canonicalUrl: safeInspectionUrl(article.canonicalUrl || article.sourceUrl),
    source: { id: article.sourceId, label: bounded(article.source?.mediaName, 160) },
    category: article.categoryId ? { id: article.categoryId, label: bounded(article.category?.name, 160), pathUrl: safeInspectionUrl(article.category?.pathUrl) } : null,
    durableState: state,
    pipelineStage: stage,
    publicationReadiness: { status: article.publicationStatus, stage: bounded(article.publicationStage, 40), ready: state === "PUBLISHED" },
    createdAt: article.createdAt.toISOString(), discoveredAt: article.date.toISOString(),
    publishedAt: article.publishedAt?.toISOString() ?? null, publicationReadyAt: article.publicationReadyAt?.toISOString() ?? null,
    agent1Provenance: { sourceId: article.sourceId, categoryId: article.categoryId, sourceUrl: safeInspectionUrl(article.sourceUrl) },
    agent2Discovery: { processingStage: bounded(article.processingStage, 40), processingStatus: bounded(article.processingStatus, 40) },
    agent3Enrichment: { status: bounded(article.enrichmentStatus, 60), method: bounded(asRecord(article.enrichmentOutcome)?.method, 60), confidence: typeof asRecord(article.enrichmentOutcome)?.confidence === "number" ? asRecord(article.enrichmentOutcome)?.confidence : null },
    retry: { nextRetryAt: summary.retryAfterAt, deferred: state === "DEFERRED", retryable: state === "RETRYABLE_FAILURE" },
    rejectionReason: bounded(summary.rejectionCode || asRecord(article.enrichmentOutcome)?.rejectionDetail || readArtifactFailureReason(evidence || {})),
    browserFallback: browserFallback ? { attempted: browserFallback.attempted === true, succeeded: browserFallback.succeeded === true } : null,
    paywallClassification: article.isPaywall ? "PAYWALL" : "NOT_PAYWALL",
    bodyPreview: normalizeBodyPreview(article.bodyText ?? article.bodyPrefix),
    bodyEvidenceTruncated: typeof article.bodyPrefix === "string" && article.bodyPrefix.length >= 520,
    evidenceSummary: bounded(summary.rejectionCode || evidence?.errorLog || asRecord(article.enrichmentOutcome)?.rejectionDetail || article.processingStatus),
  };
};

export async function runAdminArticleInspection(db: any, userId: string, query: AdminInspectionParams): Promise<any> {
  await requireInspectionAdminForUser(db, userId);
  if (query.targetType !== undefined && (typeof query.targetType !== "string" || !VALID_TARGET_TYPES.has(query.targetType))) throw createError({ statusCode: 400, statusMessage: "Invalid target type." });
  const targetType = typeof query.targetType === "string" && query.targetType !== "ALL" ? query.targetType as "SOURCE" | "CATEGORY" : null;
  const targetIds = parseIds(query.targetIds); const allActive = query.allActive === "true" || query.allActive === true;
  if (targetIds.length > ADMIN_INSPECTION_MAX_TARGETS) throw createError({ statusCode: 400, statusMessage: "Too many inspection targets." });
  if (targetIds.length === 0 && !allActive) return { ok: true, items: [], pagination: { limit: clampInspectionLimit(query.limit), nextCursor: null, scanTruncated: false }, selection: { mode: "explicit", targetType, targetCount: 0, activeTargetResolutionTruncated: false, maxTargets: ADMIN_INSPECTION_MAX_TARGETS, snapshotSource: "none" }, snapshot: null, snapshotToken: null };
  if (allActive && targetIds.length > 0) throw createError({ statusCode: 400, statusMessage: "Choose explicit targets or all-active mode." });
  if (query.articleState !== undefined && (typeof query.articleState !== "string" || !VALID_STATES.has(query.articleState))) throw createError({ statusCode: 400, statusMessage: "Invalid article state." });
  if (query.pipelineStage !== undefined && (typeof query.pipelineStage !== "string" || !VALID_STAGES.has(query.pipelineStage))) throw createError({ statusCode: 400, statusMessage: "Invalid pipeline stage." });

  const limit = clampInspectionLimit(query.limit); const cursor = decodeArticleCursor(query.cursor);
  if (query.dateFrom !== undefined && !parseInspectionDate(query.dateFrom)) throw createError({ statusCode: 400, statusMessage: "Invalid dateFrom." });
  if (query.dateTo !== undefined && !parseInspectionDate(query.dateTo)) throw createError({ statusCode: 400, statusMessage: "Invalid dateTo." });
  const dateRangeError = validateInspectionDateRange({ dateFrom: query.dateFrom, dateTo: query.dateTo });
  if (dateRangeError) throw createError({ statusCode: 400, statusMessage: dateRangeError });
  const { dateFrom, dateTo, days } = normalizeInspectionDateRange({ dateFrom: query.dateFrom, dateTo: query.dateTo });
  const requestedState = typeof query.articleState === "string" ? query.articleState : "ALL";
  const requestedStage = typeof query.pipelineStage === "string" ? query.pipelineStage : "ALL";
  const search = normalizeInspectionSearch(query.search);
  // Display fingerprint: article display filters (articleState, pipelineStage,
  // title search, article date filters) never alter the active-target universe.
  const fingerprint = JSON.stringify({ targetType: targetType ?? "ALL", targetIds: [...targetIds].sort(), allActive, articleState: requestedState, pipelineStage: requestedStage, search, dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString() });
  if (cursor?.fingerprint && cursor.fingerprint !== fingerprint) throw createError({ statusCode: 400, statusMessage: "Article cursor does not match the current filters." });
  // Cross-endpoint snapshot contract: an all-active request may supply the
  // signed token returned by source inspection. The article endpoint then uses
  // the exact validated active target IDs instead of resolving a different
  // universe. Without a token it resolves a fresh snapshot and reports that it
  // is independent. Explicit target inspection never requires a snapshot.
  const targetTypeBoundary = (targetType ?? "ALL") as InspectionTargetType;
  const targetFingerprint = buildTargetFingerprint(targetTypeBoundary);
  const requestedSnapshot = typeof query.snapshot === "string" && query.snapshot.length > 0 ? query.snapshot : null;
  if (requestedSnapshot && requestedSnapshot.length > ADMIN_INSPECTION_SNAPSHOT_MAX_TOKEN_CHARS) {
    // Bounded transport: reject oversized snapshot tokens with 413 before any
    // parsing work, mirroring the POST body cap. The token value is never
    // echoed in the error.
    throw createError({ statusCode: 413, statusMessage: "Inspection snapshot is too large." });
  }
  let activeTargetIds: { sourceIds: string[]; categoryIds: string[]; truncated: boolean } | null = null;
  let snapshotSource: "none" | "client-provided" | "independent" = "none";
  let snapshotSummary: ReturnType<typeof inspectionSnapshotSummaryFromClaims> | null = null;
  let snapshotToken: string | null = null;
  if (allActive && requestedSnapshot) {
    try {
      const claims = parseInspectionSnapshotToken(requestedSnapshot, targetTypeBoundary, targetFingerprint);
      snapshotSummary = inspectionSnapshotSummaryFromClaims(claims);
      snapshotSource = "client-provided";
      activeTargetIds = {
        sourceIds: claims.sourceIds,
        categoryIds: claims.categoryIds,
        truncated: claims.sourceTruncated || claims.categoryTruncated || claims.artifactEvidenceTruncated,
      };
    } catch (error) {
      const validationError = error as InspectionSnapshotValidationError;
      throw createError({ statusCode: 400, statusMessage: validationError?.message || "Invalid inspection snapshot." });
    }
  } else if (allActive) {
    const fresh = await resolveInspectionActiveTargetIds(db, 500, targetTypeBoundary, targetFingerprint);
    activeTargetIds = fresh;
    snapshotSource = "independent";
    try {
      snapshotToken = createInspectionSnapshotToken(fresh);
      snapshotSummary = snapshotToken
        ? inspectionSnapshotSummaryFromClaims(parseInspectionSnapshotToken(snapshotToken, targetTypeBoundary, targetFingerprint))
        : null;
    } catch {
      snapshotToken = null;
      snapshotSummary = null;
    }
  } else {
    activeTargetIds = null;
  }
  const targetWhere: any = allActive
    ? targetType === "SOURCE"
      ? { sourceId: { in: activeTargetIds?.sourceIds ?? [] } }
      : targetType === "CATEGORY"
        ? { categoryId: { in: activeTargetIds?.categoryIds ?? [] } }
        : { OR: [{ sourceId: { in: activeTargetIds?.sourceIds ?? [] } }, { categoryId: { in: activeTargetIds?.categoryIds ?? [] } }] }
    : targetType === "CATEGORY" ? { categoryId: { in: targetIds } }
      : targetType === "SOURCE" ? { sourceId: { in: targetIds } }
        : { OR: [{ sourceId: { in: targetIds } }, { categoryId: { in: targetIds } }] };
  const baseWhere: any = { ...targetWhere, date: { gte: dateFrom, lte: dateTo }, ...(search ? { title: { contains: search, mode: "insensitive" } } : {}) };
  const items: any[] = []; let scanCursor = cursor; let scanTruncated = false; let exhausted = false; let lastScanned: ArticleCursor | undefined; let scannedRows = 0;
  while (items.length < limit && !exhausted && !scanTruncated) {
    const cursorWhere = scanCursor ? { OR: [{ date: { lt: new Date(scanCursor.date) } }, { date: new Date(scanCursor.date), id: { lt: scanCursor.id } }] } : {};
    const batch = await db.article.findMany({ where: { ...baseWhere, ...cursorWhere }, orderBy: [{ date: "desc" }, { id: "desc" }], take: Math.min(250, ADMIN_INSPECTION_ARTICLE_SCAN_CAP - scannedRows), select: { id: true, title: true, sourceId: true, categoryId: true, sourceUrl: true, canonicalUrl: true, publishedAt: true, date: true, createdAt: true, publicationStatus: true, publicationStage: true, publicationReadyAt: true, enrichmentStatus: true, enrichmentOutcome: true, processingStage: true, processingStatus: true, isPaywall: true, source: { select: { mediaName: true, frontPageUrl: true } }, category: { select: { name: true, pathUrl: true } } } as any });
    if (batch.length === 0) { exhausted = true; break; }
    const numericArticleIds = batch
      .map((article: any) => article.id)
      .filter((id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id));
    const bodyEvidence = await loadBodyReadinessEvidence(db, numericArticleIds);
    const artifacts = await loadArticleInspectionEvidenceForArticles(db, numericArticleIds, 20);
    const latestByArticle = new Map<number, any>();
    for (const artifact of artifacts) {
      const id = artifact.articleId === null ? null : Number(artifact.articleId);
      if (typeof id === "number" && Number.isSafeInteger(id) && !latestByArticle.has(id)) latestByArticle.set(id, {
        ...artifact,
        payload: {
          articleId: id,
          kind: artifact.kind,
          rejection: artifact.rejectionCode ? { code: artifact.rejectionCode, detail: artifact.rejectionDetail } : null,
          rejectionCode: artifact.rejectionCode,
          retryAfterAt: artifact.retryAfterAt,
          browserFallback: artifact.browserAttempted === null ? null : { attempted: artifact.browserAttempted === "true", succeeded: artifact.browserSucceeded === "true" },
          retryDiagnostics: artifact.retryDisposition === null ? null : { disposition: artifact.retryDisposition },
          failureReason: artifact.failureReason,
          error: artifact.errorLog,
        },
      });
    }
    for (const article of batch as any[]) {
      Object.assign(article, bodyEvidence.get(article.id) ?? {});
      scannedRows++;
      const articleDate = article.date instanceof Date ? article.date : new Date(article.date);
      if (!Number.isFinite(articleDate.getTime())) continue;
      lastScanned = { date: articleDate.toISOString(), id: article.id, fingerprint };
      const item = mapItem(article, latestByArticle.get(article.id), requestedState, requestedStage); if (item) items.push(item);
      if (items.length >= limit) break;
    }
    if (batch.length < 250) exhausted = true; else scanCursor = lastScanned;
    if (lastScanned && cursor && lastScanned.date === cursor.date && lastScanned.id === cursor.id) throw createError({ statusCode: 400, statusMessage: "Invalid article cursor." });
    if (lastScanned && cursor == null) scanCursor = lastScanned;
    if (scanCursor && lastScanned && (lastScanned.id === scanCursor.id && lastScanned.date === scanCursor.date) && !exhausted) {
      // continue with the same deterministic key; the next query uses lt.
    }
    if (items.length === limit && !exhausted) break;
    if (lastScanned && scanCursor == null) scanCursor = lastScanned;
    if (lastScanned && scanCursor && Number(items.length) >= limit) break;
    // A bounded scan loop: no request can inspect unbounded historical rows.
    if (scannedRows >= ADMIN_INSPECTION_ARTICLE_SCAN_CAP && !exhausted) scanTruncated = true;
  }
  const nextCursor = lastScanned && (!exhausted || scanTruncated || items.length === limit) ? encodeArticleCursor(lastScanned) : null;
  return { ok: true, items: items.slice(0, limit), pagination: { limit, cursor: typeof query.cursor === "string" ? query.cursor : null, nextCursor, scanTruncated: scanTruncated || activeTargetIds?.truncated === true, dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString(), dateRangeDays: days }, selection: { mode: allActive ? "all-active" : "explicit", targetType, targetCount: allActive ? null : targetIds.length, activeTargetResolutionTruncated: activeTargetIds?.truncated ?? false, maxTargets: ADMIN_INSPECTION_MAX_TARGETS, snapshotSource }, snapshot: snapshotSummary, snapshotToken };
}

export async function runAdminArticleInspectionDetail(db: any, userId: string, articleId: number): Promise<any> {
  await requireInspectionAdminForUser(db, userId);
  if (!Number.isSafeInteger(articleId) || articleId <= 0) throw createError({ statusCode: 400, statusMessage: "Invalid article id." });
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: {
      id: true, title: true, bodyText: true, sourceId: true, categoryId: true, sourceUrl: true, canonicalUrl: true,
      publishedAt: true, date: true, createdAt: true, publicationStatus: true, publicationStage: true,
      publicationReadyAt: true, enrichmentStatus: true, enrichmentOutcome: true, processingStage: true,
      processingStatus: true, isPaywall: true, source: { select: { mediaName: true, frontPageUrl: true } },
      category: { select: { name: true, pathUrl: true } },
    },
  });
  if (!article) throw createError({ statusCode: 404, statusMessage: "Article not found." });
  const artifacts = await loadArticleInspectionEvidence(db, article.id, 500);
  const articleArtifacts = artifacts.map((artifact) => ({
    ...artifact,
    payload: {
      articleId: artifact.articleId === null ? null : Number(artifact.articleId),
      kind: artifact.kind,
      rejection: artifact.rejectionCode ? { code: artifact.rejectionCode, detail: artifact.rejectionDetail } : null,
      rejectionCode: artifact.rejectionCode,
      rejectionDetail: artifact.rejectionDetail,
      retryAfterAt: artifact.retryAfterAt,
      browserFallback: artifact.browserAttempted === null ? null : { attempted: artifact.browserAttempted === "true", succeeded: artifact.browserSucceeded === "true" },
      retryDiagnostics: artifact.retryDisposition === null ? null : { disposition: artifact.retryDisposition },
      failureReason: artifact.failureReason,
      error: artifact.errorLog,
    },
  }));
  const dedupedArticleArtifacts = articleArtifacts.filter((artifact, index, rows) => index === rows.findIndex((candidate) => candidate.artifactType === artifact.artifactType && candidate.status === artifact.status && JSON.stringify(candidate.payload) === JSON.stringify(artifact.payload)));
  const evidenceTimelineTruncated = artifacts.length >= 500;
  // The query is exact for modern numeric articleId evidence. Legacy rows
  // without that identity are intentionally not attached to this article, so
  // a non-empty modern result is bounded/partial rather than falsely complete.
  // Only modern numeric articleId evidence is currently queryable. We do not
  // claim legacy correlation or invent an uncorrelated count from source-level
  // artifacts that were intentionally excluded from this article-specific query.
  const evidenceCoverage = articleArtifacts.length === 0 ? "NONE" : "PARTIAL_LEGACY";
  const latest = dedupedArticleArtifacts[0];
  const payload = asRecord(latest?.payload);
  const outcome = readInspectionOutcomeSummary(article.enrichmentOutcome);
  const state = classifyInspectionArticleState(article, outcome);
  const stage = getInspectionPipelineStage(article, dedupedArticleArtifacts.map((artifact) => artifact.artifactType));
  return {
    ok: true,
    item: {
      articleId: article.id,
      title: bounded(article.title, 240),
      canonicalUrl: safeInspectionUrl(article.canonicalUrl || article.sourceUrl),
      source: { id: article.sourceId, label: bounded(article.source.mediaName, 160) },
      category: article.categoryId ? { id: article.categoryId, label: bounded(article.category?.name, 160), pathUrl: safeInspectionUrl(article.category?.pathUrl) } : null,
      durableState: state, pipelineStage: stage,
      publicationGate: { status: article.publicationStatus, stage: article.publicationStage, readyAt: article.publicationReadyAt?.toISOString() ?? null, ready: state === "PUBLISHED" },
      agent1Provenance: { sourceId: article.sourceId, categoryId: article.categoryId, sourceUrl: safeInspectionUrl(article.sourceUrl) },
      agent2Discovery: { processingStage: bounded(article.processingStage, 40), processingStatus: bounded(article.processingStatus, 40) },
      agent3Enrichment: { status: bounded(article.enrichmentStatus, 60), method: bounded(asRecord(article.enrichmentOutcome)?.method, 60), confidence: typeof asRecord(article.enrichmentOutcome)?.confidence === "number" ? asRecord(article.enrichmentOutcome)?.confidence : null },
      retry: { nextRetryAt: outcome.retryAfterAt, deferred: state === "DEFERRED", retryable: state === "RETRYABLE_FAILURE" },
      rejectionReason: bounded(outcome.rejectionCode || asRecord(article.enrichmentOutcome)?.rejectionDetail || readArtifactFailureReason(latest || {})),
      browserFallback: outcome.browserFallback ? { attempted: outcome.browserFallback.attempted === true, succeeded: outcome.browserFallback.succeeded === true } : null,
      paywallClassification: article.isPaywall ? "PAYWALL" : "NOT_PAYWALL",
      bodyPreview: normalizeBodyPreview(article.bodyText),
      evidenceCoverage,
      evidenceTimelineTruncated,
      evidenceScannedCount: artifacts.length,
      evidenceMatchedCount: dedupedArticleArtifacts.length,
      evidenceOmittedCount: evidenceTimelineTruncated ? null : 0,
      uncorrelatedLegacyEvidenceCount: null,
      evidenceBound: 500,
      evidenceTimeline: dedupedArticleArtifacts.slice(0, 20).map((artifact) => ({ createdAt: artifact.createdAt.toISOString(), type: bounded(artifact.artifactType, 80), status: bounded(artifact.status, 60), summary: bounded(readArtifactFailureReason(artifact) || asRecord(artifact.payload)?.kind) })),
      evidenceSummary: bounded(readArtifactFailureReason(latest || {}) || payload?.kind || article.processingStatus),
      createdAt: article.createdAt.toISOString(), discoveredAt: article.date.toISOString(), publishedAt: article.publishedAt?.toISOString() ?? null,
    },
  };
}
