import { createError, type H3Event } from "h3";
import { getRequestPrisma } from "./request-prisma";
import { getBootstrapAdminEmails } from "./admin";
import { requireUserId } from "./require-user";

export type InspectionAdminDb = {
  user: { findUnique: (args: any) => Promise<{ email: string | null } | null> };
};

/**
 * Framework-independent inspection authorization core (Prompt 13H).
 *
 * Access is granted only when the authenticated user's current database email
 * is present in NUXT_ADMIN_EMAILS. Role and client claims are not sufficient,
 * and client-supplied email in headers/body/query is never read. This function
 * is used by the H3 event wrapper below and directly by the admin-inspection
 * service functions, so production handlers and the PostgreSQL application
 * isolation integration test exercise the exact same authorization logic.
 */
export async function requireInspectionAdminForUser(
  db: InspectionAdminDb,
  userId: string,
): Promise<string> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const configured = user?.email
    ? getBootstrapAdminEmails().has(user.email.trim().toLowerCase())
    : false;

  if (!configured) {
    throw createError({ statusCode: 403, statusMessage: "Admin access required." });
  }

  return userId;
}

/**
 * Prompt 13 authorization boundary for H3 handlers: resolves the session user
 * ID, then applies the same database-email authority as the service layer.
 */
export async function requireInspectionAdmin(event: H3Event): Promise<string> {
  const userId = requireUserId(event);
  const db = getRequestPrisma(event as unknown as { context?: Record<string, unknown> });
  return requireInspectionAdminForUser(db as InspectionAdminDb, userId);
}
