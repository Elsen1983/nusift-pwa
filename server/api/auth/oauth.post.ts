// server/api/auth/oauth.post.ts
import { Resend } from 'resend';
import jwt from 'jsonwebtoken';
import appleSigninAuth from 'apple-signin-auth';
import { prisma } from '../../utils/prisma'; 

const resend = new Resend(process.env.RESEND_API_KEY); 

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const { token, provider } = body; 

  let verifiedEmail: string | undefined;
  let verifiedProviderId: string | undefined;

  try {
    // --- 1. CRYPTOGRAPHIC VERIFICATION ---
    if (provider === 'GOOGLE') {
      const googleResponse: any = await $fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (!googleResponse?.email) throw new Error("Invalid Google Token");
      
      verifiedEmail = googleResponse.email;
      verifiedProviderId = googleResponse.sub;

    } else if (provider === 'APPLE') {
      const appleTokenPayload = await appleSigninAuth.verifyIdToken(token, {
        audience: 'com.yourdomain.nusift', 
        ignoreExpiration: false,
      });

      verifiedProviderId = appleTokenPayload.sub;
      verifiedEmail = appleTokenPayload.email;
    }

    if (!verifiedEmail || !verifiedProviderId) {
      throw new Error("Identity verification failed: Missing payload.");
    }

    // --- 2. DATABASE SYNC (Explicit Relational Fetch) ---
    let user = await prisma.user.findUnique({ 
      where: { email: verifiedEmail },
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
      user = await prisma.user.create({
        data: {
          email: verifiedEmail,
          isVerified: true,
          oauthProvider: provider,
          oauthId: verifiedProviderId,
        },
        include: {
          sourceSubscriptions: { include: { newsSource: true } },
          categorySubscriptions: { include: { category: true } }
        }
      });

      try {
        await resend.emails.send({
          from: 'NuSift <welcome@nusift.com>',
          to: [verifiedEmail],
          subject: 'Welcome to your Sovereign-Grade Intelligence Platform',
          html: '<strong>Success! Your NuSift node is ready for calibration.</strong>',
        });
      } catch (e) {
        console.error("Welcome email failed, but account created:", e);
      }
    }

    // --- 3. JWT GENERATION ---
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("Missing JWT_SECRET in environment variables.");

    const isFullyOnboarded = user.onboardingStep >= 3;
    const tokenExpirationStr = isFullyOnboarded ? '7d' : '1h';
    const cookieMaxAge = isFullyOnboarded ? 60 * 60 * 24 * 7 : 60 * 60;

    const sessionToken = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        onboardingStep: user.onboardingStep 
      },
      secret,
      { expiresIn: tokenExpirationStr } 
    );

    // --- 4. COOKIE MANAGEMENT ---
    setCookie(event, 'auth_token', sessionToken, {
      httpOnly: true, 
      secure: process.env.NODE_ENV === 'production', 
      sameSite: 'lax', 
      maxAge: cookieMaxAge, 
      path: '/', 
    });

    setCookie(event, 'session_status', 'active', {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production', 
      sameSite: 'lax', 
      maxAge: cookieMaxAge,
      path: '/', 
    });

    // --- 5. SAFE RETURN ---
    return { 
      success: true, 
      user: {
        id: user.id,
        email: user.email,
        onboardingStep: user.onboardingStep,
        primaryRegion: user.primaryRegion,
        tier: user.tier,
        topSources: [
          ...user.sourceSubscriptions.map(s => s.newsSource.frontPageUrl),
          ...user.categorySubscriptions.map(c => c.category.pathUrl)
        ],
        topInterests: user.topInterests
      }
    };

  } catch (error: any) {
    console.error("OAuth Internal Error:", error);
    throw createError({ 
      statusCode: 401, 
      statusMessage: 'Identity verification failed',
      message: error.message 
    });
  }
});