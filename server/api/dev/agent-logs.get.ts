import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { prisma } from "../../utils/prisma";
import { getAgentLogPrefix } from "../../utils/news-pipeline/log";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  await assertRateLimit(event, "agent-logs", 10, 60 * 1000);

  const logs = await prisma.agentScanLog.findMany({
    select: {
      id: true,
      status: true,
      sourceId: true,
      errorLog: true,
      createdAt: true,
      executionTimeMs: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return {
    ok: true,
    logs: logs.map((log) => ({
      ...log,
      agentPrefix: getAgentLogPrefix(log.status),
      displayStatus: `${getAgentLogPrefix(log.status)} - ${log.status}`,
    })),
  };
});
