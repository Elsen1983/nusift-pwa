import { createError } from "h3";
import { prisma } from "../../../utils/prisma";
import { requireAdminId } from "../../../utils/require-admin";

/**
 * Admin-only endpoint to resolve or dismiss a FeedReviewRequest.
 *
 * Route: PATCH /api/dev/review-requests/:id
 *
 * Actions:
 * - RESOLVED_BY_ADMIN: admin has reviewed and confirmed the request
 * - DISMISSED: admin considers the request invalid or not actionable
 *
 * Optional body flags:
 * - confirmFeed=true: updates the target's feedProvenance to ADMIN_CONFIRMED
 * - revertProvenance=true: resets provenance to SYSTEM_DISCOVERED and clears submitted fields
 *
 * confirmFeed and revertProvenance are mutually exclusive.
 */
export default defineEventHandler(async (event) => {
  const adminId = await requireAdminId(event);

  const requestId = getRouterParam(event, "id");
  const body = await readBody(event);

  const action = String(body?.action || "").trim().toUpperCase();
  const confirmFeed = body?.confirmFeed === true;
  const revertProvenance = body?.revertProvenance === true;

  if (!requestId) {
    throw createError({ statusCode: 400, statusMessage: "Missing review request id in URL." });
  }

  if (confirmFeed && revertProvenance) {
    throw createError({
      statusCode: 400,
      statusMessage: "Cannot set both confirmFeed and revertProvenance. Choose one.",
    });
  }

  if (action !== "RESOLVED_BY_ADMIN" && action !== "DISMISSED") {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid action. Must be RESOLVED_BY_ADMIN or DISMISSED.",
    });
  }

  // Fetch the existing request to verify it exists and is OPEN
  const existingRequest = await prisma.feedReviewRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      sourceId: true,
      categoryId: true,
      targetType: true,
    },
  });

  if (!existingRequest) {
    throw createError({ statusCode: 404, statusMessage: "Review request not found." });
  }

  if (existingRequest.status !== "OPEN") {
    throw createError({
      statusCode: 409,
      statusMessage: `Review request is already ${existingRequest.status}. Cannot modify.`,
    });
  }

  const now = new Date();
  const provenanceValue = confirmFeed ? "ADMIN_CONFIRMED" : revertProvenance ? "SYSTEM_DISCOVERED" : null;
  const clearSubmittedFields = revertProvenance;

  // Build transaction operations. Branch on whether a provenance update
  // is needed to avoid dynamic array type issues with Prisma.
  const requestUpdate = prisma.feedReviewRequest.update({
    where: { id: requestId },
    data: {
      status: action,
      resolvedAt: now,
      resolvedByUserId: adminId,
    },
  });

  if (provenanceValue && existingRequest.sourceId) {
    const [_, updatedRequest] = await prisma.$transaction([
      prisma.newsSource.update({
        where: { id: existingRequest.sourceId },
        data: {
          feedProvenance: provenanceValue,
          ...(clearSubmittedFields ? { feedSubmittedByUserId: null, feedSubmittedAt: null } : {}),
        },
      }),
      requestUpdate,
    ]);
    return {
      ok: true,
      reviewRequest: {
        id: updatedRequest.id,
        status: updatedRequest.status,
        resolvedAt: updatedRequest.resolvedAt,
        resolvedByUserId: updatedRequest.resolvedByUserId,
      },
      feedProvenanceUpdated: true,
    };
  }

  if (provenanceValue && existingRequest.categoryId) {
    const [_, updatedRequest] = await prisma.$transaction([
      prisma.sourceCategory.update({
        where: { id: existingRequest.categoryId },
        data: {
          feedProvenance: provenanceValue,
          ...(clearSubmittedFields ? { feedSubmittedByUserId: null, feedSubmittedAt: null } : {}),
        },
      }),
      requestUpdate,
    ]);
    return {
      ok: true,
      reviewRequest: {
        id: updatedRequest.id,
        status: updatedRequest.status,
        resolvedAt: updatedRequest.resolvedAt,
        resolvedByUserId: updatedRequest.resolvedByUserId,
      },
      feedProvenanceUpdated: true,
    };
  }

  // No provenance update needed — resolve the request alone
  const updatedRequest = await requestUpdate;

  return {
    ok: true,
    reviewRequest: {
      id: updatedRequest.id,
      status: updatedRequest.status,
      resolvedAt: updatedRequest.resolvedAt,
      resolvedByUserId: updatedRequest.resolvedByUserId,
    },
    feedProvenanceUpdated: false,
  };
});
