import { prisma } from "../prisma";

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

export async function markFeedRunOutcome(input: {
  sourceId: string;
  categoryId?: string | null;
  feedUrl?: string | null;
  productive: boolean;
  shouldTrackFeedProductivity: boolean;
}) {
  if (input.categoryId) {
    if (!input.shouldTrackFeedProductivity) {
      return;
    }

    if (input.productive) {
      await prisma.sourceCategory.update({
        where: { id: input.categoryId },
        data: {
          currentFeedProductive: true,
          consecutiveNonProductiveRuns: 0,
          lastProductiveFeedUrl: input.feedUrl || null,
          lastProductiveAt: new Date(),
        },
      });
      await autoResolveOpenReviewRequests({ sourceId: input.sourceId, categoryId: input.categoryId });
      return;
    }

    await prisma.sourceCategory.update({
      where: { id: input.categoryId },
      data: {
        consecutiveNonProductiveRuns: {
          increment: 1,
        },
      },
    });
    return;
  }

  if (!input.shouldTrackFeedProductivity) {
    return;
  }

  if (input.productive) {
    await prisma.newsSource.update({
      where: { id: input.sourceId },
      data: {
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: 0,
        lastProductiveFeedUrl: input.feedUrl || null,
        lastProductiveAt: new Date(),
      },
    });
    await autoResolveOpenReviewRequests({ sourceId: input.sourceId });
    return;
  }

  await prisma.newsSource.update({
    where: { id: input.sourceId },
    data: {
      consecutiveNonProductiveRuns: {
        increment: 1,
      },
    },
  });
}
