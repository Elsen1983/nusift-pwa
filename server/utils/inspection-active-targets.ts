import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  adaptInspectionLifecycleEvidence,
  type InspectionLifecycleArtifact,
  deriveInspectionActivityEvidence,
  type InspectionActivityState,
  type InspectionActiveReason,
  resolveInspectionActivity,
} from "./admin-inspection";
import type { Agent2LifecycleState } from "./news-pipeline/agent2-target-lifecycle";

export type InspectionTargetType = "SOURCE" | "CATEGORY" | "ALL";

export type InspectionActiveTargetInput = {
  targetType: "SOURCE" | "CATEGORY";
  targetId: string;
  sourceId: string;
  parentSourceId: string | null;
  rssStatus: string;
  parentRssStatus: string | null;
  currentFeedProductive: boolean;
  activeSubscriberCount: number;
  isSystemImported: boolean;
  nextRetryAt: Date | null;
  lifecycleArtifacts: InspectionLifecycleArtifact[];
  /** Parent-source-owned lifecycle evidence (sourceId = parent, categoryId NULL). CATEGORY targets only. */
  parentLifecycleArtifacts?: InspectionLifecycleArtifact[];
  /** Parent source currentFeedProductive; used to classify a parent resolved by Agent 1 RSS. */
  parentCurrentFeedProductive?: boolean;
};

export type InspectionActiveTarget = InspectionActiveTargetInput & {
  active: boolean;
  activeReason: InspectionActiveReason;
  activityState: InspectionActivityState;
  lifecycleState: Agent2LifecycleState;
  lifecycleEvidenceCoverage: "COMPLETE" | "BOUNDED" | "NONE";
  usedArtifactEvidence: boolean;
  evidenceTruncated: boolean;
};

export type InspectionActiveTargetResolution = {
  sourceIds: string[];
  categoryIds: string[];
  targets: InspectionActiveTarget[];
  sourceScanned: number;
  categoryScanned: number;
  sourceTruncated: boolean;
  categoryTruncated: boolean;
  artifactEvidenceTruncated: boolean;
  truncated: boolean;
  targetType: InspectionTargetType;
  snapshotId: string;
  filterFingerprint: string;
};

const boundedCap = (cap: number) => Math.max(1, Math.min(5_000, Math.floor(cap)));
const stableTargetSort = (a: InspectionActiveTargetInput, b: InspectionActiveTargetInput) =>
  a.targetType.localeCompare(b.targetType) || a.targetId.localeCompare(b.targetId);

const PRODUCTIVE_LIFECYCLES = new Set<Agent2LifecycleState>([
  "rss_owned",
  "static_productive",
  "browser_productive",
  "resolved",
  "profile_active",
]);

const mergeCoverage = (
  a: "COMPLETE" | "BOUNDED" | "NONE",
  b: "COMPLETE" | "BOUNDED" | "NONE",
): "COMPLETE" | "BOUNDED" | "NONE" => {
  if (a === "BOUNDED" || b === "BOUNDED") return "BOUNDED";
  if (a === "NONE" && b === "NONE") return "NONE";
  return "COMPLETE";
};

