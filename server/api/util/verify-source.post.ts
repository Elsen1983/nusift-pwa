// server/api/util/verify-source.post.ts
import dns from "node:dns/promises";

export default defineEventHandler(async (event) => {
  const { url } = await readBody(event);

  if (!url) {
    throw createError({ statusCode: 400, statusMessage: "URL is required" });
  }

  // 1. Normalizálás: Biztosítjuk, hogy legyen protokoll a kéréshez
  let targetUrl = url.trim();
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = `https://${targetUrl}`;
  }

  try {
    // 2. A könnyűsúlyú HTTP HEAD kérés (Timeout-al, hogy ne fagyjon le)
    const response = await $fetch.raw(targetUrl, {
      method: "HEAD",
      timeout: 5000,
      ignoreResponseError: true, // Mi magunk akarjuk lekezelni a 404-et
    });

    // 3. Ha az oldal 2xx (Siker) vagy 3xx (Átirányítás) kódot ad, létezik.
    if (response.status >= 200 && response.status < 400) {
      return { success: true, url: targetUrl };
    } else {
      // 404 Not Found vagy 500 Server Error
      return {
        success: false,
        message: "Az oldal vagy aloldal nem található (404).",
      };
    }
  } catch (error: any) {
    // 4. Hálózati hiba (pl. nincs ilyen szerver, vagy a szerver blokkolja a HEAD kérést)
    // Megpróbáljuk a DNS-t (alap domain ellenőrzés)
    try {
      const urlObj = new URL(targetUrl);
      await dns.lookup(urlObj.hostname);
      // A domain létezik, csak a szerver dobta el a pingünket (pl. Cloudflare védelem)
      return {
        success: true,
        url: targetUrl,
        warning: "Domain verified via DNS.",
      };
    } catch (dnsError) {
      // A DNS sem ismeri -> A domain kitalált.
      return { success: false, message: "Nem létező domain." };
    }
  }
});
