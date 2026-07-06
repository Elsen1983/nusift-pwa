import { prisma } from "../prisma";

const VERBOSE_PIPELINE_LOGS = process.env.NUXT_PIPELINE_VERBOSE_LOGS === "true";

const ESSENTIAL_AGENT_LOG_STATUSES = new Set([
  "PIPELINE_STARTED",
  "PIPELINE_FINISHED",
  "SOURCE_NOT_FOUND",
  "SOURCE_FETCH_EXCEPTION",
  "SOURCE_FETCH_BLOCKED_SECURITY",
  "HTML_FALLBACK_EXCEPTION",
  "ARTICLE_INSERT_FAILED",
  "RSS_REIMPORT_STARTED",
  "RSS_REIMPORT_FINISHED",
  "SCOPED_RSS_AUDIT_STARTED",
  "SCOPED_RSS_AUDIT_FINISHED",
]);

const isPersistedAgentLogStatus = (status: string) =>
  VERBOSE_PIPELINE_LOGS || ESSENTIAL_AGENT_LOG_STATUSES.has(status);

export async function logAgentScan(input: {
  status: string;
  executionTimeMs: number;
  sourceId?: string | null;
  categoryId?: string | null;
  errorLog?: string | null;
}) {
  if (!isPersistedAgentLogStatus(input.status)) {
    return;
  }

  await prisma.agentScanLog.create({
    data: {
      sourceId: input.sourceId || null,
      categoryId: input.categoryId || null,
      status: input.status,
      executionTimeMs: input.executionTimeMs,
      errorLog: input.errorLog || null,
    },
  });
}
