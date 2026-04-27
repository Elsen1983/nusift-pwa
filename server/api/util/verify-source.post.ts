// server/api/util/verify-source.post.ts
import dns from "node:dns/promises";

// ANCHOR UGC & SOCIAL BLACKLIST
const NON_NEWS_DOMAINS = [
  "youtube.com", "youtu.be",
  "facebook.com", "fb.com",
  "twitter.com", "x.com",
  "instagram.com", "tiktok.com",
  "reddit.com", "linkedin.com",
  "pinterest.com", "twitch.tv", 
  "vimeo.com", "quora.com", 
  "wikipedia.org", "medium.com",
   "amazon.com" // Folyamatosan bővíthető
];

export default defineEventHandler(async (event) => {
  const { url } = await readBody(event);

  if (!url) {
    throw createError({ statusCode: 400, statusMessage: "URL is required" });
  }

  let targetUrl = url.trim();
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = `https://${targetUrl}`;
  }

  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch (e) {
    return { success: false, message: "Érvénytelen URL formátum." };
  }

  const rootDomain = urlObj.hostname.replace(/^www\./, '').toLowerCase();

  // ==========================================
  // PHASE 0: UGC & SOCIAL MEDIA SZŰRŐ
  // ==========================================
  const isBlacklisted = NON_NEWS_DOMAINS.some(domain => 
    rootDomain === domain || rootDomain.endsWith(`.${domain}`)
  );

  if (isBlacklisted) {
    return {
      success: false,
      message: "Ez a domain nem használható hírforrásként (Közösségi média/UGC)."
    };
  }

  let isDomainValid = false;
  let validationWarning = "";
  let htmlContent = ""; // Tároljuk a HTML elejét, ha sikerül letölteni

  // ==========================================
  // PHASE 1: LIVENESS & HTML FETCH
  // ==========================================
  try {
    // HEAD helyett GET-et kérünk, de csak az első 15KB-ot akarjuk, hogy gyors legyen
    // A fetch API-nál a timeout és az abort controller segít
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(targetUrl, {
      method: "GET",
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) {
        isDomainValid = true;
        // Csak az elejét olvassuk be, nem az egész oldalt
        const text = await response.text();
        htmlContent = text.slice(0, 15000).toLowerCase(); 
    } else {
         return { success: false, message: `Az oldal nem elérhető (${response.status}).` };
    }
  } catch (error: any) {
    // Ha a GET elszállt (WAF, Cloudflare, Timeout), próbáljuk csak a domaint DNS-el
    try {
      await dns.lookup(urlObj.hostname);
      isDomainValid = true;
      validationWarning = "Domain valid (DNS fallback).";
    } catch (dnsError) {
      return { success: false, message: "Nem létező domain." };
    }
  }

  if (!isDomainValid) {
    return { success: false, message: "Érvénytelen forrás." };
  }

  // ==========================================
  // PHASE 1.5: HEURISTIC HTML CHECK
  // ==========================================
  // Ha sikerült letölteni a HTML elejét, megnézzük, ordít-e róla, hogy hírportál
  if (htmlContent) {
      const isLikelyNews = 
        htmlContent.includes('application/rss+xml') ||
        htmlContent.includes('application/atom+xml') ||
        htmlContent.includes('"@type":"newsarticle"') ||
        htmlContent.includes('"@type": "newsarticle"');

      if (isLikelyNews) {
          return {
              success: true,
              url: targetUrl,
              isNewsSource: true,
              warning: validationWarning || "Heuristic check passed."
          };
      }
  }

  // ==========================================
  // PHASE 2: SECONDARY VALIDATION (GDELT)
  // ==========================================
  let isNewsSource: boolean | string = "unknown";

  try {
    const gdeltApiUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=domain:${rootDomain}&mode=artlist&maxrecords=1&format=json`;
    
    // Node.js 18+ esetén a DNS feloldás olykor IPv6 problémát okozhat a fetch-nél (ez okozhat fetch failed-et)
    // Ezért 5 másodpercet adunk neki
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const gdeltResponse = await fetch(gdeltApiUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!gdeltResponse.ok) {
        throw new Error(`HTTP ${gdeltResponse.status}`);
    }

    const contentType = gdeltResponse.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
        throw new Error("No JSON response");
    }

    const gdeltData = await gdeltResponse.json();

    if (gdeltData.articles && gdeltData.articles.length > 0) {
      isNewsSource = true;
    } else {
      isNewsSource = "unknown"; 
    }
  } catch (gdeltError: any) {
    let gdeltWarn = "GDELT API error.";
    if (gdeltError.name === 'AbortError') {
      gdeltWarn = "GDELT timeout.";
    } else if (gdeltError.message) {
      gdeltWarn = `GDELT Error: ${gdeltError.message}`; 
    }

    validationWarning = validationWarning ? `${validationWarning} | ${gdeltWarn}` : gdeltWarn;
  }

  // ==========================================
  // FINAL RESPONSE
  // ==========================================
  return { 
    success: true, 
    url: targetUrl,
    isNewsSource,
    warning: validationWarning || undefined
  };
});