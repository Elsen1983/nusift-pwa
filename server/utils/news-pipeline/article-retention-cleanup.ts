/**
 * Article retention cleanup.
 *
 * Deletes Article rows older than a retention window ONLY when no user-owned
 * or user-visible reference exists. Designed to be safe, bounded, and
 * cron-ready: the utility is pure DB logic, while endpoints (admin or cron)
 * decide dry-run, limits, and auth.
 *
 * Protection rules (from prisma/schema.prisma):
 *   - Bookmark           → saved / read-later. ALWAYS protects.
 *   - ArticleRating      → user rating / favorite-like state. ALWAYS protects in v1.
 *   - UserReadActivity   → IMPRESSION / CLICKED / READ_FULL. Protects in v1 to
 *                          avoid surprising deletion; may be relaxed later in a
 *                          dedicated read-activity expiry path.
 *   - Notification       → does NOT protect. No Article FK; only `url`/`payload`
 *                          JSON. Checking it would be expensive and unreliable.
 *
 * Age rule:
 *   - Effective date = Article.publishedAt ?? Article.createdAt.
 *   - Eligible only if effective date < (now - olderThanDays).
 *
 * Bounded + idempotent + safe to repeat.
 */

import { prisma } from "../prisma";
import { logAgentScan } from "./log";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ArticleRetentionCleanupInput = {
  dryRun?: boolean;
  olderThanDays?: number;
  limit?: number;
  now?: Date;
};

export type ArticleRetentionCleanupResult = {
  ok: true;
  dryRun: boolean;
  olderThanDays: number;
  cutoff: string;
  inspected: number;
  eligibleForDeletion: number;
  deleted: number;
  protected: number;
  skipped: number;
  limit: number;
  durationMs: number;
  bySource: Array<{ sourceId: string | null; count: number }>;
  protectedReasons: Record<string, number>;
  skippedReasons: Record<string, number>;
  sampleDeletedOrWouldDelete: Array<{
    id: string;
    url: string | null;
    title: string | null;
    sourceId: string | null;
    publishedAt: string | null;
    createdAt: string;
    effectiveDate: string;
  }>;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_OLDER_THAN_DAYS = 7;
const MIN_OLDER_THAN_DAYS = 1;
const MAX_OLDER_THAN_DAYS = 365;

const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

const MAX_SAMPLE_SIZE = 20;

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null || typeof value === "boolean") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Inspect or delete old, unowned Article rows.
 *
 * `dryRun=true` (default) only inspects and reports; no DB mutation.
 * `dryRun=false` deletes the selected eligible ids via bounded deleteMany.
 *
 * Always returns a compact, auditable result. Raw payloads / full text are
 * never included.
 */
