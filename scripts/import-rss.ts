// scripts/import-rss.ts
// to run : `npx tsx scripts/import-rss.ts`
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

const cleanField = (val: string | undefined | null) => {
  return val && val.trim() !== '' ? val.trim() : null;
};

const formatLocationName = (raw: string | undefined | null) => {
  if (!raw || raw.trim() === '') return null;
  let formatted = raw.trim();
  if (formatted.startsWith('United_States_')) {
    formatted = formatted.replace(/^United_States_/, 'United States - ');
  }
  return formatted.replace(/_/g, ' ');
};

async function validateAndResolveUrl(rawUrl: string | undefined | null): Promise<string | null> {
  if (!rawUrl || rawUrl.trim() === '') return null;
  let targetUrl = rawUrl.trim();
  if (!targetUrl.startsWith('http')) targetUrl = `https://${targetUrl}`;
  const TIMEOUT_MS = 3500;
  try {
    const controller = new AbortController();
    const fetchPromise = fetch(targetUrl, { method: 'HEAD', signal: controller.signal });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => { controller.abort(); reject(new Error('Timeout')); }, TIMEOUT_MS);
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]) as Response;
    if (response && response.ok) return response.url.replace(/\/+$/, '');
    return targetUrl.replace(/\/+$/, '');
  } catch (error) {
    return targetUrl.replace(/\/+$/, '');
  }
}

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
  for (const code of codes) { isoToContinent[code] = continent; }
}

const customIsoOverrides: Record<string, string> = {
  'congo brazzaville': 'CG', 'congo kinshasa': 'CD', 'cote d ivoire': 'CI', 'guinea bissau': 'GW',
  'holy see': 'VA', 'laos': 'LA', 'macedonia': 'MK', 'moldova': 'MD', 'swaziland': 'SZ', 'syria': 'SY', 'timor leste': 'TL'
};

interface ExtractedSourcePayload {
  rootUrl: string;
  fullUrl: string;
  isCategory: boolean;
  mediaName: string;
  mediaType: string | null;
  language: string | null;
  location: string | null;
  countryCode: string | null;
  continent: string | null;
  detailPageUrl: string | null;
  aboutPageUrl: string | null;
  contactPageUrl: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  rssFeedUrl: string | null;
  rssStatus: RssStatus;
}

async function processJson(filePath: string, defaultStatus: RssStatus): Promise<ExtractedSourcePayload[]> {
  if (!fs.existsSync(filePath)) {
    console.warn(`[WARN] Fájl nem található: ${filePath}`);
    return [];
  }

  const rawData = fs.readFileSync(filePath, 'utf-8');
  let parsed: any = null;
  try { parsed = JSON.parse(rawData); } catch (e) { return []; }

  const extractedPayloads: ExtractedSourcePayload[] = [];
  if (!parsed || !parsed.locations || !Array.isArray(parsed.locations)) return [];

  const rawItems: any[] = [];
  for (const locObj of parsed.locations) {
    const formattedLocation = formatLocationName(locObj.location);
    let isoCode = null;
    let continent = null;

    if (formattedLocation) {
      const searchCountry = formattedLocation.split(' - ')[0] || '';
      const normalizedSearch = searchCountry.toLowerCase().trim();
      isoCode = customIsoOverrides[normalizedSearch] || countries.getAlpha2Code(searchCountry, 'en') || null;
      if (isoCode) continent = isoToContinent[isoCode] || 'Unknown';
    }

    if (!locObj.content || !Array.isArray(locObj.content)) continue;
    for (const item of locObj.content) {
      rawItems.push({ item, formattedLocation, isoCode, continent });
    }
  }

  console.log(`\n⏳ [${path.basename(filePath)}] ${rawItems.length} rekord hálózati normalizálása indul...`);
  const BATCH_SIZE = 50;

  for (let i = 0; i < rawItems.length; i += BATCH_SIZE) {
    const batch = rawItems.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (data) => {
      const resolvedUrl = await validateAndResolveUrl(data.item.front_page_url);
      if (!resolvedUrl) return;

      try {
        const urlObj = new URL(resolvedUrl);
        const rootUrl = `${urlObj.protocol}//${urlObj.hostname}`;
        const isCategory = urlObj.pathname !== '/' && urlObj.pathname !== '';

        extractedPayloads.push({
          rootUrl: rootUrl.toLowerCase().trim(),
          fullUrl: resolvedUrl,
          isCategory,
          mediaName: cleanField(data.item.media_name) || 'Unknown Media',
          mediaType: cleanField(data.item.media_type),
          language: cleanField(data.item.language),
          location: data.formattedLocation,
          countryCode: data.isoCode,
          continent: data.continent,
          detailPageUrl: cleanField(data.item.detail_page_url),
          aboutPageUrl: cleanField(data.item.about_page_url),
          contactPageUrl: cleanField(data.item.contact_page_url),
          contactName: cleanField(data.item.name),
          contactEmail: cleanField(data.item.email),
          contactPhone: cleanField(data.item.phone),
          rssFeedUrl: cleanField(data.item.rss_feed_url),
          rssStatus: defaultStatus
        });
      } catch (e) {}
    }));
    console.log(`   ✔️ Normalizálva: ${Math.min(i + BATCH_SIZE, rawItems.length)} / ${rawItems.length}`);
  }

  return extractedPayloads;
}

