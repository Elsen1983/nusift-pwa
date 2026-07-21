import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaPgPool: Pool | undefined;
};

const connectionString = process.env.DATABASE_URL;
const parsedPoolMax = Number(process.env.DATABASE_POOL_MAX);
const poolMax = Number.isFinite(parsedPoolMax) && parsedPoolMax > 0
  ? Math.floor(parsedPoolMax)
  : process.env.NODE_ENV === 'production' ? 1 : 10;

const pool = globalForPrisma.prismaPgPool ?? new Pool({
  connectionString,
  max: poolMax,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

globalForPrisma.prismaPgPool = pool;

const adapter = new PrismaPg(pool);

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

globalForPrisma.prisma = prisma;
