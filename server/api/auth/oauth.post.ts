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
    // --- 1. CRYPTOGRAPHIC VERIFICATION (The Lock) ---
    if (provider === 'GOOGLE') {
      // Interrogate Google using the Access Token
      const googleResponse: any = await $fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (!googleResponse?.email) throw new Error("Invalid Google Token");
      
      verifiedEmail = googleResponse.email;
      verifiedProviderId = googleResponse.sub;

    } else if (provider === 'APPLE') {
      // Verify Apple's JWT Signature
      const appleTokenPayload = await appleSigninAuth.verifyIdToken(token, {
        audience: 'com.yourdomain.nusift', // MUST match your Apple Services ID
        ignoreExpiration: false,
      });

      verifiedProviderId = appleTokenPayload.sub;
      
      // FALLBACK: Apple only sends email on the FIRST login attempt
      if (appleTokenPayload.email) {
        verifiedEmail = appleTokenPayload.email;
      } else {
        const existingAppleUser = await prisma.user.findUnique({
          where: { oauthId: verifiedProviderId }
        });
        if (!existingAppleUser) throw new Error("Identity record missing");
        verifiedEmail = existingAppleUser.email;
      }
    } else {
      throw new Error("Unsupported Identity Provider");
    }

    if (!verifiedEmail || !verifiedProviderId) {
       throw new Error("Identity extraction failed");
    }

    // --- 2. UNIFIED DATABASE HANDSHAKE ---
    const existingUser = await prisma.user.findUnique({ where: { email: verifiedEmail } });
    const isNewUser = !existingUser;

    const user = await prisma.user.upsert({
      where: { email: verifiedEmail },
      update: {}, // You could update 'lastLogin' here
      create: {
        email: verifiedEmail,
        oauthProvider: provider, 
        oauthId: verifiedProviderId,
        isVerified: true, 
        onboardingStep: 0,
      }
    });

    // --- 3. CONDITIONAL WELCOME SEQUENCE ---
    if (isNewUser) {
      const htmlContent = `
        <div style="background-color: #131313; color: white; font-family: 'Inter', sans-serif; padding: 40px;">
          <div style="max-width: 500px; margin: 0 auto; background-color: #1e1e1e; padding: 30px; border-radius: 12px; border: 1px solid rgba(0, 229, 255, 0.2);">
            <h1 style="color: #00E5FF; text-align: center;">Welcome to NUSIFT</h1>
            <p style="color: #d1d5db;">Your neural node has been initialized via <strong>${provider}</strong>.</p>
            <div style="text-align: center; margin-top: 30px;">
              <a href="https://nusift.io/auth" style="background-color: #00E5FF; color: black; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Enter Dashboard</a>
            </div>
          </div>
        </div>
      `;

      await resend.emails.send({
        from: 'NuSift System <system@nusift.io>', 
        to: [user.email],
        subject: 'Welcome to NuSift Agent',
        html: htmlContent, 
      });
    }

    // --- 4. SESSION PROVISIONING ---
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET missing');

    // SENIOR PROTOCOL: Dual-Zone Expiration
    // In case onboarding is complete (step >= 3), token lasts 7 days. Otherwise, only 1 hour for security reasons.
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

    // 5.a Set the HTTP-Only Cookie
    setCookie(event, 'auth_token', sessionToken, {
      httpOnly: true, 
      secure: process.env.NODE_ENV === 'production', 
      sameSite: 'lax', 
      maxAge: cookieMaxAge, 
      path: '/', 
    });

    // 5.b Set a non-HTTP-Only cookie to indicate session status (optional, can be used by frontend to show user is logged in)
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
        topSources: user.topSources,
        topInterests: user.topInterests
      } 
    };

  } catch (error: any) {
    console.error("OAuth Verification Security Exception:", error);
    throw createError({ statusCode: 401, statusMessage: "Identity verification failed" });
  }
});