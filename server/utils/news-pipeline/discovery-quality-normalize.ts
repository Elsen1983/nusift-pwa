/**
 * Normalizes a raw PipelineArtifact row into a compact discovery quality item
 * for the admin dashboard. Handles both article_discovery_candidates and
 * article_discovery_headless_required artifact shapes.
 */

export type DiscoveryQualityStaleSample = {
  url: string;
  normalizedPublishedAt: string | null;
  publishedAtSource: string | null;
  ageDays: number | null;
  staleReason: string | null;
};

export type NormalizedDiscoveryQualityItem = {
  id: string;
  createdAt: Date;
  sourceId: string | null;
  categoryId: string | null;
  artifactType: string;
  status: string;
  candidateCount: number | null;
  targetUrl: string | null;
  quality: string | null;
  confidence: string | null;
  shouldEscalateToHeadless: boolean;
  headlessState: "active" | "history" | "recommended" | "none";
  headlessStatus: string | null;
  escalationReasons: string[];
  explanation: string | null;
  staleSamples: DiscoveryQualityStaleSample[];
  dateAnomalySamples: DiscoveryQualityStaleSample[];
  outcomeSummary: {
    totalEvaluated: number;
    accepted: number;
    rejected: number;
    byStatus: Record<string, number>;
    topRejectionReasons: Array<{ reason: string; count: number }>;
  };
  discoverySources: {
    listingPages: number;
    sitemapUrls: number;
    jsonldUrls: number;
  };
};

/**
 * Keep one current diagnostic per logical target. Historical RSS-first and
 * resolved markers remain in PipelineArtifact, but showing them next to the
 * current candidate or queue state makes the dashboard look like duplicate work.
 */
export function collapseDiscoveryQualityItems(
  items: readonly NormalizedDiscoveryQualityItem[],
): NormalizedDiscoveryQualityItem[] {
  const priority = (item: NormalizedDiscoveryQualityItem): number => {
    if (item.headlessState === "active") return 4;
    if (item.headlessState === "recommended") return 3;
    if (item.headlessState === "none") return 2;
    return 1;
  };
  const normalizeTargetKey = (value: string | null): string | null => {
    if (!value) return null;
    try {
      const url = new URL(value);
      url.hash = "";
      url.search = "";
      url.hostname = url.hostname.toLowerCase();
      if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
      return url.toString();
    } catch {
      return value.trim().replace(/\/+$/, "") || null;
    }
  };
  const keyFor = (item: NormalizedDiscoveryQualityItem): string =>
    `${item.sourceId ?? ""}:${item.categoryId ?? ""}:${normalizeTargetKey(item.targetUrl) ?? item.id}`;
  const selected = new Map<string, NormalizedDiscoveryQualityItem>();

  for (const item of items) {
    const key = keyFor(item);
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, item);
      continue;
    }
    const priorityDelta = priority(item) - priority(existing);
    if (
      priorityDelta > 0 ||
      (priorityDelta === 0 && (
        item.createdAt.getTime() > existing.createdAt.getTime() ||
        (item.createdAt.getTime() === existing.createdAt.getTime() && item.id > existing.id)
      ))
    ) {
      selected.set(key, item);
    }
  }

  return [...selected.values()].sort((left, right) =>
    right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
  );
}

const MAX_STALE_SAMPLES = 3;
const HISTORICAL_HEADLESS_STATUSES = new Set([
  "RESOLVED",
  "RESOLVED_BY_STATIC_DISCOVERY",
  "RESOLVED_BY_AGENT1_RSS",
  "SKIPPED_BY_FEED_FIRST_POLICY",
  "BROWSER_FALLBACK_DISABLED",
]);

function collectStaleSamplesFromRejected(
  rejectedCandidates: unknown,
  samples: DiscoveryQualityStaleSample[],
): void {
  if (!Array.isArray(rejectedCandidates)) return;
  for (const entry of rejectedCandidates) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (e.status !== "rejected_stale") continue;
    if (typeof e.staleReason !== "string") continue;

    samples.push({
      url: typeof e.url === "string" ? e.url : "",
      normalizedPublishedAt: typeof e.normalizedPublishedAt === "string" ? e.normalizedPublishedAt : null,
      publishedAtSource: typeof e.publishedAtSource === "string" ? e.publishedAtSource : null,
      ageDays: typeof e.ageDays === "number" && Number.isFinite(e.ageDays) ? e.ageDays : null,
      staleReason: e.staleReason,
    });

    if (samples.length >= MAX_STALE_SAMPLES) break;
  }
}

