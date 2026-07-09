import { prisma } from "../../../utils/prisma";
import { requireAdminId } from "../../../utils/require-admin";

/**
 * Admin-only endpoint to list FeedReviewRequests with full details.
 *
 * Query params:
 * - status: filter by status (default: OPEN)
 * - targetType: filter by SOURCE or CATEGORY
 * - limit: max results (default: 50)
 *
 * Returns review requests with target info, requester identity, and resolver identity.
 */
export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  const query = getQuery(event);
  const status = query.status ? String(query.status).toUpperCase() : "OPEN";
  const targetType = query.targetType ? String(query.targetType).toUpperCase() : null;
  const limit = Math.min(Number(query.limit) || 50, 200);

  const where: Record<string, unknown> = {};
  if (status !== "ALL") {
    where.status = status;
  }
  if (targetType === "SOURCE" || targetType === "CATEGORY") {
    where.targetType = targetType;
  }

  const requests = await prisma.feedReviewRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      targetType: true,
      sourceId: true,
      categoryId: true,
      reason: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
      requestedBy: {
        select: {
          id: true,
          email: true,
          role: true,
        },
      },
      resolvedBy: {
        select: {
          id: true,
          email: true,
          role: true,
        },
      },
      source: {
        select: {
          id: true,
          mediaName: true,
          frontPageUrl: true,
          rssFeedUrl: true,
          feedProvenance: true,
          rssStatus: true,
          currentFeedProductive: true,
        },
      },
      category: {
        select: {
          id: true,
          name: true,
          pathUrl: true,
          rssFeedUrl: true,
          feedProvenance: true,
          rssStatus: true,
          currentFeedProductive: true,
          newsSource: {
            select: {
              id: true,
              mediaName: true,
            },
          },
        },
      },
    },
  });

  return {
    ok: true,
    count: requests.length,
    requests,
  };
});
