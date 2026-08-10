// ─────────────────────────────────────────────────────────────────────────────
// Prompt 15A — Evidence-Based Article-Access Classification (centralized)
// ─────────────────────────────────────────────────────────────────────────────
//
// Single authoritative classifier for whether an extracted article page is
// accessible, paywalled, metered/declared, blocked by a challenge/interstitial,
// or blocked at the HTTP layer.
//
// Design rules:
//  - Generic topic words (paywall, subscription, Netflix subscription, premium,
//    subscriber, member, newsletter, ...) are NEVER decisive. They are stored
//    only as low-confidence context evidence (topic_signals).
//  - Technical access failures (CAPTCHA, robot/browser challenge, JS challenge,
//    ad-blocker interstitial, HTTP 401/403, explicit request denial) are
//    separated from paywalls and can never set isPaywall=true merely because
//    article content was unavailable.
//  - PAYWALL_BLOCKED requires article-scoped runtime evidence (an access CTA
//    inside/adjacent to the article container, optionally a gate/overlay)
//    combined with a missing or materially truncated article body.
//  - A substantial usable full body is strong contrary evidence: with no
//    article-scoped gate/CTA it forces ACCESSIBLE; with a genuine restriction
//    it produces METERED_OR_DECLARED, never PAYWALL_BLOCKED.
//  - Structured (JSON-LD) metadata alone normally produces
//    METERED_OR_DECLARED, not PAYWALL_BLOCKED, unless runtime access-block
//    evidence also exists. JSON-LD is parsed safely and only supported article
//    nodes scoped to the canonical URL are honored.
//
// The module is dependency-free and synchronous so it can be unit-tested with
// plain fixtures and reused by the Agent 3 extractor and the early-stage
// classifyEarlyAccessHint() production paths. The legacy hasStrongPaywallHint()
// wrapper remains only for compatibility, tests, and older callers.
// ─────────────────────────────────────────────────────────────────────────────

export const ARTICLE_ACCESS_DETECTOR_VERSION = "article-access-v1.1.0";

/** Classification taxonomy shared by the extractor, admin inspection, and persistence. */
export type ArticleAccessClassification =
  | "ACCESSIBLE"
  | "PAYWALL_BLOCKED"
  | "METERED_OR_DECLARED"
  | "INTERSTITIAL_OR_CHALLENGE"
  | "HTTP_ACCESS_BLOCKED"
  | "UNKNOWN";

export type ArticleAccessConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface AccessEvidenceEntry {
  /** Bounded machine-readable code, e.g. "article_scoped_cta". */
  code: string;
  /** Bounded human detail (capped, no raw HTML / secrets / cookies). */
  detail?: string;
  /** Whether this evidence supports a blocking classification or accessibility. */
  polarity: "blocking" | "supporting";
}

export type JsonLdNodeIdentityState = "matched" | "conflicting" | "unstated";

/** A bounded, article-scoped structured (JSON-LD) paywall signal. */
export interface JsonLdPaywallSignal {
  code: "isAccessibleForFree:false" | "PaywalledContent";
  nodeType: string;
  /** Whether the carrying article node matched the canonical URL identity. */
  nodeIdentityState: JsonLdNodeIdentityState;
}

export interface JsonLdPaywallSignalScan {
  signals: JsonLdPaywallSignal[];
  /** Number of supported article nodes seen (used for single-node disambiguation). */
  articleNodeCount: number;
  /** Number of article nodes whose identity conflicted with the canonical URL. */
  conflictingNodeCount: number;
}

