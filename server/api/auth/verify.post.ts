// server/api/auth/verify.post.ts
import { prisma } from '../../utils/prisma';
import jwt from 'jsonwebtoken';

export default defineEventHandler(async (event) => {
  try {
    const { token } = await readBody(event);

    if (!token) {
      throw createError({ statusCode: 400, statusMessage: 'Verification token is missing.' });
    }

    // 1. Megkeressük a usert a token alapján
    const user = await prisma.user.findUnique({
      where: { verificationToken: token }
    });

    if (!user) {
      throw createError({ statusCode: 401, statusMessage: 'Invalid or expired verification token.' });
    }

    // 2. Frissítjük a DB-ben: isVerified = true, tokent töröljük
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        verificationToken: null // Egyszer használatos!
      }
    });

    // 3. Automatikus Beléptetés (JWT generálás)
    const secret = process.env.JWT_SECRET || 'fallback_secret';
    const jwtToken = jwt.sign(
      { 
        userId: updatedUser.id, 
        email: updatedUser.email, 
        onboardingStep: updatedUser.onboardingStep 
      },
      secret,
      { expiresIn: '7d' }
    );

    // 4. Süti beállítása a hitelesítéshez
    setCookie(event, 'auth_token', jwtToken, {
      httpOnly: false, // Fontos, hogy a Guard hozzáférjen
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });

    return { 
      success: true, 
      message: 'Email verified successfully. Logging in.' 
    };

  } catch (error: any) {
    console.error('Verification Error:', error);
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || 'Failed to verify email.'
    });
  }
});