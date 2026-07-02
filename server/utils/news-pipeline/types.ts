export type ProcessingStatus = "PENDING" | "SUCCESS" | "SKIPPED" | "FAILED";

export interface IngestCandidate {
  sourceId: string;
  sourceUrl: string;
  canonicalUrl: string;
  rssGuid?: string | null;
  title: string;
  publishedAt?: Date | null;
  bodyText?: string | null;
  contentHash: string;
  isPaywall: boolean;
  rawTags: string[];
  rawSignals: string[];
  reasoning: string;
}

export interface PipelineResult {
  sourcesScanned: number;
  candidatesFound: number;
  inserted: number;
  skipped: number;
  failed: number;
}
