import "dotenv/config";
import { RssStatus } from "@prisma/client";
import { prisma } from "../../server/utils/prisma";
import { executeTargetedDiscovery } from "../../server/utils/discovery";

async function main() {
  const limit = Number(process.argv.includes("--limit")
    ? process.argv[process.argv.indexOf("--limit") + 1]
    : "20");

  const pending = await prisma.newsSource.findMany({
    where: { rssStatus: RssStatus.PENDING_DISCOVERY },
    take: limit,
    select: { id: true },
  });

  if (pending.length === 0) {
    console.log("[discover-pending] nothing to scan");
    await prisma.$disconnect();
    return;
  }

  const run = await prisma.ingestRun.create({
    data: { jobType: "DISCOVERY", startedAt: new Date() },
  });

  try {
    await executeTargetedDiscovery(pending.map((s) => s.id));
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        sourcesTried: pending.length,
      },
    });
    console.log(`[discover-pending] scanned=${pending.length}`);
  } catch (error) {
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        sourcesTried: pending.length,
        errors: 1,
        errorLog: String(error),
      },
    });
    console.error("[discover-pending] fatal", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

void main();