/**
 * Extract up to 3 compact stale/date anomaly samples from static and browser
 * rejected outcomes in the payload. Only includes entries with staleReason
 * audit metadata. Returns [] when absent.
 */
function extractStaleSamples(...rejectedOutcomeSources: unknown[]): DiscoveryQualityStaleSample[] {
  const samples: DiscoveryQualityStaleSample[] = [];
  for (const source of rejectedOutcomeSources) {
    collectStaleSamplesFromRejected(source, samples);
    if (samples.length >= MAX_STALE_SAMPLES) break;
  }
  return samples;
}

function extractDateAnomalySamples(browserRejectedOutcomes: unknown): DiscoveryQualityStaleSample[] {
  const allBrowserSamples = extractStaleSamples(browserRejectedOutcomes);
  return allBrowserSamples.filter((sample) =>
    sample.staleReason === "future_published_at" ||
    sample.staleReason === "invalid_published_at" ||
    sample.staleReason === "missing_published_at",
  );
}

export function normalizeDiscoveryQualityArtifact(artifact: {
  id: string;
  createdAt: Date;
  sourceId: string | null;
  categoryId: string | null;
  artifactType: string;
  status: string;
  candidateCount: number | null;
  payload: unknown;
}): NormalizedDiscoveryQualityItem {
  const payload = (artifact.payload as Record<string, unknown>) || {};
  const qualityAssessment = (payload.qualityAssessment as Record<string, unknown>) || {};
  const outcomeSummary = (payload.outcomeSummary as Record<string, unknown>) || {};
  const discoverySources = payload.discoverySources as Record<string, unknown> | undefined;
  const isHeadlessMarker = artifact.artifactType === "article_discovery_headless_required";
  const candidateRecommendsHeadless = "shouldEscalateToHeadless" in qualityAssessment
    ? Boolean(qualityAssessment.shouldEscalateToHeadless)
    : false;
  const headlessState: NormalizedDiscoveryQualityItem["headlessState"] = isHeadlessMarker
    ? HISTORICAL_HEADLESS_STATUSES.has(artifact.status) ? "history" : "active"
    : candidateRecommendsHeadless ? "recommended" : "none";

  return {
    id: artifact.id,
    createdAt: artifact.createdAt,
    sourceId: artifact.sourceId,
    categoryId: artifact.categoryId,
    artifactType: artifact.artifactType,
    status: artifact.status,
    candidateCount: artifact.candidateCount,
    targetUrl: (payload.targetUrl as string) || null,
    quality: (qualityAssessment.quality as string) || (payload.quality as string) || null,
    confidence: (qualityAssessment.confidence as string) || null,
    // Headless markers always escalate; candidates use nested value or default to false
    shouldEscalateToHeadless: headlessState === "active" || headlessState === "recommended",
    headlessState,
    headlessStatus: isHeadlessMarker ? artifact.status : null,
    escalationReasons:
      (qualityAssessment.escalationReasons as string[]) ||
      (payload.escalationReasons as string[]) ||
      [],
    explanation:
      (qualityAssessment.explanation as string) ||
      (payload.explanation as string) ||
      null,
    staleSamples: extractStaleSamples(payload.rejectedCandidates, payload.browserRejectedOutcomes),
    dateAnomalySamples: extractDateAnomalySamples(payload.browserRejectedOutcomes),
    outcomeSummary: {
      totalEvaluated: (outcomeSummary.totalEvaluated as number) ?? 0,
      accepted: (outcomeSummary.accepted as number) ?? 0,
      rejected: (outcomeSummary.rejected as number) ?? 0,
      byStatus: (outcomeSummary.byStatus as Record<string, number>) || {},
      topRejectionReasons:
        (outcomeSummary.topRejectionReasons as Array<{ reason: string; count: number }>) ||
        [],
    },
    discoverySources: (discoverySources as NormalizedDiscoveryQualityItem["discoverySources"]) || {
      listingPages: 0,
      sitemapUrls: 0,
      jsonldUrls: 0,
    },
  };
}
