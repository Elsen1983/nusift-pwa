import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../prisma";
import { createPipelineRun } from "./artifacts";
import {
  discoverArticlesFromTarget,
  persistArticleDiscoveryArtifact,
  type ArticleDiscoveryTarget,
} from "./article-discovery";
import {
  discoverArticleLinksWithBrowser,
  evaluateArticleLinkCandidateWithBrowser,
  isBrowserFallbackEnabled,
} from "./article-discovery-browser";
import { persistCandidates } from "./ingest";
import type { IngestCandidate } from "./types";

type Agent2DebugMode = "static" | "browser" | "both";

export type Agent2TargetInput = {
  sourceId?: string | null;
  categoryId?: string | null;
  targetUrl?: string | null;
  mode?: Agent2DebugMode;
  persist?: boolean;
};

type ArtifactSummary = {
  id: string;
  artifactType: string;
  status: string;
  candidateCount: number;
  createdAt: string;
  targetUrl: string | null;
  quality: string | null;
  shouldEscalateToHeadless: boolean | null;
};

type TargetStateSnapshot = {
  sourceId: string;
  categoryId: string | null;
  targetUrl: string;
  rssStatus: string;
  rssFeedUrl: string | null;
  currentFeedProductive: boolean;
  consecutiveNonProductiveRuns: number;
  lastRssCheckAt: string | null;
  latestCandidateArtifact: ArtifactSummary | null;
  latestHeadlessArtifact: ArtifactSummary | null;
};

const readPayloadObject = (payload: unknown): Record<string, any> =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, any>
    : {};

const targetUrlVariants = (targetUrl: string): string[] => {
  const trimmed = targetUrl.trim();
  if (!trimmed) return [];
  const variants = new Set([trimmed]);
  if (trimmed.endsWith("/")) {
    variants.add(trimmed.replace(/\/+$/, ""));
  } else {
    variants.add(`${trimmed}/`);
  }
  return Array.from(variants);
};

async function resolveInputSourceId(input: Agent2TargetInput): Promise<string> {
  if (input.sourceId) return input.sourceId;
  if (!input.targetUrl) {
    throw new Error("Missing required --sourceId=<id> or --targetUrl=<url>");
  }

  const urlVariants = targetUrlVariants(input.targetUrl);
  const category = await prisma.sourceCategory.findFirst({
    where: { pathUrl: { in: urlVariants } },
    select: { newsSourceId: true },
  });
  if (category) return category.newsSourceId;

  const source = await prisma.newsSource.findFirst({
    where: { frontPageUrl: { in: urlVariants } },
    select: { id: true },
  });
  if (source) return source.id;

  throw new Error(
    `No local NewsSource or SourceCategory found for --targetUrl=${input.targetUrl}. ` +
    `Import/export the fixture first, or pass --sourceId=<id>.`,
  );
}

const summarizeArtifact = (artifact: {
  id: string;
  artifactType: string;
  status: string;
  candidateCount: number;
  createdAt: Date;
  payload: unknown;
} | null): ArtifactSummary | null => {
  if (!artifact) return null;
  const payload = readPayloadObject(artifact.payload);
  const quality = readPayloadObject(payload.qualityAssessment).quality || payload.quality || null;
  const shouldEscalate = readPayloadObject(payload.qualityAssessment).shouldEscalateToHeadless;

  return {
    id: artifact.id,
    artifactType: artifact.artifactType,
    status: artifact.status,
    candidateCount: artifact.candidateCount,
    createdAt: artifact.createdAt.toISOString(),
    targetUrl: typeof payload.targetUrl === "string" ? payload.targetUrl : null,
    quality: typeof quality === "string" ? quality : null,
    shouldEscalateToHeadless: typeof shouldEscalate === "boolean" ? shouldEscalate : null,
  };
};

