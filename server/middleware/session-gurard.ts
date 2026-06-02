// server/middleware/session-guard.ts
import { prisma } from "../utils/prisma";

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);

  // Csak az oldalletöltéseknél futtatjuk, statikus fájloknál és API kéréseknél nem, hogy gyors maradjon
  const isApiRequest = url.pathname.startsWith("/api/");
  const isStaticAsset =
    url.pathname.startsWith("/_nuxt/") || url.pathname.includes(".");
  if (isApiRequest || isStaticAsset) return;

  const token = getCookie(event, "auth_token");
  if (!token) return;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");

    const base64Url = parts[1];
    if (!base64Url) throw new Error("Invalid token payload"); // TS type narrowing

    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
    const userId = payload.userId;

    if (!userId) throw new Error("No user ID");

    // Gyors adatbázis lekérdezés a Prisma segítségével
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!userExists) {
      console.warn(
        `[Sovereign Shield] Törölt felhasználó kiléptetése: ${userId}`,
      );

      deleteCookie(event, "auth_token");
      deleteCookie(event, "session_status");

      if (url.pathname !== "/auth") {
        return sendRedirect(event, "/auth", 302);
      }
    }
  } catch (error) {
    deleteCookie(event, "auth_token");
    deleteCookie(event, "session_status");

    if (url.pathname !== "/auth") {
      return sendRedirect(event, "/auth", 302);
    }
  }
});
