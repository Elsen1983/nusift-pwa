/**
 * Agent 2 headless fallback queue consumer.
 *
 * Inspects and marks pending headless fallback artifacts. When browser
 * fallback is enabled (runBrowser=true + NUXT_ENABLE_AGENT2_BROWSER_FALLBACK),
 * attempts Playwright-based article discovery for valid artifacts.
 *
 * Otherwise marks artifacts as SKIPPED_UNIMPLEMENTED (safe default).
 */

import { prisma } from "../prisma";
import { logAgentScan } from "./log";
import { isBrowserFallbackEnabled, discoverArticleLinksWithBrowser, evaluateArticleLinkCandidateWithBrowser } from "./article-discovery-browser";
import {
  evaluateArticleLinkCandidate,
  ArticleDiscoveryOutcomeTracker,
  assessArticleDiscoveryQuality,
  type ArticleDiscoveryCandidateOutcome,
} from "./article-discovery-helpers";
import { persistCandidates } from "./ingest";
import type { IngestCandidate } from "./types";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
const MAX_BROWSER_LIMIT = 3;
const MAX_BROWSER_DETAIL_EVALUATED_LINKS = 10;
const MAX_BROWSER_ACCEPTED_CANDIDATES = 10;

type HeadlessQueueInput = {
  limit?: number;
  dryRun?: boolean;
  runBrowser?: boolean;
};

type HeadlessQueueArtifact = {
  id: string;
  sourceId: string | null;
  categoryId: string | null;
  createdAt: Date;
  payload: Record<string, unknown>;
};

type HeadlessQueueDryRunResult = {
  dryRun: true;
  inspected: number;
  wouldProcess: number;
  skippedInvalid: number;
  skippedAlreadyClaimed: number;
  artifacts: Array<{
    id: string;
    sourceId: string | null;
    categoryId: string | null;
    targetUrl: string | null;
    quality: string | null;
    escalationReasons: string[];
    valid: boolean;
    invalidReason?: string;
  }>;
};

type HeadlessQueueProcessResult = {
  dryRun: false;
  processed: number;
  skippedInvalid: number;
  skippedAlreadyClaimed: number;
  updatedArtifactIds: string[];
  // Browser-specific counters (when runBrowser=true)
  claimed?: number;
  browserProcessed?: number;
  browserResolved?: number;
  browserNoCandidates?: number;
  browserSkippedDisabled?: number;
  browserSkippedUnavailable?: number;
  browserFailed?: number;
  browserCandidatesFound?: number;
  browserCandidatesPersisted?: { inserted: number; skipped: number; failed: number };
};

export type HeadlessQueueResult = HeadlessQueueDryRunResult | HeadlessQueueProcessResult;

/**
 * Validate that an artifact payload has the minimum fields needed for
 * headless processing.
 */
function isValidHeadlessArtifact(payload: Record<string, unknown>): { valid: boolean; reason?: string } {
  const targetUrl = payload.targetUrl;
  const sourceId = payload.sourceId;

  if (!targetUrl || typeof targetUrl !== "string") {
    return { valid: false, reason: "missing targetUrl" };
  }
  if (!sourceId || typeof sourceId !== "string") {
    return { valid: false, reason: "missing sourceId" };
  }
  return { valid: true };
}

/**
 * Extract compact payload fields from a raw artifact payload.
 */
function extractPayloadFields(payload: Record<string, unknown>) {
  return {
    targetUrl: (payload.targetUrl as string) || null,
    quality: (payload.quality as string) || null,
    escalationReasons: (payload.escalationReasons as string[]) || [],
    outcomeSummary: payload.outcomeSummary || null,
    discoverySources: payload.discoverySources || null,
  };
}

/**
 * Process the pending headless fallback queue.
 *
 * - Finds recent PENDING_HEADLESS artifacts, ordered by createdAt ascending.
 * - In dry-run mode: reports which artifacts would be processed without DB changes.
 * - In non-dry-run mode without runBrowser: marks artifacts as SKIPPED_UNIMPLEMENTED.
 * - In non-dry-run mode with runBrowser: attempts Playwright-based article discovery
 *   for valid artifacts, persists candidates, and updates artifact statuses.
 *
 * @param input.limit - Max artifacts to inspect (default 5, max 25; max 3 for browser)
 * @param input.dryRun - If true, do not modify DB (default true for safety)
 * @param input.runBrowser - If true, attempt browser fallback (requires env flag)
 */
