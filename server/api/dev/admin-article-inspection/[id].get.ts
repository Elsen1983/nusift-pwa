import { requireUserId } from "../../../utils/require-user";
import { assertRateLimit } from "../../../utils/rate-limit";
import { getRequestPrisma } from "../../../utils/request-prisma";
import { runAdminArticleInspectionDetail } from "../../../services/admin-inspection";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  await assertRateLimit(event, "admin-article-inspection-detail", 30, 60 * 1000);
  const db = getRequestPrisma(event as unknown as { context?: Record<string, unknown> });
  const articleId = Number(getRouterParam(event, "id"));
  return runAdminArticleInspectionDetail(db, userId, articleId);
});
