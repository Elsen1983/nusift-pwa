import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";
import { RssStatus } from "@prisma/client";
import { safeFetch, SSRFError } from "./ssrf-guard";
import { normalizeActiveRssStatus } from "./news-pipeline/rss-status";
import { logAgentScan } from "./news-pipeline/log";
import { discoverFeedForUrl } from "./news-pipeline/feed-discovery";

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

const formatDiscoveryEvidence = (discovery: {
  detection: string;
  scopeConfidence?: string;
  score?: number;
  topCandidates?: Array<{ feedUrl: string; detection: string; score: number }>;
  lastError?: string;
}) => {
  const candidates =
    discovery.topCandidates?.length
      ? discovery.topCandidates
          .slice(0, 3)
          .map((candidate) => `${candidate.detection}:${candidate.score}:${candidate.feedUrl}`)
          .join(" | ")
      : "none";

  return `method=${discovery.detection}, confidence=${discovery.scopeConfidence || "n/a"}, score=${discovery.score ?? 0}, candidates=${candidates}${discovery.lastError ? `, lastError=${discovery.lastError}` : ""}`;
};

const buildDiscoveryEvidencePayload = (
  targetUrl: string,
  discovery: {
    feedUrl: string | null;
    discoveredVia: string | null;
    detection: string;
    scopeConfidence?: string;
    score?: number;
    topCandidates?: Array<{ feedUrl: string; detection: string; score: number; contentType?: string | null }>;
    rejectedCandidates?: Array<{ feedUrl: string; detection: string; score: number; contentType?: string | null; reason: string }>;
    lastError?: string;
  },
) =>
  ({
    evaluatedAt: new Date().toISOString(),
    targetUrl,
    feedUrl: discovery.feedUrl,
    discoveredVia: discovery.discoveredVia,
    detection: discovery.detection,
    scopeConfidence: discovery.scopeConfidence || "low",
    score: discovery.score ?? 0,
    topCandidates: discovery.topCandidates || [],
    rejectedCandidates: discovery.rejectedCandidates || [],
    lastError: discovery.lastError || null,
  }) satisfies Prisma.InputJsonValue;

export async function executeTargetedDiscovery(
  sourceIds: string[],
): Promise<void> {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    console.warn("[Targeted-Discovery] No source IDs provided for execution.");
    return;
  }

  const pendingSources = await prisma.newsSource.findMany({
    where: {
      id: { in: sourceIds },
      rssStatus: RssStatus.PENDING_DISCOVERY,
    },
  });

  if (pendingSources.length === 0) {
    console.log("[Targeted-Discovery] All requested sources are already processed.");
    return;
  }

  console.log(
    `[Targeted-Discovery] Initiating direct scan for ${pendingSources.length} specific sources....`,
  );

  for (const source of pendingSources) {
    try {
      const acceptLangHeader = generateAcceptLanguageHeader(source.language || "en");

      console.log(
        `[Targeted-Discovery][Fetch] Scanning frontPageUrl: "${source.frontPageUrl}" using Sovereign-Agent UA.`,
      );

      const response = await safeFetch(source.frontPageUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NuSift/1.0 Sovereign-Agent",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": acceptLangHeader,
        },
      });

      if (!response.ok) {
        if (response.status === 403 || response.status === 503) {
          throw new Error(`WAF_BLOCKED_${response.status}`);
        }
        throw new Error(`HTTP Error: ${response.status}`);
      }

      const finalUrlObj = new URL(response.url);
      const isWafTrap = WAF_AND_PAYWALL_PATTERNS.some((pattern) =>
        finalUrlObj.pathname.toLowerCase().includes(pattern),
      );

      if (isWafTrap) {
        const sourceHost = new URL(source.frontPageUrl).hostname
          .replace(/^www\./, "")
          .toLowerCase();
        console.warn(
          `[Targeted-Discovery] Soft WAF/Paywall Trap detected on ${sourceHost}. Path: ${finalUrlObj.pathname}`,
        );
        throw new Error("WAF_BLOCKED_REDIRECT");
      }

      const html = await response.text();
      console.log(
        `[Targeted-Discovery][Fetch] Successfully downloaded HTML from "${source.frontPageUrl}" (${html.length} bytes). Probing feed candidates...`,
      );

      const discovery = await discoverFeedForUrl({
        pageUrl: source.frontPageUrl,
        existingFeedUrl: source.rssFeedUrl || null,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NuSift/1.0 Sovereign-Agent",
        acceptLanguage: acceptLangHeader,
      });

      const nextStatus = normalizeActiveRssStatus(
        discovery.feedUrl ? RssStatus.ACTIVE : RssStatus.NO_RSS_FOUND,
        discovery.feedUrl,
      );

      await prisma.newsSource.update({
        where: { id: source.id },
        data: {
          rssStatus: nextStatus,
          rssFeedUrl: discovery.feedUrl,
          lastRssCheckAt: new Date(),
          discoveryEvidence: buildDiscoveryEvidencePayload(
            source.frontPageUrl,
            discovery,
          ),
        },
      });

      console.log(
        `[Targeted-Discovery][Database] Updated ID ${source.id} (${source.frontPageUrl}) status to: ${nextStatus}`,
      );
      await logAgentScan({
        sourceId: source.id,
        status: "ROOT_DISCOVERY_COMPLETED",
        executionTimeMs: 0,
        errorLog: discovery.feedUrl
          ? `Resolved root feed ${discovery.feedUrl}. ${formatDiscoveryEvidence(discovery)}`
          : `No root feed found for ${source.frontPageUrl}. ${formatDiscoveryEvidence(discovery)}`,
      });
    } catch (error: any) {
      if (error instanceof SSRFError) {
        console.warn(
          `[Targeted-Discovery][SSRF] Blocked unsafe URL: ${error.detail}. Marking as DOMAIN_DEAD.`,
        );
        await prisma.newsSource.update({
          where: { id: source.id },
          data: {
            rssStatus: "DOMAIN_DEAD",
            discoveryEvidence: {
              evaluatedAt: new Date().toISOString(),
              targetUrl: source.frontPageUrl,
              feedUrl: null,
              discoveredVia: null,
              detection: "blocked-security",
              scopeConfidence: "low",
              score: 0,
              topCandidates: [],
              rejectedCandidates: [],
              lastError: error.detail,
            } satisfies Prisma.InputJsonValue,
          },
        });
        continue;
      }

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
        data: {
          rssStatus: "FAILED",
          discoveryEvidence: {
            evaluatedAt: new Date().toISOString(),
            targetUrl: source.frontPageUrl,
            feedUrl: null,
            discoveredVia: null,
            detection: "failed",
            scopeConfidence: "low",
            score: 0,
            topCandidates: [],
            rejectedCandidates: [],
            lastError: error?.message || String(error),
          } satisfies Prisma.InputJsonValue,
        },
      });
    }
  }
}

