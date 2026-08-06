// server/api/auth/oauth.post.ts
import { Resend } from 'resend';
import appleSigninAuth from 'apple-signin-auth';
import { prisma } from '../../utils/prisma';
import { signSessionToken, setSessionCookies, requireJwtSecret } from "../../utils/auth";
import { assertRateLimit } from "../../utils/rate-limit";
import { getAdminStatusByUserId } from "../../utils/admin";
import { verifyGoogleAccessToken } from "../../utils/google-oauth";

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
  let failureStage = "request_validation";

  try {
    // --- 1. CRYPTOGRAPHIC VERIFICATION ---
    if (provider === 'GOOGLE') {
      failureStage = "google_userinfo";
      const identity = await verifyGoogleAccessToken(token, $fetch as any);
      verifiedEmail = identity.email;
      verifiedProviderId = identity.providerId;

    } else if (provider === 'APPLE') {
      failureStage = "apple_token";
      const appleTokenPayload = await appleSigninAuth.verifyIdToken(token, {
        audience: APPLE_CLIENT_ID,
        ignoreExpiration: false,
      });

      verifiedProviderId = appleTokenPayload.sub;
      verifiedEmail = appleTokenPayload.email;
    } else {
      throw new Error("unsupported_oauth_provider");
    }

    if (!verifiedEmail || !verifiedProviderId) {
      throw new Error("Identity verification failed: Missing payload.");
    }

    // --- 2. DATABASE SYNC (Explicit Relational Fetch) ---
    failureStage = "account_lookup";
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
      failureStage = "account_create";
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
          from: EMAIL_SENDER,
          to: verifiedEmail,
          subject: t.subject,
          html: `
            <div style="font-family: 'Courier New', Courier, monospace; background-color: #131313; padding: 40px; text-align: center; border-radius: 12px; border: 1px solid #1a1a1a;">
              <h2 style="color: #00E5FF; font-size: 24px;">${t.title}</h2>
              <p style="color: #ccc; font-size: 16px; line-height: 1.5; max-width: 400px; margin: 0 auto;">${t.body}</p>
            </div>
          `
        });
      } catch {
        console.error("[auth:oauth] welcome email failed", { provider });
      }
    } else {
      // Preserve the established linking behavior for legacy email accounts.
      if (!user.oauthProvider || !user.oauthId) {
        failureStage = "account_link";
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
        throw new Error("oauth_account_conflict");
      }
    }

    failureStage = "session_creation";

    // --- 3. JWT GENERATION ---
    const isFullyOnboarded = user.onboardingStep >= 3;
    const tokenExpirationStr = isFullyOnboarded ? '7d' : '1h';
    const cookieMaxAge = isFullyOnboarded ? 60 * 60 * 24 * 7 : 60 * 60;

    requireJwtSecret();
    const adminStatus = await getAdminStatusByUserId(user.id);
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
        role: user.role,
        isAdmin: adminStatus.isAdmin,
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
    const upstreamStatus = Number(error?.response?.status || error?.statusCode) || undefined;
    const errorCode = typeof error?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(error.code)
      ? error.code
      : undefined;
    const errorName = typeof error?.constructor?.name === "string"
      ? error.constructor.name.slice(0, 80)
      : undefined;
    const knownReason = typeof error?.message === "string" && [
      "invalid_google_token",
      "invalid_google_identity",
      "unsupported_oauth_provider",
      "oauth_account_conflict",
    ].includes(error.message)
      ? error.message
      : "internal_or_upstream_failure";
    console.error("[auth:oauth] request failed", {
      provider: provider === "GOOGLE" || provider === "APPLE" ? provider : "UNKNOWN",
      stage: failureStage,
      upstreamStatus,
      errorCode,
      errorName,
      reason: knownReason,
    });
    throw createError({
      statusCode: 401,
      statusMessage: 'Identity verification failed',
    });
  }
});
