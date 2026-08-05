const STRONG_PAYWALL_TEXT_PATTERNS = [
  /subscribe\s+to\s+(?:continue|read|unlock|access)/i,
  /sign\s+in\s+to\s+(?:continue|read|access)/i,
  /log\s*in\s+to\s+(?:continue|read|access)/i,
  /become\s+a\s+(?:subscriber|member)\s+to\s+(?:continue|read|access)/i,
  /(?:this\s+)?(?:article|content|story)\s+is\s+(?:for|available\s+to)\s+(?:subscribers|members)/i,
  /premium\s+(?:article|content|subscriber-only)/i,
  /(?:subscriber|member)[-\s]+only\s+(?:article|content|story)/i,
] as const;

const STRUCTURED_PAYWALL_PATTERNS = [
  /["']isAccessibleForFree["']\s*:\s*false/i,
  /name=["']isAccessibleForFree["'][^>]*content=["']false["']/i,
  /content=["']false["'][^>]*name=["']isAccessibleForFree["']/i,
  /["']@type["']\s*:\s*["']PaywalledContent["']/i,
] as const;

/**
 * Conservative early-stage hint only. Callers must pass article-scoped text,
 * not a complete feed or page chrome where newsletter CTAs are common.
 */
export function hasStrongPaywallHint(input: {
  articleText?: string | null;
  structuredMarkup?: string | null;
}): boolean {
  const articleText = input.articleText?.slice(0, 20_000) ?? "";
  const structuredMarkup = input.structuredMarkup?.slice(0, 200_000) ?? "";
  return STRONG_PAYWALL_TEXT_PATTERNS.some((pattern) => pattern.test(articleText))
    || STRUCTURED_PAYWALL_PATTERNS.some((pattern) => pattern.test(structuredMarkup));
}
