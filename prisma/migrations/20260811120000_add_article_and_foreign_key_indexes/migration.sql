-- Supporting indexes for Article feed filters and foreign-key actions.
CREATE INDEX "UserSourceSubscription_sourceId_idx" ON "UserSourceSubscription"("sourceId");
CREATE INDEX "UserCategorySubscription_categoryId_idx" ON "UserCategorySubscription"("categoryId");
CREATE INDEX "Article_sourceId_date_idx" ON "Article"("sourceId", "date");
CREATE INDEX "Article_categoryId_date_idx" ON "Article"("categoryId", "date");
CREATE INDEX "ArticleRating_articleId_idx" ON "ArticleRating"("articleId");
CREATE INDEX "Bookmark_articleId_idx" ON "Bookmark"("articleId");
CREATE INDEX "UserReadActivity_userId_idx" ON "UserReadActivity"("userId");
CREATE INDEX "UserReadActivity_articleId_idx" ON "UserReadActivity"("articleId");
CREATE INDEX "FeedReviewRequest_resolvedByUserId_idx" ON "FeedReviewRequest"("resolvedByUserId");
