import {
  buildUserFeedPublicationWhere,
  isEffectivelyPublishableArticle,
} from "../utils/news-pipeline/publication-gate";
import { buildSubscriptionArticleScope, getSubscriptionScope, type SubscriptionScope } from "../utils/subscription-scope";

/**
 * Shared user-feed service (Prompt 13G).
 *
 * The production /api/feed handler calls these functions with the process-global
 * Prisma client so normal requests retain their previous production behavior.
 * Integration tests call the same functions with an isolated schema-scoped
 * Prisma client, which is why the client is passed explicitly instead of being
 * imported from ../utils/prisma.
 */

const PUBLIC_ACCESS_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "ACCESSIBLE",
  "PAYWALL_BLOCKED",
  "METERED_OR_DECLARED",
  "INTERSTITIAL_OR_CHALLENGE",
  "HTTP_ACCESS_BLOCKED",
  "UNKNOWN",
]);

type PublicAccessClassification =
  | "ACCESSIBLE"
  | "PAYWALL_BLOCKED"
  | "METERED_OR_DECLARED"
  | "INTERSTITIAL_OR_CHALLENGE"
  | "HTTP_ACCESS_BLOCKED"
  | "UNKNOWN";

const toPublicAccessClassification = (value: unknown): PublicAccessClassification | null =>
  typeof value === "string" && PUBLIC_ACCESS_CLASSIFICATIONS.has(value)
    ? value as PublicAccessClassification
    : null;

export type FeedDb = {
  user: { findUnique: (args: any) => Promise<any> };
  article: { findMany: (args: any) => Promise<any[]> };
};

const toSourceLabel = (frontPageUrl: string) => {
  try {
    return new URL(frontPageUrl).hostname.replace(/^www\./, "");
  } catch {
    return frontPageUrl;
  }
};

export async function loadUserFeed(db: FeedDb, userId: string): Promise<any[]> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      sourceSubscriptions: {
        where: { isActive: true },
        select: { sourceId: true },
      },
      categorySubscriptions: {
        where: { isActive: true },
        select: {
          categoryId: true,
          category: {
            select: {
              pathUrl: true,
            },
          },
        },
      },
    },
  });

  const scope = getSubscriptionScope(
    user?.sourceSubscriptions || [],
    user?.categorySubscriptions || [],
  );
  const subscriptionPredicates = buildSubscriptionArticleScope(scope);

  if (subscriptionPredicates.length === 0) {
    return [];
  }

  const articles = await db.article.findMany({
    where: {
      // User-feed publication boundary: only rows that completed Agent 3
      // successfully and have durable, minimally complete content are visible.
      // Candidates/failures remain available to admin and diagnostic paths.
      ...buildUserFeedPublicationWhere(),
      OR: subscriptionPredicates,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    select: {
      id: true,
      title: true,
      canonicalUrl: true,
      date: true,
      score: true,
      isPaywall: true,
      tags: true,
      signals: true,
      reasoning: true,
      bodyText: true,
      enrichmentOutcome: true,
      source: {
        select: {
          frontPageUrl: true,
          mediaName: true,
        },
      },
      category: {
        select: {
          pathUrl: true,
        },
      },
    },
  });

  return articles
    // Defense in depth for legacy rows containing null/blank values despite
    // the durable publication fields. The DB predicate remains the primary
    // publication gate; this protects the API if old data is malformed.
    .filter(isEffectivelyPublishableArticle)
    .map((article) => ({
    id: article.id,
    title: article.title,
    source: article.source.mediaName || toSourceLabel(article.source.frontPageUrl),
    sourceUrl: article.source.frontPageUrl,
    sourceTargetUrl: article.category?.pathUrl || article.source.frontPageUrl,
    canonicalUrl: article.canonicalUrl || article.source.frontPageUrl,
    categoryPathUrl: article.category?.pathUrl || null,
    date: article.date.toISOString(),
    score: article.score,
    isPaywall: article.isPaywall,
    accessClassification: toPublicAccessClassification((article as any).enrichmentOutcome?.access?.classification),
    tags: article.tags,
    signals: article.signals,
    reasoning: article.reasoning || "",
    bodyText: article.bodyText || null,
  }));
}

/**
 * Count publishable articles inside a subscription scope within the last 24h
 * window used by the daily notification digest. The sender uses this so its
 * article selection runs through the exact same application code as the feed.
 */
export async function countScopedPublishableArticles(
  db: FeedDb,
  scope: SubscriptionScope,
  now: Date,
): Promise<number> {
  const subscriptionPredicates = buildSubscriptionArticleScope(scope);
  if (subscriptionPredicates.length === 0) return 0;

  const publicationWhere = {
    ...buildUserFeedPublicationWhere(),
    publicationReadyAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    OR: subscriptionPredicates,
  };
  const pageSize = 500;
  let articleCount = 0;
  let cursor: number | undefined;
  while (true) {
    const page = await db.article.findMany({
      where: publicationWhere,
      select: { id: true, title: true, canonicalUrl: true, bodyText: true },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor === undefined ? {} : { skip: 1, cursor: { id: cursor } }),
    });
    articleCount += page.filter(isEffectivelyPublishableArticle).length;
    if (page.length < pageSize) break;
    cursor = page[page.length - 1]!.id;
  }
  return articleCount;
}
