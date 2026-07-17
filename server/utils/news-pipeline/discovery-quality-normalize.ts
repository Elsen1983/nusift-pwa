/**
 * Normalizes a raw PipelineArtifact row into a compact discovery quality item
 * for the admin dashboard. Handles both article_discovery_candidates and
 * article_discovery_headless_required artifact shapes.
 */

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
  escalationReasons: string[];
  explanation: string | null;
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
    shouldEscalateToHeadless:
      artifact.artifactType === "article_discovery_headless_required"
        ? true
        : "shouldEscalateToHeadless" in qualityAssessment
          ? Boolean(qualityAssessment.shouldEscalateToHeadless)
          : false,
    escalationReasons:
      (qualityAssessment.escalationReasons as string[]) ||
      (payload.escalationReasons as string[]) ||
      [],
    explanation:
      (qualityAssessment.explanation as string) ||
      (payload.explanation as string) ||
      null,
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
