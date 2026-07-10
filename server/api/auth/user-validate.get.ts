import { prisma } from '../../utils/prisma';
import { verifySessionToken } from "../../utils/auth";
import { getAdminStatusByUserId } from "../../utils/admin";

export default defineEventHandler(async (event) => {
  // 1. Extract the token directly from the cookie
  const token = getCookie(event, 'auth_token');
  
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: "No active session." });
  }

  try {
    const payload = verifySessionToken(token);
    const userId = payload.userId;

    // 3. Query the DB and ensure tokenVersion still matches
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tokenVersion: true }
    });

    // 4. Force reject if the user was deleted
    if (!userExists || userExists.tokenVersion !== payload.tokenVersion) {
      // Clear the cookie on the server side
      deleteCookie(event, 'auth_token');
      deleteCookie(event, 'session_status');
      throw createError({ statusCode: 401, statusMessage: "Zombie session: User deleted." });
    }

    const adminStatus = await getAdminStatusByUserId(userId);

    return { success: true, valid: true, isAdmin: adminStatus.isAdmin };

  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token or user not found." });
  }
});
