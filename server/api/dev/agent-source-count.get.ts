import { requireAdminId } from "../../utils/require-admin";
import { assertRateLimit } from "../../utils/rate-limit";
import { resolveActivePipelineSourceIds } from "../../utils/news-pipeline/targets";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  await assertRateLimit(event, "agent-source-count", 10, 60 * 1000);

  const sourceIds = await resolveActivePipelineSourceIds();
  return { ok: true, count: sourceIds.length };
});