export async function processArticleDiscoveryHeadlessQueue(
  input?: HeadlessQueueInput,
): Promise<HeadlessQueueResult> {
  const runBrowser = input?.runBrowser === true;
  const maxLimit = runBrowser ? MAX_BROWSER_LIMIT : MAX_LIMIT;
  const limit = Math.min(Math.max(input?.limit ?? DEFAULT_LIMIT, 1), maxLimit);
  const dryRun = input?.dryRun !== false; // default to dry-run for safety

  const startedAt = Date.now();

  await logAgentScan({
    status: "ARTICLE_DISCOVERY_HEADLESS_QUEUE_STARTED",
    executionTimeMs: 0,
    errorLog: `Headless queue ${dryRun ? "inspection" : "processing"} started. limit=${limit}, dryRun=${dryRun}, runBrowser=${runBrowser}.`,
  });

  const artifacts = await prisma.pipelineArtifact.findMany({
    where: {
      artifactType: "article_discovery_headless_required",
      status: "PENDING_HEADLESS",
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      sourceId: true,
      categoryId: true,
      createdAt: true,
      payload: true,
    },
  });

  const items: HeadlessQueueArtifact[] = artifacts.map((a) => ({
    id: a.id,
    sourceId: a.sourceId,
    categoryId: a.categoryId,
    createdAt: a.createdAt,
    payload: (a.payload as Record<string, unknown>) || {},
  }));

  // ── Dry-run mode ─────────────────────────────────────────────────────
  if (dryRun) {
    const artifactDetails = items.map((item) => {
      const fields = extractPayloadFields(item.payload);
      const validation = isValidHeadlessArtifact(item.payload);
      return {
        id: item.id,
        sourceId: item.sourceId,
        categoryId: item.categoryId,
        targetUrl: fields.targetUrl,
        quality: fields.quality,
        escalationReasons: fields.escalationReasons,
        valid: validation.valid,
        invalidReason: validation.reason,
      };
    });

    const wouldProcess = artifactDetails.filter((a) => a.valid).length;
    const skippedInvalid = artifactDetails.filter((a) => !a.valid).length;

    await logAgentScan({
      status: "ARTICLE_DISCOVERY_HEADLESS_QUEUE_FINISHED",
      executionTimeMs: Date.now() - startedAt,
      errorLog: `Headless queue dry-run complete. inspected=${items.length}, wouldProcess=${wouldProcess}, skippedInvalid=${skippedInvalid}, runBrowser=${runBrowser}.`,
    });

    return {
      dryRun: true,
      inspected: items.length,
      wouldProcess,
      skippedInvalid,
      skippedAlreadyClaimed: 0,
      artifacts: artifactDetails,
    };
  }

  // ── Non-dry-run mode ─────────────────────────────────────────────────
  let processed = 0;
  let skippedInvalid = 0;
  let skippedAlreadyClaimed = 0;
  const updatedArtifactIds: string[] = [];

  // Browser-specific counters
  let browserProcessed = 0;
  let browserResolved = 0;
  let browserNoCandidates = 0;
  let browserSkippedDisabled = 0;
  let browserSkippedUnavailable = 0;
  let browserFailed = 0;
  let browserCandidatesFound = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const item of items) {
    const validation = isValidHeadlessArtifact(item.payload);

    if (!validation.valid) {
      // Mark invalid artifacts so they are not retried — compare-and-set
      const { count } = await prisma.pipelineArtifact.updateMany({
        where: {
          id: item.id,
          artifactType: "article_discovery_headless_required",
          status: "PENDING_HEADLESS",
        },
        data: {
          status: "INVALID",
          errorLog: `Invalid headless artifact: ${validation.reason}.`,
        },
      });
      if (count === 0) {
        skippedAlreadyClaimed += 1;
      } else {
        skippedInvalid += 1;
        updatedArtifactIds.push(item.id);
      }
      continue;
    }

    const fields = extractPayloadFields(item.payload);
    const targetUrl = fields.targetUrl!;
    const sourceId = (item.payload.sourceId as string) || item.sourceId;

    // ── Browser fallback path ──────────────────────────────────────────
    if (runBrowser) {
      // Env disabled: mark without claiming (no expensive work)
      if (!isBrowserFallbackEnabled()) {
        browserSkippedDisabled += 1;

        const { count } = await prisma.pipelineArtifact.updateMany({
          where: {
            id: item.id,
            artifactType: "article_discovery_headless_required",
            status: "PENDING_HEADLESS",
          },
          data: {
            status: "BROWSER_FALLBACK_DISABLED",
            errorLog: "NUXT_ENABLE_AGENT2_BROWSER_FALLBACK is not enabled.",
          },
        });
        if (count === 0) {
          skippedAlreadyClaimed += 1;
        } else {
          updatedArtifactIds.push(item.id);
        }
        continue;
      }

      // ── Claim artifact before expensive browser work ───────────────
      // Atomically transition PENDING_HEADLESS → HEADLESS_PROCESSING
      // so concurrent queue runs cannot duplicate browser work.
      const claimed = await prisma.pipelineArtifact.updateMany({
        where: {
          id: item.id,
          artifactType: "article_discovery_headless_required",
          status: "PENDING_HEADLESS",
        },
        data: {
          status: "HEADLESS_PROCESSING",
          payload: {
            ...item.payload,
            headlessProcessingStartedAt: new Date().toISOString(),
            headlessProcessingMode: "browser",
          },
        },
      });

      if (claimed.count === 0) {
        skippedAlreadyClaimed += 1;
        await logAgentScan({
          sourceId: item.sourceId,
          categoryId: item.categoryId || undefined,
          status: "ARTICLE_DISCOVERY_HEADLESS_SKIPPED",
          executionTimeMs: 0,
          errorLog: `Artifact ${item.id} already claimed by another worker. Skipping.`,
        });
        continue;
      }

      updatedArtifactIds.push(item.id);

      // ── Run browser work on claimed artifact ──────────────────────
      await logAgentScan({
        sourceId: item.sourceId,
        categoryId: item.categoryId || undefined,
        status: "ARTICLE_DISCOVERY_BROWSER_STARTED",
        executionTimeMs: 0,
        errorLog: `Browser fallback started for artifact ${item.id}. targetUrl=${targetUrl}, quality=${fields.quality}.`,
      });

      const claimedPayload = {
        ...item.payload,
        headlessProcessingStartedAt: new Date().toISOString(),
        headlessProcessingMode: "browser",
      };

      let browserResult;
      try {
        browserResult = await discoverArticleLinksWithBrowser({
          targetUrl,
          sourceId: sourceId!,
          categoryId: item.categoryId,
          targetType: item.categoryId ? "category" : "source",
          categoryPathUrl: item.categoryId ? targetUrl : null,
        });
      } catch (error: any) {
        browserResult = {
          ok: false,
          reason: "browser_error",
          links: [],
          diagnostics: {
            pageTitle: null,
            linkCount: 0,
            articleLikeLinkCount: 0,
            blockedReason: error?.message || String(error),
            browserRuntimeAvailable: true,
            elapsedMs: 0,
          },
        };
      }

      if (!browserResult.ok) {
        // Semantics note: the spec defines BROWSER_NO_CANDIDATES as "browser
        // ran but no valid article candidates survived evaluation". Here we
        // also map navigation_failed / http_error / browser_error to the
        // same status. This is an intentional compromise given the
        // constrained status set — there is no dedicated status for
        // navigation/HTTP errors. The precise failure reason is preserved
        // in browserError + browserDiagnostics.blockedReason so the admin
        // can distinguish "page did not load" from "page loaded but had no
        // article links". Only runtime-unavailable gets its own status
        // (BROWSER_RUNTIME_UNAVAILABLE) because it implies a setup gap,
        // not a per-target failure.
        const status = browserResult.reason === "browser_runtime_unavailable"
          ? "BROWSER_RUNTIME_UNAVAILABLE"
          : "BROWSER_NO_CANDIDATES";

        if (browserResult.reason === "browser_runtime_unavailable") {
          browserSkippedUnavailable += 1;
        } else {
          browserFailed += 1;
        }

        // Transition from HEADLESS_PROCESSING → final failure status.
        // Preserve the same compact browser metadata shape as the success
        // path so the admin normalizer can consume both uniformly.
        const failedFinishedAt = new Date().toISOString();
        await prisma.pipelineArtifact.updateMany({
          where: {
            id: item.id,
            artifactType: "article_discovery_headless_required",
            status: "HEADLESS_PROCESSING",
          },
          data: {
            status,
            errorLog: `Browser fallback failed: ${browserResult.reason}. ${browserResult.diagnostics.blockedReason || ""}`,
            payload: {
              ...claimedPayload,
              // ── Compact browser fallback result metadata ──────────────
              browserFallbackRan: true,
              browserFallbackStartedAt: claimedPayload.headlessProcessingStartedAt,
              browserFallbackFinishedAt: failedFinishedAt,
              // linkCount is always a number on the browser result type;
              // for failures it reflects whatever the resolver observed.
              browserRawLinks: browserResult.rawLinkCount ?? browserResult.diagnostics.linkCount,
              browserShortlistedLinks: browserResult.shortlistedLinkCount ?? browserResult.diagnostics.articleLikeLinkCount,
              browserTopRejectedLinks: browserResult.topRejectedLinks ?? [],
              browserShortlistedLinkSamples: browserResult.shortlistedLinkSamples ?? [],
              browserTopLinkRejectionReasons: browserResult.topRejectionReasons ?? [],
              browserEvaluated: 0,
              browserAccepted: 0,
              browserRejected: 0,
              browserInserted: 0,
              browserSkipped: 0,
              browserFailed: 0,
              browserTopRejectionReasons: [],
              // No detail recovery attempted when the listing page itself failed.
              browserDetailEvaluated: 0,
              browserDetailAccepted: 0,
              browserDetailRejected: 0,
              browserDetailFetchRecovered: 0,
              browserDetailRecoveryReasons: [],
              browserError: `Browser fallback failed: ${browserResult.reason}. ${browserResult.diagnostics.blockedReason || ""}`,
              browserOutcomeSummary: {
                totalEvaluated: 0,
                accepted: 0,
                rejected: 0,
                byStatus: {},
                bySourceKind: {},
                topRejectionReasons: [],
              },
              browserQualityAssessment: null,
              browserDiagnostics: {
                pageTitle: browserResult.diagnostics.pageTitle,
                articleLikeLinkCount: browserResult.diagnostics.articleLikeLinkCount,
                blockedReason: browserResult.diagnostics.blockedReason ?? null,
                browserRuntimeAvailable: browserResult.diagnostics.browserRuntimeAvailable,
                elapsedMs: browserResult.diagnostics.elapsedMs,
              },
              renderedUrl: null,
              browserAcceptedOutcomes: [],
              browserRejectedOutcomes: [],
              // Legacy nested result preserved for backward-compat readers.
              browserResult: {
                ok: false,
                reason: browserResult.reason,
                diagnostics: browserResult.diagnostics,
              },
              resolvedAt: failedFinishedAt,
              processedAt: failedFinishedAt,
            },
          },
        });

        await logAgentScan({
          sourceId: item.sourceId,
          categoryId: item.categoryId || undefined,
          status: "ARTICLE_DISCOVERY_BROWSER_FAILED",
          executionTimeMs: browserResult.diagnostics.elapsedMs,
          errorLog: `Browser fallback failed for ${targetUrl}: ${browserResult.reason}. links=${browserResult.diagnostics.articleLikeLinkCount}, runtime=${browserResult.diagnostics.browserRuntimeAvailable}.`,
        });
        continue;
      }

      // Browser returned links — evaluate each through the same Agent 2
      // candidate evaluation path used by static discovery (same-domain
      // validation, utility path rejection, scoreCandidateUrl, title/date
      // extraction, freshness checks, dedupe, outcome tracking).
      await logAgentScan({
        sourceId: item.sourceId,
        categoryId: item.categoryId || undefined,
        status: "ARTICLE_DISCOVERY_BROWSER_LINKS_FOUND",
        executionTimeMs: browserResult.diagnostics.elapsedMs,
        errorLog: `Browser found ${browserResult.links.length} article-like links from ${targetUrl}.`,
      });

      // Outcome tracker — same type used by static discovery so browser
      // fallback produces an identical audit shape (byStatus, bySourceKind,
      // topRejectionReasons, accepted/rejected lists).
      const tracker = new ArticleDiscoveryOutcomeTracker();
      const candidates: IngestCandidate[] = [];
      const seenCanonicalUrls = new Set<string>();
      let browserRejected = 0;
      let browserSkipped = 0;
      let browserError: string | null = null;

      // Browser detail recovery bounds. We only attempt recovery when the
      // static detail fetch fails (fetch_failed / detail_validation_failed or
      // HTTP 401/403/429). Normal quality rejections (stale, low score,
      // missing title, duplicate, out of scope) are not retried.
      const MAX_DETAIL_RECOVERY_PAGES = MAX_BROWSER_DETAIL_EVALUATED_LINKS;
      let detailRecoveryAttempts = 0;
      let browserDetailEvaluated = 0;
      let browserDetailAccepted = 0;
      let browserDetailRejected = 0;
      let browserDetailFetchRecovered = 0;
      const browserDetailRecoveryReasons: string[] = [];

      const isRecoverableDetailRejection = (outcome: ArticleDiscoveryCandidateOutcome): boolean => {
        if (outcome.status === "fetch_failed" || outcome.status === "detail_validation_failed") {
          return true;
        }
        const reason = String(outcome.reason || "");
        return /\b(403|401|429)\b/.test(reason);
      };

      // Limit total detail evaluations (static + recovery) to MAX_BROWSER_DETAIL_EVALUATED_LINKS.
      let totalDetailEvaluations = 0;

      for (const link of browserResult.links) {
        // Stop early if we have enough accepted candidates
        if (candidates.length >= MAX_BROWSER_ACCEPTED_CANDIDATES) break;
        // Stop early if we've evaluated enough detail pages
        if (totalDetailEvaluations >= MAX_BROWSER_DETAIL_EVALUATED_LINKS) break;

        try {
          totalDetailEvaluations += 1;
          const listingDateFallbackRaw =
            typeof link.rawSignals?.listingDateText === "string"
              ? link.rawSignals.listingDateText
              : null;
          const evaluation = await evaluateArticleLinkCandidate({
            articleUrl: link.url,
            sourcePageUrl: link.sourcePageUrl,
            targetUrl,
            sourceId: sourceId!,
            categoryId: item.categoryId,
            listingDateFallbackRaw,
          });

          // Weak-date diagnostic: if rejected for missing date but otherwise
          // article-like (has title, description/body), flag it for audit.
          if (!evaluation.accepted &&
            evaluation.outcome.status === "rejected_stale" &&
            evaluation.outcome.staleReason === "missing_published_at"
          ) {
            // Check if the page had enough quality signals to be article-like
            // despite missing a date. The title must be non-empty (indicates
            // the page rendered properly).
            const hasTitle = Boolean(evaluation.outcome.title && evaluation.outcome.title.length >= 12);
            if (hasTitle) {
              // Augment the outcome with a diagnostic flag for admin audit.
              // Use a backward-compatible way: add to reason metadata.
              evaluation.outcome.reason =
                (evaluation.outcome.reason ? evaluation.outcome.reason + "; " : "") +
                "wouldAcceptWithWeakDate";
            }
          }

          if (!evaluation.accepted) {
            const shouldRecover =
              detailRecoveryAttempts < MAX_DETAIL_RECOVERY_PAGES &&
              isRecoverableDetailRejection(evaluation.outcome);

            if (shouldRecover) {
              detailRecoveryAttempts += 1;
              totalDetailEvaluations += 1;
              browserDetailRecoveryReasons.push(evaluation.outcome.status);

              const detailEval = await evaluateArticleLinkCandidateWithBrowser({
                articleUrl: link.url,
                sourcePageUrl: `browser:${link.url}`,
                targetUrl,
                sourceId: sourceId!,
                categoryId: item.categoryId,
                listingDateFallbackRaw,
              });

              browserDetailEvaluated += 1;

              if (detailEval.accepted) {
                browserDetailAccepted += 1;
                if (evaluation.outcome.status === "fetch_failed") {
                  browserDetailFetchRecovered += 1;
                }

                const candidate = detailEval.candidate as unknown as IngestCandidate;

                // Dedupe by canonical URL — same rule as static discovery.
                if (seenCanonicalUrls.has(candidate.canonicalUrl)) {
                  tracker.record({
                    url: candidate.canonicalUrl,
                    sourceKind: "browser",
                    status: "rejected_duplicate",
                    canonicalUrl: candidate.canonicalUrl,
                    title: candidate.title,
                    reason: "duplicate canonical URL",
                  } as ArticleDiscoveryCandidateOutcome);
                  browserSkipped += 1;
                } else {
                  seenCanonicalUrls.add(candidate.canonicalUrl);
                  candidates.push(candidate);
                  tracker.record(detailEval.outcome);
                }
              } else {
                browserDetailRejected += 1;
                tracker.record(detailEval.outcome);
              }
            } else {
              // Normal rejection (stale, low score, missing title, etc.) or
              // detail recovery limit reached — record the original outcome.
              tracker.record(evaluation.outcome);
              browserRejected += 1;
            }
            continue;
          }

          const candidate = evaluation.candidate as unknown as IngestCandidate;

          // Dedupe by canonical URL — same rule as static discovery.
          if (seenCanonicalUrls.has(candidate.canonicalUrl)) {
            tracker.record({
              url: candidate.canonicalUrl,
              sourceKind: "browser",
              status: "rejected_duplicate",
              canonicalUrl: candidate.canonicalUrl,
              title: candidate.title,
              reason: "duplicate canonical URL",
            } as ArticleDiscoveryCandidateOutcome);
            browserSkipped += 1;
            continue;
          }

          seenCanonicalUrls.add(candidate.canonicalUrl);
          candidates.push(candidate);
          tracker.record(evaluation.outcome);
        } catch (error: any) {
          // Individual link evaluation failure — record as detail_validation_failed.
          tracker.record({
            url: link.url,
            sourceKind: "browser",
            status: "detail_validation_failed",
            reason: error?.message || "unknown error",
          } as ArticleDiscoveryCandidateOutcome);
          browserSkipped += 1;
        }
      }

      const browserOutcomeSummary = tracker.getSummary();
      const acceptedOutcomes = tracker.getAccepted();
      const rejectedOutcomes = tracker.getRejected();

      // Quality assessment — reuse the static discovery classifier so browser
      // fallback produces a comparable quality label for hard-source tracking.
      const browserQualityAssessment = assessArticleDiscoveryQuality({
        acceptedCount: candidates.length,
        totalEvaluated: browserOutcomeSummary.totalEvaluated,
        pagesVisited: 1, // browser fallback inspects exactly one rendered page
        failed: 0,
        byStatus: browserOutcomeSummary.byStatus,
      });

      browserCandidatesFound += candidates.length;

      // Compact browser outcome summary for the artifact payload + admin toast.
      // Mirrors the static discovery summary shape but is nested under a
      // browserOutcomeSummary key to keep static and browser audits separate.
      const browserOutcomeSummaryCompact = {
        totalEvaluated: browserOutcomeSummary.totalEvaluated,
        accepted: browserOutcomeSummary.accepted,
        rejected: browserOutcomeSummary.rejected,
        byStatus: browserOutcomeSummary.byStatus,
        bySourceKind: browserOutcomeSummary.bySourceKind,
        topRejectionReasons: browserOutcomeSummary.topRejectionReasons,
      };

      // Persist accepted candidates through the same persistence path as
      // static Agent 2. Persistence failure does NOT discard the audit data —
      // we still record the browser result so the admin can see what happened.
      let persisted = { inserted: 0, skipped: 0, failed: 0 };
      try {
        if (candidates.length > 0) {
          persisted = await persistCandidates(candidates);
          totalInserted += persisted.inserted;
          totalSkipped += persisted.skipped;
          totalFailed += persisted.failed;
        }
      } catch (error: any) {
        browserError = `Candidate persistence failed: ${error?.message || String(error)}`;
        totalFailed += candidates.length;
        await logAgentScan({
          sourceId: item.sourceId,
          categoryId: item.categoryId || undefined,
          status: "ARTICLE_DISCOVERY_BROWSER_FAILED",
          executionTimeMs: 0,
          errorLog: browserError,
        });
      }

      // Transition from HEADLESS_PROCESSING → final success/failure status.
      // RESOLVED requires accepted candidates AND candidate persistence to
      // have been attempted (persistence errors still surface as RESOLVED
      // when candidates were found, so the marker leaves the active queue;
      // the persistence error is preserved in browserError for review).
      const finalStatus = candidates.length > 0 ? "RESOLVED" : "BROWSER_NO_CANDIDATES";
      const finishedAt = new Date().toISOString();

      await prisma.pipelineArtifact.updateMany({
        where: {
          id: item.id,
          artifactType: "article_discovery_headless_required",
          status: "HEADLESS_PROCESSING",
        },
        data: {
          status: finalStatus,
          candidateCount: candidates.length,
          payload: {
            ...claimedPayload,
            // ── Compact browser fallback result metadata ──────────────
            // All fields are compact counts / short strings / short arrays.
            // No raw HTML, screenshots, or large DOM dumps are stored.
            browserFallbackRan: true,
            browserFallbackStartedAt: claimedPayload.headlessProcessingStartedAt,
            browserFallbackFinishedAt: finishedAt,
            // linkCount is the total anchor count on the rendered page;
            // it is always a number on a successful browser result.
            browserRawLinks: browserResult.rawLinkCount ?? browserResult.diagnostics.linkCount,
            browserShortlistedLinks: browserResult.shortlistedLinkCount ?? browserResult.diagnostics.articleLikeLinkCount,
            browserTopRejectedLinks: browserResult.topRejectedLinks ?? [],
            browserShortlistedLinkSamples: browserResult.shortlistedLinkSamples ?? [],
            browserTopLinkRejectionReasons: browserResult.topRejectionReasons ?? [],
            browserEvaluated: browserOutcomeSummaryCompact.totalEvaluated,
            browserAccepted: browserOutcomeSummaryCompact.accepted,
            browserRejected: browserOutcomeSummaryCompact.rejected,
            browserInserted: persisted.inserted,
            // browserSkipped combines two kinds of skips: persistence-phase
            // skips (candidates already in the DB) and evaluation-phase
            // skips (duplicate canonical URLs + individual link evaluation
            // errors). Both are non-productive outcomes for this run, so they
            // are merged into a single compact field per the spec's field list.
            // The detailed breakdown is available in browserOutcomeSummary
            // (byStatus includes rejected_duplicate / detail_validation_failed)
            // and browserRejectedOutcomes for admin drill-down.
            browserSkipped: persisted.skipped + browserSkipped,
            browserFailed: persisted.failed,
            browserTopRejectionReasons: browserOutcomeSummaryCompact.topRejectionReasons.slice(0, 5),
            // Browser detail-recovery counters (compact).
            browserDetailEvaluated,
            browserDetailAccepted,
            browserDetailRejected,
            browserDetailFetchRecovered,
            browserDetailRecoveryReasons,
            browserError,
            browserOutcomeSummary: browserOutcomeSummaryCompact,
            browserQualityAssessment: {
              quality: browserQualityAssessment.quality,
              shouldEscalateToHeadless: browserQualityAssessment.shouldEscalateToHeadless,
              escalationReasons: browserQualityAssessment.escalationReasons,
              confidence: browserQualityAssessment.confidence,
              explanation: browserQualityAssessment.explanation,
            },
            browserDiagnostics: {
              pageTitle: browserResult.diagnostics.pageTitle,
              articleLikeLinkCount: browserResult.diagnostics.articleLikeLinkCount,
              blockedReason: browserResult.diagnostics.blockedReason ?? null,
              browserRuntimeAvailable: browserResult.diagnostics.browserRuntimeAvailable,
              elapsedMs: browserResult.diagnostics.elapsedMs,
            },
            renderedUrl: browserResult.renderedUrl || null,
            // Accepted/rejected outcome audit (capped by the tracker).
            // These mirror the static discovery artifact shape so admin and
            // hard-source tooling can consume both with the same code path.
            browserAcceptedOutcomes: acceptedOutcomes,
            browserRejectedOutcomes: rejectedOutcomes,
            resolvedAt: finishedAt,
          },
        },
      });

      browserProcessed += 1;
      if (candidates.length > 0) {
        browserResolved += 1;
      } else {
        browserNoCandidates += 1;
      }

      await logAgentScan({
        sourceId: item.sourceId,
        categoryId: item.categoryId || undefined,
        status: candidates.length > 0 ? "ARTICLE_DISCOVERY_BROWSER_RESOLVED" : "ARTICLE_DISCOVERY_BROWSER_FAILED",
        executionTimeMs: browserResult.diagnostics.elapsedMs,
        errorLog: `Browser fallback ${candidates.length > 0 ? "resolved" : "no candidates"} for ${targetUrl}. ` +
          `evaluated=${browserOutcomeSummaryCompact.totalEvaluated}, accepted=${candidates.length}, rejected=${browserRejected}, ` +
          `inserted=${persisted.inserted}, skipped=${persisted.skipped}, failed=${persisted.failed}. ` +
          `quality=${browserQualityAssessment.quality}.`,
      });

      continue;
    }

    // ── Default non-browser path: mark as SKIPPED_UNIMPLEMENTED ────────
    const { count } = await prisma.pipelineArtifact.updateMany({
      where: {
        id: item.id,
        artifactType: "article_discovery_headless_required",
        status: "PENDING_HEADLESS",
      },
      data: {
        status: "SKIPPED_UNIMPLEMENTED",
        payload: {
          ...item.payload,
          headlessQueueNote: "Browser execution is not implemented yet. Artifact marked by queue consumer.",
          processedAt: new Date().toISOString(),
        },
      },
    });

    if (count === 0) {
      skippedAlreadyClaimed += 1;
      continue;
    }

    processed += 1;
    updatedArtifactIds.push(item.id);

    await logAgentScan({
      sourceId: item.sourceId,
      categoryId: item.categoryId || undefined,
      status: "ARTICLE_DISCOVERY_HEADLESS_SKIPPED",
      executionTimeMs: 0,
      errorLog: `Headless artifact ${item.id} marked SKIPPED_UNIMPLEMENTED. targetUrl=${fields.targetUrl}, quality=${fields.quality}. Browser execution not yet available.`,
    });
  }

  await logAgentScan({
    status: "ARTICLE_DISCOVERY_HEADLESS_QUEUE_FINISHED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Headless queue processing complete. processed=${processed}, skippedInvalid=${skippedInvalid}, skippedAlreadyClaimed=${skippedAlreadyClaimed}, total=${items.length}.` +
      (runBrowser ? ` browser: processed=${browserProcessed}, disabled=${browserSkippedDisabled}, unavailable=${browserSkippedUnavailable}, failed=${browserFailed}, candidates=${browserCandidatesFound}, inserted=${totalInserted}.` : ""),
  });

  const result: HeadlessQueueProcessResult = {
    dryRun: false,
    processed: processed + browserProcessed,
    skippedInvalid,
    skippedAlreadyClaimed,
    updatedArtifactIds,
  };

  if (runBrowser) {
    result.claimed = updatedArtifactIds.length;
    result.browserProcessed = browserProcessed;
    result.browserResolved = browserResolved;
    result.browserNoCandidates = browserNoCandidates;
    result.browserSkippedDisabled = browserSkippedDisabled;
    result.browserSkippedUnavailable = browserSkippedUnavailable;
    result.browserFailed = browserFailed;
    result.browserCandidatesFound = browserCandidatesFound;
    result.browserCandidatesPersisted = { inserted: totalInserted, skipped: totalSkipped, failed: totalFailed };
  }

  return result;
}

