import "./load-env";
import { prisma } from "../../server/utils/prisma";
import { runArticleDiscoveryBatch } from "../../server/utils/news-pipeline/article-discovery";

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

const readList = (args: Map<string, string>, key: string) => {
  const raw = args.get(key);
  if (!raw) return undefined;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
};

const args = parseArgs();

const input = {
  sourceIds: readList(args, "sourceIds"),
  categoryIds: readList(args, "categoryIds"),
  maxTargets: readNumber(args, "maxTargets", 5),
  timeBudgetMs: readNumber(args, "timeBudgetMs", 240_000),
  minRemainingMs: readNumber(args, "minRemainingMs", 30_000),
};

try {
  const result = await runArticleDiscoveryBatch(input);
  console.log(JSON.stringify({
    ok: true,
    agent: "A2",
    mode: "batch",
    runId: result.pipelineRunId,
    targetsResolved: result.targets.length,
    processed: result.processed,
    deferred: result.deferred,
    remainingEligible: result.remainingEligible,
    stoppedReason: result.stoppedReason,
    candidates: result.result.candidatesFound,
    inserted: result.result.inserted,
    skipped: result.result.skipped,
    failed: result.result.failed,
    artifacts: result.result.artifactCount || 0,
    input,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
