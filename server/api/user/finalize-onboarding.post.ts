// server/api/user/finalize-onboarding.post.ts
import jwt from 'jsonwebtoken';
import { prisma } from '../../utils/prisma';

export default defineEventHandler(async (event) => {
  // 1. JWT Token kiolvasása a HTTP-Only süti-ből
  const token = getCookie(event, 'auth_token');
  
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized: Missing token." });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw createError({ statusCode: 500, statusMessage: "Server Configuration Error." });
  }

  let decodedToken: any;
  try {
    // 2. Token érvényességének ellenőrzése
    decodedToken = jwt.verify(token, secret);
  } catch (error) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized: Invalid or expired token." });
  }

  // A dekódolt tokenből megkapjuk a user ID-t (a login.post.ts alapján 'userId' a kulcs)
  const currentUserId = decodedToken.userId;

  if (!currentUserId) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized: Invalid token payload." });
  }

  // 3. Frontendről érkező kalibrációs adatok kinyerése
  const body = await readBody(event);
  const { region, sources, interests } = body;

  try {
    // 4. Adatbázis frissítése a Prisma-val
    const updatedUser = await prisma.user.update({
      where: { id: currentUserId },
      data: {
        primaryRegion: region,
        topSources: sources,
        topInterests: interests,
        onboardingStep: 3 // A szerveren állítjuk be a végleges lépést!
      }
    });

    // Biztonsági okokból sosem küldjük vissza a jelszó hash-t!
    return { 
      success: true, 
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        onboardingStep: updatedUser.onboardingStep,
        primaryRegion: updatedUser.primaryRegion
      } 
    };

  } catch (error: any) {
    console.error("Database Error during finalization:", error);
    // VÁLTOZÁS: Dobjuk vissza a nyers Prisma hibát a frontendnek!
    throw createError({ 
      statusCode: 500, 
      statusMessage: error.message || "Failed to save profile data to database." 
    });
  }
});