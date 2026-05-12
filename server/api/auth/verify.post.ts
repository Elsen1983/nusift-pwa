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

    // SENIOR PROTOCOL: Dual-Zone Expiration
    const isFullyOnboarded = user.onboardingStep >= 3;
    const tokenExpirationStr = isFullyOnboarded ? '7d' : '1h';
    const cookieMaxAge = isFullyOnboarded ? 60 * 60 * 24 * 7 : 60 * 60; // second-based

    const sessionToken = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        onboardingStep: user.onboardingStep 
      },
      secret,
      { expiresIn: tokenExpirationStr } 
    );

    // --- 4. SESSION PROVISIONING ---
    // 4.a Set the HTTP-Only Cookie for Authentication
    setCookie(event, 'auth_token', sessionToken, {
      httpOnly: true, // The cookie is inaccessible to JavaScript, mitigating XSS risks
      secure: process.env.NODE_ENV === 'production', 
      sameSite: 'lax', 
      maxAge: cookieMaxAge, // Dinamically set based on onboarding status
      path: '/', 
    });

    // 4.b Set a non-HTTP-Only cookie to indicate session status (optional, can be used by frontend to show user is logged in)
    setCookie(event, 'session_status', 'active', {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production', 
      sameSite: 'lax', 
      maxAge: cookieMaxAge,
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