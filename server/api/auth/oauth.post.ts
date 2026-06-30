// server/api/auth/oauth.post.ts
import { Resend } from 'resend';
import appleSigninAuth from 'apple-signin-auth';
import { prisma } from '../../utils/prisma'; 
import { signSessionToken, setSessionCookies, requireJwtSecret } from "../../utils/auth";
import { assertRateLimit } from "../../utils/rate-limit";

const resend = new Resend(process.env.RESEND_API_KEY);
const EMAIL_SENDER = process.env.EMAIL_SENDER || 'NuSift <onboarding@nusift.com>';
const APPLE_CLIENT_ID = process.env.NUXT_PUBLIC_APPLE_CLIENT_ID || process.env.APPLE_CLIENT_ID || '';
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
  await assertRateLimit(event, "auth-oauth", 10, 60_000);
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
        audience: APPLE_CLIENT_ID,
        ignoreExpiration: false,
      });

      verifiedProviderId = appleTokenPayload.sub;
      verifiedEmail = appleTokenPayload.email;
    }

    if (!verifiedProviderId) {
      throw new Error("Identity verification failed: Missing provider ID.");
    }

    const userInclude = {
      sourceSubscriptions: { include: { newsSource: true } },
      categorySubscriptions: { include: { category: true } },
    } as const;

    // --- 2. DATABASE SYNC ---
    // Apple omits email on repeat sign-ins; resolve returning users by oauthId.
    let user =
      (verifiedEmail
        ? await prisma.user.findUnique({
            where: { email: verifiedEmail },
            include: userInclude,
          })
        : null) ||
      (await prisma.user.findUnique({
        where: { oauthId: verifiedProviderId },
        include: userInclude,
      }));

    if (!user) {
      if (!verifiedEmail) {
        throw new Error("Identity verification failed: Email required for new accounts.");
      }

      user = await prisma.user.create({
        data: {
          email: verifiedEmail,
          isVerified: true,
          oauthProvider: provider,
          oauthId: verifiedProviderId,
          preferredLanguage: language || "en",
        },
        include: userInclude,
      });

      try {
        type SupportedLang = keyof typeof welcomeDictionaries;
        const t = welcomeDictionaries[(language as SupportedLang)] || welcomeDictionaries["en"];

        await resend.emails.send({
          from: EMAIL_SENDER,
          to: verifiedEmail,
          subject: t.subject,
          html: `
            <div style="font-family: 'Courier New', Courier, monospace; background-color: #131313; padding: 40px; text-align: center; border-radius: 12px; border: 1px solid #1a1a1a;">
              <h2 style="color: #00E5FF; font-size: 24px;">${t.title}</h2>
              <p style="color: #ccc; font-size: 16px; line-height: 1.5; max-width: 400px; margin: 0 auto;">${t.body}</p>
            </div>
          `,
        });
      } catch (e) {
        console.error("Welcome email failed, but account created:", e);
      }
    } else if (!user.oauthProvider || !user.oauthId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          oauthProvider: provider,
          oauthId: verifiedProviderId,
        },
        include: userInclude,
      });
    } else if (user.oauthProvider !== provider || user.oauthId !== verifiedProviderId) {
      throw new Error("Identity verification failed: Account conflict.");
    }

    // --- 3. JWT GENERATION ---
    const isFullyOnboarded = user.onboardingStep >= 3;
    const tokenExpirationStr = isFullyOnboarded ? '7d' : '1h';
    const cookieMaxAge = isFullyOnboarded ? 60 * 60 * 24 * 7 : 60 * 60;

    requireJwtSecret();
    const sessionToken = signSessionToken(
      {
        userId: user.id,
        email: user.email,
        onboardingStep: user.onboardingStep,
        tokenVersion: user.tokenVersion,
      },
      tokenExpirationStr,
    );
    setSessionCookies(event, sessionToken, cookieMaxAge);

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
      statusMessage: "Identity verification failed",
    });
  }
});
