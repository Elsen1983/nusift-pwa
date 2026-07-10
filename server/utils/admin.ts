import { prisma } from "./prisma";

export function getBootstrapAdminEmails() {
  return new Set(
    (process.env.NUXT_ADMIN_EMAILS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function isBootstrapAdminUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true },
  });

  const bootstrapAdmins = getBootstrapAdminEmails();
  const isBootstrapAdmin = user?.email ? bootstrapAdmins.has(user.email.toLowerCase()) : false;

  return Boolean(user && (user.role === "ADMIN" || isBootstrapAdmin));
}

export async function getAdminStatusByUserId(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true },
  });

  if (!user) return { isAdmin: false, email: null as string | null };

  const bootstrapAdmins = getBootstrapAdminEmails();
  const isBootstrapAdmin = user.email ? bootstrapAdmins.has(user.email.toLowerCase()) : false;

  return {
    isAdmin: user.role === "ADMIN" || isBootstrapAdmin,
    email: user.email,
  };
}
