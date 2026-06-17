import { defineEventHandler, readBody, createError } from 'h3';

export default defineEventHandler(async (event) => {
  const user = event.context.user;
  if (!user || !user.id) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const body = await readBody(event);
  
  // Extract strictly the billing fields
  const {
    firstName,
    lastName,
    addressLine1,
    addressLine2,
    city,
    stateRegion,
    postalCode,
    country,
    vatNumber,
  } = body;

  try {
    // Dynamically import prisma so module evaluation errors don't break lazy handler
    let prisma;
    try {
      ({ prisma } = await import("../../../utils/prisma"));
    } catch (impErr) {
      console.error('Failed to import prisma in billing.put handler:', impErr);
      throw createError({ statusCode: 500, statusMessage: 'Database unavailable' });
    }

    const updatedProfile = await prisma.userProfile.upsert({
      where: { userId: user.id },
      update: {
        firstName: firstName || null,
        lastName: lastName || null,
        addressLine1: addressLine1 || null,
        addressLine2: addressLine2 || null,
        city: city || null,
        stateRegion: stateRegion || null,
        postalCode: postalCode || null,
        country: country || null,
        vatNumber: vatNumber || null,
      },
      create: {
        userId: user.id,
        firstName: firstName || null,
        lastName: lastName || null,
        addressLine1: addressLine1 || null,
        addressLine2: addressLine2 || null,
        city: city || null,
        stateRegion: stateRegion || null,
        postalCode: postalCode || null,
        country: country || null,
        vatNumber: vatNumber || null,
      },
    });

    return {
      success: true,
      profile: updatedProfile,
    };
  } catch (error) {
    console.error('Failed to update billing profile:', error);
    throw createError({ statusCode: 500, statusMessage: 'Database execution failed' });
  }
});