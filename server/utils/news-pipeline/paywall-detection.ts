// ─────────────────────────────────────────────────────────────────────────────
// Prompt 15A — Legacy hasStrongPaywallHint compatibility wrapper (EARLY HINT)
// ─────────────────────────────────────────────────────────────────────────────
//
// The authoritative article-access decision lives in
// ./article-access-classification.ts. Current Agent 1 and Agent 2 production
// paths use `classifyEarlyAccessHint()` for bounded early evidence while they
// operate on feed text or raw markup before Agent 3 runs. This module retains
// the legacy `hasStrongPaywallHint()` boolean API only for compatibility,
// tests, and older callers.
//
// IMPORTANT — the early-stage classifier is a HINT, not the authoritative final
// boolean mapper:
//  - It may return true for a strong article-specific access CTA in a short
//    feed/article preview, or for supported structured article metadata
//    declaring restricted access (PAYWALL_BLOCKED / METERED_OR_DECLARED).
//  - Its text evidence is NOT DOM-verified article scope: callers must pass
//    article-scoped text, and a newsletter CTA elsewhere in a feed must not
//    mark every item as paywalled.
//  - Generic topic words (paywall, subscription, Netflix subscription,
//    premium, subscriber, member, newsletter, ...) remain non-decisive.
//  - Substantial article text that merely QUOTES another service's paywall
//    remains false.
//  - The hint deliberately does NOT use the legacy boolean mapping
//    (METERED_OR_DECLARED -> false) so the distinction between an early hint
//    and the final blocking state is never erased.
// ─────────────────────────────────────────────────────────────────────────────

import {
  classifyArticleAccess,
  extractJsonLdPaywallSignalsFromMarkup,
  isSubstantialBodyText,
  type ArticleAccessClassification,
} from "./article-access-classification";
import type { IngestAccessEvidence } from "./types";

const EARLY_HINT_CLASSIFICATIONS: ReadonlySet<ArticleAccessClassification> = new Set([
  "PAYWALL_BLOCKED",
  "METERED_OR_DECLARED",
]);

/**
 * Build bounded Agent 1/2 evidence. Current Agent 1 and Agent 2 production
 * paths call this function for early evidence. The returned classification is
 * a hint only; callers must not treat it as the authoritative blocking boolean.
 * Public blocking still requires `accessClassification === "PAYWALL_BLOCKED"`.
 */
export function classifyEarlyAccessHint(input: {
  articleText?: string | null;
  structuredMarkup?: string | null;
  articleUrl?: string | null;
  sourceStage: "agent1" | "agent2";
}): IngestAccessEvidence {
  const articleText = (input.articleText ?? "").slice(0, 20_000);
  const structuredMarkup = (input.structuredMarkup ?? "").slice(0, 200_000);
  const substantial = isSubstantialBodyText(articleText);
  const result = classifyArticleAccess({
    statusCode: 200,
    bodyText: articleText || null,
    usableBodyExtracted: substantial,
    bodyTruncationDetected: false,
    rawPageText: articleText,
    articleScopedGateOrOverlayDetected: false,
    articleScopedCtaTexts: articleText && !substantial ? [articleText] : [],
    jsonLdPaywallSignals: extractJsonLdPaywallSignalsFromMarkup(structuredMarkup, input.articleUrl ?? null),
  });
  return {
    classification: result.classification === "PAYWALL_BLOCKED" || result.classification === "METERED_OR_DECLARED"
      ? result.classification
      : result.classification === "ACCESSIBLE" ? "ACCESSIBLE" : "UNKNOWN",
    confidence: result.confidence,
    detectorVersion: result.detectorVersion,
    evidenceCodes: result.evidence.map((entry) => entry.code).slice(0, 8),
    contradictingEvidenceCodes: result.contradictingEvidence.map((entry) => entry.code).slice(0, 8),
    sourceStage: input.sourceStage,
  };
}

/**
 * Legacy compatibility wrapper for callers that still need a boolean. Current
 * Agent 1/2 production code should use `classifyEarlyAccessHint()` so bounded
 * classification and evidence are preserved. Callers must pass article-scoped
 * text, not a complete feed or page chrome where newsletter CTAs are common.
 */
export function hasStrongPaywallHint(input: {
  articleText?: string | null;
  structuredMarkup?: string | null;
  articleUrl?: string | null;
}): boolean {
  return EARLY_HINT_CLASSIFICATIONS.has(
    classifyEarlyAccessHint({ ...input, sourceStage: "agent1" }).classification,
  );
}
