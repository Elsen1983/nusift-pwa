CREATE TYPE "PublicationStatus" AS ENUM ('CANDIDATE', 'PROCESSING', 'PUBLISHED', 'REJECTED');

ALTER TABLE "Article"
  ADD COLUMN "publicationStatus" "PublicationStatus" NOT NULL DEFAULT 'CANDIDATE',
  ADD COLUMN "publicationStage" TEXT,
  ADD COLUMN "publicationReadyAt" TIMESTAMP(3);

UPDATE "Article"
SET
  "publicationStatus" = 'PUBLISHED',
  "publicationStage" = 'agent3',
  "publicationReadyAt" = COALESCE("enrichmentFinishedAt", "updatedAt", "createdAt")
WHERE "enrichmentStatus" = 'ENRICHED';

CREATE INDEX "Article_publicationStatus_publicationReadyAt_idx"
  ON "Article"("publicationStatus", "publicationReadyAt");
