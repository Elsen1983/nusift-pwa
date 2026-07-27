import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { getAgent1Progress } from "../../utils/news-pipeline/orchestrator";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);
  await assertRateLimit(event, "agent1-progress", 10, 60 * 1000);

  const progress = await getAgent1Progress();

  return {
    ok: true,
    progress,
  };
});
