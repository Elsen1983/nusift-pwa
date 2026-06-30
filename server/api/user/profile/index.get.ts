import { defineEventHandler, createError } from 'h3';
import { requireUserId } from '../../../utils/require-user';

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);

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
        userId,
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