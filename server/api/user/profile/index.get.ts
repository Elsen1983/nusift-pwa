import { defineEventHandler, createError } from 'h3';

export default defineEventHandler(async (event) => {
  // 1. Verify authentication
  const user = event.context.user;
  if (!user || !user.id) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
    });
  }

  try {
    // Dynamically import prisma to avoid failing module evaluation
    let prisma;
    try {
      ({ prisma } = await import("../../../utils/prisma"));
    } catch (impErr) {
      console.error('Failed to import prisma in profile.get handler:', impErr);
      throw createError({ statusCode: 500, statusMessage: 'Database unavailable' });
    }

    // 2. Fetch the profile relation
    const profile = await prisma.userProfile.findUnique({
      where: {
        userId: user.id,
      },
    });

    return {
      success: true,
      profile: profile || {}, // Return empty object if no profile exists yet
    };
  } catch (error) {
    console.error('Error fetching user profile:', error);
    throw createError({
      statusCode: 500,
      statusMessage: 'Internal Server Error',
    });
  }
});