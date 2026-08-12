-- Add a queryable eligibility boundary for durable headless queue work.
ALTER TABLE "PipelineArtifact"
ADD COLUMN "nextEligibleAt" TIMESTAMP(3);

CREATE INDEX "PipelineArtifact_artifactType_status_nextEligibleAt_createdAt_idx"
ON "PipelineArtifact"("artifactType", "status", "nextEligibleAt", "createdAt");
