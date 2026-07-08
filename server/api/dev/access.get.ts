import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  const isProduction = process.env.NODE_ENV === "production";
  const manualPipelineEnabled =
    !isProduction || process.env.NUXT_ALLOW_MANUAL_NOTIFICATION_RUN === "true";
  const devToolsEnabled = !isProduction;

  if (isProduction && !manualPipelineEnabled) {
    throw createError({ statusCode: 403, statusMessage: "Admin tools disabled." });
  }

  return {
    ok: true,
    canAccess: true,
    manualPipelineEnabled,
    devToolsEnabled,
  };
});
