-- Agent 2 (Article enrichment) Phase 1: minimal status-tracking fields.
-- Detailed extraction evidence lives in PipelineArtifact payloads
-- (artifactType: "article_enrichment_*"); only cheap summary fields
-- are added to the Article row to keep DB pressure low.
--
-- enrichmentStatus values (plain TEXT, matching existing
-- processingStage/processingStatus pattern — no new enum):
--   INGESTED | ENRICHING | ENRICHED | ENRICHMENT_FAILED |
--   ENRICHMENT_SKIPPED | ENRICHMENT_QUEUED_HEADLESS
-- All fields are nullable / have safe defaults so existing rows are
-- unaffected (existing articles default to "INGESTED").

-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "enrichmentStatus" TEXT NOT NULL DEFAULT 'INGESTED',
ADD COLUMN     "enrichmentStartedAt" TIMESTAMP(3),
ADD COLUMN     "enrichmentFinishedAt" TIMESTAMP(3),
ADD COLUMN     "enrichmentAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "enrichmentMethod" TEXT,
ADD COLUMN     "enrichmentConfidence" DOUBLE PRECISION,
ADD COLUMN     "enrichmentOutcome" JSONB;

-- CreateIndex: supports Agent 2 batch selection (fresh + not-yet-enriched / retryable)
CREATE INDEX "Article_enrichmentStatus_date_idx" ON "Article"("enrichmentStatus", "date");
