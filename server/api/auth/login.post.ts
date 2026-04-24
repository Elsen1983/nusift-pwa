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

    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        onboardingStep: user.onboardingStep
      },
      secret,
      { expiresIn: '7d' } // Token expires in 7 days
    );

    // 5. Set the HTTP-Only Cookie
    setCookie(event, 'auth_token', token, {
      httpOnly: true, // Prevents JavaScript access (XSS protection)
      secure: process.env.NODE_ENV === 'production', // Only sent over HTTPS in production
      sameSite: 'lax', // CSRF protection
      maxAge: 60 * 60 * 24 * 7, // 7 days in seconds
      path: '/', // Cookie is valid across the whole site
    });

    // 6. Return safe user data to the frontend
    return {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
        onboardingStep: user.onboardingStep,
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