export async function buildAgent2Target(input: Agent2TargetInput): Promise<ArticleDiscoveryTarget> {
  const resolvedSourceId = await resolveInputSourceId(input);
  const source = await prisma.newsSource.findUnique({
    where: { id: resolvedSourceId },
    select: {
      id: true,
      mediaName: true,
      frontPageUrl: true,
      rssStatus: true,
      currentFeedProductive: true,
      consecutiveNonProductiveRuns: true,
    },
  });

  if (!source) {
    throw new Error(`NewsSource not found: ${resolvedSourceId}`);
  }

  if (input.categoryId || input.targetUrl) {
    let category = await prisma.sourceCategory.findUnique({
      where: { id: input.categoryId || "__missing_category_id__" },
      select: {
        id: true,
        newsSourceId: true,
        name: true,
        pathUrl: true,
        rssStatus: true,
        currentFeedProductive: true,
        consecutiveNonProductiveRuns: true,
      },
    });

    if (!category && input.targetUrl) {
      category = await prisma.sourceCategory.findFirst({
        where: {
          newsSourceId: source.id,
          pathUrl: { in: targetUrlVariants(input.targetUrl) },
        },
        select: {
          id: true,
          newsSourceId: true,
          name: true,
          pathUrl: true,
          rssStatus: true,
          currentFeedProductive: true,
          consecutiveNonProductiveRuns: true,
        },
      });
    }

    if (!category && !input.categoryId) {
      return {
        targetType: "source",
        sourceId: source.id,
        categoryId: null,
        targetUrl: input.targetUrl || source.frontPageUrl,
        rssStatus: source.rssStatus,
        currentFeedProductive: source.currentFeedProductive,
        consecutiveNonProductiveRuns: source.consecutiveNonProductiveRuns,
        mediaName: source.mediaName,
      };
    }

    if (!category) {
      throw new Error(
        `SourceCategory not found: ${input.categoryId || input.targetUrl}. ` +
        `If this ID came from production, export/import the fixture first or pass a local categoryId. ` +
        `You can also pass --targetUrl=<url> to match an existing local category by URL.`,
      );
    }
    if (category.newsSourceId !== source.id) {
      throw new Error(`SourceCategory ${category.id} does not belong to NewsSource ${source.id}`);
    }

    return {
      targetType: "category",
      sourceId: source.id,
      categoryId: category.id,
      targetUrl: input.targetUrl || category.pathUrl,
      rssStatus: category.rssStatus,
      currentFeedProductive: category.currentFeedProductive,
      consecutiveNonProductiveRuns: category.consecutiveNonProductiveRuns,
      mediaName: `${source.mediaName} / ${category.name}`,
    };
  }

  return {
    targetType: "source",
    sourceId: source.id,
    categoryId: null,
    targetUrl: input.targetUrl || source.frontPageUrl,
    rssStatus: source.rssStatus,
    currentFeedProductive: source.currentFeedProductive,
    consecutiveNonProductiveRuns: source.consecutiveNonProductiveRuns,
    mediaName: source.mediaName,
  };
}

