import { createError } from "h3";
import { prisma } from "../utils/prisma";
import { verifySessionToken } from "../utils/auth";

function clearSessionCookies(event: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(event, "auth_token");
  deleteCookie(event, "session_status");
}

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);
  const isStaticAsset = url.pathname.startsWith("/_nuxt/") || url.pathname.includes(".");
  if (isStaticAsset) return;

  const token = getCookie(event, "auth_token");
  if (!token) return;

  let payload: ReturnType<typeof verifySessionToken>;
  try {
    payload = verifySessionToken(token);
  } catch (error: any) {
    console.warn(`[Sovereign Shield] Session token rejected: ${error?.message || error}`);
    clearSessionCookies(event);

    if (!url.pathname.startsWith("/api/") && url.pathname !== "/auth") {
      return sendRedirect(event, "/auth", 302);
    }
    return;
  }

  let userExists: { id: string; tokenVersion: number } | null;
  try {
    userExists = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, tokenVersion: true },
    });
  } catch (error: any) {
    console.error(`[Sovereign Shield] Session authority unavailable: ${error?.message || error}`);
    throw createError({
      statusCode: 503,
      statusMessage: "Session authority temporarily unavailable.",
    });
  }

  if (!userExists || userExists.tokenVersion !== payload.tokenVersion) {
    console.warn(`[Sovereign Shield] Invalid or revoked session: ${payload.userId}`);
    clearSessionCookies(event);

    if (!url.pathname.startsWith("/api/") && url.pathname !== "/auth") {
      return sendRedirect(event, "/auth", 302);
    }
    return;
  }

  event.context.user = { id: payload.userId };
});
