// server/api/auth/forgot-password.post.ts
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

    // SECURITY GATE: Anti-Enumeration & OAuth Check
    // If user doesn't exist OR they use OAuth (no passwordHash), we silently succeed
    if (!user || !user.passwordHash) {
      return { success: true, message: 'If an account exists, a password reset link has been sent.' };
    }

    // Generate a secure cryptographic token and set expiry to 15 minutes from now
    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 15 * 60 * 1000);

    // Save token to database
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: resetToken,
        resetPasswordExpires: tokenExpiry
      }
    });

    const config = useRuntimeConfig();
    const appUrl = config.public.appUrl || 'http://localhost:3000';
    const resetLink = `${appUrl}/reset-password?token=${resetToken}`;

    // Dispatch Email via Resend
    await resend.emails.send({
      from: 'NuSift Sovereign <onboarding@nusift.com>',
      to: email,
      subject: 'Neural Node Security - Password Reset Request',
      html: `
        <div style="font-family: sans-serif; color: #131313; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #333; border-radius: 12px; background-color: #1a1a1a;">
          <h2 style="color: #00E5FF;">Password Reset Authorized</h2>
          <p style="color: #ccc;">A request was made to reset the password for your Neural Node. This secure link is only valid for 15 minutes.</p>
          <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background-color: #00E5FF; color: #131313; font-weight: bold; text-decoration: none; border-radius: 8px; margin-top: 20px;">Reset My Password</a>
          <p style="color: #666; font-size: 11px; margin-top: 30px;">If you did not request this, safely ignore this email. Your Node remains secure.</p>
        </div>
      `
    });

    return { success: true, message: 'If an account exists, a password reset link has been sent.' };

  } catch (error: any) {
    console.error('Forgot Password Error:', error);
    throw createError({ statusCode: 500, statusMessage: 'An error occurred during the request.' });
  }
});