export async function getAgent2TargetSnapshot(target: ArticleDiscoveryTarget): Promise<TargetStateSnapshot> {
  const [state, latestCandidateArtifact, latestHeadlessArtifact] = await Promise.all([
    target.categoryId
      ? prisma.sourceCategory.findUnique({
          where: { id: target.categoryId },
          select: {
            id: true,
            pathUrl: true,
            rssStatus: true,
            rssFeedUrl: true,
            currentFeedProductive: true,
            consecutiveNonProductiveRuns: true,
            lastRssCheckAt: true,
          },
        })
      : prisma.newsSource.findUnique({
          where: { id: target.sourceId },
          select: {
            id: true,
            frontPageUrl: true,
            rssStatus: true,
            rssFeedUrl: true,
            currentFeedProductive: true,
            consecutiveNonProductiveRuns: true,
            lastRssCheckAt: true,
          },
        }),
    prisma.pipelineArtifact.findFirst({
      where: {
        sourceId: target.sourceId,
        categoryId: target.categoryId || null,
        artifactType: "article_discovery_candidates",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        artifactType: true,
        status: true,
        candidateCount: true,
        createdAt: true,
        payload: true,
      },
    }),
    prisma.pipelineArtifact.findFirst({
      where: {
        sourceId: target.sourceId,
        categoryId: target.categoryId || null,
        artifactType: "article_discovery_headless_required",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        artifactType: true,
        status: true,
        candidateCount: true,
        createdAt: true,
        payload: true,
      },
    }),
  ]);

  if (!state) {
    throw new Error(`Target state not found for ${target.sourceId}/${target.categoryId || "root"}`);
  }

  const targetUrl = "pathUrl" in state ? state.pathUrl : state.frontPageUrl;

  return {
    sourceId: target.sourceId,
    categoryId: target.categoryId || null,
    targetUrl,
    rssStatus: state.rssStatus,
    rssFeedUrl: state.rssFeedUrl,
    currentFeedProductive: state.currentFeedProductive,
    consecutiveNonProductiveRuns: state.consecutiveNonProductiveRuns,
    lastRssCheckAt: state.lastRssCheckAt?.toISOString() || null,
    latestCandidateArtifact: summarizeArtifact(latestCandidateArtifact),
    latestHeadlessArtifact: summarizeArtifact(latestHeadlessArtifact),
  };
}

async function isBrowserRuntimeAvailable() {
  try {
    await import("playwright-core");
    return true;
  } catch {
    return false;
  }
}

export async function buildAgent2EnvironmentSnapshot() {
  return {
    nodeVersion: process.version,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    nowIso: new Date().toISOString(),
    enableAgent2BrowserFallback: process.env.NUXT_ENABLE_AGENT2_BROWSER_FALLBACK || null,
    browserFallbackEnabled: isBrowserFallbackEnabled(),
    browserRuntimeAvailable: await isBrowserRuntimeAvailable(),
    isVercel: Boolean(process.env.VERCEL),
    vercelEnv: process.env.VERCEL_ENV || null,
    nodeEnv: process.env.NODE_ENV || null,
  };
}

const summarizeStaticResult = (result: Awaited<ReturnType<typeof discoverArticlesFromTarget>>) => ({
  quality: result.qualityAssessment.quality,
  confidence: result.qualityAssessment.confidence,
  shouldEscalateToHeadless: result.qualityAssessment.shouldEscalateToHeadless,
  accepted: result.candidates.length,
  rejected: result.outcomeSummary.rejected,
  totalEvaluated: result.outcomeSummary.totalEvaluated,
  discoverySources: result.discoverySources,
  topRejectionReasons: result.outcomeSummary.topRejectionReasons,
  staleSamples: result.rejectedOutcomes
    .filter((outcome) => outcome.status === "rejected_stale")
    .slice(0, 5),
  listingDiagnostics: result.listingDiagnostics,
});

async function runBrowserOnly(target: ArticleDiscoveryTarget) {
  const linkResult = await discoverArticleLinksWithBrowser({
    targetUrl: target.targetUrl,
    sourceId: target.sourceId,
    categoryId: target.categoryId || null,
    targetType: target.targetType,
    categoryPathUrl: target.categoryId ? target.targetUrl : null,
  });

  const evaluated = [];
  const accepted: IngestCandidate[] = [];

  for (const link of linkResult.links.slice(0, 10)) {
    const detail = await evaluateArticleLinkCandidateWithBrowser({
      articleUrl: link.url,
      sourcePageUrl: target.targetUrl,
      targetUrl: target.targetUrl,
      sourceId: target.sourceId,
      categoryId: target.categoryId || null,
      listingDateFallbackRaw: null,
    });
    evaluated.push(detail.outcome);
    if (detail.accepted && detail.candidate) {
      const feedFormat = detail.candidate.provenance.feedFormat;
      accepted.push({
        ...detail.candidate,
        provenance: {
          ...detail.candidate.provenance,
          feedFormat: feedFormat === "rss" || feedFormat === "atom" || feedFormat === "json"
            ? feedFormat
            : "unknown",
        },
      });
    }
  }

  return {
    linkResult,
    candidates: accepted,
    summary: {
      ok: linkResult.ok,
      reason: linkResult.reason || null,
      rawLinkCount: linkResult.rawLinkCount,
      shortlistedLinkCount: linkResult.shortlistedLinkCount,
      evaluated: evaluated.length,
      accepted: accepted.length,
      rejected: evaluated.filter((outcome) => outcome.status !== "accepted").length,
      topRejectionReasons: linkResult.topRejectionReasons,
      browserDiagnostics: linkResult.diagnostics,
      detailOutcomes: evaluated,
    },
  };
}

