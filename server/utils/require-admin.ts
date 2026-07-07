import { createError, type H3Event } from "h3";
import { prisma } from "./prisma";
import { requireUserId } from "./require-user";

function getBootstrapAdminEmails() {
  return new Set(
    (process.env.NUXT_ADMIN_EMAILS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function requireAdminId(event: H3Event): Promise<string> {
  const userId = requireUserId(event);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true },
  });

  const bootstrapAdmins = getBootstrapAdminEmails();
  const isBootstrapAdmin = user?.email ? bootstrapAdmins.has(user.email.toLowerCase()) : false;

  if (!user || (user.role !== "ADMIN" && !isBootstrapAdmin)) {
    throw createError({ statusCode: 403, statusMessage: "Admin access required." });
  }

  return user.id;
}
