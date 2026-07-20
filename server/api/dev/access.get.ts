import { requireAdminId } from "../../utils/require-admin";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  const isProduction = process.env.NODE_ENV === "production";
  const manualPipelineEnabled =
    !isProduction || process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN === "true";
  const manualArticleDiscoveryEnabled =
    !isProduction || process.env.NUXT_ALLOW_MANUAL_ARTICLE_DISCOVERY_RUN === "true";
  const destructiveActionsEnabled = !isProduction;

  return {
    ok: true,
    canAccess: true,
    diagnosticsEnabled: true,
    manualPipelineEnabled,
    manualArticleDiscoveryEnabled,
    destructiveActionsEnabled,
  };
});