export async function processOldArticleRetentionCleanup(
  input?: ArticleRetentionCleanupInput,
): Promise<ArticleRetentionCleanupResult> {
  const dryRun = input?.dryRun !== false; // default true for safety
  const olderThanDays = clampInt(
    input?.olderThanDays,
    DEFAULT_OLDER_THAN_DAYS,
    MIN_OLDER_THAN_DAYS,
    MAX_OLDER_THAN_DAYS,
  );
  const limit = clampInt(input?.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
  const now = input?.now ?? new Date();
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);

  const startedAt = Date.now();
  const emptyResult = (extra?: Partial<ArticleRetentionCleanupResult>): ArticleRetentionCleanupResult => ({
    ok: true,
    dryRun,
    olderThanDays,
    cutoff: cutoff.toISOString(),
    inspected: 0,
    eligibleForDeletion: 0,
    deleted: 0,
    protected: 0,
    skipped: 0,
    limit,
    durationMs: Date.now() - startedAt,
    bySource: [],
    protectedReasons: {},
    skippedReasons: {},
    sampleDeletedOrWouldDelete: [],
    ...extra,
  });

  await logAgentScan({
    status: "ARTICLE_RETENTION_CLEANUP_STARTED",
    executionTimeMs: 0,
    errorLog:
      `Article retention cleanup ${dryRun ? "inspection" : "run"} started. ` +
      `olderThanDays=${olderThanDays}, limit=${limit}, dryRun=${dryRun}, cutoff=${cutoff.toISOString()}.`,
  }).catch(() => {});

  try {
    // ── Step 1: Candidate selection ──────────────────────────────────────
    // Fetch candidate rows older than the cutoff by effective date.
    // `publishedAt` is null for many rows, so we use OR to fall back to
    // `createdAt`. We over-fetch slightly (limit) and finalize selection in JS
    // after the protection check so the limit applies to *eligible* rows, not
    // to the raw candidate pool.
    //
    // We fetch `take: limit` from each branch and merge+sort in JS; this keeps
    // the candidate pool bounded by 2*limit and avoids scanning all old rows.
    const [byPublished, byCreated] = await Promise.all([
      prisma.article.findMany({
        where: {
          publishedAt: { lt: cutoff },
        },
        select: {
          id: true,
          title: true,
          sourceId: true,
          sourceUrl: true,
          publishedAt: true,
          createdAt: true,
        },
        orderBy: { date: "asc" },
        take: limit,
      }),
      prisma.article.findMany({
        where: {
          publishedAt: null,
          createdAt: { lt: cutoff },
        },
        select: {
          id: true,
          title: true,
          sourceId: true,
          sourceUrl: true,
          publishedAt: true,
          createdAt: true,
        },
        orderBy: { date: "asc" },
        take: limit,
      }),
    ]);

    // Merge & dedupe by id, then keep the oldest `limit` candidates by
    // effective date. Effective date = publishedAt ?? createdAt.
    const seen = new Set<number>();
    const candidates = [...byPublished, ...byCreated]
      .filter((a) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      })
      .map((a) => {
        const effectiveDate = a.publishedAt ?? a.createdAt;
        return { ...a, effectiveDate };
      })
      .sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime())
      .slice(0, limit);

    const inspected = candidates.length;
    if (inspected === 0) {
      await logAgentScan({
        status: "ARTICLE_RETENTION_CLEANUP_FINISHED",
        executionTimeMs: Date.now() - startedAt,
        errorLog:
          `Article retention cleanup ${dryRun ? "inspection" : "run"} complete. ` +
          `No candidates older than cutoff. inspected=0.`,
      }).catch(() => {});
      return emptyResult();
    }

    const candidateIds = candidates.map((c) => c.id);

    // ── Step 2: Protection check (bounded batched queries) ──────────────
    // Article ids are Int; querying `articleId IN (...)` against each relation
    // is cheap and bounded by `limit` (≤ 500). We do three parallel count
    // queries and mark protection per-candidate. A candidate is protected if
    // any relation references it.
    const [bookmarkCounts, ratingCounts, readActivityCounts] = await Promise.all([
      prisma.bookmark.groupBy({
        by: ["articleId"],
        where: { articleId: { in: candidateIds } },
        _count: { _all: true },
        orderBy: { articleId: "asc" },
        take: candidateIds.length,
      }),
      prisma.articleRating.groupBy({
        by: ["articleId"],
        where: { articleId: { in: candidateIds } },
        _count: { _all: true },
        orderBy: { articleId: "asc" },
        take: candidateIds.length,
      }),
      prisma.userReadActivity.groupBy({
        by: ["articleId"],
        where: { articleId: { in: candidateIds } },
        _count: { _all: true },
        orderBy: { articleId: "asc" },
        take: candidateIds.length,
      }),
    ]);

    const protectedArticleIds = new Set<number>();
    const protectedReasons: Record<string, number> = {};

    for (const row of bookmarkCounts) {
      protectedArticleIds.add(row.articleId);
      bump(protectedReasons, "bookmark");
    }
    for (const row of ratingCounts) {
      protectedArticleIds.add(row.articleId);
      bump(protectedReasons, "rating");
    }
    for (const row of readActivityCounts) {
      protectedArticleIds.add(row.articleId);
      bump(protectedReasons, "readActivity");
    }

    // Split candidates into eligible vs protected.
    const eligible = candidates.filter((c) => !protectedArticleIds.has(c.id));
    const protectedRows = candidates.filter((c) => protectedArticleIds.has(c.id));

    // Note: protectedReasons counts per relation, so an article protected by
    // two relations is counted twice. The `protected` count below counts
    // unique protected articles. The `protectedReasons` map is intentionally
    // per-relation to show the breakdown.

    const eligibleForDeletion = eligible.length;
    const protectedCount = protectedRows.length;
    const skippedReasons: Record<string, number> = {};

    // skippedReasons.protected equals the unique protected article count,
    // consistent with the pipeline-artifact-cleanup utility and the top-level
    // `protected` field. (protectedReasons breaks this down per relation.)
    if (protectedCount > 0) skippedReasons.protected = protectedCount;

    // ── Step 3: Build bySource + samples ─────────────────────────────────
    const sourceMap = new Map<string | null, number>();
    for (const c of eligible) {
      const key = c.sourceId ?? null;
      sourceMap.set(key, (sourceMap.get(key) || 0) + 1);
    }
    const bySource = [...sourceMap.entries()]
      .map(([sourceId, count]) => ({ sourceId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const sampleDeletedOrWouldDelete = eligible
      .slice(0, MAX_SAMPLE_SIZE)
      .map((c) => ({
        id: String(c.id),
        url: c.sourceUrl ?? null,
        title: c.title ?? null,
        sourceId: c.sourceId ?? null,
        publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
        createdAt: c.createdAt.toISOString(),
        effectiveDate: c.effectiveDate.toISOString(),
      }));

    // ── Step 4: Dry-run short-circuit ────────────────────────────────────
    if (dryRun) {
      const result = emptyResult({
        inspected,
        eligibleForDeletion,
        deleted: 0,
        protected: protectedCount,
        skipped: protectedCount,
        bySource,
        protectedReasons,
        skippedReasons,
        sampleDeletedOrWouldDelete,
      });
      result.durationMs = Date.now() - startedAt;

      await logAgentScan({
        status: "ARTICLE_RETENTION_CLEANUP_FINISHED",
        executionTimeMs: result.durationMs,
        errorLog:
          `Article retention cleanup inspection complete. ` +
          `inspected=${inspected}, eligibleForDeletion=${eligibleForDeletion}, ` +
          `protected=${protectedCount}, protectedReasons=${JSON.stringify(protectedReasons)}.`,
      }).catch(() => {});

      return result;
    }

    // ── Step 5: Non-dry-run deletion (bounded, explicit id list) ─────────
    const eligibleIds = eligible.map((c) => c.id);
    let deleted = 0;
    if (eligibleIds.length > 0) {
      const delResult = await prisma.article.deleteMany({
        where: { id: { in: eligibleIds } },
      });
      deleted = delResult.count;

      if (deleted !== eligibleIds.length) {
        // Report the discrepancy in skippedReasons but do not throw. This can
        // happen if concurrent deletes removed rows between selection and
        // deleteMany — safe and idempotent.
        bump(skippedReasons, "deleteCountMismatch");
      }
    }

    const result = emptyResult({
      inspected,
      eligibleForDeletion,
      deleted,
      protected: protectedCount,
      skipped: protectedCount,
      bySource,
      protectedReasons,
      skippedReasons,
      sampleDeletedOrWouldDelete,
    });
    result.durationMs = Date.now() - startedAt;

    await logAgentScan({
      status: "ARTICLE_RETENTION_CLEANUP_FINISHED",
      executionTimeMs: result.durationMs,
      errorLog:
        `Article retention cleanup run complete. ` +
        `inspected=${inspected}, eligibleForDeletion=${eligibleForDeletion}, ` +
        `deleted=${deleted}, protected=${protectedCount}, ` +
        `protectedReasons=${JSON.stringify(protectedReasons)}.`,
    }).catch(() => {});

    return result;
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    await logAgentScan({
      status: "ARTICLE_RETENTION_CLEANUP_FAILED",
      executionTimeMs: durationMs,
      errorLog:
        `Article retention cleanup failed: ${error?.message || String(error)}. ` +
        `olderThanDays=${olderThanDays}, limit=${limit}, dryRun=${dryRun}.`,
    }).catch(() => {});

    // Re-throw so callers (endpoints) can surface the error. We logged first.
    throw error;
  }
}
