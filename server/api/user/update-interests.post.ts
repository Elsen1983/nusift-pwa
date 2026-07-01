// server/api/user/update-interests.post.ts
import { prisma } from '../../utils/prisma';
import { requireUserId } from '../../utils/require-user';

export default defineEventHandler(async (event) => {
  // 1. Authentication (session-guard validates tokenVersion)
  const currentUserId = requireUserId(event);

  // 3. Extract the updated interests from the frontend payload
  const body = await readBody(event);
  const { interests } = body;

  // Basic validation to ensure we received an array
  if (!interests || !Array.isArray(interests)) {
     throw createError({ statusCode: 400, statusMessage: "Bad Request: Invalid interests payload." });
  }

  try {
    // 4. Update the database using Prisma
    // Because we changed the schema to Json, Prisma handles the stringification automatically
    const updatedUser = await prisma.user.update({
      where: { id: currentUserId },
      data: {
        topInterests: interests,
      }
    });

    return { 
      success: true, 
      message: "Agent memory synchronized successfully.",
      // Return the updated data to confirm it was saved
      interests: updatedUser.topInterests 
    };

  } catch (error: any) {
    console.error("Database Error during interest update:", error);
    throw createError({ 
      statusCode: 500, 
      statusMessage: error.message || "Failed to save fine-tuned memory to database." 
    });
  }
});
