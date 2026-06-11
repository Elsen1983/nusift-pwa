/*
  Warnings:

  - You are about to drop the column `source` on the `Article` table. All the data in the column will be lost.
  - Added the required column `sourceId` to the `Article` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Article" DROP COLUMN "source",
ADD COLUMN     "sourceId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "NewsSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