export const resolveInspectionActiveTarget = (input: InspectionActiveTargetInput): InspectionActiveTarget => {
  const ownArtifacts = input.lifecycleArtifacts;
  const parentArtifacts = input.targetType === "CATEGORY" ? (input.parentLifecycleArtifacts ?? []) : [];
  // Category resolution includes the parent source's source-owned lifecycle
  // evidence so canonical lifecycle rules hold across the parent boundary:
  // newest evidence wins, so a resolved parent supersedes stale parent failure
  // evidence without the category's own evidence ever altering the parent.
  const lifecycleEvidence = adaptInspectionLifecycleEvidence([...ownArtifacts, ...parentArtifacts], {
    rssStatus: input.rssStatus,
    currentFeedProductive: input.currentFeedProductive,
  });
  let lifecycle = lifecycleEvidence.lifecycle;
  let evidenceCoverage = lifecycleEvidence.evidenceCoverage;
  let evidenceTruncated = lifecycleEvidence.evidenceTruncated;
  let parentLifecycle: Agent2LifecycleState | null = null;

  if (input.targetType === "CATEGORY" && input.parentSourceId) {
    const parentAdapted = adaptInspectionLifecycleEvidence(parentArtifacts, {
      rssStatus: input.parentRssStatus ?? input.rssStatus,
      currentFeedProductive: input.parentCurrentFeedProductive ?? false,
    });
    parentLifecycle = parentAdapted.lifecycle;
    // A parent resolved by Agent 1 scoped RSS with no durable artifacts is
    // canonically rss_owned; the category inherits that resolution.
    if (
      parentArtifacts.length === 0 &&
      input.parentRssStatus === "ACTIVE" &&
      input.parentCurrentFeedProductive === true
    ) {
      parentLifecycle = "rss_owned";
    }
    evidenceCoverage = mergeCoverage(evidenceCoverage, parentAdapted.evidenceCoverage);
    evidenceTruncated = evidenceTruncated || parentAdapted.evidenceTruncated;
    // Resolved/productive parent supersedes a category with no countervailing
    // direct evidence (canonical: the parent owns the feed path).
    if (
      parentLifecycle !== null &&
      PRODUCTIVE_LIFECYCLES.has(parentLifecycle) &&
      ownArtifacts.length === 0 &&
      lifecycle !== "browser_failed_terminal" &&
      lifecycle !== "ignored"
    ) {
      lifecycle = parentLifecycle;
    }
  }

  const activityEvidence = deriveInspectionActivityEvidence({
    rssStatus: input.rssStatus,
    parentRssStatus: input.parentRssStatus,
    currentFeedProductive: input.currentFeedProductive,
    activeSubscriberCount: input.activeSubscriberCount,
    isSystemImported: input.isSystemImported,
    nextRetryAt: input.nextRetryAt,
    lifecycle,
    parentLifecycle,
  });
  const effectiveStatus = input.parentRssStatus === "FAILED" || input.parentRssStatus === "DOMAIN_DEAD"
    ? input.parentRssStatus
    : input.rssStatus;
  const activityState = resolveInspectionActivity({
    rssStatus: effectiveStatus,
    currentFeedProductive: input.currentFeedProductive,
    active: activityEvidence.active,
    activeReason: activityEvidence.activeReason,
    nextRetryAt: input.nextRetryAt,
    lifecycle,
  });
  return {
    ...input,
    active: !["INACTIVE", "FAILED", "DOMAIN_DEAD"].includes(activityState),
    activeReason: activityEvidence.activeReason,
    activityState,
    lifecycleState: lifecycle,
    lifecycleEvidenceCoverage: evidenceCoverage,
    usedArtifactEvidence: ownArtifacts.length > 0 || parentArtifacts.length > 0,
    evidenceTruncated,
  };
};

/**
 * Resolve a caller-supplied set without applying a combined SOURCE/CATEGORY
 * cap. This is intentionally safe for callers that already paged each stream.
 */
export const resolveInspectionActiveTargets = (
  inputs: InspectionActiveTargetInput[],
): { targets: InspectionActiveTarget[]; truncated: boolean } => ({
  targets: [...inputs].sort(stableTargetSort).map(resolveInspectionActiveTarget),
  truncated: false,
});

const targetArtifactWhere = (target: InspectionActiveTargetInput) => target.targetType === "SOURCE"
  ? { sourceId: target.targetId, categoryId: null }
  : { categoryId: target.targetId };

/** Default legacy fallback: one bounded findMany per target (non-PostgreSQL clients only). */
async function loadLifecycleArtifactsPerTarget(
  client: any,
  targets: InspectionActiveTargetInput[],
  limit: number,
): Promise<{ byTarget: Map<string, InspectionLifecycleArtifact[]>; truncated: boolean; truncatedTargetKeys: string[] }> {
  const entries: Array<{ key: string; rows: InspectionLifecycleArtifact[]; truncated: boolean }> = [];
  for (let offset = 0; offset < targets.length; offset += 25) {
    const batch = targets.slice(offset, offset + 25);
    entries.push(...await Promise.all(batch.map(async (target) => {
      const rows = await client.pipelineArtifact.findMany({
        where: targetArtifactWhere(target),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: { id: true, createdAt: true, sourceId: true, categoryId: true, artifactType: true, status: true, payload: true },
      });
      const truncated = rows.length > limit;
      return {
        key: `${target.targetType}:${target.targetId}`,
        rows: rows.slice(0, limit) as InspectionLifecycleArtifact[],
        truncated,
      };
    })));
  }
  return {
    byTarget: new Map(entries.map((entry) => [entry.key, entry.rows])),
    truncated: entries.some((entry) => entry.truncated),
    truncatedTargetKeys: entries.filter((entry) => entry.truncated).map((entry) => entry.key),
  };
}

