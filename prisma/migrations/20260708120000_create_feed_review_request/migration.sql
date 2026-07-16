-- Repair migration for a missing historical table create.
-- The Prisma schema already contains `FeedReviewRequest`, but the migration
-- chain that follows it expects the table to exist. Without this repair step,
-- shadow DB replay fails when later CHECK-constraint migrations run.

DO $$
BEGIN
  CREATE TYPE "ReviewRequestTarget" AS ENUM ('SOURCE', 'CATEGORY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ReviewRequestStatus" AS ENUM (
    'OPEN',
    'RESOLVED_BY_ADMIN',
    'DISMISSED',
    'AUTO_RESOLVED_VALIDATED',
    'AUTO_RESOLVED_REVERTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TABLE "FeedReviewRequest" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetType" "ReviewRequestTarget" NOT NULL,
    "sourceId" TEXT,
    "categoryId" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "reason" TEXT,
    "status" "ReviewRequestStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,

    CONSTRAINT "FeedReviewRequest_pkey" PRIMARY KEY ("id")
  );
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "FeedReviewRequest_sourceId_status_idx"
  ON "FeedReviewRequest"("sourceId", "status");

CREATE INDEX IF NOT EXISTS "FeedReviewRequest_categoryId_status_idx"
  ON "FeedReviewRequest"("categoryId", "status");

CREATE INDEX IF NOT EXISTS "FeedReviewRequest_requestedByUserId_status_idx"
  ON "FeedReviewRequest"("requestedByUserId", "status");

DO $$
BEGIN
  ALTER TABLE "FeedReviewRequest"
    ADD CONSTRAINT "FeedReviewRequest_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "NewsSource"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "FeedReviewRequest"
    ADD CONSTRAINT "FeedReviewRequest_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "SourceCategory"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "FeedReviewRequest"
    ADD CONSTRAINT "FeedReviewRequest_requestedByUserId_fkey"
    FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "FeedReviewRequest"
    ADD CONSTRAINT "FeedReviewRequest_resolvedByUserId_fkey"
    FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
