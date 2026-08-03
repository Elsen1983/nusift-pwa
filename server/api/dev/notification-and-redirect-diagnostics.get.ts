import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import { inspectNotificationWorkflowMarkers } from "../../utils/news-pipeline/notification-workflow-reconciliation";
import { sanitizeRedirectUrl } from "../../utils/news-pipeline/redirect-retry-state";

const MAX_ARTIFACTS = 100;
const bounded = (value: unknown, max = 300): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  ? Math.max(0, Math.min(1_000_000, Math.round(value)))
  : 0;

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "notification-redirect-diagnostics", 10, 60 * 1000);

  const artifacts = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: {
        in: ["agent1_redirect_retry", "agent1_target_outcome", "rss_candidates", "article_discovery_headless_required"],
      },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ARTIFACTS,
    select: { id: true, artifactType: true, status: true, sourceId: true, categoryId: true, createdAt: true, payload: true },
  });

  const discoveryLogs = await prisma.agentScanLog.findMany({
    where: {
      status: { in: ["ARTICLE_DISCOVERY_TARGETS_RESOLVED", "ARTICLE_DISCOVERY_TARGET_SKIPPED", "ARTICLE_DISCOVERY_CATEGORY_TARGETS_AUDIT"] },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { status: true, errorLog: true, createdAt: true },
  });

  const redirects = artifacts
    .filter((artifact) => artifact.artifactType === "agent1_redirect_retry")
    .slice(0, 25)
    .map((artifact) => {
      const payload = artifact.payload && typeof artifact.payload === "object" && !Array.isArray(artifact.payload)
        ? artifact.payload as Record<string, unknown>
        : {};
      return {
        id: artifact.id,
        sourceId: artifact.sourceId,
        categoryId: artifact.categoryId,
        status: artifact.status,
        originalUrl: typeof payload.normalizedUrl === "string" ? sanitizeRedirectUrl(payload.normalizedUrl) : null,
        finalUrl: typeof payload.finalUrl === "string" ? sanitizeRedirectUrl(payload.finalUrl) : null,
        urlHash: bounded(payload.urlHash, 64),
        failureKind: bounded(payload.failureKind, 40),
        redirectCount: count(payload.redirectCount),
        attemptCount: count(payload.attemptCount),
        nextRetryAt: bounded(payload.nextRetryAt, 40),
        terminalAt: bounded(payload.terminalAt, 40),
        httpStatus: typeof payload.httpStatus === "number" ? payload.httpStatus : null,
        retryAfterMs: typeof payload.retryAfterMs === "number" ? Math.min(3_600_000, Math.max(0, Math.round(payload.retryAfterMs))) : null,
        createdAt: artifact.createdAt.toISOString(),
      };
    });

  const rssSkipReasons: Record<string, number> = {};
  for (const artifact of artifacts.filter((item) => item.artifactType === "agent1_target_outcome")) {
    const payload = artifact.payload && typeof artifact.payload === "object" && !Array.isArray(artifact.payload)
      ? artifact.payload as Record<string, unknown>
      : {};
    const reason = bounded(payload.failureReason, 100) || bounded(payload.redirectRetryAt, 40) || artifact.status;
    rssSkipReasons[reason] = (rssSkipReasons[reason] || 0) + 1;
  }
  // Agent 2 ownership decisions are persisted as bounded log summaries. Parse
  // only the known `reasons=` / `sample=` JSON fragments; never expose raw log
  // bodies or target payloads through this diagnostics endpoint.
  for (const log of discoveryLogs) {
    const reasonsMatch = log.errorLog?.match(/reasons=(\{[^}]{1,1200}\})/);
    const escalationsMatch = log.errorLog?.match(/escalations=(\{[^}]{1,800}\})/);
    if (escalationsMatch?.[1]) {
      try {
        const escalations = JSON.parse(escalationsMatch[1]) as Record<string, unknown>;
        for (const [reason, value] of Object.entries(escalations)) {
          if (!/^(rss_owned_invalid_feed|rss_owned_scope_mismatch|rss_owned_repeatedly_non_productive)$/.test(reason)) continue;
          rssSkipReasons[reason] = Math.min(1_000_000, (rssSkipReasons[reason] || 0) + count(value));
        }
      } catch {
        // Malformed diagnostics remain safely omitted.
      }
    }
    if (reasonsMatch?.[1]) {
      try {
        const reasons = JSON.parse(reasonsMatch[1]) as Record<string, unknown>;
        for (const [reason, value] of Object.entries(reasons)) {
          if (!/^(rss_owned_productive|rss_owned_waiting_evidence|rss_active_productive|rss_active_waiting_for_second_nonproductive_run|rss_pending_discovery|unsupported_status)$/.test(reason)) continue;
          rssSkipReasons[reason] = Math.min(1_000_000, (rssSkipReasons[reason] || 0) + count(value));
        }
      } catch {
        // Malformed diagnostics remain safely omitted.
      }
    }
    const sampleMatch = log.errorLog?.match(/skipReason":"([a-z0-9_]{1,80})"/g) || [];
    for (const token of sampleMatch) {
      const reason = token.slice(token.indexOf("\\\":\\\"") + 5, -1);
      if (/^rss_owned_(productive|waiting_evidence)$/.test(reason)) {
        rssSkipReasons[reason] = Math.min(1_000_000, (rssSkipReasons[reason] || 0) + 1);
      }
    }
  }

  const browserStatuses: Record<string, number> = {};
  for (const artifact of artifacts.filter((item) => item.artifactType === "article_discovery_headless_required")) {
    const payload = artifact.payload && typeof artifact.payload === "object" && !Array.isArray(artifact.payload)
      ? artifact.payload as Record<string, unknown>
      : {};
    const status = bounded(payload.browserStatus, 60) || artifact.status;
    browserStatuses[status] = (browserStatuses[status] || 0) + 1;
  }

  return {
    ok: true,
    notifications: { markers: await inspectNotificationWorkflowMarkers() },
    redirects,
    rssSkipReasons,
    rssOwnership: {
      productiveSkip: rssSkipReasons.rss_owned_productive || 0,
      waitingForEvidenceSkip: rssSkipReasons.rss_owned_waiting_evidence || 0,
      invalidFeedEscalation: (rssSkipReasons.rss_owned_invalid_feed || 0) + (rssSkipReasons.rss_owned_repeatedly_non_productive || 0),
      scopeMismatchEscalation: rssSkipReasons.rss_owned_scope_mismatch || 0,
      explicitAdminBypass: "targeted requests only",
    },
    browserStatuses,
    bounded: true,
  };
});
