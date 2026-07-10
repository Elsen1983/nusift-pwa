export type ProcessingStatus = "PENDING" | "SUCCESS" | "SKIPPED" | "FAILED";

export interface IngestCandidateProvenance {
  origin: "rss" | "atom" | "json" | "html_fallback";
  feedUrl?: string | null;
  feedFormat?: "rss" | "atom" | "json" | "unknown" | null;
  discoveredFromCategoryFeed?: boolean;
  sourcePageUrl?: string | null;
  fetchedAt: string;
}

export interface IngestRejectedItem {
  reason:
    | "empty_link"
    | "out_of_scope"
    | "stale_or_missing_published_at"
    | "already_seen_feed_item"
    | "html_fallback_non_article"
    | "html_fallback_stale";
  rawLink?: string | null;
  canonicalUrl?: string | null;
  title?: string | null;
  publishedAt?: string | null;
}

export interface IngestSkipSummary {
  emptyLink: number;
  outOfScope: number;
  staleOrMissingPublishedAt: number;
  alreadySeenFeedItem: number;
  htmlFallbackNonArticle: number;
  htmlFallbackStale: number;
}

export type ScopeMatch = "exact" | "probable" | "generic" | "unrelated";

/**
 * Structured taxonomy/section evidence extracted from page HTML.
 * Used to generate scoped feed candidates and boost scoring for
 * candidates that align with the target category/section.
 */
export type TaxonomyEvidence = {
  sectionIds: string[];
  tagIds: string[];
  categorySlugs: string[];
  collectionIds: string[];
  routeNames: string[];
  canonicalSectionHandles: string[];
  feedParams: string[];
  matchedFeedUrls: string[];
  /** Present only when the feed was found via directory-traversal fallback. */
  directoryTraversal?: {
    traversedUrl: string;
    matchedLabel: string;
    candidateCount: number;
  };
  /** Locale/edition hints extracted from page metadata (og:locale, html lang, JSON-LD inLanguage). */
  localeHints: string[];
  /** hreflang locale codes extracted from <link rel="alternate" hreflang="..."> tags. */
  hreflangLocales: string[];
  /** Edition/locale-scoped URL paths extracted from hreflang links and edition navigation. */
  editionPaths: string[];
  /** Country names detected from edition/locale labels or hreflang-derived metadata. */
  countryHints?: string[];
  /** ISO 3166-1 alpha-2 country codes detected from edition/locale signals. */
  countryCodes?: string[];
  /** Canonical feed identity derived from canonicalFeedKey(). Persists the normalised feed URL key so downstream tooling can recognise when two different-looking feed URLs are the same feed. */
  canonicalIdentity?: string | null;
};

export interface HardCaseDiscoveryCandidate {
  targetType: "source" | "category";
  sourceId: string;
  categoryId?: string | null;
  targetUrl: string;
  existingFeedUrl?: string | null;
  queueReason:
    | "no_feed_discovered"
    | "candidate_verification_failed"
    | "blocked_or_fetch_failed";
  discovery: {
    feedUrl: string | null;
    discoveredVia: string | null;
    detection: string;
    score: number;
    scopeConfidence: string;
    scopeMatch?: ScopeMatch;
    taxonomyEvidence?: TaxonomyEvidence;
    canonicalIdentity?: string | null;
    topCandidates: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      scopeMatch?: ScopeMatch;
      taxonomyEvidence?: TaxonomyEvidence;
      canonicalIdentity?: string | null;
    }>;
    rejectedCandidates: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      reason: string;
      scopeMatch?: ScopeMatch;
      taxonomyEvidence?: TaxonomyEvidence;
      canonicalIdentity?: string | null;
    }>;
    lastError?: string;
  };
}

/** Candidate in a discovery result summary (canonical shared contract). */
export type DiscoverySummaryCandidate = {
  feedUrl: string;
  detection: string;
  score: number;
  contentType?: string | null;
  scopeMatch: ScopeMatch;
  /** Canonical feed identity for this candidate, derived from canonicalFeedKey(). */
  canonicalIdentity?: string | null;
};

/** Rejected candidate from discovery verification. */
export type RejectedDiscoveryCandidate = DiscoverySummaryCandidate & {
  reason: string;
};

/**
 * Canonical discovery result contract returned by feed discovery functions.
 * Shared by feed-discovery.ts, hard-case-consumer.ts, and ingest.ts.
 */
export type FeedDiscoveryResult = {
  feedUrl: string | null;
  discoveredVia: string | null;
  detection: string;
  contentType?: string | null;
  score: number;
  scopeConfidence: "high" | "medium" | "low";
  scopeMatch: ScopeMatch;
  taxonomyEvidence: TaxonomyEvidence;
  topCandidates: DiscoverySummaryCandidate[];
  rejectedCandidates: RejectedDiscoveryCandidate[];
  lastError?: string;
  /** Canonical feed identity for the resolved feedUrl, derived from canonicalFeedKey(). Present when a feed was discovered. */
  canonicalIdentity?: string | null;
};

export interface IngestCandidate {
  sourceId: string;
  categoryId?: string | null;
  sourceUrl: string;
  canonicalUrl: string;
  rssGuid?: string | null;
  rawTitle?: string | null;
  title: string;
  publishedAt?: Date | null;
  rawBodyText?: string | null;
  bodyText?: string | null;
  contentHash: string;
  isPaywall: boolean;
  rawTags: string[];
  rawSignals: string[];
  reasoning: string;
  provenance: IngestCandidateProvenance;
  normalizationFlags?: string[];
}

export interface IngestResult {
  sourceId: string;
  categoryId?: string | null;
  candidates: IngestCandidate[];
  failed: number;
  feedUrl?: string | null;
  feedFormat?: "rss" | "atom" | "json" | "html_fallback" | "unknown" | null;
  skipSummary: IngestSkipSummary;
  rejectedItems: IngestRejectedItem[];
  hardCaseQueueCandidates?: HardCaseDiscoveryCandidate[];
}

export interface PipelineTarget {
  sourceId: string;
  categoryId?: string | null;
}

export interface PipelineResult {
  sourcesScanned: number;
  candidatesFound: number;
  inserted: number;
  skipped: number;
  failed: number;
  artifactCount?: number;
}
