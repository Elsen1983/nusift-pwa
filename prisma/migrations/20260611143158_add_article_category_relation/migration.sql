-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "categoryId" TEXT;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "SourceCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
