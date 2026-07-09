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
    topCandidates: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      scopeMatch?: ScopeMatch;
      taxonomyEvidence?: TaxonomyEvidence;
    }>;
    rejectedCandidates: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      reason: string;
      scopeMatch?: ScopeMatch;
      taxonomyEvidence?: TaxonomyEvidence;
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
