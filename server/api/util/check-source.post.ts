// server/api/util/check-source.post.ts
import { prisma } from "../../utils/prisma";
import { ISO_LANG_CODES } from "../../utils/langCodes"; // Globális, gyorsítótárazott import

// ANCHOR: WAF & Paywall Trap Signatures
const WAF_AND_PAYWALL_PATTERNS = [
  "/cdn-cgi/challenge-platform",
  "/cdn-cgi/bm/cv",
  "/.well-known/acme-challenge", // Cloudflare
  "/datadome",
  "/geo/datadome",
  "tags.datadome.co", // DataDome
  "/_px/",
  "/px/captcha",
  "/human-verification", // HUMAN / PerimeterX
  "/_incapsula_resource",
  "/reese84", // Imperva
  "/akamai/sps",
  "/sec-challenge",
  "/149e9513-01fa-4fb0-aa45-", // Akamai & Kasada
  "/captcha",
  "/verify-human",
  "/are-you-human",
  "/security-check",
  "/browser-check", // Generic
  "/paywall",
  "/subscribe",
  "/premium",
  "/subscription-required",
  "/digital-access",
  "/plans",
  "/membership", // Paywalls
  "/login",
  "/signin",
  "/premium-login",
  "/auth",
  "/sso",
  "/register",
  "/sign-up", // Auth
];

// Cikk URL felismerő heurisztika
const isArticleUrl = (urlString: string): boolean => {
  try {
    const urlObj = new URL(urlString);
    const path = urlObj.pathname.replace(/^\/|\/$/g, "");
    
    if (!path) return false; // Gyökér domain (pl. hvg.hu) - MINDIG VALID
    
    const segments = path.split('/');
    
    // 1. Túl mély útvonal (pl. /rovat/alrovat/cikk-cime -> 3 szegmens)
    if (segments.length > 2) return true;
    
    // 2. Szabványos Dátum minta a path-ban (pl. /2026/06/09/...)
    const hasDateSignature = /\/(19|20)\d{2}\/[01]\d\/[0-3]\d\//.test(urlObj.pathname);
    if (hasDateSignature) return true;

    // 3. ÚJ: Hosszú számok (Dátum ID-k vagy Cikk ID-k) az első két szegmensben
    // Kiszűri a "20260609_cikk_neve" típusú egybefüggő számsorokat (min. 6 számjegy)
    const hasLongNumbersInEarlySegments = segments.slice(0, 2).some(segment => /\d{6,}/.test(segment));
    if (hasLongNumbersInEarlySegments) return true;
    
    // 4. Tipikus cikk "slug" felismerése (túl hosszú vagy túl sok kötőjel)
    // Egy normál kategória (pl. /tech-tudomany) ritkán hosszabb 20 karakternél és 1-2 kötőjelnél.
    const lastSegment = segments[segments.length - 1] || "";
    const hyphenCount = (lastSegment.match(/-/g) || []).length;
    if (lastSegment.length > 40 || hyphenCount > 4) return true;

    return false; // Ha átment a szűrőkön, valószínűleg egy valid kategória
  } catch {
    return false;
  }
};

// URL Heuristics: Guess language from TLD, Subdomain, or Path
const guessLanguageFromUrl = (urlString: string): string | null => {
  try {
    const url = new URL(urlString);
    const hostParts = url.hostname.split(".");
    const pathParts = url.pathname.split("/").filter(Boolean);

    // 1. Check Subdomain (e.g., hu.euronews.com)
    const subdomain = hostParts[0];
    if (hostParts.length > 2 && subdomain && ISO_LANG_CODES.has(subdomain)) {
      return subdomain;
    }

    // 2. Check TLD (e.g., telex.hu)
    const tld = hostParts[hostParts.length - 1];
    if (tld && ISO_LANG_CODES.has(tld)) {
      return tld;
    }

    // 3. Check First Path Segment (e.g., domain.com/es/news)
    const firstPath = pathParts[0];
    if (pathParts.length > 0 && firstPath && ISO_LANG_CODES.has(firstPath)) {
      return firstPath;
    }

    return null;
  } catch {
    return null;
  }
};
// Fejléc generátor a Geo-IP blokkolás elkerülésére
const generateAcceptLanguageHeader = (langCode?: string) => {
  switch (langCode) {
    case "hu":
      return "hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7";
    case "en":
      return "en-US,en;q=0.9,en-GB;q=0.8";
    case "de":
      return "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7";
    case "fr":
      return "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7";
    case "es":
      return "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7";
    case "pl":
      return "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7";
    default:
      return "en-US,en;q=0.9"; // Biztonságos nemzetközi alapértelmezés
  }
};

