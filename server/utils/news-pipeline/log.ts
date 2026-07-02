import { prisma } from "../prisma";

export async function logAgentScan(input: {
  status: string;
  executionTimeMs: number;
  sourceId?: string | null;
  categoryId?: string | null;
  errorLog?: string | null;
}) {
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
