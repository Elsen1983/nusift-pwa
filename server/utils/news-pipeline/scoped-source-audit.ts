import fs from "fs";
import path from "path";
import { normalizeFrontPageUrlForAudit } from "./import-rss";

type SourceRecord = {
  id: string;
  frontPageUrl: string;
  mediaName: string | null;
  rssFeedUrl: string | null;
  rssStatus: string;
};

export type ScopedSourceAuditAction =
  | "keep"
  | "normalize_to_https"
  | "candidate_delete_invalid_subpath"
  | "candidate_shared_root_only"
  | "needs_manual_review";

export type ScopedSourceAuditItem = {
  sourceId: string;
  mediaName: string | null;
  frontPageUrl: string;
  normalizedFrontPageUrl: string;
  rssFeedUrl: string | null;
  rssStatus: string;
  action: ScopedSourceAuditAction;
  reasons: string[];
};

const LEGACY_PATH_PREFIXES: Record<string, string[]> = {
  "independent.ie": ["/regionals/"],
};

const toComparableHost = (rawUrl: string) => {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

const toComparablePath = (rawUrl: string) => {
  try {
    return new URL(rawUrl).pathname.replace(/\/+$/, "").toLowerCase() || "/";
  } catch {
    return "/";
  }
};

const hasNonRootPath = (rawUrl: string) => toComparablePath(rawUrl) !== "/";

const isRootLevelFeedForSameHost = (rssFeedUrl: string | null, frontPageUrl: string) => {
  if (!rssFeedUrl) return false;

  try {
    const feedUrl = new URL(rssFeedUrl);
    const sourceUrl = new URL(frontPageUrl);
    const sameHost =
      feedUrl.hostname.replace(/^www\./, "").toLowerCase() ===
      sourceUrl.hostname.replace(/^www\./, "").toLowerCase();

    if (!sameHost) return false;

    const feedPath = feedUrl.pathname.replace(/\/+$/, "").toLowerCase() || "/";
    return ["/rss", "/rss.xml", "/feed"].includes(feedPath) || feedUrl.search.includes("service=rss");
  } catch {
    return false;
  }
};

const isKnownLegacySubPath = (frontPageUrl: string) => {
  const host = toComparableHost(frontPageUrl);
  const pathValue = toComparablePath(frontPageUrl);
  const prefixes = LEGACY_PATH_PREFIXES[host] || [];
  return prefixes.some((prefix) => pathValue === prefix.slice(0, -1) || pathValue.startsWith(prefix));
};

export function buildScopedSourceAuditReport(sources: SourceRecord[]) {
  const rootRssByHost = new Map<string, Set<string>>();

  for (const source of sources) {
    if (hasNonRootPath(source.frontPageUrl) || !source.rssFeedUrl) continue;
    const host = toComparableHost(source.frontPageUrl);
    if (!host) continue;
    if (!rootRssByHost.has(host)) rootRssByHost.set(host, new Set<string>());
    rootRssByHost.get(host)?.add(source.rssFeedUrl);
  }

  const items: ScopedSourceAuditItem[] = [];

  for (const source of sources) {
    if (!hasNonRootPath(source.frontPageUrl)) continue;

    const normalizedFrontPageUrl = normalizeFrontPageUrlForAudit(source.frontPageUrl);
    const host = toComparableHost(source.frontPageUrl);
    const reasons: string[] = [];
    let action: ScopedSourceAuditAction = "keep";

    if (normalizedFrontPageUrl !== source.frontPageUrl) {
      reasons.push("Front page URL is not in canonical https form.");
      action = "normalize_to_https";
    }

    const usesSameRootFeed = Boolean(
      source.rssFeedUrl && rootRssByHost.get(host)?.has(source.rssFeedUrl),
    );

    if (isKnownLegacySubPath(source.frontPageUrl)) {
      reasons.push("Front page URL matches a known legacy sub-path pattern.");
      action = "candidate_delete_invalid_subpath";
    }

    if (isRootLevelFeedForSameHost(source.rssFeedUrl, source.frontPageUrl)) {
      reasons.push("Source uses a root-level RSS feed on the same host.");
      if (action === "keep" || action === "normalize_to_https") {
        action = "candidate_shared_root_only";
      }
    }

    if (usesSameRootFeed) {
      reasons.push("Source reuses the same RSS feed as the root-domain source.");
      if (action === "candidate_shared_root_only" || action === "normalize_to_https") {
        action = "candidate_delete_invalid_subpath";
      }
    }

    if (!source.rssFeedUrl) {
      reasons.push("Source has no RSS feed URL.");
      if (action === "keep") action = "needs_manual_review";
    }

    items.push({
      sourceId: source.id,
      mediaName: source.mediaName,
      frontPageUrl: source.frontPageUrl,
      normalizedFrontPageUrl,
      rssFeedUrl: source.rssFeedUrl,
      rssStatus: source.rssStatus,
      action,
      reasons,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalSubPathSources: items.length,
      keep: items.filter((item) => item.action === "keep").length,
      normalizeToHttps: items.filter((item) => item.action === "normalize_to_https").length,
      candidateDeleteInvalidSubpath: items.filter((item) => item.action === "candidate_delete_invalid_subpath").length,
      candidateSharedRootOnly: items.filter((item) => item.action === "candidate_shared_root_only").length,
      needsManualReview: items.filter((item) => item.action === "needs_manual_review").length,
    },
    items,
  };
}

export function getScopedSourceAuditReportPath() {
  return path.join(process.cwd(), "data", "scoped-source-audit-report.json");
}

export function writeScopedSourceAuditReport(report: ReturnType<typeof buildScopedSourceAuditReport>) {
  fs.writeFileSync(getScopedSourceAuditReportPath(), JSON.stringify(report, null, 2), "utf-8");
}

export function readScopedSourceAuditReport(): ReturnType<typeof buildScopedSourceAuditReport> {
  return JSON.parse(fs.readFileSync(getScopedSourceAuditReportPath(), "utf-8"));
}
