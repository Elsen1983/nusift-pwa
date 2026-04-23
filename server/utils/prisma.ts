import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// Globális példány a fejlesztői környezet memóriaszivárgásának megelőzésére
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// 1. Létrehozzuk a natív PostgreSQL kapcsolatot a Vercel URL-el
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });

// 2. Becsomagoljuk a Prisma Adapterbe
const adapter = new PrismaPg(pool);

// 3. Átadjuk az Adaptert a Prisma Kliensnek (Ez a Prisma 7+ standard)
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;