import { createError } from "h3";

/**
 * Validates that exactly one target (source or category) is set
 * and that targetType is consistent with the populated field.
 *
 * This is also enforced at DB level via CHECK constraint, but we
 * validate here for clear error messages before hitting the DB.
 */
export function assertExactlyOneTarget(input: {
  sourceId?: string | null;
  categoryId?: string | null;
  targetType?: "SOURCE" | "CATEGORY" | null;
}): asserts input is (
  | { sourceId: string; categoryId: null | undefined; targetType?: "SOURCE" | null }
  | { sourceId: null | undefined; categoryId: string; targetType?: "CATEGORY" | null }
) {
  const hasSource = Boolean(input.sourceId);
  const hasCategory = Boolean(input.categoryId);

  if (hasSource && hasCategory) {
    throw createError({
      statusCode: 400,
      statusMessage: "Review request must target either a source or a category, not both.",
    });
  }

  if (!hasSource && !hasCategory) {
    throw createError({
      statusCode: 400,
      statusMessage: "Review request must target a source or category.",
    });
  }

  // When targetType is provided, validate it matches the populated field
  if (input.targetType) {
    if (input.targetType === "SOURCE" && !hasSource) {
      throw createError({
        statusCode: 400,
        statusMessage: "targetType is SOURCE but sourceId is not set.",
      });
    }

    if (input.targetType === "CATEGORY" && !hasCategory) {
      throw createError({
        statusCode: 400,
        statusMessage: "targetType is CATEGORY but categoryId is not set.",
      });
    }

    if (input.targetType === "SOURCE" && hasCategory) {
      throw createError({
        statusCode: 400,
        statusMessage: "targetType is SOURCE but categoryId is set instead of sourceId.",
      });
    }

    if (input.targetType === "CATEGORY" && hasSource) {
      throw createError({
        statusCode: 400,
        statusMessage: "targetType is CATEGORY but sourceId is set instead of categoryId.",
      });
    }
  }
}
