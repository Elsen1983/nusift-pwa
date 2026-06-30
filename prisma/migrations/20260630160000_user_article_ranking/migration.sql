-- CreateTable
CREATE TABLE "UserArticleRank" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "articleId" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "reasoning" TEXT,
    "signals" TEXT[],
    "rankedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserArticleRank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankJob" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "articlesProcessed" INTEGER NOT NULL DEFAULT 0,
    "usersProcessed" INTEGER NOT NULL DEFAULT 0,
    "ranksWritten" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "errorLog" TEXT,

    CONSTRAINT "RankJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserArticleRank_userId_score_idx" ON "UserArticleRank"("userId", "score");

-- CreateIndex
CREATE INDEX "UserArticleRank_articleId_idx" ON "UserArticleRank"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserArticleRank_userId_articleId_key" ON "UserArticleRank"("userId", "articleId");

-- AddForeignKey
ALTER TABLE "UserArticleRank" ADD CONSTRAINT "UserArticleRank_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserArticleRank" ADD CONSTRAINT "UserArticleRank_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;