// server/api/auth/reset-password.post.ts
import { prisma } from '../../utils/prisma';
import bcrypt from 'bcryptjs';

export default defineEventHandler(async (event) => {
  try {
    const { token, newPassword } = await readBody(event);

    // Validate inputs (Enforcing Sovereign-Grade 12 char minimum)
    if (!token || !newPassword || newPassword.length < 12) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid request. Minimum 12 character password required.'
      });
    }

    // Find user by token, but ONLY if the expiry time is greater than Right Now
    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: token,
        resetPasswordExpires: {
          gt: new Date() 
        }
      }
    });

    if (!user) {
      throw createError({
        statusCode: 400,
        statusMessage: 'The reset token is invalid or has expired.'
      });
    }

    // Hash the new password securely
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update user: Set new password, and critically: CLEAR the reset token data
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpires: null
      }
    });

    return {
      success: true,
      message: 'Password has been successfully reset. You may now log in.'
    };

  } catch (error: any) {
    console.error('Reset Password Error:', error);
    // Return specific status code if we threw it, otherwise 500
    throw createError({ 
      statusCode: error.statusCode || 500, 
      statusMessage: error.statusMessage || 'An error occurred during password reset.' 
    });
  }
});