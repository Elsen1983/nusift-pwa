import fs from "fs";
import path from "path";
import { RssStatus } from "@prisma/client";
import * as isoPackage from "i18n-iso-countries";
import enLocaleJson from "i18n-iso-countries/langs/en.json";
import { safeFetch } from "../ssrf-guard";
import { normalizeActiveRssStatus } from "./rss-status";

const countries = ("default" in isoPackage ? isoPackage.default : isoPackage) as any;
const enLocale = "default" in enLocaleJson ? enLocaleJson.default : enLocaleJson;

countries.registerLocale(enLocale);

const cleanField = (val: string | undefined | null) => {
  return val && val.trim() !== "" ? val.trim() : null;
};

const normalizeUrl = (rawUrl: string | undefined | null) => {
  if (!rawUrl || rawUrl.trim() === "") return null;
  return rawUrl.trim().replace(/\/+$/, "");
};

const formatLocationName = (raw: string | undefined | null) => {
  if (!raw || raw.trim() === "") return null;
  let formatted = raw.trim();

  if (formatted.startsWith("United_States_")) {
    formatted = formatted.replace(/^United_States_/, "United States - ");
  }

  return formatted.replace(/_/g, " ");
};

const continentGroups: Record<string, string[]> = {
  Africa: ["AO","BF","BI","BJ","BW","CD","CF","CG","CI","CM","CV","DJ","DZ","EG","EH","ER","ET","GA","GH","GM","GN","GQ","GW","KE","KM","LR","LS","LY","MA","MG","ML","MR","MU","MW","MZ","NA","NE","NG","RW","SC","SD","SL","SN","SO","ST","SZ","TD","TG","TN","TZ","UG","ZA","ZM","ZW"],
  Asia: ["AE","AF","AM","AZ","BD","BH","BN","BT","CN","GE","ID","IL","IN","IQ","IR","JO","JP","KG","KH","KP","KR","KW","KZ","LA","LB","LK","MM","MN","MY","OM","PH","PK","QA","SA","SY","TH","TJ","TM","TR","TW","UZ","VN","YE"],
  Europe: ["AD","AL","AT","BA","BE","BG","BY","CH","CY","CZ","DE","DK","EE","ES","FI","FR","GB","GR","HR","HU","IE","IS","IT","LI","LT","LU","LV","MC","MD","ME","MK","MT","NL","NO","PL","PT","RO","RS","RU","SE","SI","SK","SM","UA","VA"],
  "North America": ["AG","BS","BZ","CA","CR","CU","DM","DO","GD","GT","HN","HT","JM","KN","LC","MX","NI","PA","SV","US","VC"],
  "South America": ["AR","BO","BR","CL","CO","EC","GY","PE","PY","SR","UY","VE"],
  Oceania: ["AU","FJ","FM","KI","MH","NR","NZ","PG","PW","SB","TO","TV","VU","WS"],
};

const isoToContinent: Record<string, string> = {};
for (const [continent, codes] of Object.entries(continentGroups)) {
  for (const code of codes) isoToContinent[code] = continent;
}

const customIsoOverrides: Record<string, string> = {
  "congo brazzaville": "CG",
  "congo kinshasa": "CD",
  "cote d ivoire": "CI",
  "guinea bissau": "GW",
  "holy see": "VA",
  laos: "LA",
  macedonia: "MK",
  moldova: "MD",
  swaziland: "SZ",
  syria: "SY",
  "timor leste": "TL",
};

export type ImportSourceRecord = {
  frontPageUrl: string;
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
};

