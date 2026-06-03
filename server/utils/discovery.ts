// server/utils/discovery.ts
import { prisma } from "./prisma";
import { RssStatus } from "@prisma/client";

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
    `[Targeted-Discovery] Initiating direct scan for ${pendingSources.length} specific sources...`,
  );

  // 2. Iteráció és Web Scraping
  for (const source of pendingSources) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      // RÉSZLETES LOG: Indul a letöltés
      console.log(
        `[Targeted-Discovery][Fetch] Scanning frontPageUrl: "${source.frontPageUrl}" using Sovereign-Agent UA.`,
      );

      const response = await fetch(source.frontPageUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NuSift/1.0 Sovereign-Agent",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // WAF-Aware Response Handling
      if (!response.ok) {
        if (response.status === 403 || response.status === 503) {
           throw new Error(`WAF_BLOCKED_${response.status}`); // Custom error flag
        }
        throw new Error(`HTTP Error: ${response.status}`);
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
          rssStatus: newStatus,
          rssFeedUrl: finalFeedUrl,
        },
      });

      console.log(
        `[Targeted-Discovery][Database] Updated ID ${source.id} (${source.frontPageUrl}) status to: ${newStatus}`,
      );
    } catch (error: any) {
      // 2. Graceful Logging for Firewalls
      if (error.message.includes('WAF_BLOCKED')) {
        console.warn(`[Targeted-Discovery][Blocked] Firewall prevented scanning of "${source.frontPageUrl}". Marking as FAILED.`);
      } else {
        console.error(`[Targeted-Discovery][Error] Critical failure scanning "${source.frontPageUrl}":`, error.message);
      }
      
      await prisma.newsSource.update({
        where: { id: source.id },
        data: { rssStatus: 'FAILED' } // Safe fallback
      });
    }
  }
}
