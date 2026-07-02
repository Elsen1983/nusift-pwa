import { prisma } from "../utils/prisma";
import { requireUserId } from "../utils/require-user";

const toSourceLabel = (frontPageUrl: string) => {
  try {
    return new URL(frontPageUrl).hostname.replace(/^www\./, "");
  } catch {
    return frontPageUrl;
  }
};

export default defineEventHandler(async (event) => {
  requireUserId(event);

  const articles = await prisma.article.findMany({
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      id: true,
      title: true,
      date: true,
      score: true,
      isPaywall: true,
      tags: true,
      signals: true,
      reasoning: true,
      source: {
        select: {
          frontPageUrl: true,
          mediaName: true,
        },
      },
    },
  });

  return articles.map((article) => ({
    id: article.id,
    title: article.title,
    source: article.source.mediaName || toSourceLabel(article.source.frontPageUrl),
    sourceUrl: article.source.frontPageUrl,
    date: article.date.toISOString(),
    score: article.score,
    isPaywall: article.isPaywall,
    tags: article.tags,
    signals: article.signals,
    reasoning: article.reasoning || "",
  }));
});
