// server/api/auth/register-oauth.post.ts
import { Resend } from 'resend';
import { prisma } from '../../utils/prisma'; 

// Note: Use process.env.RESEND_API_KEY in production!
const resend = new Resend('re_your_api_key_here'); 

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const { email, providerId } = body; 

  try {
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        oauthProvider: 'GOOGLE',
        oauthId: providerId,
        isVerified: true, 
        onboardingStep: 0,
      }
    });

    // Native HTML template string (replaces Vue Email)
    const htmlContent = `
      <div style="background-color: #131313; color: white; font-family: 'Inter', sans-serif; padding: 40px;">
        <div style="max-width: 500px; margin: 0 auto; background-color: #1e1e1e; padding: 30px; border-radius: 12px; border: 1px solid rgba(0, 229, 255, 0.2);">
          <h1 style="color: #00E5FF; text-align: center; letter-spacing: 2px;">NUSIFT</h1>
          <p style="color: #d1d5db; line-height: 1.6;">Hello <strong>${user.email}</strong>,</p>
          <p style="color: #d1d5db; line-height: 1.6;">Your account has been successfully created via your linked provider. Because you used a secure provider, your email is already verified. You are ready to calibrate your intelligence agent.</p>
          
          <div style="text-align: center; margin-top: 35px; margin-bottom: 20px;">
            <a href="https://nusift.io/auth" style="background-color: #00E5FF; color: black; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Access Dashboard</a>
          </div>
          
          <p style="color: #6b7280; font-size: 11px; text-align: center; margin-top: 40px;">
            Securing your digital sovereignty.<br/>NuSift Inc.
          </p>
        </div>
      </div>
    `;

    // Send the email
    await resend.emails.send({
      from: 'NuSift System <system@nusift.io>', 
      to: [user.email],
      subject: 'Welcome to NuSift Agent',
      html: htmlContent, 
    });

    // Generate Session JWT logic goes here...

    return { success: true, userId: user.id };

  } catch (error) {
    console.error("OAuth Registration Error:", error);
    throw createError({ statusCode: 500, statusMessage: "Registration failed" });
  }
});