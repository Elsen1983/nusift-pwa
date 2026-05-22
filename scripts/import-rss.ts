// scripts/import-rss.ts
import fs from 'fs';
import path from 'path';
import { RssStatus } from '@prisma/client';
import 'dotenv/config'; 
import { prisma } from '../server/utils/prisma'; 

import * as isoPackage from 'i18n-iso-countries';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const enLocaleJson = require('i18n-iso-countries/langs/en.json');

const countries = ('default' in isoPackage ? isoPackage.default : isoPackage) as any;
const enLocale = 'default' in enLocaleJson ? enLocaleJson.default : enLocaleJson;
countries.registerLocale(enLocale);

// ==========================================
// TISZTÍTÓ ÉS FORMÁZÓ FÜGGVÉNYEK
// ==========================================
const cleanField = (val: string | undefined | null) => {
  return val && val.trim() !== '' ? val.trim() : null;
};

const formatLocationName = (raw: string | undefined | null) => {
  if (!raw || raw.trim() === '') return null;
  let formatted = raw.trim();
  
  if (formatted.startsWith('United_States_')) {
    formatted = formatted.replace(/^United_States_/, 'United States - ');
  }
  
  formatted = formatted.replace(/_/g, ' ');
  return formatted;
};

// ==========================================
// HÁLÓZATI VALIDÁCIÓ (PÁRHUZAMOSÍTÁSRA OPTIMALIZÁLVA)
// ==========================================
async function validateAndResolveUrl(rawUrl: string | undefined | null): Promise<string | null> {
  if (!rawUrl || rawUrl.trim() === '') return null;
  
  let targetUrl = rawUrl.trim();
  if (!targetUrl.startsWith('http')) targetUrl = `https://${targetUrl}`;

  const TIMEOUT_MS = 3500;

  try {
    const controller = new AbortController();
    const fetchPromise = fetch(targetUrl, { 
      method: 'HEAD', 
      signal: controller.signal 
    });

    // Golyóálló timeout: Ha a fetch beragadna (pl. DNS hiba), ez biztosan leállítja
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        controller.abort();
        reject(new Error('Timeout'));
      }, TIMEOUT_MS);
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]) as Response;

    if (response && response.ok) {
      return response.url.replace(/\/+$/, '');
    }
    return targetUrl.replace(/\/+$/, '');
  } catch (error) {
    // Timeout vagy hiba esetén megtartjuk az eredeti linket
    return targetUrl.replace(/\/+$/, '');
  }
}

// ==========================================
// KONTINENS MAPPER
// ==========================================
const continentGroups: Record<string, string[]> = {
  "Africa": ["AO","BF","BI","BJ","BW","CD","CF","CG","CI","CM","CV","DJ","DZ","EG","EH","ER","ET","GA","GH","GM","GN","GQ","GW","KE","KM","LR","LS","LY","MA","MG","ML","MR","MU","MW","MZ","NA","NE","NG","RW","SC","SD","SL","SN","SO","ST","SZ","TD","TG","TN","TZ","UG","ZA","ZM","ZW"],
  "Asia": ["AE","AF","AM","AZ","BD","BH","BN","BT","CN","GE","ID","IL","IN","IQ","IR","JO","JP","KG","KH","KP","KR","KW","KZ","LA","LB","LK","MM","MN","MY","OM","PH","PK","QA","SA","SY","TH","TJ","TM","TR","TW","UZ","VN","YE"],
  "Europe": ["AD","AL","AT","BA","BE","BG","BY","CH","CY","CZ","DE","DK","EE","ES","FI","FR","GB","GR","HR","HU","IE","IS","IT","LI","LT","LU","LV","MC","MD","ME","MK","MT","NL","NO","PL","PT","RO","RS","RU","SE","SI","SK","SM","UA","VA"],
  "North America": ["AG","BS","BZ","CA","CR","CU","DM","DO","GD","GT","HN","HT","JM","KN","LC","MX","NI","PA","SV","US","VC"],
  "South America": ["AR","BO","BR","CL","CO","EC","GY","PE","PY","SR","UY","VE"],
  "Oceania": ["AU","FJ","FM","KI","MH","NR","NZ","PG","PW","SB","TO","TV","VU","WS"],
};

const isoToContinent: Record<string, string> = {};
for (const [continent, codes] of Object.entries(continentGroups)) {
  for (const code of codes) {
    isoToContinent[code] = continent;
  }
}

const customIsoOverrides: Record<string, string> = {
  'congo brazzaville': 'CG',
  'congo kinshasa': 'CD',
  'cote d ivoire': 'CI',
  'guinea bissau': 'GW',
  'holy see': 'VA',
  'laos': 'LA',
  'macedonia': 'MK',
  'moldova': 'MD',
  'swaziland': 'SZ',
  'syria': 'SY',
  'timor leste': 'TL'
};

