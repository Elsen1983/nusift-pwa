import { createError, deleteCookie, getCookie, type H3Event } from "h3";
import { verifySessionToken } from "./auth";
import { prisma } from "./prisma";

/**
 * Resolve the authenticated user id for a request.
 * Validates JWT signature and tokenVersion against the database so revoked
 * sessions (e.g. after password reset) cannot access protected endpoints.
 */
export async function requireUserId(event: H3Event): Promise<string> {
  if (event?.context?.user?.id) {
    return event.context.user.id;
  }

  const token = getCookie(event, "auth_token");
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }

  const payload = verifySessionToken(token);
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, tokenVersion: true },
  });

  if (!user || user.tokenVersion !== payload.tokenVersion) {
    deleteCookie(event, "auth_token");
    deleteCookie(event, "session_status");
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }

  event.context.user = { id: user.id };
  return user.id;
}