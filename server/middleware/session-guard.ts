// server/middleware/session-guard.ts
import { prisma } from "../utils/prisma";
import jwt from 'jsonwebtoken';

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);

  // Statikus fájlokat ignoráljuk
  const isStaticAsset = url.pathname.startsWith("/_nuxt/") || url.pathname.includes(".");
  if (isStaticAsset) return;

  const token = getCookie(event, "auth_token");
  if (!token) return;

  try {
    // Preferált: ellenőrizzük az aláírást, ha van konfigurálva a secret
    const secret = process.env.JWT_SECRET;
    let userId: string | undefined;

    if (secret) {
      const decoded: any = jwt.verify(token, secret);
      userId = decoded?.userId;
    } else {
      // Fallback: ha nincs secret, dekódoljuk a payloadot (nem biztonságos)
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("Invalid token");

      const base64Url = parts[1];
      if (!base64Url) throw new Error("Invalid token payload");

      const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
      userId = payload.userId;
    }

    if (!userId) throw new Error("No user ID");

    // INJECT USER ID INTO EVENT CONTEXT - Ezt keresi az analytics.ts!
    event.context.user = { id: userId };

    const isApiRequest = url.pathname.startsWith("/api/");

    // Ha API kérés, csak a tokent dekódoljuk a contexthez, de NEM terheljük
    // az adatbázist minden egyes lekérdezésnél (Performancia optimalizáció).
    if (isApiRequest) return;

    // A teljes adatbázis ellenőrzés csak oldalletöltéseknél fut le.
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!userExists) {
      console.warn(`[Sovereign Shield] Törölt felhasználó kiléptetése: ${userId}`);
      deleteCookie(event, "auth_token");
      deleteCookie(event, "session_status");

      if (url.pathname !== "/auth") {
        return sendRedirect(event, "/auth", 302);
      }
    }
  } catch (error) {
    deleteCookie(event, "auth_token");
    deleteCookie(event, "session_status");

    if (!url.pathname.startsWith("/api/") && url.pathname !== "/auth") {
      return sendRedirect(event, "/auth", 302);
    }
  }
});