export function loadImportSources() {
  const processJson = (filePath: string, defaultStatus: RssStatus) => {
    if (!fs.existsSync(filePath)) return [] as ImportSourceRecord[];

    const rawData = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(rawData);
    const sources: ImportSourceRecord[] = [];

    for (const locObj of parsed.locations) {
      const formattedLocation = formatLocationName(locObj.location);

      let isoCode = null;
      let continent = null;

      if (formattedLocation) {
        const searchCountry = formattedLocation.split(" - ")[0] || "";
        const normalizedSearch = searchCountry.toLowerCase().trim();

        isoCode =
          customIsoOverrides[normalizedSearch] ||
          countries.getAlpha2Code(searchCountry, "en") ||
          null;

        if (isoCode) continent = isoToContinent[isoCode] || "Unknown";
      }

      for (const item of locObj.content) {
        const frontUrl = normalizeUrl(item.front_page_url);
        if (!frontUrl) continue;

        const rssFeedUrl = cleanField(item.rss_feed_url);
        sources.push({
          frontPageUrl: frontUrl,
          mediaName: cleanField(item.media_name) || "Unknown Media",
          mediaType: cleanField(item.media_type),
          language: cleanField(item.language),
          location: formattedLocation,
          countryCode: isoCode,
          continent,
          detailPageUrl: cleanField(item.detail_page_url),
          aboutPageUrl: cleanField(item.about_page_url),
          contactPageUrl: cleanField(item.contact_page_url),
          contactName: cleanField(item.name),
          contactEmail: cleanField(item.email),
          contactPhone: cleanField(item.phone),
          rssFeedUrl,
          rssStatus: normalizeActiveRssStatus(defaultStatus, rssFeedUrl),
        });
      }
    }

    return sources;
  };

  const successPath = path.join(process.cwd(), "data", "allSuccessRss.json");
  const failedPath = path.join(process.cwd(), "data", "allFailedRss.json");

  return [
    ...processJson(successPath, RssStatus.ACTIVE),
    ...processJson(failedPath, RssStatus.NO_RSS_FOUND),
  ];
}

export function buildFeedUrlCandidates(feedUrl: string | null, frontPageUrl?: string | null) {
  const candidates = new Set<string>();

  const add = (value?: string | null) => {
    if (!value) return;
    candidates.add(value);
  };

  add(feedUrl);

  try {
    if (feedUrl) {
      const parsed = new URL(feedUrl);
      if (parsed.pathname.replace(/\/+$/, "").toLowerCase() === "/rss.xml") {
        add(`${parsed.protocol}//${parsed.hostname}/?service=rss`);
      }
    }
  } catch {}

  try {
    if (frontPageUrl) {
      const parsedFront = new URL(frontPageUrl);
      add(`${parsedFront.protocol}//${parsedFront.hostname}/?service=rss`);
    }
  } catch {}

  return [...candidates];
}

const looksLikeFeed = (body: string) => {
  const sample = body.slice(0, 4000).toLowerCase();
  return (
    sample.includes("<rss") ||
    sample.includes("<feed") ||
    sample.includes("<rdf:rdf") ||
    sample.includes("<channel") ||
    sample.includes("<entry") ||
    sample.includes("<item")
  );
};

export async function verifyImportedRssFeed(rssFeedUrl: string | null) {
  if (!rssFeedUrl) {
    return { verified: false, status: RssStatus.NO_RSS_FOUND, reason: "No rss_feed_url in import data." };
  }

  const urlsToTry = buildFeedUrlCandidates(rssFeedUrl);
  let lastReason = "Feed verification failed.";

  for (const candidateUrl of urlsToTry) {
    try {
      const response = await safeFetch(candidateUrl, {
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent": "NuSift/1.0 RSS-Verify",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        },
      });

      if (!response.ok) {
        lastReason = `Feed returned HTTP ${response.status} for ${candidateUrl}.`;
        continue;
      }

      const body = await response.text();
      if (!looksLikeFeed(body)) {
        lastReason = `URL responded, but payload did not look like RSS or Atom for ${candidateUrl}.`;
        continue;
      }

      return {
        verified: true,
        status: RssStatus.ACTIVE,
        reason: `Feed URL verified successfully via ${candidateUrl}.`,
      };
    } catch (error: any) {
      lastReason = `${error?.message || String(error)} via ${candidateUrl}`;
    }
  }

  return {
    verified: false,
    status: RssStatus.FAILED,
    reason: lastReason,
  };
}

export function getImportRssReportPath() {
  return path.join(process.cwd(), "data", "import-rss-report.json");
}