const partitionKeyOfRow = (row: { sourceId?: string | null; categoryId?: string | null }): string | null => {
  if (typeof row.categoryId === "string" && row.categoryId) return `CATEGORY:${row.categoryId}`;
  if (typeof row.sourceId === "string" && row.sourceId) return `SOURCE:${row.sourceId}`;
  return null;
};

/**
 * Fetch lifecycle evidence for every logical target in a bounded number of
 * parameterized PostgreSQL round trips (independent of target count).
 *
 * - Rows are partitioned by logical target with row_number() per SOURCE or
 *   CATEGORY partition and newest-first deterministic ordering.
 * - SOURCE targets consume only source-owned evidence (sourceId set,
 *   categoryId NULL); CATEGORY targets consume category-owned evidence.
 * - Parent sources of category targets are included in the same query so
 *   category lifecycle resolution carries the parent's source-owned evidence
 *   without an extra query and without category evidence altering parents.
 * - A noisy target can never displace another target's bounded evidence.
 */
export async function loadInspectionLifecycleArtifacts(
  client: any,
  targets: InspectionActiveTargetInput[],
  perTargetLimit = 100,
): Promise<{ byTarget: Map<string, InspectionLifecycleArtifact[]>; truncated: boolean; truncatedTargetKeys: string[] }> {
  const limit = Math.max(1, Math.min(500, Math.floor(perTargetLimit)));
  if (targets.length === 0) {
    return { byTarget: new Map(), truncated: false, truncatedTargetKeys: [] };
  }
  if (typeof client.$queryRaw !== "function") {
    // Non-PostgreSQL (mock/unit) clients keep the per-target fallback. Real
    // PostgreSQL clients expose $queryRaw and use the single batched query.
    return loadLifecycleArtifactsPerTarget(client, targets, limit);
  }

  const sourceIds = new Set<string>();
  const categoryIds = new Set<string>();
  for (const target of targets) {
    if (target.targetType === "SOURCE") sourceIds.add(target.targetId);
    else {
      categoryIds.add(target.targetId);
      if (target.parentSourceId) sourceIds.add(target.parentSourceId);
    }
  }
  const sourceIdList = [...sourceIds];
  const categoryIdList = [...categoryIds];
  if (sourceIdList.length === 0 && categoryIdList.length === 0) {
    return { byTarget: new Map(), truncated: false, truncatedTargetKeys: [] };
  }

  const SOURCE_CHUNK = 500;
  const CATEGORY_CHUNK = 500;
  const sourceChunks: string[][] = [];
  const categoryChunks: string[][] = [];
  for (let offset = 0; offset < sourceIdList.length; offset += SOURCE_CHUNK) sourceChunks.push(sourceIdList.slice(offset, offset + SOURCE_CHUNK));
  for (let offset = 0; offset < categoryIdList.length; offset += CATEGORY_CHUNK) categoryChunks.push(categoryIdList.slice(offset, offset + CATEGORY_CHUNK));
  if (sourceChunks.length === 0) sourceChunks.push([]);
  if (categoryChunks.length === 0) categoryChunks.push([]);

  const byPartition = new Map<string, InspectionLifecycleArtifact[]>();
  for (const sourceChunk of sourceChunks) {
    for (const categoryChunk of categoryChunks) {
      const conditions: Prisma.Sql[] = [];
      if (sourceChunk.length > 0) {
        conditions.push(Prisma.sql`("sourceId" IN (${Prisma.join(sourceChunk)}) AND "categoryId" IS NULL)`);
      }
      if (categoryChunk.length > 0) {
        conditions.push(Prisma.sql`("categoryId" IN (${Prisma.join(categoryChunk)}))`);
      }
      if (conditions.length === 0) continue;
      const whereClause = conditions.length === 1 ? conditions[0] : Prisma.sql`(${Prisma.join(conditions, " OR ")})`;
      const rows = await (client.$queryRaw as (query: Prisma.Sql) => Promise<Array<{
        id: string;
        createdAt: Date;
        sourceId: string | null;
        categoryId: string | null;
        artifactType: string;
        status: string;
        payload: unknown;
      }>>)(Prisma.sql`
        WITH ranked AS (
          SELECT "id", "createdAt", "sourceId", "categoryId", "artifactType", "status", "payload",
                 row_number() OVER (
                   PARTITION BY CASE
                     WHEN "categoryId" IS NOT NULL THEN 'CATEGORY:' || "categoryId"
                     WHEN "sourceId" IS NOT NULL AND "categoryId" IS NULL THEN 'SOURCE:' || "sourceId"
                     ELSE 'OTHER'
                   END
                   ORDER BY "createdAt" DESC, "id" DESC
                 ) AS "rowNumber"
          FROM "PipelineArtifact"
          WHERE ${whereClause}
        )
        SELECT "id", "createdAt", "sourceId", "categoryId", "artifactType", "status", "payload"
        FROM ranked
        WHERE "rowNumber" <= ${limit + 1}
        ORDER BY "createdAt" DESC, "id" DESC
      `);
      for (const row of rows) {
        const key = partitionKeyOfRow(row);
        if (!key) continue;
        const existing = byPartition.get(key) ?? [];
        existing.push({
          id: row.id,
          createdAt: row.createdAt,
          sourceId: row.sourceId,
          categoryId: row.categoryId,
          artifactType: row.artifactType,
          status: row.status,
          payload: row.payload,
        });
        byPartition.set(key, existing);
      }
    }
  }

  const byTarget = new Map<string, InspectionLifecycleArtifact[]>();
  const truncatedTargetKeys: string[] = [];
  for (const [key, rows] of byPartition) {
    // Chunk-pair queries can return the same category-owned row once per
    // source chunk; dedupe by row id (rows are globally newest-first, so the
    // first occurrence is the newest) before applying the per-target bound.
    const seenIds = new Set<string>();
    const unique: InspectionLifecycleArtifact[] = [];
    for (const row of rows) {
      if (typeof row.id === "string" && seenIds.has(row.id)) continue;
      if (typeof row.id === "string") seenIds.add(row.id);
      unique.push(row);
    }
    const truncated = unique.length > limit;
    byTarget.set(key, unique.slice(0, limit));
    if (truncated) truncatedTargetKeys.push(key);
  }
  return {
    byTarget,
    truncated: truncatedTargetKeys.length > 0,
    truncatedTargetKeys,
  };
}