export interface ArticleAccessClassificationInput {
  /** HTTP status of the response being classified. */
  statusCode: number;
  /** Extracted article body text (usable or not). Bounded by the caller. */
  bodyText: string | null;
  /** True when a substantial usable multi-paragraph body was extracted. */
  usableBodyExtracted: boolean;
  /** True when the extractor detected truncation (early stop / cap / hidden continuation). */
  bodyTruncationDetected: boolean;
  /** Cleaned whole-page text (bounded by the caller; capped here as a guard). */
  rawPageText: string;
  /** True when a gate/overlay was detected inside/adjacent to the article container. */
  articleScopedGateOrOverlayDetected: boolean;
  /** Bounded list of article-scoped CTA texts (each capped by the caller). */
  articleScopedCtaTexts: string[];
  /** Article-scoped structured (JSON-LD) paywall signals. */
  jsonLdPaywallSignals: JsonLdPaywallSignal[];
  /** Pre-detected challenge text signals (CAPTCHA / robot / JS challenge). */
  challengeTextSignals?: string[];
  /** True when an ad-blocker warning was detected on the page. */
  adBlockerWarningDetected?: boolean;
}

export interface ArticleAccessClassificationResult {
  classification: ArticleAccessClassification;
  confidence: ArticleAccessConfidence;
  detectorVersion: string;
  /** Bounded evidence supporting the classification. */
  evidence: AccessEvidenceEntry[];
  /** Bounded evidence contradicting the classification. */
  contradictingEvidence: AccessEvidenceEntry[];
  /** Whether any decisive evidence was article-scoped (gate/CTA/scoped JSON-LD). */
  evidenceArticleScoped: boolean;
  usableBodyExtracted: boolean;
  bodyTruncationDetected: boolean;
  articleScopedGateOrOverlayDetected: boolean;
  /** Legacy tri-state mapping for isPaywall persistence. */
  isPaywall: boolean | null;
  /** True when evidence was strong enough to override earlier Agent 1/2 hints. */
  decisive: boolean;
}

// ─── Pattern vocabularies ───────────────────────────────────────────────────
// These are the ONLY paywall/blocker vocabularies. Nothing outside this module
// may classify paywall status from raw text.

/** Supported schema.org article node types whose metadata is honored. */
const SUPPORTED_JSONLD_ARTICLE_TYPES: ReadonlySet<string> = new Set([
  "article",
  "newsarticle",
  "reportagenewsarticle",
  "analysisnewsarticle",
]);

/**
 * Generic topic words. These may never classify an article as paywalled;
 * they are stored only as low-confidence context evidence.
 */
const TOPIC_WORD_PATTERNS: RegExp[] = [
  /paywall/i,
  /\bpaywalled\b/i,
  /behind\s+a\s+paywall/i,
  /\bsubscription\b/i,
  /\bsubscriber[s]?\b/i,
  /\bpremium\b/i,
  /\bnewsletter\b/i,
  /\bnetflix\s+subscription\b/i,
];

/**
 * Article-specific access CTA phrases. Decisive ONLY when article-scoped and
 * combined with a missing/truncated body (PAYWALL_BLOCKED) or when the
 * restriction is otherwise proven (METERED_OR_DECLARED).
 * A navigation Subscribe button, footer CTA, newsletter widget, account menu,
 * advertisement, or recommendation card must never match these patterns on
 * their own — the DOM-side analyzer passes only article-scoped text.
 */
const ARTICLE_ACCESS_CTA_PATTERNS: RegExp[] = [
  /subscribe\s+to\s+(?:continue\s+reading|continue|read|unlock|access|view)/i,
  /(?:sign\s*in|log\s*in|login)\s+to\s+(?:continue\s+reading|continue|read|access|unlock|view)/i,
  /(?:you\s+must|please)\s+(?:sign\s*in|log\s*in|subscribe|register)\s+to\s+(?:continue|read|access|unlock|view)/i,
  /become\s+a\s+(?:subscriber|member)\s+to\s+(?:continue|read|unlock|access|view)/i,
  /(?:this|the)\s+(?:article|story|content)\s+is\s+(?:for|available\s+to|exclusive\s+to)\s+(?:subscribers|members)/i,
  /(?:subscriber|member)[\s-]+only\s+(?:article|story|content|access|reading|section)/i,
  /(?:unlock|access)\s+(?:this|the|full)\s+(?:article|story|content)/i,
  /(?:read|view)\s+(?:the\s+)?(?:full|complete|rest\s+of)\s+(?:this\s+)?(?:article|story|content)\s+(?:by|after)\s+(?:subscribing|signing\s*in)/i,
];

