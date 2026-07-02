// server/utils/discovery.ts
import { prisma } from "./prisma";
import { RssStatus } from "@prisma/client";
import { safeFetch, SSRFError } from "./ssrf-guard";
import { normalizeActiveRssStatus } from "./news-pipeline/rss-status";

// ANCHOR: WAF & Paywall Trap Signatures (Ugyanaz a lista)
const WAF_AND_PAYWALL_PATTERNS = [
  "/cdn-cgi/challenge-platform",
  "/cdn-cgi/bm/cv",
  "/.well-known/acme-challenge",
  "/datadome",
  "/geo/datadome",
  "tags.datadome.co",
  "/_px/",
  "/px/captcha",
  "/human-verification",
  "/_incapsula_resource",
  "/reese84",
  "/akamai/sps",
  "/sec-challenge",
  "/149e9513-01fa-4fb0-aa45-",
  "/captcha",
  "/verify-human",
  "/are-you-human",
  "/security-check",
  "/browser-check",
  "/paywall",
  "/subscribe",
  "/premium",
  "/subscription-required",
  "/digital-access",
  "/plans",
  "/membership",
  "/login",
  "/signin",
  "/premium-login",
  "/auth",
  "/sso",
  "/register",
  "/sign-up",
];

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
      return "en-US,en;q=0.9";
  }
};

/**
 * Célzott RSS felfedező motor.
 * Közvetlenül hívható a finalize-onboarding-ból vagy Cron jobokból.
 */
export async function executeTargetedDiscovery(
  sourceIds: string[],
): Promise<void> {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    console.warn("[Targeted-Discovery] No source IDs provided for execution.");
    return;
  }

  // 1. Csak a pending állapotú források lekérése
  const pendingSources = await prisma.newsSource.findMany({
    where: {
      id: { in: sourceIds },
      rssStatus: RssStatus.PENDING_DISCOVERY,
    },
  });

  if (pendingSources.length === 0) {
    console.log(
      "[Targeted-Discovery] All requested sources are already processed.",
    );
    return;
  }

  console.log(
    `[Targeted-Discovery] Initiating direct scan for ${pendingSources.length} specific sources....`,
  );

  // 2. Iteráció és Web Scraping
  for (const source of pendingSources) {
    try {
      // Dinamikus fejléc generálása az adatbázisban lévő nyelv alapján
      const acceptLangHeader = generateAcceptLanguageHeader(
        source.language || "en",
      );

      // RÉSZLETES LOG: Indul a letöltés
      console.log(
        `[Targeted-Discovery][Fetch] Scanning frontPageUrl: "${source.frontPageUrl}" using Sovereign-Agent UA.`,
      );

      // SSRF-protected fetch: validates DNS/IP even for DB-stored URLs (defence-in-depth)
      const response = await safeFetch(source.frontPageUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NuSift/1.0 Sovereign-Agent",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": acceptLangHeader,
        },
        // allowIp defaults to false — hostname-only validation + DNS IP check for defence-in-depth
      });

      // WAF-Aware Response Handling
      if (!response.ok) {
        if (response.status === 403 || response.status === 503) {
          throw new Error(`WAF_BLOCKED_${response.status}`); // Custom error flag
        }
        throw new Error(`HTTP Error: ${response.status}`);
      }

      // Cross-domain redirect is now enforced inside safeFetch (SSRF guard).
      // If safeFetch throws SSRFError, the catch block marks the source as FAILED.

      // Soft WAF / Paywall csapda (Hibát dobunk, hogy a catch blokk FAILED-re tegye)
      const finalUrlObj = new URL(response.url);
      const isWafTrap = WAF_AND_PAYWALL_PATTERNS.some((pattern) =>
        finalUrlObj.pathname.toLowerCase().includes(pattern),
      );

      if (isWafTrap) {
        const sourceHost = new URL(source.frontPageUrl).hostname.replace(/^www\./, '').toLowerCase();
        console.warn(
          `[Targeted-Discovery] Soft WAF/Paywall Trap detected on ${sourceHost}. Path: ${finalUrlObj.pathname}`,
        );
        throw new Error(`WAF_BLOCKED_REDIRECT`);
      }

      const html = await response.text();
      console.log(
        `[Targeted-Discovery][Fetch] Successfully downloaded HTML from "${source.frontPageUrl}" (${html.length} bytes). Parsing regex...`,
      );

      const rssRegex =
        /<link[^>]+type=["']application\/(rss\+xml|atom\+xml)["'][^>]+href=["']([^"']+)["']/i;
      const match = html.match(rssRegex);

      let newStatus: RssStatus = RssStatus.NO_RSS_FOUND;
      let finalFeedUrl = null;

      if (match && match[2]) {
        newStatus = RssStatus.ACTIVE;
        let rawFeedUrl = match[2];

        if (rawFeedUrl.startsWith("/")) {
          const urlObj = new URL(source.frontPageUrl);
          finalFeedUrl = `${urlObj.origin}${rawFeedUrl}`;
        } else {
          finalFeedUrl = rawFeedUrl;
        }
        // RÉSZLETES LOG: Találat esetén
        console.log(
          `[Targeted-Discovery][Match] FOUND VALID FEED. Raw Regex Link: "${rawFeedUrl}" -> Resolved absolute URL: "${finalFeedUrl}"`,
        );
      } else {
        // RÉSZLETES LOG: Ha nincs RSS a HTML-ben
        console.warn(
          `[Targeted-Discovery][Match] No RSS/Atom link tags found in the HTML header of "${source.frontPageUrl}".`,
        );
      }

      // Adatbázis frissítése
      await prisma.newsSource.update({
        where: { id: source.id },
        data: {
          rssStatus: normalizeActiveRssStatus(newStatus, finalFeedUrl),
          rssFeedUrl: finalFeedUrl,
        },
      });

      console.log(
        `[Targeted-Discovery][Database] Updated ID ${source.id} (${source.frontPageUrl}) status to: ${newStatus}`,
      );
    } catch (error: any) {
      // SSRF guard violations → mark as DOMAIN_DEAD (likely poisoned DB entry)
      if (error instanceof SSRFError) {
        console.warn(
          `[Targeted-Discovery][SSRF] Blocked unsafe URL: ${error.detail}. Marking as DOMAIN_DEAD.`,
        );
        await prisma.newsSource.update({
          where: { id: source.id },
          data: { rssStatus: "DOMAIN_DEAD" },
        });
        continue;
      }

      // Graceful Logging for Firewalls
      if (error.message.includes("WAF_BLOCKED")) {
        console.warn(
          `[Targeted-Discovery][Blocked] Firewall prevented scanning of "${source.frontPageUrl}". Marking as FAILED.`,
        );
      } else {
        console.error(
          `[Targeted-Discovery][Error] Critical failure scanning "${source.frontPageUrl}":`,
          error.message,
        );
      }

      await prisma.newsSource.update({
        where: { id: source.id },
        data: { rssStatus: "FAILED" },
      });
    }
  }
}
