import "./load-env";
import { prisma } from "../../server/utils/prisma";
import { exportAgent2Fixture, type Agent2TargetInput } from "../../server/utils/news-pipeline/agent2-dev-parity";

const parseArgs = () => {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match?.[1] && match[2] !== undefined) args.set(match[1], match[2]);
  }
  return args;
};

const args = parseArgs();
const sourceId = args.get("sourceId");
const out = args.get("out");

if (!sourceId || !out) {
  console.error("Usage: npx tsx scripts/dev/export-agent2-fixture.ts --sourceId=<id> [--categoryId=<id>] --out=data/fixtures/agent2/<slug>.json");
  process.exit(1);
}

const input: Agent2TargetInput & { out: string } = {
  sourceId,
  categoryId: args.get("categoryId") || null,
  targetUrl: args.get("targetUrl") || null,
  out,
};

try {
  const result = await exportAgent2Fixture(input);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await prisma.$disconnect();
}
