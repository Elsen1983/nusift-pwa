// server/middleware/session-guard.ts
import { prisma } from "../utils/prisma";
import { verifySessionToken } from "../utils/auth";

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);

  // Statikus fájlokat ignoráljuk
  const isStaticAsset = url.pathname.startsWith("/_nuxt/") || url.pathname.includes(".");
  if (isStaticAsset) return;

  const token = getCookie(event, "auth_token");
  if (!token) return;

  try {
    const payload = verifySessionToken(token);

    const userExists = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, tokenVersion: true },
    });

    if (!userExists || userExists.tokenVersion !== payload.tokenVersion) {
      console.warn(`[Sovereign Shield] Érvénytelen vagy visszavont session: ${payload.userId}`);
      deleteCookie(event, "auth_token");
      deleteCookie(event, "session_status");

      if (url.pathname.startsWith("/api/")) {
        return;
      }

      if (url.pathname !== "/auth") {
        return sendRedirect(event, "/auth", 302);
      }

      return;
    }

    event.context.user = { id: payload.userId };
  } catch (error) {
    deleteCookie(event, "auth_token");
    deleteCookie(event, "session_status");

    if (url.pathname.startsWith("/api/")) {
      return;
    }

    if (url.pathname !== "/auth") {
      return sendRedirect(event, "/auth", 302);
    }

    return;
  }
});
