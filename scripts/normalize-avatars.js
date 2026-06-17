#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import path from 'path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Set it before running this script.');
  process.exit(1);
}

// Construct Prisma with the same adapter as the app to avoid client init errors
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  try {
    console.log('Scanning userProfile.avatarUrl values to normalize to basenames...');
    const profiles = await prisma.userProfile.findMany({
      where: { avatarUrl: { not: null } },
      select: { id: true, userId: true, avatarUrl: true },
    });

    let updated = 0;
    for (const p of profiles) {
      const av = p.avatarUrl;
      if (!av) continue;
      // If avatar already looks like a bare filename, skip
      if (!av.includes('/') && !av.includes('\\')) continue;
      const base = path.basename(av);
      if (base && base !== av) {
        await prisma.userProfile.update({ where: { id: p.id }, data: { avatarUrl: base } });
        updated++;
        console.log(`Updated profile id=${p.id} userId=${p.userId} -> ${base}`);
      }
    }

    console.log(`Normalization complete. Updated ${updated} profiles.`);
    await prisma.$disconnect();
  } catch (err) {
    console.error('Failed to normalize avatars:', err);
    process.exitCode = 1;
  }
}

main();
