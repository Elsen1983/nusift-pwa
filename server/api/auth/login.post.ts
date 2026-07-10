// server/api/auth/login.post.ts
import bcrypt from 'bcryptjs';
import { prisma } from '../../utils/prisma';
import { signSessionToken, setSessionCookies, requireJwtSecret } from "../../utils/auth";
import { assertRateLimit } from "../../utils/rate-limit";
import { getAdminStatusByUserId } from "../../utils/admin";

export default defineEventHandler(async (event) => {
  try {
    await assertRateLimit(event, "auth-login", 10, 60_000);
    const body = await readBody(event);
    const { email, password } = body;

    // 1. Basic Validation
    if (!email || !password) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Email and password are required.',
      });
    }

    // 2. Find the User in the database (Explicit Relációkkal)
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        sourceSubscriptions: {
          include: { newsSource: true }
        },
        categorySubscriptions: {
          include: { category: true }
        }
      }
    });

    if (!user) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Invalid credentials.',
      });
    }

    // 3. OAuth Guard
    if (!user.passwordHash) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Invalid credentials. Please use your connected social account.', 
      });
    }

    if (!user.isVerified) {
      throw createError({
        statusCode: 403, // 403 Forbidden
        statusMessage: 'UNVERIFIED_ACCOUNT',
      });
    }

    // 4. Verify the Password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Invalid credentials.',
      });
    }

    // 5. Generate the JWT
    const isFullyOnboarded = user.onboardingStep >= 3;
    const tokenExpirationStr = isFullyOnboarded ? '7d' : '1h';
    const cookieMaxAge = isFullyOnboarded ? 60 * 60 * 24 * 7 : 60 * 60; 

    requireJwtSecret();
    const adminStatus = await getAdminStatusByUserId(user.id);
    const token = signSessionToken(
      {
        userId: user.id,
        email: user.email,
        onboardingStep: user.onboardingStep,
        tokenVersion: user.tokenVersion,
      },
      tokenExpirationStr,
    );
    setSessionCookies(event, token, cookieMaxAge);

    // 7. Return safe user data
    return {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        isAdmin: adminStatus.isAdmin,
        createdAt: user.createdAt,
        onboardingStep: user.onboardingStep,
        primaryRegion: user.primaryRegion,
        tier: user.tier, // Visszaadjuk a csomagot is
        // Lapos string tömbbé alakítjuk az explicit relációkat a frontend store számára
        topSources: [
          ...user.sourceSubscriptions.map(sub => sub.newsSource.frontPageUrl),
          ...user.categorySubscriptions.map(sub => sub.category.pathUrl)
        ],
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
