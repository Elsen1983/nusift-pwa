-- DropForeignKey
ALTER TABLE "NewsSource" DROP CONSTRAINT "NewsSource_feedSubmittedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "SourceCategory" DROP CONSTRAINT "SourceCategory_feedSubmittedByUserId_fkey";

-- DropIndex
DROP INDEX "User_role_idx";

-- RenameIndex
ALTER INDEX "PipelineArtifact_artifactType_status_nextEligibleAt_createdAt_i" RENAME TO "PipelineArtifact_artifactType_status_nextEligibleAt_created_idx";

-- RenameIndex
ALTER INDEX "PipelineArtifact_orchestrationRunId_sourceId_categoryId_created" RENAME TO "PipelineArtifact_orchestrationRunId_sourceId_categoryId_cre_idx";
