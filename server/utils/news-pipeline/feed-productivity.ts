import { prisma } from "../prisma";
import { logAgentScan } from "./log";
import {
  applyFeedProductivityOutcome,
  type FeedProductivityState,
  type FeedRunOutcomeKind,
} from "./feed-productivity-policy";

const normalizeComparableFeedUrl = (value?: string | null) =>
  (value || "").trim().replace(/\/+$/, "").toLowerCase();

/**
 * Auto-resolve open review requests for a target when the feed has been
 * validated as productive. This is called from markFeedRunOutcome when
 * productive === true.
 *
 * Only resolves requests with status OPEN. Transitions them to
 * AUTO_RESOLVED_VALIDATED and refreshes no aggregate fields (they are
 * computed dynamically in sources.get.ts).
 */
async function autoResolveOpenReviewRequests(input: {
  sourceId: string;
  categoryId?: string | null;
}) {
  const where = input.categoryId
    ? { categoryId: input.categoryId, status: "OPEN" as const }
    : { sourceId: input.sourceId, status: "OPEN" as const };

  await prisma.feedReviewRequest.updateMany({
    where,
    data: {
      status: "AUTO_RESOLVED_VALIDATED",
      resolvedAt: new Date(),
    },
  });
}

export const getFeedProductivityResetData = (
  previousFeedUrl?: string | null,
  nextFeedUrl?: string | null,
) => {
  const previousNormalized = normalizeComparableFeedUrl(previousFeedUrl);
  const nextNormalized = normalizeComparableFeedUrl(nextFeedUrl);

  if (previousNormalized === nextNormalized) {
    return {};
  }

  return {
    currentFeedProductive: false,
    consecutiveNonProductiveRuns: 0,
  };
};

const stateFromRow = (row: {
  currentFeedProductive: boolean;
  consecutiveNonProductiveRuns: number;
  lastProductiveFeedUrl: string | null;
  lastProductiveAt: Date | null;
  nextRetryAt: Date | null;
}): FeedProductivityState => ({
  currentFeedProductive: row.currentFeedProductive,
  consecutiveNonProductiveRuns: row.consecutiveNonProductiveRuns,
  lastProductiveFeedUrl: row.lastProductiveFeedUrl,
  lastProductiveAt: row.lastProductiveAt,
  nextRetryAt: row.nextRetryAt,
});

export async function markFeedRunOutcome(input: {
  sourceId: string;
  categoryId?: string | null;
  feedUrl?: string | null;
  feedRunOutcomeKind?: FeedRunOutcomeKind | null;
  shouldTrackFeedProductivity: boolean;
}) {
  if (!input.shouldTrackFeedProductivity) return;

  const kind: FeedRunOutcomeKind = input.feedRunOutcomeKind ?? "unknown";
  const now = new Date();

  if (input.categoryId) {
    const current = await prisma.sourceCategory.findUnique({
      where: { id: input.categoryId },
      select: {
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: true,
        lastProductiveFeedUrl: true,
        lastProductiveAt: true,
        nextRetryAt: true,
        feedProductivityVersion: true,
      },
    });
    if (!current) return;

    const next = applyFeedProductivityOutcome(stateFromRow(current), { kind, feedUrl: input.feedUrl }, { now });
    const updated = await prisma.sourceCategory.updateMany({
      where: { id: input.categoryId, feedProductivityVersion: current.feedProductivityVersion },
      data: {
        currentFeedProductive: next.currentFeedProductive,
        consecutiveNonProductiveRuns: next.consecutiveNonProductiveRuns,
        lastProductiveFeedUrl: next.lastProductiveFeedUrl,
        lastProductiveAt: next.lastProductiveAt,
        nextRetryAt: next.nextRetryAt,
        feedProductivityVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      await logAgentScan({
        sourceId: input.sourceId,
        categoryId: input.categoryId,
        status: "FEED_PRODUCTIVITY_CAS_CONFLICT",
        executionTimeMs: 0,
        errorLog: `Feed-productivity CAS write conflict for category ${input.categoryId}; a concurrent writer already advanced the version. Skipped, will retry next cycle.`,
      });
      return;
    }
    if (kind === "productive") {
      await autoResolveOpenReviewRequests({ sourceId: input.sourceId, categoryId: input.categoryId });
    }
    return;
  }

  const current = await prisma.newsSource.findUnique({
    where: { id: input.sourceId },
    select: {
      currentFeedProductive: true,
      consecutiveNonProductiveRuns: true,
      lastProductiveFeedUrl: true,
      lastProductiveAt: true,
      nextRetryAt: true,
      feedProductivityVersion: true,
    },
  });
  if (!current) return;

  const next = applyFeedProductivityOutcome(stateFromRow(current), { kind, feedUrl: input.feedUrl }, { now });
  const updated = await prisma.newsSource.updateMany({
    where: { id: input.sourceId, feedProductivityVersion: current.feedProductivityVersion },
    data: {
      currentFeedProductive: next.currentFeedProductive,
      consecutiveNonProductiveRuns: next.consecutiveNonProductiveRuns,
      lastProductiveFeedUrl: next.lastProductiveFeedUrl,
      lastProductiveAt: next.lastProductiveAt,
      nextRetryAt: next.nextRetryAt,
      feedProductivityVersion: { increment: 1 },
    },
  });
  if (updated.count !== 1) {
    await logAgentScan({
      sourceId: input.sourceId,
      status: "FEED_PRODUCTIVITY_CAS_CONFLICT",
      executionTimeMs: 0,
      errorLog: `Feed-productivity CAS write conflict for source ${input.sourceId}; a concurrent writer already advanced the version. Skipped, will retry next cycle.`,
    });
    return;
  }
  if (kind === "productive") {
    await autoResolveOpenReviewRequests({ sourceId: input.sourceId });
  }
}
