import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { getRequestPrisma } from "../../utils/request-prisma";
import {
  GOVERNANCE_DIAGNOSTICS_DEFAULT_LIMIT,
  GOVERNANCE_DIAGNOSTICS_MAX_LIMIT,
  GOVERNANCE_DIAGNOSTICS_MAX_ARTIFACT_SCAN,
  loadGovernanceDiagnostics,
} from "../../utils/news-pipeline/governance-observability";

const parseBoundedInteger = (value: unknown, fallback: number, maximum: number): number => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  return Math.min(maximum, Math.max(1, Number.parseInt(value, 10)));
};

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "domain-governance-diagnostics", 10, 60 * 1000);

  const query = getQuery(event);
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const limit = parseBoundedInteger(query.limit, GOVERNANCE_DIAGNOSTICS_DEFAULT_LIMIT, GOVERNANCE_DIAGNOSTICS_MAX_LIMIT);
  const scanCap = parseBoundedInteger(query.scanCap, GOVERNANCE_DIAGNOSTICS_MAX_ARTIFACT_SCAN, GOVERNANCE_DIAGNOSTICS_MAX_ARTIFACT_SCAN);

  try {
    return await loadGovernanceDiagnostics(getRequestPrisma(event) as never, { cursor, limit, scanCap });
  } catch (error) {
    if (error instanceof Error && /Invalid governance diagnostics cursor/.test(error.message)) {
      throw createError({ statusCode: 400, statusMessage: "Invalid governance diagnostics cursor." });
    }
    throw error;
  }
});
