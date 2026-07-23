import "./load-env";
import { prisma } from "../../server/utils/prisma";
import { processArticleDiscoveryHeadlessQueue } from "../../server/utils/news-pipeline/article-discovery-headless-queue";

const parseArgs = () => {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match?.[1] && match[2] !== undefined) args.set(match[1], match[2]);
  }
  return args;
};

const readNumber = (args: Map<string, string>, key: string, fallback: number) => {
  const raw = args.get(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
};

const readBoolean = (args: Map<string, string>, key: string, fallback: boolean) => {
  const raw = args.get(key);
  if (raw == null) return fallback;
  return raw.trim().toLowerCase() === "true";
};

const args = parseArgs();

const input = {
  limit: readNumber(args, "limit", 3),
  dryRun: readBoolean(args, "dryRun", false),
  runBrowser: readBoolean(args, "runBrowser", true),
};

try {
  const result = await processArticleDiscoveryHeadlessQueue(input);
  console.log(JSON.stringify({
    ok: true,
    agent: "A2",
    mode: "headless_queue",
    input,
    result,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
