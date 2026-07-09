import { prisma } from "../prisma";

const normalizeComparableFeedUrl = (value?: string | null) =>
  (value || "").trim().replace(/\/+$/, "").toLowerCase();

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
