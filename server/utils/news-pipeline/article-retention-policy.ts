/**
 * Shared article retention / freshness policy.
 *
 * Single source of truth for the article retention window used by:
 *   - Agent 1 RSS/Atom/JSON feed ingest
 *   - Agent 1 HTML fallback ingest
 *   - Agent 2 static discovery candidate acceptance
 *   - Agent 2 browser fallback candidate acceptance
 *   - Article retention cleanup (maintenance cron)
 *   - Agent 3 enrichment eligibility
 *
 * All code paths that decide whether an article is "fresh enough" to
 * import or "old enough" to delete MUST use this module.
 */

// ─── Canonical retention window ─────────────────────────────────────────────

/** Number of days an article is considered fresh / eligible for ingest. */
export const ARTICLE_RETENTION_DAYS = 7;

/** Retention window in milliseconds. */
export const ARTICLE_RETENTION_MS = ARTICLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the article retention cutoff date: articles older than this
 * are outside the retention window.
 */
export function getArticleRetentionCutoff(now?: Date): Date {
  return new Date((now ?? new Date()).getTime() - ARTICLE_RETENTION_MS);
}

/**
 * Check whether a publishedAt date falls within the article retention
 * window (i.e. the article is fresh enough to import or keep).
 *
 * Returns false for null / undefined / unparseable dates and future dates.
 */
export function isWithinArticleRetentionWindow(
  publishedAt: Date | string | null | undefined,
  now?: Date,
): boolean {
  if (publishedAt == null) return false;
  const date = typeof publishedAt === "string" ? new Date(publishedAt) : publishedAt;
  if (!date || Number.isNaN(date.getTime())) return false;
  const diff = (now ?? new Date()).getTime() - date.getTime();
  return diff >= 0 && diff <= ARTICLE_RETENTION_MS;
}

/**
 * Compact reason string for why a publishedAt is outside the retention
 * window, or null if it is inside.
 */
export function getArticleAgeReason(
  publishedAt: Date | string | null | undefined,
  now?: Date,
): string | null {
  if (publishedAt == null) return "missing_published_at";
  const date = typeof publishedAt === "string" ? new Date(publishedAt) : publishedAt;
  if (!date || Number.isNaN(date.getTime())) return "invalid_published_at";
  const diff = (now ?? new Date()).getTime() - date.getTime();
  if (diff < 0) return "future_published_at";
  if (diff > ARTICLE_RETENTION_MS) return "outside_retention_window";
  return null;
}
