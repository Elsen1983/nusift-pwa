import { createError } from "h3";
import { prisma } from "../../../utils/prisma";
import { requireUserId } from "../../../utils/require-user";
import { assertExactlyOneTarget } from "../../../utils/feed-review-integrity";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  const body = await readBody(event);

  const subscriptionId = String(body?.subscriptionId || "").trim();
  const reason = body?.reason ? String(body.reason).trim().slice(0, 500) : null;

  if (!subscriptionId) {
    throw createError({ statusCode: 400, statusMessage: "Missing subscriptionId." });
  }

  // Resolve the subscription to a global NewsSource or SourceCategory
  const rootSubscription = await prisma.userSourceSubscription.findFirst({
    where: { id: subscriptionId, userId },
    select: {
      id: true,
      newsSource: { select: { id: true, mediaName: true } },
    },
  });

  const categorySubscription = rootSubscription
    ? null
    : await prisma.userCategorySubscription.findFirst({
        where: { id: subscriptionId, userId },
        select: {
          id: true,
          category: { select: { id: true, name: true } },
        },
      });

  if (!rootSubscription && !categorySubscription) {
    throw createError({ statusCode: 404, statusMessage: "Source subscription not found." });
  }

  const targetSourceId = rootSubscription ? rootSubscription.newsSource.id : null;
  const targetCategoryId = categorySubscription ? categorySubscription.category.id : null;

  // Application-level target integrity validation (DB CHECK constraint also enforces this)
  assertExactlyOneTarget({ sourceId: targetSourceId, categoryId: targetCategoryId });

  // Concurrency-safe anti-spam: use a transaction to atomically check for
  // existing OPEN request and create if none exists. This prevents two concurrent
  // requests from both passing the findFirst check and creating duplicates.
  // The DB-level unique constraint is not feasible for partial uniqueness in Prisma,
  // but the SERIALIZABLE transaction provides strong protection.
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingOpenRequest = await tx.feedReviewRequest.findFirst({
        where: {
          requestedByUserId: userId,
          status: "OPEN",
          ...(targetSourceId ? { sourceId: targetSourceId } : {}),
          ...(targetCategoryId ? { categoryId: targetCategoryId } : {}),
        },
        select: { id: true },
      });

      if (existingOpenRequest) {
        return {
          ok: true,
          alreadyRequested: true,
          reviewRequestId: existingOpenRequest.id,
          message: "You have already submitted a review request for this source.",
        };
      }

      const reviewRequest = await tx.feedReviewRequest.create({
        data: {
          targetType: targetSourceId ? "SOURCE" : "CATEGORY",
          sourceId: targetSourceId,
          categoryId: targetCategoryId,
          requestedByUserId: userId,
          reason,
          status: "OPEN",
        },
      });

      return {
        ok: true,
        alreadyRequested: false,
        reviewRequestId: reviewRequest.id,
        message: "Review request submitted successfully.",
      };
    }, {
      // Use SERIALIZABLE isolation to prevent race conditions where two concurrent
      // requests both see no existing OPEN request and both create one.
      isolationLevel: "Serializable",
    });

    return result;
  } catch (error: any) {
    // If the transaction fails due to serialization conflict, surface a clear error
    if (error?.code === "P2034") {
      throw createError({
        statusCode: 409,
        statusMessage: "Concurrent review request detected. Please try again.",
      });
    }
    throw error;
  }
});