// ==========================================
// ASZINKRON FELDOLGOZÓ MOTOR
// ==========================================
async function processJson(filePath: string, defaultStatus: RssStatus) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[WARN] Fájl nem található: ${filePath}`);
    return [];
  }

  const rawData = fs.readFileSync(filePath, 'utf-8');
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawData);
  } catch (e) {
    console.error(`[ERROR] JSON parse hiba: ${filePath}`, e);
    return [];
  }

  const sources: any[] = [];
  const missingIsoCodes = new Set<string>();

  if (!parsed || !parsed.locations || !Array.isArray(parsed.locations)) {
    return sources;
  }

  // 1. Lépés: Kinyerjük az összes rekordot egy lapos tömbbe
  const allExtractedItems: any[] = [];

  for (const locObj of parsed.locations) {
    const formattedLocation = formatLocationName(locObj.location);
    let isoCode = null;
    let continent = null;

    if (formattedLocation) {
      const searchCountry = formattedLocation.split(' - ')[0] || '';
      const normalizedSearch = searchCountry.toLowerCase().trim();
      isoCode = customIsoOverrides[normalizedSearch] || countries.getAlpha2Code(searchCountry, 'en') || null;

      if (isoCode) {
        continent = isoToContinent[isoCode] || 'Unknown';
      } else {
        missingIsoCodes.add(searchCountry);
      }
    }

    if (!locObj.content || !Array.isArray(locObj.content)) continue;

    for (const item of locObj.content) {
      allExtractedItems.push({
        originalItem: item,
        formattedLocation,
        isoCode,
        continent
      });
    }
  }

  console.log(`\n⏳ [${path.basename(filePath)}] ${allExtractedItems.length} URL hálózati ellenőrzése indul...`);

  // 2. Lépés: Párhuzamosított hálózati ellenőrzés (Kötegekben)
  const BATCH_SIZE = 50; // Egyszerre 50 kérést küldünk a gyorsaság érdekében

  for (let i = 0; i < allExtractedItems.length; i += BATCH_SIZE) {
    const batch = allExtractedItems.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (data) => {
      const frontUrl = await validateAndResolveUrl(data.originalItem.front_page_url);
      if (!frontUrl) return;

      sources.push({
        frontPageUrl: frontUrl,
        mediaName: cleanField(data.originalItem.media_name) || 'Unknown Media',
        mediaType: cleanField(data.originalItem.media_type),
        language: cleanField(data.originalItem.language),
        location: data.formattedLocation,
        countryCode: data.isoCode,
        continent: data.continent,
        detailPageUrl: cleanField(data.originalItem.detail_page_url),
        aboutPageUrl: cleanField(data.originalItem.about_page_url),
        contactPageUrl: cleanField(data.originalItem.contact_page_url),
        contactName: cleanField(data.originalItem.name),
        contactEmail: cleanField(data.originalItem.email),
        contactPhone: cleanField(data.originalItem.phone),
        rssFeedUrl: cleanField(data.originalItem.rss_feed_url),
        rssStatus: defaultStatus,
        isSystemImported: true, 
      });
    }));

    // Folyamatjelző kiírása a konzolra
    console.log(`   ✔️ Feldolgozva: ${Math.min(i + BATCH_SIZE, allExtractedItems.length)} / ${allExtractedItems.length}`);
  }
  
  if (missingIsoCodes.size > 0) {
    console.log(`⚠️ Hiányzó ISO kódok:`, Array.from(missingIsoCodes));
  }

  return sources;
}

// ==========================================
// FŐ FUTTATÓ FÜGGVÉNY
// ==========================================
async function runImport() {
  console.log('🚀 Adatbázis Importálás hálózati ellenőrzéssel (Párhuzamosítva)...');

  const successPath = path.join(process.cwd(), 'data', 'allSuccessRss.json');
  const failedPath = path.join(process.cwd(), 'data', 'allFailedRss.json');

  const successSources = await processJson(successPath, RssStatus.ACTIVE);
  const failedSources = await processJson(failedPath, RssStatus.NO_RSS_FOUND);

  const allSources = [...successSources, ...failedSources];

  if (allSources.length === 0) {
    console.log('❌ Nem található érvényes adat. Megszakítás.');
    return;
  }

  console.log(`\n📦 ${allSources.length} ellenőrzött rekord előkészítése az adatbázisba...`);

  try {
    // NEW LOGIC: Chunk the database inserts to bypass PostgreSQL limits
    const DB_BATCH_SIZE = 1000;
    let totalInserted = 0;

    console.log(`⏳ Adatbázisba írás indítása (${DB_BATCH_SIZE} elem/csomag)...`);

    for (let i = 0; i < allSources.length; i += DB_BATCH_SIZE) {
      const chunk = allSources.slice(i, i + DB_BATCH_SIZE);
      
      const result = await prisma.newsSource.createMany({
        data: chunk,
        skipDuplicates: true 
      });
      
      totalInserted += result.count;
      console.log(`   💾 Sikeresen mentve: ${Math.min(i + DB_BATCH_SIZE, allSources.length)} / ${allSources.length}`);
    }
    
    console.log(`\n✅ Importálás sikeresen befejeződött!`);
    console.log(`📊 Újonnan beszúrt rekordok (összesen): ${totalInserted}`);
    console.log(`⏭️ Kihagyott rekordok (Már létező domainek): ${allSources.length - totalInserted}`);

  } catch (error: any) {
    console.error('❌ Adatbázis hiba az importálás során:', error);
  } finally {
    await prisma.$disconnect();
    console.log('🔌 Adatbázis kapcsolat lezárva.');
  }
}

runImport();

// to run: npx ts-node scripts/import-rss.ts