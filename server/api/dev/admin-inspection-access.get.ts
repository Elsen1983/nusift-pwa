import { requireUserId } from "../../utils/require-user";
import { getRequestPrisma } from "../../utils/request-prisma";
import { runAdminInspectionAccess } from "../../services/admin-inspection";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  const db = getRequestPrisma(event as unknown as { context?: Record<string, unknown> });
  return runAdminInspectionAccess(db, userId);
});
