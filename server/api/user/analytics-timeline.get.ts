import { getUserAnalyticsTimeline } from "../../utils/user-analytics";

export default defineEventHandler(async (event) => {
  const userId = event.context.user?.id;

  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const query = getQuery(event);
  const currentYear = parseInt(query.year as string) || new Date().getFullYear();

  try {
    const timeline = await getUserAnalyticsTimeline(userId, currentYear);
    return {
      success: true,
      data: timeline.data,
      cached: timeline.cached,
    };
  } catch (error) {
    console.error("Analytics Timeline Error:", error);
    throw createError({ statusCode: 500, statusMessage: "Internal Server Error" });
  }
});
