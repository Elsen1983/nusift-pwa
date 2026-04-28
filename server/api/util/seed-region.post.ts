// server/api/util/seed-region.post.ts
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * ANCHOR SEED-REGION-HANDLER
 * Ez a végpont felelős az adott ország hírforrásainak aszinkron begyűjtéséért.
 * Megkerüli a szinkron timeout-okat és lokális JSON adatbázist épít.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const country = body.country;

  if (!country) {
    throw createError({ statusCode: 400, message: "Country parameter is required" });
  }

  // Fire-and-forget: A Nitro nem várja meg a háttérfolyamat végét, azonnal válaszol a kliensnek.
  event.waitUntil(scrapeAndSaveRegion(country));

  return {
    success: true,
    message: `Sovereign Seeding: Background database sync initiated for region: ${country}`
  };
});

async function scrapeAndSaveRegion(countryCode: string) {
  const apiKey = process.env.NEWSDATA_API_KEY;
  if (!apiKey) {
    console.error("[Seeder] CRITICAL: NEWSDATA_API_KEY is missing from .env");
    return;
  }

  const dirPath = path.join(process.cwd(), 'data', 'sources');
  const filePath = path.join(dirPath, `${countryCode.toUpperCase()}.json`);
  
  let existingDomains = new Set<string>();

  // ==========================================
  // 1. MEGLÉVŐ ADATOK BEOLVASÁSA (DEDUPLIKÁCIÓHOZ)
  // ==========================================
  try {
    await fs.mkdir(dirPath, { recursive: true });
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const parsedData = JSON.parse(fileContent);
    
    if (parsedData.domains && Array.isArray(parsedData.domains)) {
      parsedData.domains.forEach((domain: string) => existingDomains.add(domain.toLowerCase()));
      console.log(`[Seeder] Found ${existingDomains.size} existing domains in ${countryCode}.json`);
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error(`[Seeder] Warning: Could not parse existing JSON for ${countryCode}:`, error.message);
    } else {
      console.log(`[Seeder] Initialize: No existing database found for ${countryCode}.`);
    }
  }

  // ==========================================
  // 2. ÚJ ADATOK LETÖLTÉSE (ITERATÍV PAGINÁCIÓ)
  // ==========================================
  let nextPageToken: string | null = null;
  const MAX_PAGES = 10; // Beállítható, hány oldalt menjen előre (1 oldal = 1 API kredit)
  let newlyAddedCount = 0;

  console.log(`[Seeder] 🛰️  Starting deep-scan for ${countryCode} (Max ${MAX_PAGES} pages)...`);

  for (let i = 0; i < MAX_PAGES; i++) {
    const fetchQuery: Record<string, string> = {
      apikey: apiKey,
      country: countryCode.toLowerCase(),
    };

    if (nextPageToken) fetchQuery.page = nextPageToken;

    try {
      const response: any = await $fetch('https://newsdata.io/api/1/sources', { query: fetchQuery });

      if (response && response.results) {
        response.results.forEach((source: any) => {
          try {
            const urlObj = new URL(source.url);
            const domain = urlObj.hostname.replace(/^www\./, '').toLowerCase();
            
            // Deduplikáció: Csak akkor adjuk hozzá, ha még nincs a Set-ben
            if (!existingDomains.has(domain)) {
              existingDomains.add(domain);
              newlyAddedCount++;
            }
          } catch (e) {
            // Invalid URL az API válaszban, átugorjuk
          }
        });

        console.log(`[Seeder] ${countryCode} - Page ${i + 1} processed. Unique domains so far: ${existingDomains.size} (+${newlyAddedCount} new)`);

        // DEBUG: Lapozó token ellenőrzése
        console.log(`[Seeder] NextPage Token check: ${response.nextPage || 'NULL - Reached End'}`);

        if (response.nextPage) {
          nextPageToken = response.nextPage;
          // Rate Limit védelem: 2 másodperc szünet az oldalak között
          await new Promise(resolve => setTimeout(resolve, 2000)); 
        } else {
          console.log(`[Seeder] 🛑 ${countryCode} - Reached end of global news database.`);
          break;
        }
      } else {
        console.warn(`[Seeder] Warning: Received unexpected response format at page ${i + 1}`);
        break;
      }
    } catch (apiError: any) {
      // 429 = Too Many Requests
      if (apiError.status === 429) {
        console.error(`[Seeder] ⚠️  RATE LIMIT EXCEEDED. Stopping for ${countryCode} to save credits.`);
      } else {
        console.error(`[Seeder] ❌ API Error at page ${i + 1}:`, apiError.message);
      }
      break; 
    }
  }

  // ==========================================
  // 3. ADATOK MENTÉSE (FÉSÜLVE ÉS RENDEZVE)
  // ==========================================
  if (newlyAddedCount > 0 || existingDomains.size > 0) {
    try {
      const dataToWrite = {
        region: countryCode.toUpperCase(),
        lastUpdated: new Date().toISOString(),
        sourceCount: existingDomains.size,
        // Ábécé sorrendbe rendezés a könnyebb manuális ellenőrzés és Git diff miatt
        domains: Array.from(existingDomains).sort() 
      };

      await fs.writeFile(filePath, JSON.stringify(dataToWrite, null, 2), 'utf-8');
      console.log(`[Seeder] ✅ DATABASE SYNC COMPLETE: ${countryCode.toUpperCase()} now has ${existingDomains.size} domains.`);
      
    } catch (writeError) {
      console.error(`[Seeder] Failed to commit changes to ${filePath}:`, writeError);
    }
  } else {
    console.log(`[Seeder] No changes detected for ${countryCode}. File not updated.`);
  }
}