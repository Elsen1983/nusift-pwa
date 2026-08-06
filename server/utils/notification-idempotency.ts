/**
 * Daily notification scheduling uses UTC as the explicit deployment-independent
 * calendar contract. The sender's slot check and legacy lookup use the same
 * UTC boundary, and the key is one digest per user/day regardless of slot.
 */
export function dailyDigestDedupeKey(userId: string, day: Date): string {
  const year = day.getUTCFullYear();
  const month = String(day.getUTCMonth() + 1).padStart(2, "0");
  const date = String(day.getUTCDate()).padStart(2, "0");
  return `DAILY_DIGEST:${userId}:${year}-${month}-${date}`;
}

/**
 * Classify only Prisma's P2002 unique conflict for the daily dedupe key.
 * PrismaPg 7.8 emits P2002 with nested driver-adapter metadata for the
 * PostgreSQL unique index; raw-query/connector errors are not claim conflicts.
 */
export function isUniqueConstraintConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown; driverAdapterError?: unknown } };
  if (candidate.code !== "P2002") return false;
  const target = candidate.meta?.target;
  const nested = candidate.meta?.driverAdapterError as { cause?: { constraint?: { fields?: unknown } } } | undefined;
  const fields = nested?.cause?.constraint?.fields;
  const normalize = (value: unknown): string | null => typeof value === "string"
    ? value.trim().replace(/^"|"$/g, "")
    : null;
  const supported = new Set(["dedupeKey", "Notification_dedupeKey_key"]);
  const targetMatches = Array.isArray(target)
    ? target.some((value) => { const normalized = normalize(value); return normalized !== null && supported.has(normalized); })
    : (() => { const normalized = normalize(target); return normalized !== null && supported.has(normalized); })();
  const fieldMatches = Array.isArray(fields) && fields.some((value) => normalize(value) === "dedupeKey");
  return targetMatches || fieldMatches;
}
