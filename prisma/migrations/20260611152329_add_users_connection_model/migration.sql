-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'BLOCKED');

-- CreateTable
CREATE TABLE "UsersConnection" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "UsersConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsersConnection_requesterId_status_idx" ON "UsersConnection"("requesterId", "status");

-- CreateIndex
CREATE INDEX "UsersConnection_addresseeId_status_idx" ON "UsersConnection"("addresseeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UsersConnection_requesterId_addresseeId_key" ON "UsersConnection"("requesterId", "addresseeId");

-- AddForeignKey
ALTER TABLE "UsersConnection" ADD CONSTRAINT "UsersConnection_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsersConnection" ADD CONSTRAINT "UsersConnection_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReadActivity" ADD CONSTRAINT "UserReadActivity_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;
