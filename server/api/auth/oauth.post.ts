// server/api/auth/oauth.post.ts
import { Resend } from 'resend';
import jwt from 'jsonwebtoken';
import appleSigninAuth from 'apple-signin-auth';
import { prisma } from '../../utils/prisma'; 

const resend = new Resend(process.env.RESEND_API_KEY); 

// ANCHOR: Backend Micro-Dictionary for different languages (for future localization of email content)
const welcomeDictionaries = {
  en: {
    subject: "Welcome to your Sovereign-Grade Intelligence Platform",
    title: "Node Activated",
    body: "Success! Your NuSift node is ready for calibration. Return to the application to forge your intelligence horizon."
  },
  hu: {
    subject: "Üdvözlünk a Szuverén Intelligencia Platformodon",
    title: "Csomópont Aktiválva",
    body: "Siker! A NuSift csomópontod készen áll a kalibrációra. Térj vissza az alkalmazásba az intelligencia-horizontod formálásához."
  }
};

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const { token, provider, language } = body; 

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
      // NEW USER: Create account and apply the language from the payload
      user = await prisma.user.create({
        data: {
          email: verifiedEmail,
          isVerified: true,
          oauthProvider: provider,
          oauthId: verifiedProviderId,
          preferredLanguage: language || "en", 
        },
        include: {
          sourceSubscriptions: { include: { newsSource: true } },
          categorySubscriptions: { include: { category: true } }
        }
      });

      // ANCHOR: DYNAMIC WELCOME EMAIL
      try {
        type SupportedLang = keyof typeof welcomeDictionaries;
        const t = welcomeDictionaries[(language as SupportedLang)] || welcomeDictionaries['en'];

        await resend.emails.send({
          from: 'NuSift Protocol <onboarding@resend.dev>',
          to: verifiedEmail,
          subject: t.subject,
          html: `
            <div style="font-family: 'Courier New', Courier, monospace; background-color: #131313; padding: 40px; text-align: center; border-radius: 12px; border: 1px solid #1a1a1a;">
              <h2 style="color: #00E5FF; font-size: 24px;">${t.title}</h2>
              <p style="color: #ccc; font-size: 16px; line-height: 1.5; max-width: 400px; margin: 0 auto;">${t.body}</p>
            </div>
          `
        });
      } catch (e) {
        console.error("Welcome email failed, but account created:", e);
      }

    } else {
      // EXISTING USER: Link the OAuth account if it is missing
      // We explicitly DO NOT update preferredLanguage to protect the DB state
      if (!user.oauthProvider || !user.oauthId) {
        user = await prisma.user.update({
          where: { email: verifiedEmail },
          data: {
            oauthProvider: provider,
            oauthId: verifiedProviderId,
          },
          include: {
            sourceSubscriptions: { include: { newsSource: true } },
            categorySubscriptions: { include: { category: true } }
          }
        });
      } else if (user.oauthProvider !== provider || user.oauthId !== verifiedProviderId) {
        throw new Error("Identity verification failed: Account conflict.");
      } else {
        console.log("OAuth login: Existing account verified for", verifiedEmail);
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
        preferredLanguage: user.preferredLanguage,
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