// server/api/util/check-source.post.ts
import { prisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const rawUrl = body.url;

  if (!rawUrl) {
    throw createError({
      statusCode: 400,
      statusMessage: "Bad Request",
      message: `A URL megadása kötelező.`,
    });
  }

  try {
    // URL tisztítás
    let targetUrl = rawUrl.trim();
    if (!targetUrl.startsWith("http")) targetUrl = `https://${targetUrl}`;

    // Hálózati validáció (Első körben HEAD kérés az átirányítások és létezés ellenőrzésére)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    // ADD BROWSER HEADERS to bypass basic WAF/Cloudflare protection
    const response = await fetch(targetUrl, { 
      method: 'GET', // WAFs often block HEAD requests outright
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: controller.signal 
    });
    clearTimeout(timeout);

    let finalUrl = response.url;

    // --- ÚJ: CROSS-DOMAIN REDIRECT PAJZS ---
    const originalUrlObj = new URL(targetUrl);
    const finalUrlObj = new URL(finalUrl);
    
    const originalCleanHost = originalUrlObj.hostname.replace(/^www\./, "").toLowerCase();
    const finalCleanHost = finalUrlObj.hostname.replace(/^www\./, "").toLowerCase();

    // Ha a gyökér-domain megváltozott (pl. roblox.ie -> fruits.co)
    if (originalCleanHost !== finalCleanHost && response.ok) {
      console.warn(`[Check-Source] Cross-Domain redirect blocked: ${originalCleanHost} -> ${finalCleanHost}`);
      throw createError({ 
        statusCode: 400, 
        statusMessage: "Redirect Hijack",
        message: `Ez a domain átirányít egy másik, idegen weboldalra (${finalCleanHost}). Parkolt vagy lejárt forrás.` 
      });
    }
    // ----------------------------------------

    // 2. Graceful WAF Handling (The Existence Proof)
    if (!response.ok) {
      if (response.status === 403 || response.status === 401 || response.status === 503) {
        console.warn(`[Check-Source] WAF protection detected (${response.status}) for ${targetUrl}. Accepting as valid domain.`);
        finalUrl = targetUrl; // Fallback to user input since we couldn't resolve a clean redirect
      } else {
        throw createError({ 
          statusCode: response.status === 404 ? 404 : 400, 
          statusMessage: "Validation Failed",
          message: `URL nem érhető el (HTTP ${response.status})` 
        });
      }
    }
    const urlObj = new URL(finalUrl);
    const cleanHostname = urlObj.hostname.replace(/^www\./, "");

    // 1. Fetch potential matches (broad search to minimize DB load)
    const potentialSources = await prisma.newsSource.findMany({
      where: { frontPageUrl: { contains: cleanHostname, mode: "insensitive" } },
    });

    // 2. Filter for an exact hostname match in JavaScript
    const existingSource = potentialSources.find((source) => {
      try {
        const dbUrlObj = new URL(source.frontPageUrl);
        const dbCleanHostname = dbUrlObj.hostname.replace(/^www\./, "");
        return dbCleanHostname === cleanHostname;
      } catch {
        return false; // Skip if DB contains malformed URLs
      }
    });

    // --- ÚJ: PREDIKTÍV UX BŐVÍTÉS (Csak ha a forrás még NINCS az adatbázisban) ---
    let predictedStatus = "PENDING_DISCOVERY";

    if (!existingSource) {
      console.log(
        `[Check-Source] New domain detected. Real-time pre-scanning ${finalUrl} for immediate RSS feedback...`,
      );
      try {
        const getController = new AbortController();
        const getTimeOut = setTimeout(() => getController.abort(), 4000);

        // Letöltjük a HTML-t (korlátozott időkerettel), hogy ellenőrizzük a linkeket
        const getResponse = await fetch(finalUrl, {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 NuSift/1.0 Pre-Scanner",
            Accept: "text/html",
          },
          signal: getController.signal,
        });
        clearTimeout(getTimeOut);

        if (getResponse.ok) {
          const html = await getResponse.text();
          const rssRegex =
            /<link[^>]+type=["']application\/(rss\+xml|atom\+xml)["'][^>]+href=["']([^"']+)["']/i;
          const match = html.match(rssRegex);

          // Ha valós időben találtunk RSS linket, ACTIVE-nak mutatjuk a UI-on, különben NO_RSS_FOUND
          predictedStatus = match ? "ACTIVE" : "NO_RSS_FOUND";
          console.log(
            `[Check-Source] Pre-scan complete for ${cleanHostname}. Predictive status: ${predictedStatus}`,
          );
        }
      } catch (getErr) {
        // Ha a GET kérés elhasal (pl. timeout), csendben lenyeljük, és visszaesünk a biztonságos PENDING_DISCOVERY-re
        console.warn(
          `[Check-Source] Predictive pre-scan failed or timed out for ${finalUrl}. Falling back to PENDING_DISCOVERY.`,
        );
      }
    }
    // -----------------------------------------------------------------------------

    // Visszatérési értékek kiküldése (Eredeti struktúra megtartásával)
    return {
      success: true,
      url: finalUrl,
      name: existingSource?.mediaName || cleanHostname,
      status: existingSource?.rssStatus || predictedStatus, // Ha létezik, a DB státusz megy ki, ha új, a prediktív
    };
  } catch (err: any) {
    if (err.name === 'AbortError' || err.statusCode === 408) {
      throw createError({ 
        statusCode: 408, 
        statusMessage: "Request Timeout",
        message: "Időtúllépés a forrás ellenőrzésekor." 
      });
    }
    
    // UPDATE ERROR STRUCTURE to separate statusMessage and message
    throw createError({ 
      statusCode: err.statusCode || 400, 
      statusMessage: "Bad Request",
      message: err.message || "Érvénytelen vagy nem elérhető URL" 
    });
  }
});
