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
  htmlFallbackNonArticle: number;
  htmlFallbackStale: number;
}

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
    discoveredVia?: string | null;
    detection: string;
    score?: number;
    scopeConfidence?: string;
    topCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
    }>;
    rejectedCandidates?: Array<{
      feedUrl: string;
      detection: string;
      score: number;
      contentType?: string | null;
      reason: string;
    }>;
    lastError?: string;
  };
}

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
