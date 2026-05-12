// server/api/auth/login.post.ts
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../utils/prisma';

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event);
    const { email, password } = body;

    // 1. Basic Validation
    if (!email || !password) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Email and password are required.',
      });
    }

    // 2. Find the User in the database
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      // Use generic error messages to prevent email enumeration attacks
      throw createError({
        statusCode: 401,
        statusMessage: 'Invalid credentials.',
      });
    }

    // NEW GUARD: Prevent bcrypt from crashing on OAuth users
    if (!user.passwordHash) {
      throw createError({
        statusCode: 401,
        // Optional: You can make this message more helpful, e.g., "Please log in with Google."
        statusMessage: 'Invalid credentials. Please use your connected social account.', 
      });
    }

    // 3. Verify the Password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Invalid credentials.',
      });
    }

    // 4. Generate the JWT
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not defined in environment variables.');
    }

    // SENIOR PROTOCOL: Dual-Zone Expiration
    // If onboarding is complete (step >= 3), token lasts 7 days. Otherwise, only 1 hour for security reasons.
    const isFullyOnboarded = user.onboardingStep >= 3;
    const tokenExpirationStr = isFullyOnboarded ? '7d' : '1h';
    const cookieMaxAge = isFullyOnboarded ? 60 * 60 * 24 * 7 : 60 * 60; // másodpercben

    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        onboardingStep: user.onboardingStep
      },
      secret,
      { expiresIn: tokenExpirationStr } 
    );

    // 5.a Set the HTTP-Only Cookie
    setCookie(event, 'auth_token', token, {
      httpOnly: true, 
      secure: process.env.NODE_ENV === 'production', 
      sameSite: 'lax', 
      maxAge: cookieMaxAge, 
      path: '/', 
    });

    // 5.b Set a non-HTTP-Only cookie to indicate session status (optional, can be used by frontend to show user is logged in)
    setCookie(event, 'session_status', 'active', {
      httpOnly: false, // This cookie can be read by JavaScript to manage UI state (e.g., show user is logged in)
      secure: process.env.NODE_ENV === 'production', 
      sameSite: 'lax', 
      maxAge: cookieMaxAge, // same as auth_token to keep them in sync
      path: '/', 
    });

    // 6. Return safe user data to the frontend
    return {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
        onboardingStep: user.onboardingStep,
        primaryRegion: user.primaryRegion,
        topSources: user.topSources,
        topInterests: user.topInterests
      },
      message: 'Secure Handshake established.',
    };

  } catch (error: any) {
    console.error('Login API Error:', error);
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || 'Internal Server Error during handshake.',
    });
  }
});