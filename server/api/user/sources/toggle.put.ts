// server/api/user/sources/toggle.put.ts
import jwt from 'jsonwebtoken';
import { prisma } from '../../../utils/prisma';

export default defineEventHandler(async (event) => {
  const token = getCookie(event, 'auth_token');
  if (!token) throw createError({ statusCode: 401, statusMessage: "Unauthorized" });

  const userId = (jwt.verify(token, process.env.JWT_SECRET!) as any).userId;
  const { sourceId, isActive } = await readBody(event); 

  if (!sourceId || typeof isActive !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: "Missing required fields" });
  }

  try {
    // 1. KVÓTA-ŐR: Csak akkor aktiválhat, ha van még hely
    if (isActive) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { tier: true } });
      const maxLimit = user?.tier === 'PRO' ? 15 : 5;
      
      const activeRoots = await prisma.userSourceSubscription.count({ where: { userId, isActive: true } });
      const activeCats = await prisma.userCategorySubscription.count({ where: { userId, isActive: true } });
      
      // Ha már elértük a limitet, ne engedjük az aktiválást
      if (activeRoots + activeCats >= maxLimit) {
        throw createError({ statusCode: 403, statusMessage: "Kvóta limit elérve. Előbb függessz fel egy másik forrást." });
      }
    }

    // 2. Frissítés: Megkeressük a feliratkozást és frissítjük az isActive státuszt
    // Főoldali (Root) forrás keresése
    const rootSub = await prisma.userSourceSubscription.findUnique({ where: { id: sourceId } });
    
    if (rootSub && rootSub.userId === userId) {
      await prisma.userSourceSubscription.update({
        where: { id: sourceId },
        data: { isActive }
      });
      return { success: true, message: isActive ? "Forrás aktiválva." : "Forrás felfüggesztve." };
    }

    // Rovat (Category) forrás keresése
    const catSub = await prisma.userCategorySubscription.findUnique({ where: { id: sourceId } });
    
    if (catSub && catSub.userId === userId) {
      await prisma.userCategorySubscription.update({
        where: { id: sourceId },
        data: { isActive }
      });
      return { success: true, message: isActive ? "Rovat aktiválva." : "Rovat felfüggesztve." };
    }

    throw createError({ statusCode: 404, statusMessage: "Feliratkozás nem található." });

  } catch (error: any) {
    throw createError({ statusCode: error.statusCode || 500, statusMessage: error.message });
  }
});