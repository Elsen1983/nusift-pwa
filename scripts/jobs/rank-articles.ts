import "dotenv/config";
import { prisma } from "../../server/utils/prisma";
import { rankPendingArticles } from "../../server/utils/ranking/rank-articles";

function readArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || !process.argv[idx + 1]) return fallback;
  return process.argv[idx + 1]!;
}

async function main() {
  const articleLimit = Number(readArg("--article-limit", "100"));

  const run = await prisma.rankJob.create({
    data: { jobType: "HEURISTIC_RANK", startedAt: new Date() },
  });

  try {
    const stats = await rankPendingArticles({ articleLimit });
    await prisma.rankJob.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        articlesProcessed: stats.articlesProcessed,
        usersProcessed: stats.usersProcessed,
        ranksWritten: stats.ranksWritten,
        errors: stats.errors,
        errorLog: stats.errorLines.length ? stats.errorLines.join("\n") : null,
      },
    });

    console.log(
      `[rank-articles] articles=${stats.articlesProcessed} users=${stats.usersProcessed} ranks=${stats.ranksWritten} errors=${stats.errors}`,
    );
    process.exit(stats.errors > 0 && stats.ranksWritten === 0 ? 1 : 0);
  } catch (error) {
    await prisma.rankJob.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        errors: 1,
        errorLog: String(error),
      },
    });
    console.error("[rank-articles] fatal", error);
    process.exit(2);
  } finally {
    await prisma.$disconnect();
  }
}

void main();