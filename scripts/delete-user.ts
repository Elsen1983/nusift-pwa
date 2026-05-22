// scripts/delete-user.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function deleteUserAndCleanUp(email: string) {
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.warn(`[Abort] User not found with email: ${email}`);
      return;
    }

    console.log(`[Start] User found (ID: ${user.id}). Initiating cleanup...`);

    // 1. Store subscription IDs in memory before the cascade wipes them
    const userSources = await prisma.userSourceSubscription.findMany({ where: { userId: user.id } });
    const userCategories = await prisma.userCategorySubscription.findMany({ where: { userId: user.id } });

    const sourceIdsToCheck = [...new Set(userSources.map(s => s.sourceId))];
    const categoryIdsToCheck = [...new Set(userCategories.map(c => c.categoryId))];

    // 2. Delete User (Cascade automatically handles UserSourceSubscription and UserCategorySubscription)
    console.log(`[Delete] Removing user and associated subscriptions...`);
    await prisma.user.delete({ where: { id: user.id } });

    // 3. Orphaned Category Cleanup
    let deletedCategories = 0;
    for (const catId of categoryIdsToCheck) {
      const remainingSubs = await prisma.userCategorySubscription.count({ where: { categoryId: catId } });
      if (remainingSubs === 0) {
        await prisma.sourceCategory.delete({ where: { id: catId } });
        deletedCategories++;
      }
    }
    console.log(`[Cleanup] ${deletedCategories} orphaned SourceCategories removed.`);

    // 4. Orphaned NewsSource Cleanup (Protected by isSystemImported flag)
    let deletedSources = 0;
    let protectedSources = 0;

    for (const sourceId of sourceIdsToCheck) {
      const remainingRootSubs = await prisma.userSourceSubscription.count({ where: { sourceId } });
      const remainingCategories = await prisma.sourceCategory.count({ where: { newsSourceId: sourceId } });
      
      // If no users are subscribed to the root AND no sub-categories exist
      if (remainingRootSubs === 0 && remainingCategories === 0) {
        const source = await prisma.newsSource.findUnique({ 
          where: { id: sourceId },
          select: { isSystemImported: true } 
        });

        if (source) {
          // The Boundary Check
          if (source.isSystemImported === false) {
            await prisma.newsSource.delete({ where: { id: sourceId } });
            deletedSources++;
          } else {
            protectedSources++;
          }
        }
      }
    }
    console.log(`[Cleanup] ${deletedSources} orphaned user-added NewsSources removed.`);
    console.log(`[Cleanup] ${protectedSources} system-imported NewsSources preserved.`);
    console.log(`[Complete] Data for ${email} has been successfully purged.`);

  } catch (error) {
    console.error('[Error] Deletion process failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// CLI Execution handler
const targetEmail = process.argv[2];
if (!targetEmail) {
  console.log('Usage: npx ts-node scripts/delete-user.ts <email>');
  process.exit(1);
}

deleteUserAndCleanUp(targetEmail);

// to run it: npx ts-node scripts/delete-user.ts user@example.com (replace with actual email to delete)