export async function runAgent2TargetDebug(input: Agent2TargetInput) {
  const mode = input.mode || "static";
  const persist = input.persist === true;
  const target = await buildAgent2Target(input);
  const [environment, before] = await Promise.all([
    buildAgent2EnvironmentSnapshot(),
    getAgent2TargetSnapshot(target),
  ]);

  const output: Record<string, any> = {
    ok: true,
    mode,
    persist,
    environment,
    target,
    before,
    static: null,
    browser: null,
    persistence: null,
    after: null,
  };

  const candidatesToPersist: IngestCandidate[] = [];

  if (mode === "static" || mode === "both") {
    const result = await discoverArticlesFromTarget(target);
    output.static = summarizeStaticResult(result);
    candidatesToPersist.push(...result.candidates);

    if (persist) {
      const pipelineRun = await createPipelineRun(1);
      const artifact = await persistArticleDiscoveryArtifact({ pipelineRunId: pipelineRun.id, result });
      output.persistence = {
        pipelineRunId: pipelineRun.id,
        artifactId: artifact.id,
      };
    }
  }

  if (mode === "browser" || mode === "both") {
    const browser = await runBrowserOnly(target);
    output.browser = browser.summary;
    candidatesToPersist.push(...browser.candidates);
  }

  if (persist && candidatesToPersist.length > 0) {
    output.persistence = {
      ...(output.persistence || {}),
      candidates: await persistCandidates(candidatesToPersist),
    };
  }

  output.after = persist ? await getAgent2TargetSnapshot(target) : before;

  return output;
}

export async function exportAgent2Fixture(input: Agent2TargetInput & { out: string }) {
  const target = await buildAgent2Target(input);
  const [source, category, artifacts, articles] = await Promise.all([
    prisma.newsSource.findUnique({ where: { id: target.sourceId } }),
    target.categoryId ? prisma.sourceCategory.findUnique({ where: { id: target.categoryId } }) : null,
    prisma.pipelineArtifact.findMany({
      where: {
        sourceId: target.sourceId,
        categoryId: target.categoryId || null,
        artifactType: { in: ["article_discovery_candidates", "article_discovery_headless_required"] },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.article.findMany({
      where: {
        sourceId: target.sourceId,
        ...(target.categoryId ? { categoryId: target.categoryId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        sourceId: true,
        categoryId: true,
        sourceUrl: true,
        canonicalUrl: true,
        rssGuid: true,
        title: true,
        publishedAt: true,
        createdAt: true,
      },
    }),
  ]);

  const fixture = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    target,
    source,
    category,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      payload: summarizeArtifact(artifact),
      errorLog: artifact.errorLog ? artifact.errorLog.slice(0, 500) : null,
    })),
    articles,
  };

  await fs.mkdir(path.dirname(input.out), { recursive: true });
  await fs.writeFile(input.out, JSON.stringify(fixture, null, 2), "utf8");

  return {
    out: input.out,
    sourceId: target.sourceId,
    categoryId: target.categoryId || null,
    artifacts: artifacts.length,
    articles: articles.length,
  };
}