/** CAPTCHA / robot / browser challenge / JS-required interstitial signals. */
const CHALLENGE_TEXT_PATTERNS: RegExp[] = [
  /checking\s+your\s+browser/i,
  /verify(?:ing)?\s+(?:you\s+are|that\s+you\s+are)\s+(?:human|not\s+a\s+robot)/i,
  /are\s+you\s+a\s+robot/i,
  /\bcaptcha\b/i,
  /robot\s+(?:challenge|check|verification)/i,
  /attention\s+required/i,
  /please\s+wait\s+(?:while|for|a\s+moment)/i,
  /you\s+will\s+(?:be\s+)?redirected/i,
  /redirecting\s+(?:you|your\s+request)/i,
  /(?:request|page)\s+(?:is\s+)?(?:processing|in\s+queue)/i,
  /powered\s+by\s+(?:cloudflare|incapsula|imperva)/i,
  /enable\s+javascript\s+to\s+(?:continue|read|view|access)/i,
  /javascript\s+(?:is\s+)?disabled/i,
  /one\s+moment\s*(?:please)?/i,
  /just\s+a\s+moment/i,
  /page\s+is\s+loading/i,
  /before\s+(?:accessing|proceeding|continuing)/i,
];

/** Explicit request-access denial signals (not paywalls). */
const HTTP_DENIED_TEXT_PATTERNS: RegExp[] = [
  /\baccess\s+denied\b/i,
  /\baccess\s+forbidden\b/i,
  /\brequest\s+denied\b/i,
  /you\s+don'?t\s+have\s+permission/i,
  /403\s+forbidden/i,
];

/** Ad-blocker warnings (not paywalls). */
const AD_BLOCKER_WARNING_PATTERNS: RegExp[] = [
  /please\s+disable\s+your\s+ad\s*blocker/i,
  /ad\s*block(?:er)?\s+detected/i,
  /you\s+are\s+using\s+an?\s+ad\s*blocker/i,
];

// ─── Bounds ─────────────────────────────────────────────────────────────────

const RAW_TEXT_BOUND = 100_000;
const CTA_MATCH_BOUND = 400;
const EVIDENCE_CAP = 12;
const DETAIL_CAP = 120;

// ─── Pattern matching helpers (exported for the DOM analyzer / wrapper) ─────

function boundedDetail(items: string[], cap = EVIDENCE_CAP): string {
  return items.slice(0, cap).join(",").slice(0, DETAIL_CAP);
}

function matchPatterns(text: string, patterns: readonly RegExp[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      const source = pattern.source.replace(/\\[bi]/g, "").slice(0, 40);
      if (!found.includes(source)) found.push(source);
    }
  }
  return found;
}

/** Match article-specific access CTA phrases in a bounded text sample. */
export function matchArticleAccessCtaPatterns(text: string): string[] {
  return matchPatterns((text || "").slice(0, CTA_MATCH_BOUND), ARTICLE_ACCESS_CTA_PATTERNS);
}

/** Match CAPTCHA/robot/JS-challenge signals in a bounded text sample. */
export function matchChallengeTextPatterns(text: string): string[] {
  return matchPatterns((text || "").slice(0, CTA_MATCH_BOUND), CHALLENGE_TEXT_PATTERNS);
}

/** Match explicit request-access denial signals. */
export function matchHttpDeniedTextPatterns(text: string): string[] {
  return matchPatterns((text || "").slice(0, CTA_MATCH_BOUND), HTTP_DENIED_TEXT_PATTERNS);
}

