import { defineEventHandler, readBody, createError } from 'h3';

export default defineEventHandler(async (event) => {
  const user = event.context.user;
  if (!user || !user.id) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const body = await readBody(event);
  const { nickname, phoneNumber, dateOfBirth, avatar } = body;
  const aboutMyself = body.aboutMyself ?? body.about_myself;

  // Validate and parse the Date of Birth securely
  let parsedDate: Date | null = null;
  if (dateOfBirth) {
    parsedDate = new Date(dateOfBirth);
    if (isNaN(parsedDate.getTime())) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid date format' });
    }
  }

  try {
    // Dynamically import prisma to avoid failing module evaluation
    let prisma;
    try {
      ({ prisma } = await import("../../../utils/prisma"));
    } catch (impErr) {
      console.error('Failed to import prisma in identity.put handler:', impErr);
      throw createError({ statusCode: 500, statusMessage: 'Database unavailable' });
    }

    // --- AVATAR VALIDATION ---
    // Pattern-based validation: avatars are avatar_001.png through avatar_108.png
    // No filesystem read needed — works on Vercel serverless where app/ doesn't exist at runtime
    let avatarBasename: string | null = null;
    if (avatar) {
      const path = await import('node:path');
      const base = path.basename(avatar as string);
      const AVATAR_PATTERN = /^avatar_\d{3}\.png$/;
      if (!AVATAR_PATTERN.test(base)) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid avatar selection' });
      }
      avatarBasename = base;
    }

    // Use upsert to handle both first-time saves and subsequent updates
    const updatedProfile = await prisma.userProfile.upsert({
      where: { userId: user.id },
      update: {
        nickname: nickname || null,
        phoneNumber: phoneNumber || null,
        dateOfBirth: parsedDate,
        aboutMyself: aboutMyself ? String(aboutMyself).slice(0, 1000) : null,
        avatarUrl: avatarBasename || null,
      },
      create: {
        userId: user.id,
        nickname: nickname || null,
        phoneNumber: phoneNumber || null,
        dateOfBirth: parsedDate,
        aboutMyself: aboutMyself ? String(aboutMyself).slice(0, 1000) : null,
        avatarUrl: avatarBasename || null,
      },
    });

    return {
      success: true,
      profile: updatedProfile,
    };
  } catch (error: any) {
    // Handle Prisma unique constraint violations (e.g., duplicate nickname)
    if (error.code === 'P2002') {
      throw createError({ statusCode: 409, statusMessage: 'Nickname is already taken.' });
    }
    
    console.error('Failed to update identity profile:', {
      code: error.code,
      message: error.message,
      meta: error.meta,
      stack: error.stack,
    });
    throw createError({
      statusCode: 500,
      statusMessage: 'Database execution failed',
    });
  }
});
