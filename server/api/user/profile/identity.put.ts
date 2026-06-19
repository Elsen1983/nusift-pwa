import { defineEventHandler, readBody, createError } from 'h3';
// Top-level memory cache. Persists across requests in the Nitro process.
let cachedAvatarList: string[] | null = null;

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

    // --- OPTIMIZED AVATAR VALIDATION ---
    // Server-side whitelist validation for avatar filenames (only allow pre-bundled avatars)
    let avatarBasename: string | null = null;
    if (avatar) {
      const path = await import('node:path');
      
      // Execute the synchronous file read ONLY if the cache is empty
      if (!cachedAvatarList) {
        const fs = await import('node:fs');
        const avatarsDir = path.resolve(process.cwd(), 'app/assets/images/avatars');
        try {
          cachedAvatarList = fs.readdirSync(avatarsDir);
        } catch (e) {
          console.warn('Avatar directory missing or unreadable:', avatarsDir, e);
          cachedAvatarList = []; // Set to empty array so it doesn't try to read again
        }
      }

      // Fast memory lookup
      const base = path.basename(avatar as string);
      if (!cachedAvatarList.includes(base)) {
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
    
    console.error('Failed to update identity profile:', error);
    throw createError({ statusCode: 500, statusMessage: 'Database execution failed' });
  }
});
