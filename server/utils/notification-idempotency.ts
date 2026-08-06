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

/** Prisma's stable unique-conflict code, restricted to the dedupe key. */
export function isUniqueConstraintConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== "P2002") return false;
  const target = candidate.meta?.target;
  if (Array.isArray(target)) return target.some((value) => String(value).toLowerCase().includes("dedupekey"));
  return typeof target === "string" && target.toLowerCase().includes("dedupekey");
}
