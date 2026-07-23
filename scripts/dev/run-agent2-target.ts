import "./load-env";
import { prisma } from "../../server/utils/prisma";
import { runAgent2TargetDebug, type Agent2TargetInput } from "../../server/utils/news-pipeline/agent2-dev-parity";

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
const targetUrl = args.get("targetUrl");

if (!sourceId && !targetUrl) {
  console.error("Missing required --sourceId=<id> or --targetUrl=<url>");
  process.exit(1);
}

const input: Agent2TargetInput = {
  sourceId: sourceId || null,
  categoryId: args.get("categoryId") || null,
  targetUrl: targetUrl || null,
  mode: (args.get("mode") as Agent2TargetInput["mode"]) || "static",
  persist: args.get("persist") === "true",
};

try {
  const result = await runAgent2TargetDebug(input);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await prisma.$disconnect();
}
