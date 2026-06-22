import { defineEventHandler, readBody, createError } from 'h3';

export default defineEventHandler(async (event) => {
  const user = event.context.user;
  if (!user || !user.id) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const body = await readBody(event);
  const { nickname, phoneNumber, dateOfBirth, avatar, preferredLanguage } = body;
  const aboutMyself = body.aboutMyself ?? body.about_myself;
  const hasIdentityPayload =
    nickname !== undefined ||
    phoneNumber !== undefined ||
    dateOfBirth !== undefined ||
    avatar !== undefined ||
    aboutMyself !== undefined;

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
    // Avatars are avatar_001.png through avatar_108.png
    // Vite may hash filenames in production (e.g. avatar_087.BzDPd4l4.png)
    // Accept URL-like values, strip query/hash noise, extract the avatar number,
    // and store the canonical basename without any build-specific suffixes.
    let avatarBasename: string | null = null;
    if (avatar) {
      const path = await import('node:path');
      const rawAvatar = String(avatar).split(/[?#]/)[0] ?? '';
      const base = path.basename(rawAvatar);
      const numberMatch = base.match(/avatar_(\d{1,3})/i);
      if (!numberMatch || !numberMatch[1]) {
        console.warn('Rejected avatar selection:', { avatar, base });
        throw createError({ statusCode: 400, statusMessage: 'Invalid avatar selection' });
      }
      const num = parseInt(numberMatch[1], 10);
      if (num < 1 || num > 108) {
        console.warn('Rejected avatar selection out of range:', { avatar, base, num });
        throw createError({ statusCode: 400, statusMessage: 'Invalid avatar selection' });
      }
      // Store the canonical name without Vite hash for consistent lookups
      avatarBasename = `avatar_${String(num).padStart(3, '0')}.png`;
    }

    if (preferredLanguage) {
      await prisma.user.update({
        where: { id: user.id },
        data: { preferredLanguage: String(preferredLanguage) },
      });
    }

    let updatedProfile = null;
    if (hasIdentityPayload) {
      const profileUpdate: Record<string, unknown> = {};
      if (nickname !== undefined) profileUpdate.nickname = nickname || null;
      if (phoneNumber !== undefined) profileUpdate.phoneNumber = phoneNumber || null;
      if (dateOfBirth !== undefined) profileUpdate.dateOfBirth = parsedDate;
      if (aboutMyself !== undefined) {
        profileUpdate.aboutMyself = aboutMyself ? String(aboutMyself).slice(0, 1000) : null;
      }
      if (avatar !== undefined) profileUpdate.avatarUrl = avatarBasename || null;

      updatedProfile = await prisma.userProfile.upsert({
        where: { userId: user.id },
        update: profileUpdate,
        create: {
          userId: user.id,
          nickname: nickname !== undefined ? (nickname || null) : null,
          phoneNumber: phoneNumber !== undefined ? (phoneNumber || null) : null,
          dateOfBirth: dateOfBirth !== undefined ? parsedDate : null,
          aboutMyself: aboutMyself !== undefined ? (aboutMyself ? String(aboutMyself).slice(0, 1000) : null) : null,
          avatarUrl: avatar !== undefined ? (avatarBasename || null) : null,
        },
      });
    }

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
