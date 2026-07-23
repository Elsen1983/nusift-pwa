import "./load-env";
import { prisma } from "../../server/utils/prisma";

const query = process.argv.slice(2).find((arg) => arg.startsWith("--query="))?.slice("--query=".length) || "";

if (!query) {
  console.error("Usage: npx tsx scripts/dev/list-agent2-targets.ts --query=<domain-or-path-fragment>");
  process.exit(1);
}

try {
  const sources = await prisma.newsSource.findMany({
    where: {
      OR: [
        { mediaName: { contains: query, mode: "insensitive" } },
        { frontPageUrl: { contains: query, mode: "insensitive" } },
        { categories: { some: { pathUrl: { contains: query, mode: "insensitive" } } } },
      ],
    },
    select: {
      id: true,
      mediaName: true,
      frontPageUrl: true,
      rssStatus: true,
      currentFeedProductive: true,
      consecutiveNonProductiveRuns: true,
      categories: {
        where: { pathUrl: { contains: query, mode: "insensitive" } },
        select: {
          id: true,
          name: true,
          pathUrl: true,
          rssStatus: true,
          currentFeedProductive: true,
          consecutiveNonProductiveRuns: true,
        },
        take: 20,
      },
    },
    take: 20,
  });

  console.log(JSON.stringify({ query, count: sources.length, sources }, null, 2));
} finally {
  await prisma.$disconnect();
}