async function runImport() {
  console.log('🚀 Adatbázis Importálás strukturális szűréssel és optimalizált Bulk mentéssel...');

  const successPath = path.join(process.cwd(), 'data', 'allSuccessRss.json');
  const failedPath = path.join(process.cwd(), 'data', 'allFailedRss.json');

  const successPayloads = await processJson(successPath, RssStatus.ACTIVE);
  const failedPayloads = await processJson(failedPath, RssStatus.NO_RSS_FOUND);

  const allPayloads = [...successPayloads, ...failedPayloads];
  if (allPayloads.length === 0) {
    console.log('❌ Nem található érvényes adat. Megszakítás.');
    return;
  }

  // 1. LÉPÉS: Egyedi gyökér domainek kiszűrése a memóriában
  const uniqueRootMap = new Map<string, any>();
  for (const p of allPayloads) {
    if (!uniqueRootMap.has(p.rootUrl)) {
      uniqueRootMap.set(p.rootUrl, {
        frontPageUrl: p.rootUrl,
        mediaName: p.isCategory ? p.rootUrl.replace(/^https?:\/\/(www\.)?/, '') : p.mediaName,
        mediaType: p.mediaType,
        language: p.language,
        location: p.location,
        countryCode: p.countryCode,
        continent: p.continent,
        isSystemImported: true,
        rssStatus: p.isCategory ? RssStatus.ACTIVE : p.rssStatus
      });
    }
  }

  const newsSourcesToInsert = Array.from(uniqueRootMap.values());
  console.log(`\n📦 Előkészítve: ${newsSourcesToInsert.length} egyedi főoldal (NewsSource).`);
  
  try {
    // 2. LÉPÉS: Tömeges beszúrás a NewsSource táblába (Gyors és golyóálló)
    console.log(`⏳ Főoldalak írása az adatbázisba (Bulk createMany)...`);
    const rootResult = await prisma.newsSource.createMany({
      data: newsSourcesToInsert,
      skipDuplicates: true
    });
    console.log(`   💾 Mentve/Szinkronizálva: ${rootResult.count} új gyökér-domain.`);

    // 3. LÉPÉS: Lekérjük az összes meglévő NewsSource-t az ID-k párosításához
    console.log(`⏳ Id-k lekérése a relációk feltérképezéséhez...`);
    const dbSources = await prisma.newsSource.findMany({
      select: { id: true, frontPageUrl: true }
    });
    const urlToIdMap = new Map(dbSources.map(s => [s.frontPageUrl.toLowerCase().trim(), s.id]));

    // 4. LÉPÉS: Kategóriák előkészítése a memóriában
    const categoriesToInsert: any[] = [];
    const uniqueCategoryCheck = new Set<string>(); // Megakadályozza a belső JSON duplikációt

    for (const p of allPayloads) {
      const parentId = urlToIdMap.get(p.rootUrl);
      if (!parentId) continue;

      if (p.isCategory) {
        const urlObj = new URL(p.fullUrl);
        const uniqueKey = `${parentId}_${p.fullUrl.toLowerCase().trim()}`;

        if (!uniqueCategoryCheck.has(uniqueKey)) {
          uniqueCategoryCheck.add(uniqueKey);
          categoriesToInsert.push({
            newsSourceId: parentId,
            name: p.mediaName !== 'Unknown Media' ? p.mediaName : urlObj.pathname.substring(1).replace(/\//g, " - "),
            pathUrl: p.fullUrl,
            rssFeedUrl: p.rssFeedUrl,
            rssStatus: p.rssStatus,
            isUserRequested: false
          });
        }
      }
    }

    // 5. LÉPÉS: Tömeges beszúrás a SourceCategory táblába (Bulk createMany)
    console.log(`\n📦 Előkészítve: ${categoriesToInsert.length} egyedi aloldal/rovat (SourceCategory).`);
    
    if (categoriesToInsert.length > 0) {
      console.log(`⏳ Aloldalak írása az adatbázisba (Bulk createMany kötegekben)...`);
      const CATEGORY_CHUNK_SIZE = 1000;
      let savedCatsCount = 0;

      for (let i = 0; i < categoriesToInsert.length; i += CATEGORY_CHUNK_SIZE) {
        const chunk = categoriesToInsert.slice(i, i + CATEGORY_CHUNK_SIZE);
        const catResult = await prisma.sourceCategory.createMany({
          data: chunk,
          skipDuplicates: true
        });
        savedCatsCount += catResult.count;
        console.log(`   💾 Mentve: ${Math.min(i + CATEGORY_CHUNK_SIZE, categoriesToInsert.length)} / ${categoriesToInsert.length}`);
      }
      console.log(`   ✔️ Sikeresen létrehozva ${savedCatsCount} új egyedi SourceCategory rekord.`);
    }

    console.log(`\n✅ Szuper-gyors Bulk Import sikeresen befejeződött!`);

  } catch (error: any) {
    console.error('❌ Adatbázis hiba az importálás során:', error);
  } finally {
    await prisma.$disconnect();
    console.log('🔌 Adatbázis kapcsolat lezárva.');
  }
}

runImport();