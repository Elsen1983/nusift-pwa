-- Agent 3: durable per-article enrichment claims.
-- A unique articleId permits only one active worker lease per article.
-- Expired rows are explicitly removed by Agent 3 recovery before selection.

CREATE TABLE "ArticleEnrichmentClaim" (
    "articleId" INTEGER NOT NULL,
    "pipelineRunId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "expectedStatus" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleEnrichmentClaim_pkey" PRIMARY KEY ("articleId"),
    CONSTRAINT "ArticleEnrichmentClaim_token_key" UNIQUE ("token"),
    CONSTRAINT "ArticleEnrichmentClaim_articleId_fkey"
      FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ArticleEnrichmentClaim_expiresAt_idx"
  ON "ArticleEnrichmentClaim"("expiresAt");

CREATE INDEX "ArticleEnrichmentClaim_pipelineRunId_idx"
  ON "ArticleEnrichmentClaim"("pipelineRunId");