export async function executeTargetedCategoryDiscovery(
  categoryIds: string[],
): Promise<void> {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
    return;
  }

  const categories = await prisma.sourceCategory.findMany({
    where: {
      id: { in: categoryIds },
    },
    select: {
      id: true,
      pathUrl: true,
      newsSourceId: true,
      newsSource: {
        select: {
          language: true,
        },
      },
    },
  });

  for (const category of categories) {
    const startedAt = Date.now();
    await logAgentScan({
      sourceId: category.newsSourceId,
      categoryId: category.id,
      status: "CATEGORY_DISCOVERY_STARTED",
      executionTimeMs: 0,
      errorLog: `Scanning category path ${category.pathUrl}`,
    });

    try {
      const acceptLangHeader = generateAcceptLanguageHeader(
        category.newsSource?.language || "en",
      );

      const discovery = await discoverFeedForUrl({
        pageUrl: category.pathUrl,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NuSift/1.0 Sovereign-Agent",
        acceptLanguage: acceptLangHeader,
        preferScopedDirectFeed: true,
      });

      const nextStatus = normalizeActiveRssStatus(
        discovery.feedUrl ? RssStatus.ACTIVE : RssStatus.NO_RSS_FOUND,
        discovery.feedUrl,
      );

      await prisma.sourceCategory.update({
        where: { id: category.id },
        data: {
          rssFeedUrl: discovery.feedUrl,
          rssStatus: nextStatus,
          lastRssCheckAt: new Date(),
          discoveryEvidence: buildDiscoveryEvidencePayload(
            category.pathUrl,
            discovery,
          ),
        },
      });

      await logAgentScan({
        sourceId: category.newsSourceId,
        categoryId: category.id,
        status: "CATEGORY_DISCOVERY_COMPLETED",
        executionTimeMs: Date.now() - startedAt,
        errorLog: discovery.feedUrl
          ? `Resolved category feed ${discovery.feedUrl}. ${formatDiscoveryEvidence(discovery)}`
          : `No category feed found for ${category.pathUrl}. ${formatDiscoveryEvidence(discovery)}`.trim(),
      });
    } catch (error: any) {
      await prisma.sourceCategory.update({
        where: { id: category.id },
        data: {
          rssStatus: "FAILED",
          lastRssCheckAt: new Date(),
          discoveryEvidence: {
            evaluatedAt: new Date().toISOString(),
            targetUrl: category.pathUrl,
            feedUrl: null,
            discoveredVia: null,
            detection: "failed",
            scopeConfidence: "low",
            score: 0,
            topCandidates: [],
            rejectedCandidates: [],
            lastError: error?.message || String(error),
          } satisfies Prisma.InputJsonValue,
        },
      });

      await logAgentScan({
        sourceId: category.newsSourceId,
        categoryId: category.id,
        status: "CATEGORY_DISCOVERY_FAILED",
        executionTimeMs: Date.now() - startedAt,
        errorLog: error?.message || String(error),
      });
    }
  }
}
