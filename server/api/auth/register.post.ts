import bcrypt from 'bcryptjs';
import { prisma } from '../../utils/prisma';
import { Resend } from 'resend';
import crypto from 'crypto';
import { assertRateLimit } from "../../utils/rate-limit";
import { validatePasswordComplexity } from "../../utils/auth";

const resend = new Resend(process.env.RESEND_API_KEY);
const EMAIL_SENDER = process.env.EMAIL_SENDER || 'NuSift <onboarding@nusift.com>';

// ANCHOR: Backend Micro-Dictionary for different languages (for future localization of email content)
const emailDictionaries = {
  en: {
    subject: "Verify your NuSift Identity",
    title: "Forging Sovereign Identity",
    body: "A new Neural Node requires your authorization. Click the secure link below to verify your identity and enter the horizon:",
    button: "Verify My Identity",
    footer: "If you didn't request this, safely ignore this email."
  },
  hu: {
    subject: "Erősítsd meg a NuSift személyazonosságod",
    title: "Személyazonosság Hitelesítése",
    body: "Egy új Neurális Csomópont engedélyezésre vár. Kattints az alábbi biztonságos linkre a személyazonosságod megerősítéséhez és a belépéshez:",
    button: "Személyazonosság Megerősítése",
    footer: "Ha nem te kérted ezt, kérlek biztonságosan hagyd figyelmen kívül ezt az e-mailt."
  }
};

export default defineEventHandler(async (event) => {
  try {
    await assertRateLimit(event, "auth-register", 5, 60_000);
    // 1. Kinyerjük a frontendről küldött adatokat a kérés törzséből (body)
    const body = await readBody(event);
    const { email, password, language = 'en' } = body;

    // 2. Server-side input validation (Sovereign-Grade defense)
    if (!email || !password) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Email and password are required.',
      });
    }

    const passwordError = validatePasswordComplexity(password);
    if (passwordError) {
      throw createError({
        statusCode: 400,
        statusMessage: passwordError,
      });
    }

    // 3. Ellenőrizzük, hogy létezik-e már ez a "Neural Node" (felhasználó)
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw createError({
        statusCode: 409, // Conflict (Ütközés)
        statusMessage: 'This email is already in use.',
      });
    }

    // 4. A jelszó titkosítása (Hashing) 10-es "sózási" faktorral
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // 5. generate a unique verification token with 24-hour expiry
    const verificationToken = crypto.randomUUID();
    const verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // 5. Az új felhasználó elmentése a Vercel Postgres adatbázisba
    const newUser = await prisma.user.create({
      data: {
        email,
        passwordHash,
        verificationToken,
        verificationTokenExpires,
        preferredLanguage: language || "en",
      },
    });

    // 6. We send a verification email using Resend (you can customize the email content as needed)
    const config = useRuntimeConfig();
    const appUrl = config.public.appUrl || 'http://localhost:3000';
    const langPrefix = language === 'en' ? '' : `/${language}`;
    const verifyLink = `${appUrl}${langPrefix}/verify?token=${verificationToken}`;

    // ANCHOR: SELECT TRANSLATION
    // Fallback to English if the requested language doesn't exist in the dictionary
    type SupportedLang = keyof typeof emailDictionaries;
    const t = emailDictionaries[language as SupportedLang] || emailDictionaries['en'];

    // 7. Send verification email using Resend
    await resend.emails.send({
      from: EMAIL_SENDER,
      to: email,
      subject: t.subject,
      html: `
        <div style="font-family: 'Courier New', Courier, monospace; background-color: #131313; padding: 40px; text-align: center; border-radius: 12px; border: 1px solid #1a1a1a;">
          <h2 style="color: #00E5FF; font-size: 24px;">${t.title}</h2>
          <p style="color: #ccc; font-size: 16px; line-height: 1.5; max-width: 400px; margin: 0 auto;">${t.body}</p>
          <a href="${verifyLink}" style="display: inline-block; padding: 14px 28px; background-color: #00E5FF; color: #131313; font-weight: bold; text-decoration: none; border-radius: 8px; margin-top: 30px; letter-spacing: 1px;">${t.button}</a>
          <p style="color: #666; font-size: 12px; margin-top: 40px; border-top: 1px solid #333; padding-top: 20px;">${t.footer}</p>
        </div>
      `
    });

    // 8. Send success response (never send back the password or sensitive info!)
    return {
      success: true,
      message: 'Sovereign Identity forged successfully. Check your inbox.',
    };

    
    //   success: true,
    //   user: {
    //     id: newUser.id,
    //     email: newUser.email,
    //     createdAt: newUser.createdAt,
    //     onboardingStep: newUser.onboardingStep
    //   },
    //   message: 'Sovereign Identity forged successfully.',
    // };

  } catch (error: any) {
    // Error handling: Log the error and send a generic error response to avoid leaking sensitive information
    console.error('Registration API Error:', error);
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || 'Internal Server Error during Node forging.',
    });
  }
});
