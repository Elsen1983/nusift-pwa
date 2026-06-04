/*
  Warnings:

  - A unique constraint covering the columns `[verificationToken]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[resetPasswordToken]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[oauthId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[stripeCustomerId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[stripeSubscriptionId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[paypalSubscriptionId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[appleTransactionId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[googlePurchaseToken]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "RssStatus" AS ENUM ('ACTIVE', 'FAILED', 'PENDING_DISCOVERY', 'NO_RSS_FOUND', 'DOMAIN_DEAD');

-- CreateEnum
CREATE TYPE "UserTier" AS ENUM ('FREE', 'PRO');

-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('NONE', 'STRIPE', 'PAYPAL', 'APPLE_IAP', 'GOOGLE_PLAY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('INACTIVE', 'ACTIVE', 'CANCELED', 'PAST_DUE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "appleProductId" TEXT,
ADD COLUMN     "appleTransactionId" TEXT,
ADD COLUMN     "billingProvider" "BillingProvider" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "currentPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "googleProductId" TEXT,
ADD COLUMN     "googlePurchaseToken" TEXT,
ADD COLUMN     "oauthId" TEXT,
ADD COLUMN     "oauthProvider" TEXT,
ADD COLUMN     "onboardingStep" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paypalPlanId" TEXT,
ADD COLUMN     "paypalSubscriptionId" TEXT,
ADD COLUMN     "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "primaryRegion" TEXT,
ADD COLUMN     "resetPasswordExpires" TIMESTAMP(3),
ADD COLUMN     "resetPasswordToken" TEXT,
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripePriceId" TEXT,
ADD COLUMN     "stripeSubscriptionId" TEXT,
ADD COLUMN     "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'INACTIVE',
ADD COLUMN     "tier" "UserTier" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "topInterests" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "verificationToken" TEXT,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "nickname" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "avatarUrl" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "phoneNumber" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "stateRegion" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "vatNumber" TEXT,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsSource" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isSystemImported" BOOLEAN NOT NULL DEFAULT false,
    "mediaName" TEXT NOT NULL,
    "mediaType" TEXT,
    "language" TEXT,
    "location" TEXT,
    "continent" TEXT,
    "countryCode" TEXT,
    "frontPageUrl" TEXT NOT NULL,
    "detailPageUrl" TEXT,
    "aboutPageUrl" TEXT,
    "contactPageUrl" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "rssFeedUrl" TEXT,
    "rssStatus" "RssStatus" NOT NULL DEFAULT 'PENDING_DISCOVERY',
    "lastRssCheckAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),

    CONSTRAINT "NewsSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceCategory" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "newsSourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pathUrl" TEXT NOT NULL,
    "isUserRequested" BOOLEAN NOT NULL DEFAULT false,
    "rssFeedUrl" TEXT,
    "rssStatus" "RssStatus" NOT NULL DEFAULT 'PENDING_DISCOVERY',
    "lastRssCheckAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),

    CONSTRAINT "SourceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSourceSubscription" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "customAlias" TEXT,

    CONSTRAINT "UserSourceSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCategorySubscription" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "customAlias" TEXT,

    CONSTRAINT "UserCategorySubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "isPaywall" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[],
    "signals" TEXT[],
    "reasoning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleRating" (
    "id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "articleId" INTEGER NOT NULL,

    CONSTRAINT "ArticleRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bookmark" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "articleId" INTEGER NOT NULL,
    "folder" TEXT,

    CONSTRAINT "Bookmark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentScanLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceId" TEXT,
    "categoryId" TEXT,
    "status" TEXT NOT NULL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "executionTimeMs" INTEGER NOT NULL,
    "errorLog" TEXT,

    CONSTRAINT "AgentScanLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserReadActivity" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "articleId" INTEGER NOT NULL,
    "actionType" TEXT NOT NULL,
    "readTimeSec" INTEGER,

    CONSTRAINT "UserReadActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_nickname_key" ON "UserProfile"("nickname");

-- CreateIndex
CREATE UNIQUE INDEX "NewsSource_frontPageUrl_key" ON "NewsSource"("frontPageUrl");

-- CreateIndex
CREATE INDEX "NewsSource_continent_countryCode_idx" ON "NewsSource"("continent", "countryCode");

-- CreateIndex
CREATE INDEX "NewsSource_rssStatus_nextRetryAt_idx" ON "NewsSource"("rssStatus", "nextRetryAt");

-- CreateIndex
CREATE INDEX "SourceCategory_isUserRequested_idx" ON "SourceCategory"("isUserRequested");

-- CreateIndex
CREATE INDEX "SourceCategory_rssStatus_nextRetryAt_idx" ON "SourceCategory"("rssStatus", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceCategory_newsSourceId_pathUrl_key" ON "SourceCategory"("newsSourceId", "pathUrl");

-- CreateIndex
CREATE INDEX "UserSourceSubscription_userId_isActive_idx" ON "UserSourceSubscription"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "UserSourceSubscription_userId_sourceId_key" ON "UserSourceSubscription"("userId", "sourceId");

-- CreateIndex
CREATE INDEX "UserCategorySubscription_userId_isActive_idx" ON "UserCategorySubscription"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "UserCategorySubscription_userId_categoryId_key" ON "UserCategorySubscription"("userId", "categoryId");

-- CreateIndex
CREATE INDEX "Article_date_idx" ON "Article"("date");

-- CreateIndex
CREATE INDEX "ArticleRating_userId_idx" ON "ArticleRating"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleRating_userId_articleId_key" ON "ArticleRating"("userId", "articleId");

-- CreateIndex
CREATE UNIQUE INDEX "Bookmark_userId_articleId_key" ON "Bookmark"("userId", "articleId");

-- CreateIndex
CREATE UNIQUE INDEX "User_verificationToken_key" ON "User"("verificationToken");

-- CreateIndex
CREATE UNIQUE INDEX "User_resetPasswordToken_key" ON "User"("resetPasswordToken");

-- CreateIndex
CREATE UNIQUE INDEX "User_oauthId_key" ON "User"("oauthId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeSubscriptionId_key" ON "User"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "User_paypalSubscriptionId_key" ON "User"("paypalSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "User_appleTransactionId_key" ON "User"("appleTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "User_googlePurchaseToken_key" ON "User"("googlePurchaseToken");

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceCategory" ADD CONSTRAINT "SourceCategory_newsSourceId_fkey" FOREIGN KEY ("newsSourceId") REFERENCES "NewsSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSourceSubscription" ADD CONSTRAINT "UserSourceSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSourceSubscription" ADD CONSTRAINT "UserSourceSubscription_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "NewsSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCategorySubscription" ADD CONSTRAINT "UserCategorySubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCategorySubscription" ADD CONSTRAINT "UserCategorySubscription_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "SourceCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleRating" ADD CONSTRAINT "ArticleRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleRating" ADD CONSTRAINT "ArticleRating_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReadActivity" ADD CONSTRAINT "UserReadActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
