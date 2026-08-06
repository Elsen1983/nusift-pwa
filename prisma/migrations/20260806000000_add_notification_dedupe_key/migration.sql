-- Nullable keys preserve all existing Notification rows. PostgreSQL unique
-- constraints allow multiple NULL values, so legacy rows remain compatible.
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "Notification_dedupeKey_key"
  ON "Notification"("dedupeKey");
