// server/api/auth/verify.post.ts
import { prisma } from '../../utils/prisma';
import { signSessionToken, setSessionCookies } from "../../utils/auth";
import { assertRateLimit } from "../../utils/rate-limit";

export default defineEventHandler(async (event) => {
  try {
    await assertRateLimit(event, "auth-verify", 10, 60_000);
    const { token } = await readBody(event);

    if (!token) {
      throw createError({ statusCode: 400, statusMessage: 'Verification token is missing.' });
    }

    // 1. Find the user by verification token
    const user = await prisma.user.findUnique({
      where: { verificationToken: token }
    });

    if (!user) {
      throw createError({ statusCode: 401, statusMessage: 'Invalid or expired verification token.' });
    }

    // SECURITY: verification tokens are valid only when an explicit expiry exists
    // and that expiry is still in the future.
    if (!user.verificationTokenExpires || user.verificationTokenExpires < new Date()) {
      throw createError({ statusCode: 401, statusMessage: 'Verification token has expired. Please request a new one.' });
    }

    // 2. Update DB state and clear the one-time token
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        verificationToken: null,
        verificationTokenExpires: null,
      }
    });

    // 3. Auto-login with the existing dual-zone expiration policy
    const isFullyOnboarded = user.onboardingStep >= 3;
    const tokenExpirationStr = isFullyOnboarded ? '7d' : '1h';
    const cookieMaxAge = isFullyOnboarded ? 60 * 60 * 24 * 7 : 60 * 60;

    const sessionToken = signSessionToken(
      {
        userId: user.id,
        email: user.email,
        onboardingStep: user.onboardingStep,
        tokenVersion: updatedUser.tokenVersion,
      },
      tokenExpirationStr,
    );

    setSessionCookies(event, sessionToken, cookieMaxAge);

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
