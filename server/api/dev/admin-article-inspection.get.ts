import { createError } from "h3";
import { requireUserId } from "../../utils/require-user";
import { assertRateLimit } from "../../utils/rate-limit";
import { getRequestPrisma } from "../../utils/request-prisma";
import { runAdminArticleInspection } from "../../services/admin-inspection";

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  await assertRateLimit(event, "admin-article-inspection", 30, 60 * 1000);
  const db = getRequestPrisma(event as unknown as { context?: Record<string, unknown> });
  const query = getQuery(event);
  // Snapshot tokens are transported ONLY in the bounded POST body. A token in
  // a GET URL could be rejected by request-line limits before application
  // validation, so the unsafe transport is refused outright.
  if (typeof query.snapshot === "string" && query.snapshot.length > 0) {
    throw createError({ statusCode: 400, statusMessage: "Inspection snapshot tokens must be sent in the POST body." });
  }
  return runAdminArticleInspection(db, userId, query);
});