/** Match ad-blocker warning signals. */
export function matchAdBlockerWarningPatterns(text: string): string[] {
  return matchPatterns((text || "").slice(0, CTA_MATCH_BOUND), AD_BLOCKER_WARNING_PATTERNS);
}

/** Match generic (non-decisive) topic words. */
export function matchTopicWordPatterns(text: string): string[] {
  return matchPatterns((text || "").slice(0, CTA_MATCH_BOUND), TOPIC_WORD_PATTERNS);
}

/**
 * Whether a text sample qualifies as a substantial usable article body
 * (used by the compatibility wrapper that has no DOM access).
 */
export function isSubstantialBodyText(text: string | null | undefined): boolean {
  const trimmed = (text ?? "").trim();
  if (trimmed.length < 400) return false;
  const sentenceEnders = trimmed.match(/[.!?]+(?=\s|$)/g);
  return (sentenceEnders?.length ?? 0) >= 3;
}

// ─── JSON-LD scoping ────────────────────────────────────────────────────────

type CanonicalUrlIdentityState = "missing" | "valid" | "malformed";

type CanonicalUrlIdentity = {
  state: CanonicalUrlIdentityState;
  href: string | null;
};

function normalizeUrlForCompare(raw: string, base: string | null | undefined): string {
  try {
    const url = new URL(raw, base ?? undefined);
    // URL normalizes the protocol, hostname, and default port according to
    // URL semantics. The pathname is deliberately kept case-sensitive:
    // publishers may route `/News/Story` and `/news/story` differently.
    const pathname = url.pathname === "/"
      ? "/"
      : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname || "/"}`;
  } catch {
    // A malformed canonical or JSON-LD identity must never become a match.
    return "";
  }
}

function resolveCanonicalUrlIdentity(raw: string | null | undefined): CanonicalUrlIdentity {
  if (raw == null || raw.trim().length === 0) {
    return { state: "missing", href: null };
  }
  const href = normalizeUrlForCompare(raw, null);
  return href
    ? { state: "valid", href }
    : { state: "malformed", href: null };
}

function pickIdentityUrl(record: Record<string, unknown>): string | null {
  if (typeof record.url === "string" && record.url.trim()) return record.url.trim();
  if (typeof record["@id"] === "string" && record["@id"].trim()) return record["@id"].trim();
  const mope = record.mainEntityOfPage;
  if (typeof mope === "string" && mope.trim()) return mope.trim();
  if (mope && typeof mope === "object") {
    const mopeRecord = mope as Record<string, unknown>;
    if (typeof mopeRecord.url === "string" && mopeRecord.url.trim()) return mopeRecord.url.trim();
    if (typeof mopeRecord["@id"] === "string" && mopeRecord["@id"].trim()) return mopeRecord["@id"].trim();
  }
  return null;
}

/**
 * Collect ALL normalized string @type entries. A node is a supported article
 * node when ANY entry is a supported type — a supported type later in the
 * array (e.g. ["CreativeWork", "NewsArticle"]) must be accepted, and
 * ["WebPage", "Article"] counts as an article node. Malformed and
 * non-string entries never crash and never match.
 */
function collectTypeNames(record: Record<string, unknown>): string[] {
  const typeValue = record["@type"];
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  return types
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim().toLowerCase());
}

/** First supported article type name (preserved for evidence), or null. */
function firstSupportedArticleTypeName(record: Record<string, unknown>): string | null {
  const typeValue = record["@type"];
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  const named = types.find(
    (t): t is string =>
      typeof t === "string" &&
      t.trim().length > 0 &&
      SUPPORTED_JSONLD_ARTICLE_TYPES.has(t.trim().toLowerCase()),
  );
  return named ?? null;
}

/**
 * Walk a parsed JSON-LD value (supporting arrays and @graph) and collect
 * paywall signals from SUPPORTED article nodes only:
 *
 *  - `isAccessibleForFree: false` on the article node
 *  - `hasPart` entries typed `PaywalledContent` belonging to the article node
 *
 * Identity scoping: a node is "matched" when its url/@id/mainEntityOfPage
 * corresponds to the canonical URL; "conflicting" when an identity is present
 * but differs; "unstated" when no identity is present (single-node pages are
 * treated as clearly related by the caller). WebPage-only metadata and
 * non-article nodes are ignored, but their children are still traversed so
 * `mainEntityOfPage`/`hasPart` article nodes are found.
 *
 * Bare objects without a supported Article type are never access evidence,
 * even when they declare `isAccessibleForFree: false`. Identity-less evidence
 * is allowed only for a supported Article node and is disambiguated by the
 * markup-level single-node rule below.
 *
 * Malformed input never throws.
 */
export function extractJsonLdPaywallSignalsFromValue(
  value: unknown,
  canonicalUrl: string | null | undefined,
): JsonLdPaywallSignalScan {
  const signals: JsonLdPaywallSignal[] = [];
  let articleNodeCount = 0;
  let conflictingNodeCount = 0;
  const canonicalIdentity = resolveCanonicalUrlIdentity(canonicalUrl);

  // A supplied but malformed current identity cannot safely establish either
  // a match or an identity-less relationship. Count supported nodes for
  // diagnostics, but return no access signals so the single-node compatibility
  // rule cannot turn malformed page context into paywall evidence.
  if (canonicalIdentity.state === "malformed") {
    const countArticleNodes = (node: unknown): number => {
      if (Array.isArray(node)) return node.reduce<number>((count, item) => count + countArticleNodes(item), 0);
      if (!node || typeof node !== "object") return 0;
      const record = node as Record<string, unknown>;
      const typeValue = record["@type"];
      const types = Array.isArray(typeValue) ? typeValue : [typeValue];
      const ownCount = types.some(
        (type) => typeof type === "string" && SUPPORTED_JSONLD_ARTICLE_TYPES.has(type.trim().toLowerCase()),
      ) ? 1 : 0;
      return ownCount + Object.values(record)
        .filter((child): child is object => Boolean(child) && typeof child === "object")
        .reduce<number>((count, child) => count + countArticleNodes(child), 0);
    };
    return {
      signals: [],
      articleNodeCount: countArticleNodes(value),
      conflictingNodeCount: 0,
    };
  }

  const canonicalHref = canonicalIdentity.href;
  const canonicalBase = canonicalUrl ?? null;

  const resolveState = (
    record: Record<string, unknown>,
    inherited: { url: string | null; matched: boolean } | null,
  ): { state: JsonLdNodeIdentityState; url: string | null } => {
    const url = pickIdentityUrl(record) ?? inherited?.url ?? null;
    if (url && canonicalHref) {
      return { state: normalizeUrlForCompare(url, canonicalBase) === canonicalHref ? "matched" : "conflicting", url };
    }
    if (inherited?.matched) return { state: "matched", url };
    return { state: "unstated", url };
  };

  const visit = (
    node: unknown,
    inherited: { url: string | null; matched: boolean } | null,
  ): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, inherited);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const typeNames = collectTypeNames(record);
    const isArticleType = typeNames.some((t) => SUPPORTED_JSONLD_ARTICLE_TYPES.has(t));
    const { state, url } = resolveState(record, inherited);

    if (isArticleType) {
      articleNodeCount += 1;
      if (state === "conflicting") conflictingNodeCount += 1;
      if (record["isAccessibleForFree"] === false) {
        signals.push({
          code: "isAccessibleForFree:false",
          nodeType: firstSupportedArticleTypeName(record) ?? "unknown",
          nodeIdentityState: state,
        });
      }
      // hasPart PaywalledContent entries inherit the article node's identity.
      const hasPart = record.hasPart;
      const parts = Array.isArray(hasPart) ? hasPart : hasPart ? [hasPart] : [];
      for (const part of parts) {
        if (part && typeof part === "object") {
          const partRecord = part as Record<string, unknown>;
          const partTypes = Array.isArray(partRecord["@type"])
            ? partRecord["@type"].map((t) => String(t).toLowerCase())
            : [String(partRecord["@type"] ?? "").toLowerCase()];
          if (partTypes.some((t) => t === "paywalledcontent")) {
            signals.push({ code: "PaywalledContent", nodeType: "PaywalledContent", nodeIdentityState: state });
          }
        }
      }
    }

    // Recurse into nested objects (including @graph arrays, mainEntityOfPage,
    // hasPart article/WebPage children). Identity propagates to descendants
    // without their own identity. WebPage-only metadata itself is ignored (no
    // signal emitted above), but its children are still traversed.
    for (const child of Object.values(record)) {
      if (child && typeof child === "object") {
        visit(child, { url, matched: state === "matched" });
      }
    }
  };

  visit(value, null);
  return { signals, articleNodeCount, conflictingNodeCount };
}

/**
 * Extract JSON-LD paywall signals from raw markup (used by the legacy
 * compatibility wrapper, which has no DOM). Script blocks are regex-extracted
 * and JSON-parsed safely; malformed blocks are skipped.
 */
export function extractJsonLdPaywallSignalsFromMarkup(
  markup: string | null | undefined,
  canonicalUrl: string | null | undefined = null,
): JsonLdPaywallSignal[] {
  const bounded = (markup ?? "").slice(0, 200_000);
  const signals: JsonLdPaywallSignal[] = [];
  let articleNodeCount = 0;
  let conflictingNodeCount = 0;
  const scriptPattern = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(bounded)) !== null) {
    const raw = match[1];
    if (!raw || raw.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const scan = extractJsonLdPaywallSignalsFromValue(parsed, canonicalUrl);
      signals.push(...scan.signals);
      articleNodeCount += scan.articleNodeCount;
      conflictingNodeCount += scan.conflictingNodeCount;
    } catch {
      // Malformed JSON-LD → skip; never crash, never classify from it.
    }
  }
  const hasMatched = signals.some((signal) => signal.nodeIdentityState === "matched");
  return signals
    .filter((signal) =>
      signal.nodeIdentityState === "matched"
      || (signal.nodeIdentityState === "unstated"
        && !hasMatched
        && articleNodeCount === 1
        && conflictingNodeCount === 0),
    )
    .slice(0, 8);
}

// ─── Classification decision ────────────────────────────────────────────────

const CLASSIFICATION_TO_IS_PAYWALL: Record<ArticleAccessClassification, boolean | null> = {
  ACCESSIBLE: false,
  PAYWALL_BLOCKED: true,
  // Metered or merely declared content is READABLE — it must never trigger
  // the blocking paywall UI. Its structured classification and evidence stay
  // available for Prompt 15B persistence/admin integration.
  METERED_OR_DECLARED: false,
  INTERSTITIAL_OR_CHALLENGE: null,
  HTTP_ACCESS_BLOCKED: null,
  UNKNOWN: null,
};

/**
 * Map a classification to the legacy `isPaywall` persistence/API compatibility
 * field. Public blocking UI must use the explicit structured
 * `accessClassification === "PAYWALL_BLOCKED"` contract instead; missing or
 * malformed classification must never fall back to `isPaywall=true`. The
 * boolean is distinct from the structured classification.
 */
export function mapClassificationToIsPaywall(
  classification: ArticleAccessClassification,
): boolean | null {
  return CLASSIFICATION_TO_IS_PAYWALL[classification];
}

/** Typed evidence entry factory (keeps literal polarity narrow in spreads/ternaries). */
function ev(
  code: string,
  detail: string | undefined,
  polarity: AccessEvidenceEntry["polarity"],
): AccessEvidenceEntry {
  return { code, detail, polarity };
}

function capEvidence(evidence: AccessEvidenceEntry[]): AccessEvidenceEntry[] {
  return evidence.slice(0, EVIDENCE_CAP).map((e) => ({
    ...e,
    detail: e.detail ? e.detail.slice(0, DETAIL_CAP) : undefined,
  }));
}

export function classifyArticleAccess(
  input: ArticleAccessClassificationInput,
): ArticleAccessClassificationResult {
  const raw = (input.rawPageText || "").slice(0, RAW_TEXT_BOUND);
  const challenge = dedupe(input.challengeTextSignals ?? matchChallengeTextPatterns(raw));
  const denied = matchHttpDeniedTextPatterns(raw);
  const adBlock = input.adBlockerWarningDetected ?? matchAdBlockerWarningPatterns(raw).length > 0;
  const topics = matchTopicWordPatterns(raw);
  const cta = dedupe(
    (input.articleScopedCtaTexts ?? []).flatMap((text) => matchArticleAccessCtaPatterns(text)),
  );
  // Defensively reject conflicting identities even when a caller bypasses the
  // raw-markup parser. Early-stage and Agent 3 callers pass only matched or
  // unambiguous identity-less signals, but unrelated JSON-LD must never become
  // a classification through a malformed integration boundary.
  const jsonLd = (input.jsonLdPaywallSignals ?? [])
    .filter((signal) => signal.nodeIdentityState !== "conflicting")
    .slice(0, 8);
  const scopedJsonLd = jsonLd.filter((s) => s.nodeIdentityState === "matched");
  const usable = input.usableBodyExtracted;
  const truncated = input.bodyTruncationDetected;
  const gate = input.articleScopedGateOrOverlayDetected;

  const finalize = (
    classification: ArticleAccessClassification,
    confidence: ArticleAccessConfidence,
    evidence: AccessEvidenceEntry[],
    contradicting: AccessEvidenceEntry[],
  ): ArticleAccessClassificationResult => {
    const evidenceArticleScoped = gate || cta.length > 0 || scopedJsonLd.length > 0;
    const decisive = classification !== "UNKNOWN" && confidence !== "LOW";
    return {
      classification,
      confidence,
      detectorVersion: ARTICLE_ACCESS_DETECTOR_VERSION,
      evidence: capEvidence(evidence),
      contradictingEvidence: capEvidence(contradicting),
      evidenceArticleScoped,
      usableBodyExtracted: usable,
      bodyTruncationDetected: truncated,
      articleScopedGateOrOverlayDetected: gate,
      isPaywall: mapClassificationToIsPaywall(classification),
      decisive,
    };
  };

  const topicEvidence = (): AccessEvidenceEntry[] =>
    topics.length ? [{ code: "topic_signals", detail: boundedDetail(topics), polarity: "blocking" }] : [];

  // (a) HTTP-level access block — never a paywall.
  if (input.statusCode === 401 || input.statusCode === 403) {
    return finalize("HTTP_ACCESS_BLOCKED", "HIGH", [
      { code: "http_status_blocked", detail: `HTTP ${input.statusCode}`, polarity: "blocking" },
    ], []);
  }

  // (b) Technical access failures with no usable article body — never a paywall.
  if (!usable && challenge.length > 0) {
    const evidence: AccessEvidenceEntry[] = [
      { code: "interstitial_challenge", detail: boundedDetail(challenge, 4), polarity: "blocking" },
      ...topicEvidence(),
    ];
    if (denied.length > 0) evidence.push({ code: "http_denied_text", detail: boundedDetail(denied, 3), polarity: "blocking" });
    return finalize("INTERSTITIAL_OR_CHALLENGE", challenge.length >= 2 ? "MEDIUM" : "LOW", evidence, []);
  }

  if (!usable && denied.length > 0) {
    return finalize("HTTP_ACCESS_BLOCKED", "MEDIUM", [
      { code: "http_denied_text", detail: boundedDetail(denied, 3), polarity: "blocking" },
      ...topicEvidence(),
    ], []);
  }

  // (c) Genuine paywall block: article-scoped CTA + missing/materially truncated body.
  if (!usable && cta.length > 0) {
    const evidence: AccessEvidenceEntry[] = [
      { code: "article_scoped_cta", detail: boundedDetail(cta, 4), polarity: "blocking" },
      ...topicEvidence(),
    ];
    if (gate) evidence.push({ code: "article_scoped_gate_or_overlay", polarity: "blocking" });
    if (truncated) evidence.push({ code: "body_truncation_detected", polarity: "blocking" });
    return finalize("PAYWALL_BLOCKED", gate || truncated ? "HIGH" : "MEDIUM", evidence, []);
  }

  // (d) Declared/metered structured metadata — even with a full body.
  //     Runtime access-block evidence (c) already took precedence.
  if (jsonLd.length > 0) {
    const evidence: AccessEvidenceEntry[] = [
      {
        code: "jsonld_declared_paywall",
        detail: boundedDetail(jsonLd.map((s) => `${s.code}@${s.nodeType}`), 4),
        polarity: "blocking",
      },
      ...topicEvidence(),
    ];
    if (gate && usable) {
      evidence.push({ code: "article_scoped_gate_or_overlay", polarity: "blocking" });
      return finalize("METERED_OR_DECLARED", "HIGH", evidence, []);
    }
    return finalize("METERED_OR_DECLARED", scopedJsonLd.length > 0 ? "MEDIUM" : "LOW", evidence, []);
  }

  // (e) Soft/metered runtime evidence with a full body — genuine article-specific
  //     restriction proven, but the article is still readable → METERED.
  if (usable && cta.length > 0) {
    const evidence: AccessEvidenceEntry[] = [
      { code: "article_scoped_cta", detail: boundedDetail(cta, 4), polarity: "blocking" },
      ...topicEvidence(),
    ];
    if (gate) evidence.push({ code: "article_scoped_gate_or_overlay", polarity: "blocking" });
    return finalize("METERED_OR_DECLARED", gate ? "HIGH" : "MEDIUM", evidence, []);
  }

  if (usable && gate) {
    return finalize("METERED_OR_DECLARED", "LOW", [
      { code: "article_scoped_gate_or_overlay", polarity: "blocking" },
      ...topicEvidence(),
    ], []);
  }

  // (f) Full usable body with no article-scoped restriction evidence → ACCESSIBLE.
  if (usable) {
    return finalize("ACCESSIBLE", "HIGH", [
      ev("usable_full_body_extracted", undefined, "supporting"),
    ], [
      ...topicEvidence(),
      ...(cta.length ? [ev("article_scoped_cta", boundedDetail(cta, 4), "blocking")] : []),
      ...(jsonLd.length ? [ev("jsonld_declared_paywall", boundedDetail(jsonLd.map((s) => s.code), 4), "blocking")] : []),
    ]);
  }

  // (g) Ad-blocker interstitial without an article-specific gate (no usable body).
  if (adBlock) {
    return finalize("INTERSTITIAL_OR_CHALLENGE", "LOW", [
      ev("ad_blocker_warning", undefined, "blocking"),
      ...topicEvidence(),
    ], []);
  }

  // (h) Article-scoped gate/overlay without readable CTA text (no body).
  if (gate) {
    return finalize("PAYWALL_BLOCKED", "LOW", [
      ev("article_scoped_gate_or_overlay", undefined, "blocking"),
      ...topicEvidence(),
    ], []);
  }

  // (i) Nothing decisive.
  return finalize("UNKNOWN", "LOW", [
    ...(input.bodyText && input.bodyText.trim().length > 0
      ? [ev("partial_body_without_evidence", undefined, "supporting")]
      : []),
    ...topicEvidence(),
  ], []);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
