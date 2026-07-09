-- Drop the redundant exact-one-target CHECK constraint.
-- The newer chk_review_request_target_type_consistency constraint already
-- implies the valid target shape (SOURCE => sourceId only, CATEGORY => categoryId only).
DO $$
BEGIN
  ALTER TABLE "FeedReviewRequest"
  DROP CONSTRAINT IF EXISTS "chk_review_request_exactly_one_target";
END $$;
