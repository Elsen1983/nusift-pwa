-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('INGESTED', 'NEEDS_RANKING', 'RANKED', 'FAILED');

-- AlterTable
ALTER TABLE "Article" ADD COLUMN "canonicalUrl" TEXT;
ALTER TABLE "Article" ADD COLUMN "guid" TEXT;
ALTER TABLE "Article" ADD COLUMN "summary" TEXT;
ALTER TABLE "Article" ADD COLUMN "author" TEXT;
ALTER TABLE "Article" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "Article" ADD COLUMN "ingestStatus" "IngestStatus" NOT NULL DEFAULT 'NEEDS_RANKING';

-- Backfill canonicalUrl for any existing rows (dev safety)
UPDATE "Article" SET "canonicalUrl" = 'legacy:' || id::text WHERE "canonicalUrl" IS NULL;

ALTER TABLE "Article" ALTER COLUMN "canonicalUrl" SET NOT NULL;
ALTER TABLE "Article" ADD CONSTRAINT "Article_canonicalUrl_key" UNIQUE ("canonicalUrl");

-- AlterTable default score
ALTER TABLE "Article" ALTER COLUMN "score" SET DEFAULT 5;

-- CreateIndex
CREATE INDEX "Article_sourceId_date_idx" ON "Article"("sourceId", "date");
CREATE INDEX "Article_categoryId_date_idx" ON "Article"("categoryId", "date");
CREATE INDEX "Article_ingestStatus_idx" ON "Article"("ingestStatus");

-- CreateTable
CREATE TABLE "FeedItemCursor" (
    "id" TEXT NOT NULL,
    "feedUrl" TEXT NOT NULL,
    "sourceId" TEXT,
    "categoryId" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "lastItemDate" TIMESTAMP(3),
    "etag" TEXT,
    "lastModified" TEXT,
    CONSTRAINT "FeedItemCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeedItemCursor_feedUrl_key" ON "FeedItemCursor"("feedUrl");

-- CreateTable
CREATE TABLE "IngestRun" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "sourcesTried" INTEGER NOT NULL DEFAULT 0,
    "articlesNew" INTEGER NOT NULL DEFAULT 0,
    "articlesSkipped" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "errorLog" TEXT,
    CONSTRAINT "IngestRun_pkey" PRIMARY KEY ("id")
);