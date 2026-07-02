/*
  Warnings:

  - A unique constraint covering the columns `[sourceUrl]` on the table `Article` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[canonicalUrl]` on the table `Article` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[rssGuid]` on the table `Article` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[contentHash]` on the table `Article` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "bodyText" TEXT,
ADD COLUMN     "canonicalUrl" TEXT,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "processingStage" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "processingStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "rssGuid" TEXT,
ADD COLUMN     "sourceUrl" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Article_sourceUrl_key" ON "Article"("sourceUrl");

-- CreateIndex
CREATE UNIQUE INDEX "Article_canonicalUrl_key" ON "Article"("canonicalUrl");

-- CreateIndex
CREATE UNIQUE INDEX "Article_rssGuid_key" ON "Article"("rssGuid");

-- CreateIndex
CREATE UNIQUE INDEX "Article_contentHash_key" ON "Article"("contentHash");
