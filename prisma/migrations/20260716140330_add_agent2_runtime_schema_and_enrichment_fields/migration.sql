-- DropForeignKey
ALTER TABLE "NewsSource" DROP CONSTRAINT IF EXISTS "NewsSource_feedSubmittedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "SourceCategory" DROP CONSTRAINT IF EXISTS "SourceCategory_feedSubmittedByUserId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "User_role_idx";
