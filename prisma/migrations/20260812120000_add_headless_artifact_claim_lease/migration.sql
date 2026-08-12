ALTER TABLE "PipelineArtifact"
ADD COLUMN "headlessClaimToken" TEXT,
ADD COLUMN "headlessClaimExpiresAt" TIMESTAMP(3);

CREATE INDEX "PipelineArtifact_artifactType_status_headlessClaimExpiresAt_idx"
ON "PipelineArtifact"("artifactType", "status", "headlessClaimExpiresAt");
