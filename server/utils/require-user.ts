import { createError } from "h3";

export function requireUserId(event: any): string {
  const userId = event?.context?.user?.id;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized." });
  }
  return userId;
}
