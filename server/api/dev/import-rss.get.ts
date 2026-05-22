// server/api/dev/import-rss.get.ts
import fs from 'fs';
import path from 'path';
import { prisma } from '../../utils/prisma';
import { RssStatus } from '@prisma/client';

// 1. Biztonságos importálás mind a kód, mind a JSON esetén
import * as isoPackage from 'i18n-iso-countries';
import enLocaleJson from 'i18n-iso-countries/langs/en.json';

// 2. Golyóálló interop: ha van 'default' property (mert a fordító abba csomagolta), azt használjuk
const countries = ('default' in isoPackage ? isoPackage.default : isoPackage) as any;
const enLocale = 'default' in enLocaleJson ? enLocaleJson.default : enLocaleJson;

countries.registerLocale(enLocale);

// ==========================================
// ADATTISZTÍTÓ ÉS FORMÁZÓ FÜGGVÉNYEK
// ==========================================

const cleanField = (val: string | undefined | null) => {
  return val && val.trim() !== '' ? val.trim() : null;
};

const normalizeUrl = (rawUrl: string | undefined | null) => {
  if (!rawUrl || rawUrl.trim() === '') return null;
  let formatted = rawUrl.trim();
  return formatted.replace(/\/+$/, ''); 
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
// KONTINENS MAPPER LOGIKA
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

// Kézi felülírások a hivatalos szótárból hiányzó/alternatív nevekhez
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
// FELDOLGOZÓ MOTOR
// ==========================================

function processJson(filePath: string, defaultStatus: RssStatus) {
  if (!fs.existsSync(filePath)) return [];

  const rawData = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(rawData);
  const sources: any[] = [];
  const missingIsoCodes = new Set<string>();

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

    for (const item of locObj.content) {
      const frontUrl = normalizeUrl(item.front_page_url);
      if (!frontUrl) continue;

      sources.push({
        frontPageUrl: frontUrl,
        mediaName: cleanField(item.media_name) || 'Unknown Media',
        mediaType: cleanField(item.media_type),
        language: cleanField(item.language),
        location: formattedLocation,
        countryCode: isoCode,
        continent: continent,
        detailPageUrl: cleanField(item.detail_page_url),
        aboutPageUrl: cleanField(item.about_page_url),
        contactPageUrl: cleanField(item.contact_page_url),
        contactName: cleanField(item.name),
        contactEmail: cleanField(item.email),
        contactPhone: cleanField(item.phone),
        rssFeedUrl: cleanField(item.rss_feed_url),
        rssStatus: defaultStatus,
      });
    }
  }
  
  if (missingIsoCodes.size > 0) {
    console.log(`⚠️ ISO kód nem található a következőkhöz:`, Array.from(missingIsoCodes));
  }

  return sources;
}

export default defineEventHandler(async (event) => {
  if (process.env.NODE_ENV === 'production') {
    throw createError({ statusCode: 403, statusMessage: "Forbidden in production" });
  }

  const successPath = path.join(process.cwd(), 'data', 'allSuccessRss.json');
  const failedPath = path.join(process.cwd(), 'data', 'allFailedRss.json');

  const successSources = processJson(successPath, RssStatus.ACTIVE);
  const failedSources = processJson(failedPath, RssStatus.NO_RSS_FOUND);

  const allSources = [...successSources, ...failedSources];

  if (allSources.length === 0) return { success: false, message: "No data found." };

  try {
    const result = await prisma.newsSource.createMany({
      data: allSources,
      skipDuplicates: true, 
    });

    return {
      success: true,
      message: `Feltöltés kész! Új elemek: ${result.count}. Kihagyott elemek: ${allSources.length - result.count}`,
    };
  } catch (error: any) {
    throw createError({ statusCode: 500, statusMessage: "DB Error", message: error.message });
  }
});