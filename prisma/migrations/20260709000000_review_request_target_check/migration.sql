-- Enforce exactly-one-target on FeedReviewRequest:
-- either sourceId is set (SOURCE target) or categoryId is set (CATEGORY target), never both, never neither.
DO $$
BEGIN
  ALTER TABLE "FeedReviewRequest"
  ADD CONSTRAINT "chk_review_request_exactly_one_target"
  CHECK (
    ("sourceId" IS NOT NULL AND "categoryId" IS NULL)
    OR
    ("sourceId" IS NULL AND "categoryId" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
