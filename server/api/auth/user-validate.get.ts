import { prisma } from '../../utils/prisma';

export default defineEventHandler(async (event) => {
  // 1. Extract the token directly from the cookie
  const token = getCookie(event, 'auth_token');
  
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: "No active session." });
  }

  try {
    // 2. Decode the JWT to extract the userId
    const base64Url = token.split(".")[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
    const userId = payload.userId;

    if (!userId) throw new Error("Invalid payload");

    // 3. Query the DB (Select ONLY the ID for maximum speed)
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true } 
    });

    // 4. Force reject if the user was deleted
    if (!userExists) {
      // Clear the cookie on the server side
      deleteCookie(event, 'auth_token');
      deleteCookie(event, 'session_status');
      throw createError({ statusCode: 401, statusMessage: "Zombie session: User deleted." });
    }

    return { success: true, valid: true };

  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token or user not found." });
  }
});