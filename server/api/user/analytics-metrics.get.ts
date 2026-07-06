import { getUserAnalyticsMetrics } from "../../utils/user-analytics";

export default defineEventHandler(async (event) => {
  const userId = event.context.user?.id;

  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  try {
    const metrics = await getUserAnalyticsMetrics(userId);
    return {
      success: true,
      metrics,
    };
  } catch (error) {
    console.error("Analytics Metrics Error:", error);
    throw createError({ statusCode: 500, statusMessage: "Internal Server Error" });
  }
});
