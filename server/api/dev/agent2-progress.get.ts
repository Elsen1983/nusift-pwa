import { requireAdminId } from "../../utils/require-admin";
import { getAgent2Progress } from "../../utils/news-pipeline/article-discovery";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  const progress = await getAgent2Progress();

  return {
    ok: true,
    progress,
  };
});
