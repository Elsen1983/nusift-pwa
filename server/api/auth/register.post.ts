import bcrypt from 'bcryptjs';
import { prisma } from '../../utils/prisma';

export default defineEventHandler(async (event) => {
  try {
    // 1. Kinyerjük a frontendről küldött adatokat a kérés törzséből (body)
    const body = await readBody(event);
    const { email, password } = body;

    // 2. Alapvető validáció a szerver oldalon is (Sovereign-Grade védelem)
    if (!email || !password || password.length < 12) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid input data. Minimum 12 char password required.',
      });
    }

    // 3. Ellenőrizzük, hogy létezik-e már ez a "Neural Node" (felhasználó)
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw createError({
        statusCode: 409, // Conflict (Ütközés)
        statusMessage: 'A Neural Node with this identity already exists.',
      });
    }

    // 4. A jelszó titkosítása (Hashing) 10-es "sózási" faktorral
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // 5. Az új felhasználó elmentése a Vercel Postgres adatbázisba
    const newUser = await prisma.user.create({
      data: {
        email,
        passwordHash,
      },
    });

    // 6. Sikeres válasz küldése (sosem küldjük vissza a jelszót!)
    return {
      success: true,
      user: {
        id: newUser.id,
        email: newUser.email,
        createdAt: newUser.createdAt,
        onboardingStep: newUser.onboardingStep
      },
      message: 'Sovereign Identity forged successfully.',
    };

  } catch (error: any) {
    // Hibakezelés (ha valami elszáll a Prisma vagy a Bcrypt során)
    console.error('Registration API Error:', error);
    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.statusMessage || 'Internal Server Error during Node forging.',
    });
  }
});