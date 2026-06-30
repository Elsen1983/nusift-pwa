import "dotenv/config";
import { prisma } from "../../server/utils/prisma";
import { ingestActiveFeeds } from "../../server/utils/rss-ingest";

function readArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || !process.argv[idx + 1]) return fallback;
  return process.argv[idx + 1]!;
}

async function main() {
  const limit = Number(readArg("--limit", "50"));
  const lookbackHours = Number(readArg("--lookback-hours", "72"));

  const run = await prisma.ingestRun.create({
    data: { jobType: "RSS_POLL", startedAt: new Date() },
  });

  try {
    const stats = await ingestActiveFeeds({ limit, lookbackHours });
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        sourcesTried: stats.sourcesTried,
        articlesNew: stats.articlesNew,
        articlesSkipped: stats.articlesSkipped,
        errors: stats.errors,
        errorLog: stats.errorLines.length ? stats.errorLines.join("\n") : null,
      },
    });

    console.log(
      `[ingest-rss] feeds=${stats.sourcesTried} new=${stats.articlesNew} skipped=${stats.articlesSkipped} errors=${stats.errors}`,
    );
    process.exit(stats.errors > 0 && stats.articlesNew === 0 ? 1 : 0);
  } catch (error) {
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        errors: 1,
        errorLog: String(error),
      },
    });
    console.error("[ingest-rss] fatal", error);
    process.exit(2);
  } finally {
    await prisma.$disconnect();
  }
}

void main();