// Követőkódok levágása
const stripTrackingParams = (rawUrl: string): string => {
  try {
    const urlObj = new URL(rawUrl);
    // A leggyakoribb marketing paraméterek listája
    const paramsToStrip = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
    ];

    paramsToStrip.forEach((param) => urlObj.searchParams.delete(param));
    return urlObj.toString();
  } catch {
    return rawUrl; // Ha érvénytelen az URL, hagyjuk, majd a lenti try-catch megfogja
  }
};

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  // Enforce strict string types immediately
  const rawUrl: string = body.url ? String(body.url) : "";
  const userLang: string = body.language ? String(body.language) : "en";

  if (!rawUrl) {
    throw createError({
      statusCode: 400,
      statusMessage: "Bad Request",
      message: "api_errors.missing_url",
    });
  }

  try {
    // Mielőtt bármit csinálnánk, levágjuk az UTM paramétereket
    let cleanedUrl = stripTrackingParams(rawUrl.trim());
    if (!cleanedUrl.startsWith("http")) cleanedUrl = `https://${cleanedUrl}`;

    // Egy utolsó biztonsági ellenőrzés, hogy a URL formátuma helyes-e, mielőtt megpróbálnánk elérni
    let targetUrl = cleanedUrl;
    if (!targetUrl.startsWith("http")) targetUrl = `https://${targetUrl}`;

    if (isArticleUrl(targetUrl)) {
      console.warn(`[Check-Source] Article URL rejected: ${targetUrl}`);
      throw createError({
        statusCode: 400,
        statusMessage: "Article Detected",
        message: "api_errors.article_detected",
      });
    }

    // --- 1. LÉPÉS: PREVENTÍV GEO-IP PAJZS ---
    const guessedLang = guessLanguageFromUrl(targetUrl);
    // Ha az URL-ből tudunk nyelvet tippelni, azt használjuk. Ha nem, a felhasználó nyelvét.
    const acceptLangHeader = generateAcceptLanguageHeader(
      guessedLang || userLang,
    );

    // Hálózati validáció (Első körben HEAD kérés az átirányítások és létezés ellenőrzésére)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    // ADD BROWSER HEADERS to bypass basic WAF/Cloudflare protection
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": acceptLangHeader, // Ezzel "verjük át" a célpont szerverét
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    let finalUrl = response.url;

    // --- ÚJ: CROSS-DOMAIN REDIRECT PAJZS ---
    const originalUrlObj = new URL(targetUrl);
    const finalUrlObj = new URL(finalUrl);

    const originalCleanHost = originalUrlObj.hostname
      .replace(/^www\./, "")
      .toLowerCase();
    const finalCleanHost = finalUrlObj.hostname
      .replace(/^www\./, "")
      .toLowerCase();

    // --- 2. LÉPÉS: HÁLÓZATI PAJZSOK (Cross-Domain & WAF) ---
    // Cross-Domain Átirányítás - Ha a gyökér-domain megváltozott (pl. roblox.ie -> fruits.co)
    // Engedélyezzük, ha pontosan egyezik, VAGY ha egy legitim aldomainre irányított át (pl. euronews.com -> hu.euronews.com)
    const isSubdomainRedirect = finalCleanHost.endsWith(
      `.${originalCleanHost}`,
    );

    // Cross-Domain Átirányítás Pajzs
    if (
      originalCleanHost !== finalCleanHost &&
      !isSubdomainRedirect &&
      response.ok
    ) {
      console.warn(
        `[Check-Source] Cross-Domain redirect blocked: ${originalCleanHost} -> ${finalCleanHost}`,
      );
      throw createError({
        statusCode: 400,
        statusMessage: "Redirect Hijack",
        message: `Ez a domain átirányít egy másik, idegen weboldalra (${finalCleanHost}). Parkolt vagy lejárt forrás.`,
      });
    }

    // WAF és Paywall Csapda Pajzs
    const isWafTrap = WAF_AND_PAYWALL_PATTERNS.some((pattern) =>
      finalUrlObj.pathname.toLowerCase().includes(pattern),
    );

    // Ha WAF csapdát észlelünk, logoljuk, de ne dobjunk hibát, hanem fogadjuk el a felhasználó által megadott URL-t, hogy ne büntessük a legitim forrásokat, amik erős védelmet használnak.
    if (isWafTrap) {
      console.warn(
        `[Check-Source] WAF/Paywall Trap detected at ${finalUrlObj.pathname}. Stripping redirect.`,
      );
      finalUrl = targetUrl; // Visszaállítjuk az eredeti URL-t, hogy a felhasználó lássa, hogy a domain valid, még ha a WAF miatt nem is tudunk hozzáférni. Ez egy "soft fail" megközelítés a WAF-ekkel szemben.
    }

    // 2. Graceful WAF Handling (The Existence Proof)
    if (!response.ok || isWafTrap) {
      if (
        response.status === 403 ||
        response.status === 401 ||
        response.status === 503 ||
        isWafTrap
      ) {
        console.warn(
          `[Check-Source] WAF protection detected (${response.status || "TRAP"}) for ${targetUrl}. Accepting as valid domain.`,
        );
        finalUrl = targetUrl; // Fallback to user input
      } else {
        throw createError({
          statusCode: response.status === 404 ? 404 : 400,
          statusMessage: "Validation Failed",
          message: `URL nem érhető el (HTTP ${response.status})`,
        });
      }
    }

    // --- 3. LÉPÉS: ADATBÁZIS ELLENŐRZÉS (A Leggyorsabb Válaszút) ---
    const urlObj = new URL(finalUrl);
    const cleanHostname = urlObj.hostname.replace(/^www\./, "");

    const potentialSources = await prisma.newsSource.findMany({
      where: { frontPageUrl: { contains: cleanHostname, mode: "insensitive" } },
    });

    const existingSource = potentialSources.find((source) => {
      try {
        const dbCleanHostname = new URL(source.frontPageUrl).hostname.replace(
          /^www\./,
          "",
        );
        return dbCleanHostname === cleanHostname;
      } catch {
        return false;
      }
    });

    let detectedLanguage = guessedLang || userLang; // Kezdeti tipp az URL-ből
    let predictedStatus = "PENDING_DISCOVERY";

    // --- 4. LÉPÉS: HTML FELDOLGOZÁS (CSAK HA ÚJ A FORRÁS ÉS NINCS WAF CSAPDA) ---
    if (existingSource) {
      console.log(
        `[Check-Source] Source found in DB. Skipping HTML download to save resources.`,
      );
      // Ha már adatbázisban van, onnan vesszük a tényt, nem töltjük le feleslegesen a HTML-t!
      detectedLanguage = existingSource.language || detectedLanguage;
    } else if (response.ok && !isWafTrap) {
      console.log(
        `[Check-Source] New domain detected. Real-time pre-scanning ${finalUrl} for Language and RSS...`,
      );
      try {
        // A HTML letöltése csak most történik meg
        const html = await response.text();

        // --- ÚJ LÉPÉS: SOFT 404 DETEKTOR ---
        // Kikeressük a Title és H1 tagek tartalmát
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        const pageHeadings = (
          (titleMatch?.[1] || "") +
          " " +
          (h1Match?.[1] || "")
        ).toLowerCase();

        // Ellenőrizzük a leggyakoribb Soft 404 kulcsszavakat
        const isSoft404 =
          /(404|not found|nem található|keresés|search|page not found)/i.test(
            pageHeadings,
          );

        if (isSoft404) {
          console.warn(
            `[Check-Source] Soft 404 detected via HTML content for ${finalUrl}`,
          );
          // Ha Soft 404, dobunk egy dedikált hibát, így nem kerül be a "tiszta" források közé
          throw createError({
            statusCode: 404,
            statusMessage: "Soft 404",
            message: "api_errors.soft_404",
          });
        }

        // A) Extract True Language from HTML DOM
        const htmlLangMatch = html.match(
          /<html[^>]*lang=["']([a-zA-Z-]+)["']/i,
        );
        const extractedLang = htmlLangMatch?.[1];

        if (extractedLang) {
          // Safely extract the array index to satisfy noUncheckedIndexedAccess
          const splitLang = extractedLang.split("-")[0];

          if (splitLang) {
            detectedLanguage = splitLang.toLowerCase();
            console.log(
              `[Check-Source] DOM Language Extracted: ${detectedLanguage}`,
            );
          }
        }

        // B) RSS Predikció
        const rssRegex =
          /<link[^>]+type=["']application\/(rss\+xml|atom\+xml)["'][^>]+href=["']([^"']+)["']/i;
        predictedStatus = html.match(rssRegex) ? "ACTIVE" : "NO_RSS_FOUND";
      } catch (getErr) {
        console.warn(
          `[Check-Source] Predictive pre-scan failed for ${finalUrl}. Falling back to default language and PENDING_DISCOVERY.`,
        );
      }
    }

    // --- VÉGSŐ VÁLASZ A FRONTENDNEK ---
    return {
      success: true,
      url: finalUrl,
      name: existingSource?.mediaName || cleanHostname,
      status: existingSource?.rssStatus || predictedStatus,
      detectedLanguage: detectedLanguage, // A véglegesített igazság (DB vagy HTML)
    };
  } catch (error: any) {
    console.error("[Check-Source] Network/Runtime Error:", error.message);

    // 1. Handle timeouts gracefully
    if (error.name === "AbortError" || error.statusCode === 408) {
      throw createError({
        statusCode: 408,
        statusMessage: "Request Timeout",
        message: "api_errors.invalid_domain", 
      });
    }

    // 2. Allow our pre-defined localization keys to pass through directly
    if (error.message && error.message.startsWith("api_errors.")) {
      throw error;
    }

    // 3. Mask Node.js internal errors (like "fetch failed", DNS resolution issues)
    throw createError({
      statusCode: 400,
      statusMessage: "Unreachable Domain",
      message: "api_errors.invalid_domain",
    });
  }
});
