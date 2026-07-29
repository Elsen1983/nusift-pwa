/**
 * run-agent3-batch.ts
 *
 * Dev runner for Agent 3 article enrichment batch.
 * Processes eligible articles in a bounded batch with optional browser fallback.
 *
 * Usage:
 *   npx tsx scripts/dev/run-agent3-batch.ts [--maxArticles=10] [--includeEnriched=false] [--forceReprocess=false] [--browserFallback=false] [--browserFallbackMaxAttempts=3] [--browserTimeoutMs=25000]
 *
 * Run inside Docker for production parity:
 *   npm run agent3:docker -- --maxArticles=10 --browserFallback=true --browserFallbackMaxAttempts=3
 */

import "./load-env";
import { prisma } from "../../server/utils/prisma";
import { runEnrichmentBatch } from "../../server/utils/news-pipeline/enrichment-runtime";

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
  maxArticles: readNumber(args, "maxArticles", 10),
  includeEnriched: readBoolean(args, "includeEnriched", false),
  forceReprocess: readBoolean(args, "forceReprocess", false),
  browserFallback: readBoolean(args, "browserFallback", false),
  browserFallbackMaxAttempts: readNumber(args, "browserFallbackMaxAttempts", 3),
  browserTimeoutMs: readNumber(args, "browserTimeoutMs", 25_000),
};

try {
  const result = await runEnrichmentBatch(input);
  const byKind = result.persist.byKind;
  const successfullyEnriched = byKind.SUCCESS ?? 0;
  const rejected = Object.entries(byKind)
    .filter(([k]) => k !== "SUCCESS" && k !== "SKIPPED")
    .reduce((sum, [, v]) => sum + (v as number), 0);

  console.log(JSON.stringify({
    ok: true,
    agent: "A3",
    mode: "batch",
    runId: result.pipelineRunId,
    articlesProcessed: result.articleCount,
    persisted: result.persist.persisted,
    failed: result.persist.failed,
    successfullyEnriched,
    rejected,
    byKind,
    optionsUsed: result.optionsUsed,
    browserFallbackStats: result.browserFallbackStats ?? null,
    input,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
