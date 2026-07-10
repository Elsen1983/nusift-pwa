import { createError, type H3Event } from "h3";
import { requireUserId } from "./require-user";
import { getAdminStatusByUserId } from "./admin";

export async function requireAdminId(event: H3Event): Promise<string> {
  const userId = requireUserId(event);
  const { isAdmin } = await getAdminStatusByUserId(userId);

  if (!isAdmin) {
    throw createError({ statusCode: 403, statusMessage: "Admin access required." });
  }

  return userId;
}