const snapshotIdFor = (targetType: InspectionTargetType, targets: InspectionActiveTarget[], filterFingerprint: string) => createHash("sha256")
  .update(JSON.stringify({ targetType, filterFingerprint, targets: targets.map((target) => ({ targetType: target.targetType, targetId: target.targetId, active: target.active, activityState: target.activityState, lifecycleState: target.lifecycleState, activeReason: target.activeReason })) }))
  .digest("hex")
  .slice(0, 32);

/**
 * Resolve the bounded active-target snapshot used by all-active article mode.
 * SOURCE and CATEGORY caps are independent; required category parents are
 * fetched separately and never consume the category target cap.
 */
export async function resolveInspectionActiveTargetIds(
  client: any,
  cap = 500,
  targetType: InspectionTargetType = "ALL",
  filterFingerprint = `targetType:${targetType}`,
): Promise<InspectionActiveTargetResolution> {
  const streamCap = boundedCap(cap);
  const readSources = targetType !== "CATEGORY";
  const readCategories = targetType !== "SOURCE";
  const [sourceRows, categoryRows] = await Promise.all([
    readSources ? client.newsSource.findMany({
      take: streamCap + 1,
      orderBy: [{ mediaName: "asc" }, { id: "asc" }],
      select: { id: true, rssStatus: true, currentFeedProductive: true, nextRetryAt: true, isSystemImported: true, _count: { select: { subscribers: { where: { isActive: true } } } } },
    }) : Promise.resolve([]),
    readCategories ? client.sourceCategory.findMany({
      take: streamCap + 1,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, newsSourceId: true, rssStatus: true, currentFeedProductive: true, nextRetryAt: true, _count: { select: { subscribers: { where: { isActive: true } } } }, newsSource: { select: { rssStatus: true, currentFeedProductive: true, nextRetryAt: true, isSystemImported: true } } },
    }) : Promise.resolve([]),
  ]);
  const rawSources = sourceRows as any[];
  const rawCategories = categoryRows as any[];
  const sourceTruncated = rawSources.length > streamCap;
  const categoryTruncated = rawCategories.length > streamCap;
  const sources = rawSources.slice(0, streamCap);
  const categories = rawCategories.slice(0, streamCap);
  const inputs: InspectionActiveTargetInput[] = [
    ...sources.map((row) => ({ targetType: "SOURCE" as const, targetId: row.id, sourceId: row.id, parentSourceId: null, rssStatus: String(row.rssStatus), parentRssStatus: null, currentFeedProductive: Boolean(row.currentFeedProductive), activeSubscriberCount: row._count.subscribers, isSystemImported: Boolean(row.isSystemImported), nextRetryAt: row.nextRetryAt, lifecycleArtifacts: [] })),
    ...categories.map((row) => ({ targetType: "CATEGORY" as const, targetId: row.id, sourceId: row.newsSourceId, parentSourceId: row.newsSourceId, rssStatus: String(row.rssStatus), parentRssStatus: String(row.newsSource.rssStatus), currentFeedProductive: Boolean(row.currentFeedProductive), activeSubscriberCount: row._count.subscribers, isSystemImported: Boolean(row.newsSource.isSystemImported), nextRetryAt: row.nextRetryAt, lifecycleArtifacts: [] })),
  ];
  const evidence = await loadInspectionLifecycleArtifacts(client, inputs, 100);
  const parentProductiveById = new Map<string, boolean>(
    categories.map((row) => [row.newsSourceId, Boolean(row.newsSource.currentFeedProductive)]),
  );
  const enrichedInputs = inputs.map((input) => ({
    ...input,
    lifecycleArtifacts: evidence.byTarget.get(`${input.targetType}:${input.targetId}`) ?? [],
    ...(input.targetType === "CATEGORY" && input.parentSourceId
      ? {
          parentLifecycleArtifacts: evidence.byTarget.get(`SOURCE:${input.parentSourceId}`) ?? [],
          parentCurrentFeedProductive: parentProductiveById.get(input.parentSourceId) ?? false,
        }
      : {}),
  }));
  const targets = resolveInspectionActiveTargets(enrichedInputs).targets.map((target) => {
    const key = `${target.targetType}:${target.targetId}`;
    const targetTruncated = evidence.truncatedTargetKeys.includes(key);
    return {
      ...target,
      evidenceTruncated: target.evidenceTruncated || targetTruncated,
      lifecycleEvidenceCoverage: target.evidenceTruncated || targetTruncated ? "BOUNDED" as const : target.lifecycleEvidenceCoverage,
    };
  });
  const artifactEvidenceTruncated = evidence.truncated;
  const sourceTargets = targets.filter((target) => target.targetType === "SOURCE");
  const categoryTargets = targets.filter((target) => target.targetType === "CATEGORY");
  const snapshotId = snapshotIdFor(targetType, targets, filterFingerprint);
  return {
    sourceIds: sourceTargets.filter((target) => target.active).map((target) => target.targetId),
    categoryIds: categoryTargets.filter((target) => target.active).map((target) => target.targetId),
    targets,
    sourceScanned: sourceTargets.length,
    categoryScanned: categoryTargets.length,
    sourceTruncated,
    categoryTruncated,
    artifactEvidenceTruncated,
    truncated: sourceTruncated || categoryTruncated || artifactEvidenceTruncated,
    targetType,
    snapshotId,
    filterFingerprint,
  };
}
