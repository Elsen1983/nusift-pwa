ALTER TABLE "PipelineArtifact"
ADD COLUMN "orchestrationRunId" TEXT;

CREATE INDEX "PipelineArtifact_orchestrationRunId_sourceId_categoryId_createdAt_idx"
ON "PipelineArtifact"("orchestrationRunId", "sourceId", "categoryId", "createdAt");

ALTER TABLE "PipelineArtifact"
ADD CONSTRAINT "PipelineArtifact_orchestrationRunId_fkey"
FOREIGN KEY ("orchestrationRunId") REFERENCES "PipelineRun"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
