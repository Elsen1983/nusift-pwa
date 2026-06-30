import type { UserRankingContext } from "./context";

export interface ArticleRankingInput {
  id: number;
  title: string;
  summary: string | null;
  tags: string[];
  date: Date;
  sourceId: string;
  categoryId: string | null;
  sourceCountryCode: string | null;
  sourceContinent: string | null;
  categoryName: string | null;
}

export interface HeuristicRankResult {
  score: number;
  reasoning: string;
  signals: string[];
}

const RECENCY_HALF_LIFE_HOURS = 36;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function interestKeywords(interest: UserRankingContext["interests"][number]): string[] {
  const keywords = new Set<string>();
  keywords.add(interest.name.toLowerCase());
  keywords.add(interest.id.toLowerCase().replace(/_/g, " "));
  for (const chip of interest.chips) {
    keywords.add(chip.toLowerCase());
  }
  for (const token of tokenize(interest.prompt)) {
    keywords.add(token);
  }
  return [...keywords].filter(Boolean);
}

function interestMatchScore(
  corpus: string,
  interests: UserRankingContext["interests"],
): { points: number; hits: string[] } {
  if (interests.length === 0) return { points: 0, hits: [] };

  const hits: string[] = [];
  let weighted = 0;
  let maxWeight = 0;

  for (const interest of interests) {
    maxWeight += interest.weight;
    const keywords = interestKeywords(interest);
    const matched = keywords.some((keyword) => corpus.includes(keyword));
    if (matched) {
      weighted += interest.weight;
      hits.push(interest.name);
    }
  }

  if (maxWeight === 0) return { points: 0, hits: [] };
  const ratio = weighted / maxWeight;
  return { points: Math.round(ratio * 40), hits };
}

function recencyScore(publishedAt: Date, now = new Date()): number {
  const ageHours = Math.max((now.getTime() - publishedAt.getTime()) / (60 * 60 * 1000), 0);
  const decay = Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);
  return Math.round(decay * 25);
}

function subscriptionAffinity(
  article: ArticleRankingInput,
  context: UserRankingContext,
): { points: number; signal: string | null } {
  if (context.subscribedSourceIds.has(article.sourceId)) {
    return { points: 15, signal: "Direct source subscription" };
  }
  if (article.categoryId && context.subscribedCategoryIds.has(article.categoryId)) {
    return { points: 10, signal: "Category subscription" };
  }
  return { points: 0, signal: null };
}

function ratingAffinity(
  article: ArticleRankingInput,
  context: UserRankingContext,
): { points: number; signal: string | null } {
  const avg = context.sourceRatingAvg.get(article.sourceId);
  if (avg === undefined) return { points: 0, signal: null };
  const normalized = Math.min(Math.max((avg - 1) / 4, 0), 1);
  return {
    points: Math.round(normalized * 10),
    signal: `You rated this source ~${avg.toFixed(1)}/5`,
  };
}

function readFatiguePenalty(
  article: ArticleRankingInput,
  context: UserRankingContext,
): { points: number; signal: string | null } {
  const reads = context.recentSourceReads.get(article.sourceId) ?? 0;
  if (reads < 8) return { points: 0, signal: null };
  const penalty = Math.min(Math.floor((reads - 7) / 3), 10);
  return { points: -penalty, signal: "Recent source fatigue" };
}

function regionAffinity(
  article: ArticleRankingInput,
  context: UserRankingContext,
): { points: number; signal: string | null } {
  if (!context.primaryRegion) return { points: 0, signal: null };
  const region = context.primaryRegion.toLowerCase();
  const country = article.sourceCountryCode?.toLowerCase();
  const continent = article.sourceContinent?.toLowerCase();
  if (country && region.includes(country)) {
    return { points: 5, signal: "Regional match" };
  }
  if (continent && region.includes(continent)) {
    return { points: 3, signal: "Continental match" };
  }
  return { points: 0, signal: null };
}

export function scoreArticleHeuristic(
  article: ArticleRankingInput,
  context: UserRankingContext,
  now = new Date(),
): HeuristicRankResult {
  const corpus = [
    article.title,
    article.summary ?? "",
    article.tags.join(" "),
    article.categoryName ?? "",
  ]
    .join(" ")
    .toLowerCase();

  const interest = interestMatchScore(corpus, context.interests);
  const recency = recencyScore(article.date, now);
  const subscription = subscriptionAffinity(article, context);
  const rating = ratingAffinity(article, context);
  const fatigue = readFatiguePenalty(article, context);
  const region = regionAffinity(article, context);

  const raw =
    interest.points +
    recency +
    subscription.points +
    rating.points +
    region.points +
    fatigue.points;

  const score = Math.min(Math.max(Math.round(raw), 1), 100);
  const signals = [
    ...interest.hits.map((hit) => `Interest: ${hit}`),
    ...(subscription.signal ? [subscription.signal] : []),
    ...(rating.signal ? [rating.signal] : []),
    ...(region.signal ? [region.signal] : []),
    ...(fatigue.signal ? [fatigue.signal] : []),
    `Recency boost: ${recency}`,
  ];

  const reasoning =
    interest.hits.length > 0
      ? `Matched your interests (${interest.hits.slice(0, 3).join(", ")}). Freshness and subscription context adjusted the score.`
      : "No strong interest overlap; ranked by freshness and your source preferences.";

  return { score, reasoning, signals };
}