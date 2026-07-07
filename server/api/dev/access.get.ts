import { createError } from "h3";
import { requireAdminId } from "../../utils/require-admin";

export default defineEventHandler(async (event) => {
  await requireAdminId(event);

  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 403, statusMessage: "Dev endpoints disabled in production." });
  }

  return { ok: true, canAccess: true };
});
