import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";
import { getRequestPrisma } from "../../utils/request-prisma";
import { runAdminSourceInspection } from "../../services/admin-inspection";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  await assertRateLimit(event, "admin-source-inspection", 30, 60 * 1000);
  const db = getRequestPrisma(event as unknown as { context?: Record<string, unknown> });
  return runAdminSourceInspection(db, userId, getQuery(event));
});