// ─── Stale HEADLESS_PROCESSING Recovery ────────────────────────────────────

const RECOVERY_DEFAULT_OLDER_THAN_MINUTES = 30;
const RECOVERY_DEFAULT_LIMIT = 10;
const RECOVERY_MAX_LIMIT = 50;
const RECOVERY_SCAN_MULTIPLIER = 5;
const RECOVERY_MIN_SCAN = 50;
const RECOVERY_MAX_SCAN = 250;

type RecoveryInput = {
  olderThanMinutes?: number;
  limit?: number;
  mode?: "retry" | "fail";
};

type RecoveryResult = {
  inspected: number;
  staleFound: number;
  recovered: number;
  failedStale: number;
  skippedAlreadyChanged: number;
  artifactIds: string[];
};

/**
 * Recover stale HEADLESS_PROCESSING artifacts that may have been abandoned
 * due to a process crash during browser work.
 *
 * - retry: moves stale artifact back to PENDING_HEADLESS for re-processing
 * - fail: moves stale artifact to HEADLESS_PROCESSING_STALE for manual review
 *
 * Uses compare-and-set to avoid interfering with active processing.
 */
export async function recoverStaleArticleDiscoveryHeadlessProcessing(
  input?: RecoveryInput,
): Promise<RecoveryResult> {
  const olderThanMinutes = input?.olderThanMinutes ?? RECOVERY_DEFAULT_OLDER_THAN_MINUTES;
  const limit = Math.min(Math.max(input?.limit ?? RECOVERY_DEFAULT_LIMIT, 1), RECOVERY_MAX_LIMIT);
  const mode = input?.mode ?? "retry";

  const startedAt = Date.now();
  const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  // Scan limit is larger than recovery limit so stale artifacts are not hidden
  // behind fresh HEADLESS_PROCESSING artifacts in the query result.
  const scanLimit = Math.min(Math.max(limit * RECOVERY_SCAN_MULTIPLIER, RECOVERY_MIN_SCAN), RECOVERY_MAX_SCAN);

  await logAgentScan({
    status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_STARTED",
    executionTimeMs: 0,
    errorLog: `Headless recovery started. olderThanMinutes=${olderThanMinutes}, limit=${limit}, scanLimit=${scanLimit}, mode=${mode}, threshold=${threshold.toISOString()}.`,
  });

  let inspected = 0;
  let staleFound = 0;
  let recovered = 0;
  let failedStale = 0;
  let skippedAlreadyChanged = 0;
  const artifactIds: string[] = [];

  try {
    // Query a wider window of HEADLESS_PROCESSING artifacts.
    // We filter by payload timestamp in JS because Prisma JSON field
    // queries are limited. scanLimit > limit ensures stale artifacts
    // behind fresh ones in the sort order are still discovered.
    const artifacts = await prisma.pipelineArtifact.findMany({
      where: {
        artifactType: "article_discovery_headless_required",
        status: "HEADLESS_PROCESSING",
      },
      orderBy: { createdAt: "asc" },
      take: scanLimit,
      select: {
        id: true,
        sourceId: true,
        categoryId: true,
        createdAt: true,
        payload: true,
      },
    });

    inspected = artifacts.length;

    // Filter to only stale artifacts (headlessProcessingStartedAt < threshold)
    const allStale = artifacts.filter((a) => {
      const payload = (a.payload as Record<string, unknown>) || {};
      const startedAtRaw = payload.headlessProcessingStartedAt;
      if (!startedAtRaw || typeof startedAtRaw !== "string") return false;
      try {
        return new Date(startedAtRaw) < threshold;
      } catch {
        return false;
      }
    });

    staleFound = allStale.length;
    const toProcess = allStale.slice(0, limit);
    const now = new Date().toISOString();

    for (const artifact of toProcess) {
      const payload = (artifact.payload as Record<string, unknown>) || {};

      if (mode === "retry") {
        // Move back to PENDING_HEADLESS for re-processing
        const { count } = await prisma.pipelineArtifact.updateMany({
          where: {
            id: artifact.id,
            artifactType: "article_discovery_headless_required",
            status: "HEADLESS_PROCESSING",
          },
          data: {
            status: "PENDING_HEADLESS",
            errorLog: `Stale processing recovered after ${olderThanMinutes}min. Reset to PENDING_HEADLESS for retry.`,
            payload: {
              ...payload,
              headlessRecoveryCount: ((payload.headlessRecoveryCount as number) || 0) + 1,
              lastHeadlessRecoveryAt: now,
            },
          },
        });

        if (count === 0) {
          skippedAlreadyChanged += 1;
        } else {
          recovered += 1;
          artifactIds.push(artifact.id);
        }
      } else {
        // Move to HEADLESS_PROCESSING_STALE for manual review
        const { count } = await prisma.pipelineArtifact.updateMany({
          where: {
            id: artifact.id,
            artifactType: "article_discovery_headless_required",
            status: "HEADLESS_PROCESSING",
          },
          data: {
            status: "HEADLESS_PROCESSING_STALE",
            errorLog: `Stale processing detected after ${olderThanMinutes}min. Marked for manual review.`,
            payload: {
              ...payload,
              headlessRecoveryCount: ((payload.headlessRecoveryCount as number) || 0) + 1,
              lastHeadlessRecoveryAt: now,
            },
          },
        });

        if (count === 0) {
          skippedAlreadyChanged += 1;
        } else {
          failedStale += 1;
          artifactIds.push(artifact.id);
        }
      }
    }
  } catch (error: any) {
    await logAgentScan({
      status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_FAILED",
      executionTimeMs: Date.now() - startedAt,
      errorLog: `Headless recovery failed: ${error?.message || String(error)}.`,
    });
    throw error;
  }

  await logAgentScan({
    status: "ARTICLE_DISCOVERY_HEADLESS_RECOVERY_FINISHED",
    executionTimeMs: Date.now() - startedAt,
    errorLog: `Headless recovery complete. inspected=${inspected}, staleFound=${staleFound}, recovered=${recovered}, failedStale=${failedStale}, skippedAlreadyChanged=${skippedAlreadyChanged}, mode=${mode}.`,
  });

  return { inspected, staleFound, recovered, failedStale, skippedAlreadyChanged, artifactIds };
}
