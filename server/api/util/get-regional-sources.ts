// server/api/util/get-regional-sources.ts

// A defineCachedEventHandler a Nuxt/Nitro beépített eszköze a memóriaszintű cache-eléshez.
export default defineCachedEventHandler(async (event) => {
  // 1. URL paraméter kiolvasása (pl. ?country=HU)
  const query = getQuery(event);
  const country = (query.country as string) || 'US';

  // 2. Az .env fájlban tárolt API kulcs beolvasása
  const apiKey = process.env.NEWSDATA_API_KEY;
  if (!apiKey) {
    throw createError({ statusCode: 500, statusMessage: "Missing API Key" });
  }

  try {
    // 3. Lekérdezés a Newsdata.io 'sources' végpontjától
    // (Példa: csökkenő sorrend a prioritás alapján)
    const response: any = await $fetch('https://newsdata.io/api/1/sources', {
      query: {
        apikey: apiKey,
        country: country.toLowerCase(),
      }
    });

    // 4. Ha az API válaszol, formázzuk az adatot
    if (response && response.results) {
      // Csak az URL-eket/domaineket gyűjtjük ki, és letisztítjuk róluk a www.-t
      const domains = response.results.map((source: any) => {
        try {
          const urlObj = new URL(source.url);
          return urlObj.hostname.replace(/^www\./, '').toLowerCase();
        } catch (e) {
          return null; // Ha hibás az URL, kihagyjuk
        }
      }).filter(Boolean); // Eltávolítjuk a null értékeket

      return {
        success: true,
        region: country,
        count: domains.length,
        sources: domains // Ez lesz a mi Whitelist-ünk!
      };
    }
    
    return { success: false, sources: [] };

  } catch (error) {
    console.error(`Error fetching regional sources for ${country}:`, error);
    return { success: false, sources: [] };
  }
}, {
  // CACHE KONFIGURÁCIÓ: A kulcs az országkód lesz.
  name: 'regional-sources-cache',
  getKey: (event) => {
    const query = getQuery(event);
    return (query.country as string) || 'US';
  },
  // 24 óra másodpercben (86400). Ennyi ideig nem fogja újra hívni az API-t.
  maxAge: 60 * 60 * 24
});