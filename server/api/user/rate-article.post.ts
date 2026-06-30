import { createError, readBody } from "h3";
import { prisma } from "../../utils/prisma";
import { requireUserId } from "../../utils/require-user";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const body = await readBody(event);
  const articleId = Number(body?.articleId ?? body?.id);
  const score = Number(body?.score);

  if (!Number.isInteger(articleId) || articleId <= 0) {
    throw createError({ statusCode: 400, statusMessage: "Valid article ID is required." });
  }

  if (!Number.isInteger(score) || score < 0 || score > 10) {
    throw createError({ statusCode: 400, statusMessage: "Score must be an integer between 0 and 10." });
  }

  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true },
  });

  if (!article) {
    throw createError({ statusCode: 404, statusMessage: "Article not found." });
  }

  await prisma.articleRating.upsert({
    where: { userId_articleId: { userId, articleId } },
    create: { userId, articleId, score },
    update: { score },
  });

  return { success: true, articleId, score };
});