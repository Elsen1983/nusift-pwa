import { createError } from "h3";
import { prisma } from "../../utils/prisma";
import { verifySessionToken } from "../../utils/auth";
import { getAdminStatusByUserId } from "../../utils/admin";

function clearSessionCookies(event: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(event, "auth_token");
  deleteCookie(event, "session_status");
}

export default defineEventHandler(async (event) => {
  const token = getCookie(event, "auth_token");
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: "No active session." });
  }

  let payload: ReturnType<typeof verifySessionToken>;
  try {
    payload = verifySessionToken(token);
  } catch {
    clearSessionCookies(event);
    throw createError({ statusCode: 401, statusMessage: "Invalid session." });
  }

  let userExists: { id: string; tokenVersion: number } | null;
  try {
    userExists = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, tokenVersion: true },
    });
  } catch (error: any) {
    console.error(`[Sovereign Shield] User validation authority unavailable: ${error?.message || error}`);
    throw createError({
      statusCode: 503,
      statusMessage: "Session authority temporarily unavailable.",
    });
  }

  if (!userExists || userExists.tokenVersion !== payload.tokenVersion) {
    clearSessionCookies(event);
    throw createError({ statusCode: 401, statusMessage: "Invalid or revoked session." });
  }

  try {
    const adminStatus = await getAdminStatusByUserId(payload.userId);
    return { success: true, valid: true, isAdmin: adminStatus.isAdmin };
  } catch (error: any) {
    console.error(`[Sovereign Shield] Admin authority unavailable: ${error?.message || error}`);
    throw createError({
      statusCode: 503,
      statusMessage: "Session authority temporarily unavailable.",
    });
  }
});
