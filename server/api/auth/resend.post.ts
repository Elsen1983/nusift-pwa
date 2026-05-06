// server/api/auth/resend.post.ts
import { prisma } from '../../utils/prisma';
import { Resend } from 'resend';
import crypto from 'crypto';

const resend = new Resend(process.env.RESEND_API_KEY);

export default defineEventHandler(async (event) => {
  try {
    const { email } = await readBody(event);

    if (!email) {
      throw createError({ statusCode: 400, statusMessage: 'Email is required.' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Biztonsági okokból nem áruljuk el, ha az email nem létezik, csak adunk egy fals sikert (Security Best Practice)
      return { success: true, message: 'If the email exists, a link was sent.' };
    }

    if (user.isVerified) {
      throw createError({ statusCode: 400, statusMessage: 'This Neural Node is already verified. Proceed to login.' });
    }

    // Új token generálása és frissítése
    const newVerificationToken = crypto.randomUUID();
    await prisma.user.update({
      where: { email },
      data: { verificationToken: newVerificationToken }
    });

    const config = useRuntimeConfig();
    const appUrl = config.public.appUrl || 'http://localhost:3000';
    const verifyLink = `${appUrl}/verify?token=${newVerificationToken}`;

    await resend.emails.send({
      from: 'NuSift Sovereign <onboarding@nusift.com>',
      to: email,
      subject: 'Initialize Your Neural Node - Verification Required',
      html: `
        <div style="font-family: sans-serif; color: #131313; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #333; border-radius: 12px; background-color: #1a1a1a;">
          <h2 style="color: #00E5FF;">Forging Sovereign Identity</h2>
          <p style="color: #ccc;">A new Neural Node requires your authorization. Click the secure link below to verify your identity and enter the horizon:</p>
          <a href="${verifyLink}" style="display: inline-block; padding: 12px 24px; background-color: #00E5FF; color: #131313; font-weight: bold; text-decoration: none; border-radius: 8px; margin-top: 20px;">Verify My Identity</a>
        </div>
      `
    });

    return { success: true, message: 'Verification link resent.' };

  } catch (error: any) {
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || 'Failed to resend verification email.'
    });
  }
});