-- Agent 2 runtime schema expansion.

DO $$
BEGIN
  CREATE TYPE "FeedProvenance" AS ENUM ('SYSTEM_DISCOVERED', 'USER_SUBMITTED', 'ADMIN_CONFIRMED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PipelineRun" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "targetCount" INTEGER NOT NULL DEFAULT 0,
  "candidatesFound" INTEGER NOT NULL DEFAULT 0,
  "inserted" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "artifactCount" INTEGER NOT NULL DEFAULT 0,
  "summary" JSONB,

  CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PipelineArtifact" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "pipelineRunId" TEXT NOT NULL,
  "sourceId" TEXT,
  "categoryId" TEXT,
  "artifactType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "candidateCount" INTEGER NOT NULL DEFAULT 0,
  "payload" JSONB NOT NULL,
  "errorLog" TEXT,

  CONSTRAINT "PipelineArtifact_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "role" "UserRole" NOT NULL DEFAULT 'USER';

ALTER TABLE "NewsSource"
  ADD COLUMN IF NOT EXISTS "consecutiveNonProductiveRuns" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "currentFeedProductive" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "discoveryEvidence" JSONB,
  ADD COLUMN IF NOT EXISTS "feedProvenance" "FeedProvenance" NOT NULL DEFAULT 'SYSTEM_DISCOVERED',
  ADD COLUMN IF NOT EXISTS "feedSubmittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "feedSubmittedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "lastProductiveAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastProductiveFeedUrl" TEXT;

ALTER TABLE "SourceCategory"
  ADD COLUMN IF NOT EXISTS "consecutiveNonProductiveRuns" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "currentFeedProductive" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "discoveryEvidence" JSONB,
  ADD COLUMN IF NOT EXISTS "feedProvenance" "FeedProvenance" NOT NULL DEFAULT 'SYSTEM_DISCOVERED',
  ADD COLUMN IF NOT EXISTS "feedSubmittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "feedSubmittedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "lastProductiveAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastProductiveFeedUrl" TEXT;

CREATE INDEX IF NOT EXISTS "PipelineRun_createdAt_idx"
  ON "PipelineRun"("createdAt");

CREATE INDEX IF NOT EXISTS "PipelineRun_status_createdAt_idx"
  ON "PipelineRun"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "PipelineArtifact_pipelineRunId_createdAt_idx"
  ON "PipelineArtifact"("pipelineRunId", "createdAt");

CREATE INDEX IF NOT EXISTS "PipelineArtifact_sourceId_createdAt_idx"
  ON "PipelineArtifact"("sourceId", "createdAt");

CREATE INDEX IF NOT EXISTS "PipelineArtifact_categoryId_createdAt_idx"
  ON "PipelineArtifact"("categoryId", "createdAt");

CREATE INDEX IF NOT EXISTS "PipelineArtifact_artifactType_status_idx"
  ON "PipelineArtifact"("artifactType", "status");

CREATE INDEX IF NOT EXISTS "NewsSource_continent_countryCode_idx"
  ON "NewsSource"("continent", "countryCode");

CREATE INDEX IF NOT EXISTS "NewsSource_rssStatus_nextRetryAt_idx"
  ON "NewsSource"("rssStatus", "nextRetryAt");

CREATE INDEX IF NOT EXISTS "SourceCategory_isUserRequested_idx"
  ON "SourceCategory"("isUserRequested");

CREATE INDEX IF NOT EXISTS "SourceCategory_rssStatus_nextRetryAt_idx"
  ON "SourceCategory"("rssStatus", "nextRetryAt");

CREATE INDEX IF NOT EXISTS "User_role_idx"
  ON "User"("role");

DO $$
BEGIN
  ALTER TABLE "PipelineArtifact"
    ADD CONSTRAINT "PipelineArtifact_pipelineRunId_fkey"
    FOREIGN KEY ("pipelineRunId") REFERENCES "PipelineRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "PipelineArtifact"
    ADD CONSTRAINT "PipelineArtifact_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "NewsSource"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "PipelineArtifact"
    ADD CONSTRAINT "PipelineArtifact_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "SourceCategory"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

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
