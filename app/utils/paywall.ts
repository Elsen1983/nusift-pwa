export const PUBLIC_ACCESS_CLASSIFICATIONS = [
  "ACCESSIBLE",
  "PAYWALL_BLOCKED",
  "METERED_OR_DECLARED",
  "INTERSTITIAL_OR_CHALLENGE",
  "HTTP_ACCESS_BLOCKED",
  "UNKNOWN",
] as const;

export type PublicAccessClassification = (typeof PUBLIC_ACCESS_CLASSIFICATIONS)[number];

const PUBLIC_ACCESS_CLASSIFICATION_SET = new Set<string>(PUBLIC_ACCESS_CLASSIFICATIONS);

export const toPublicAccessClassification = (
  value: unknown,
): PublicAccessClassification | null =>
  typeof value === "string" && PUBLIC_ACCESS_CLASSIFICATION_SET.has(value)
    ? value as PublicAccessClassification
    : null;

/**
 * Blocking UI requires an explicit structured PAYWALL_BLOCKED classification.
 * The legacy boolean is intentionally not a fallback when classification is
 * missing or malformed.
 */
export const isConfirmedBlockingPaywall = (article: {
  accessClassification?: unknown;
  isPaywall?: unknown;
} | null | undefined): boolean =>
  toPublicAccessClassification(article?.accessClassification) === "PAYWALL_BLOCKED";
