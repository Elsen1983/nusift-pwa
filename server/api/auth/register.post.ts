import bcrypt from 'bcryptjs';
import { prisma } from '../../utils/prisma';
import { Resend } from 'resend';
import crypto from 'crypto';

const resend = new Resend(process.env.RESEND_API_KEY); // Replace with your actual Resend API key

export default defineEventHandler(async (event) => {
  try {
    // 1. Kinyerjük a frontendről küldött adatokat a kérés törzséből (body)
    const body = await readBody(event);
    const { email, password } = body;

    // 2. Alapvető validáció a szerver oldalon is (Sovereign-Grade védelem)
    if (!email || !password || password.length < 12) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid input data. Minimum 12 char password required.',
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

    // 5. generate a unique verification token for email verification (if needed in the future)
    const verificationToken = crypto.randomUUID();

    // 5. Az új felhasználó elmentése a Vercel Postgres adatbázisba
    const newUser = await prisma.user.create({
      data: {
        email,
        passwordHash,
        verificationToken,
      },
    });

    // 6. We send a verification email using Resend (you can customize the email content as needed)
    const config = useRuntimeConfig();
    const appUrl = config.public.appUrl || 'http://localhost:3000';
    const verifyLink = `${appUrl}/verify?token=${verificationToken}`;

    // 7. Send verification email using Resend
    await resend.emails.send({
      from: 'NuSift Sovereign <onboarding@nusift.com>',
      to: email, // For testing, replace with the actual recipient email
      subject: 'Initialize Your Neural Node - Verification Required',
      html: `
        <div style="font-family: sans-serif; color: #131313; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #333; border-radius: 12px; background-color: #1a1a1a;">
          <h2 style="color: #00E5FF;">Forging Sovereign Identity</h2>
          <p style="color: #ccc;">A new Neural Node requires your authorization. Click the secure link below to verify your identity and enter the horizon:</p>
          <a href="${verifyLink}" style="display: inline-block; padding: 12px 24px; background-color: #00E5FF; color: #131313; font-weight: bold; text-decoration: none; border-radius: 8px; margin-top: 20px;">Verify My Identity</a>
          <p style="color: #666; font-size: 11px; margin-top: 30px;">If you didn't request this, safely ignore this email.</p>
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