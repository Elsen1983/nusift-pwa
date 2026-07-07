import fs from "fs";
import path from "path";
import { prisma } from "../prisma";

export type HttpSourceNormalizationItem = {
  sourceId: string;
  currentFrontPageUrl: string;
  normalizedHttpsUrl: string | null;
  currentRssFeedUrl?: string | null;
  normalizedHttpsRssFeedUrl?: string | null;
  action: "update_to_https" | "conflict_existing_https" | "invalid_url";
  conflictingSourceId?: string | null;
  conflictingFrontPageUrl?: string | null;
  invalidReason?: string | null;
};

export type HttpSourceNormalizationReport = {
  generatedAt: string;
  summary: {
    totalHttpSources: number;
    updateToHttps: number;
    conflicts: number;
    invalidUrls: number;
  };
  items: HttpSourceNormalizationItem[];
};

const normalizeToHttps = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    parsed.protocol = "https:";
    return parsed.toString();
  } catch {
    return null;
  }
};

export function getHttpSourceNormalizationReportPath() {
  return path.join(process.cwd(), "data", "http-source-normalization-report.json");
}

export function readHttpSourceNormalizationReport() {
  return JSON.parse(
    fs.readFileSync(getHttpSourceNormalizationReportPath(), "utf-8"),
  ) as HttpSourceNormalizationReport;
}

export async function buildHttpSourceNormalizationReport() {
  const httpSources = await prisma.newsSource.findMany({
    where: {
      OR: [
        {
          frontPageUrl: {
            startsWith: "http://",
          },
        },
        {
          rssFeedUrl: {
            startsWith: "http://",
          },
        },
      ],
    },
    select: {
      id: true,
      frontPageUrl: true,
      rssFeedUrl: true,
    },
    orderBy: {
      frontPageUrl: "asc",
    },
  });

  const normalizedCandidates = httpSources.map((source) => ({
    sourceId: source.id,
    currentFrontPageUrl: source.frontPageUrl,
    normalizedHttpsUrl: normalizeToHttps(source.frontPageUrl),
    currentRssFeedUrl: source.rssFeedUrl,
    normalizedHttpsRssFeedUrl:
      source.rssFeedUrl && source.rssFeedUrl.startsWith("http://")
        ? normalizeToHttps(source.rssFeedUrl)
        : source.rssFeedUrl,
  }));

  const httpsUrls = [
    ...new Set(
      normalizedCandidates
        .map((item) => item.normalizedHttpsUrl)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const existingHttpsSources = httpsUrls.length
    ? await prisma.newsSource.findMany({
        where: {
          frontPageUrl: {
            in: httpsUrls,
          },
        },
        select: {
          id: true,
          frontPageUrl: true,
        },
      })
    : [];

  const existingByHttpsUrl = new Map(
    existingHttpsSources.map((source) => [source.frontPageUrl, source]),
  );

  const items: HttpSourceNormalizationItem[] = normalizedCandidates.map((item) => {
    if (!item.normalizedHttpsUrl) {
      return {
        ...item,
        action: "invalid_url",
        conflictingSourceId: null,
        conflictingFrontPageUrl: null,
        invalidReason: `Invalid frontPageUrl: ${item.currentFrontPageUrl}`,
      };
    }

    const conflict = existingByHttpsUrl.get(item.normalizedHttpsUrl);
    if (conflict && conflict.id !== item.sourceId) {
      return {
        ...item,
        action: "conflict_existing_https",
        conflictingSourceId: conflict.id,
        conflictingFrontPageUrl: conflict.frontPageUrl,
        invalidReason: null,
      };
    }

    return {
      ...item,
      action: "update_to_https",
      conflictingSourceId: null,
      conflictingFrontPageUrl: null,
      invalidReason: null,
    };
  });

  const report: HttpSourceNormalizationReport = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalHttpSources: items.length,
      updateToHttps: items.filter((item) => item.action === "update_to_https").length,
      conflicts: items.filter((item) => item.action === "conflict_existing_https").length,
      invalidUrls: items.filter((item) => item.action === "invalid_url").length,
    },
    items,
  };

  fs.writeFileSync(getHttpSourceNormalizationReportPath(), JSON.stringify(report, null, 2), "utf-8");
  return report;
}
