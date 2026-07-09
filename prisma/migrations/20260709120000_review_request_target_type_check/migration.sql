-- Strengthen targetType integrity on FeedReviewRequest:
-- targetType = SOURCE must imply sourceId IS NOT NULL AND categoryId IS NULL
-- targetType = CATEGORY must imply categoryId IS NOT NULL AND sourceId IS NULL
DO $$
BEGIN
  ALTER TABLE "FeedReviewRequest"
  ADD CONSTRAINT "chk_review_request_target_type_consistency"
  CHECK (
    ("targetType" = 'SOURCE'   AND "sourceId"   IS NOT NULL AND "categoryId" IS NULL)
    OR
    ("targetType" = 'CATEGORY' AND "categoryId" IS NOT NULL AND "sourceId"   IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
