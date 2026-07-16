-- Repair migration to restore Agent 2 constraints/indexes that were dropped
-- in the drifted runtime schema migration.

DO $$
BEGIN
  ALTER TABLE "NewsSource"
    ADD CONSTRAINT "NewsSource_feedSubmittedByUserId_fkey"
    FOREIGN KEY ("feedSubmittedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "SourceCategory"
    ADD CONSTRAINT "SourceCategory_feedSubmittedByUserId_fkey"
    FOREIGN KEY ("feedSubmittedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "User_role_idx"
  ON "User"("role");
