import { prisma } from "../utils/prisma";
import { requireUserId } from "../utils/require-user";
import { loadUserFeed } from "../services/user-feed";

/**
 * Production feed handler.
 *
 * The query logic lives in the shared user-feed service. The production
 * handler deliberately calls the service with the process-global Prisma client
 * (previous production behavior), while integration tests call the same
 * service with an isolated schema-scoped client. Request-scoped Prisma is used
 * only by the admin-inspection dev endpoints, where isolated-client injection
 * is justified for integration testing.
 */
export default defineEventHandler(async (event) => {
  const userId = requireUserId(event);
  return loadUserFeed(prisma, userId);
});
