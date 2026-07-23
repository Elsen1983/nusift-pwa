/**
 * Parse an unknown value into a bounded integer.
 * Returns `fallback` for null, undefined, empty/whitespace strings,
 * booleans, NaN, and Infinity.
 * Floors the result and clamps to [min, max].
 */
export function readBoundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value == null) return fallback;
  if (typeof value === "boolean") return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
